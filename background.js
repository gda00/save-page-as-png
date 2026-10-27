/**
 * Background Service Worker for "Save Full Page as PNG".
 *
 * Uses minimal, Chrome Web Store-friendly permissions (`activeTab`, `scripting`, `downloads`)
 * and zero network calls. Automatically handles:
 *   1. Standard scrolling web pages.
 *   2. Single-Page Applications (SPAs) with inner scroll containers (`overflow-y: auto`).
 *   3. PHP portals / dashboards / legacy systems using `<iframe>`, `<frame>`, or `<frameset>`.
 */

const MAX_CANVAS_DIMENSION = 16384;
const MAX_CANVAS_AREA = 268435456; // 16384 * 16384 pixels
const CAPTURE_MIN_INTERVAL_MS = 520;

const activeCaptures = new Set();
let lastCaptureTime = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeCanvasLayout(totalWidthCss, totalHeightCss, dpr) {
  const rawWidth = Math.max(1, Math.round(totalWidthCss * dpr));
  const rawHeight = Math.max(1, Math.round(totalHeightCss * dpr));

  const dimScale = Math.min(
    1,
    MAX_CANVAS_DIMENSION / rawWidth,
    MAX_CANVAS_DIMENSION / rawHeight
  );
  const areaScale = Math.min(1, Math.sqrt(MAX_CANVAS_AREA / (rawWidth * rawHeight)));
  const limitScale = Math.min(dimScale, areaScale);

  const effectiveScale = dpr * limitScale;
  return {
    canvasWidth: Math.max(1, Math.round(totalWidthCss * effectiveScale)),
    canvasHeight: Math.max(1, Math.round(totalHeightCss * effectiveScale)),
    effectiveScale,
    limitScale
  };
}

function buildFilename(title) {
  const sanitized = (title || 'page')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'page';

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `${sanitized}_${stamp}.png`;
}

async function setBadge(tabId, text, bgColor = '#2563EB') {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: bgColor });
    await chrome.action.setBadgeText({ tabId, text });
  } catch (_) {}
}

async function clearBadgeLater(tabId, delayMs = 2000) {
  await sleep(delayMs);
  await setBadge(tabId, '');
}

async function sendTabMessage(tabId, payload, options) {
  if (options) {
    return await chrome.tabs.sendMessage(tabId, payload, options);
  }
  return await chrome.tabs.sendMessage(tabId, payload);
}

async function captureViewportWithRetry(windowId, maxRetries = 4) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const elapsed = Date.now() - lastCaptureTime;
    if (elapsed < CAPTURE_MIN_INTERVAL_MS) {
      await sleep(CAPTURE_MIN_INTERVAL_MS - elapsed);
    }

    try {
      lastCaptureTime = Date.now();
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (err) {
      const msg = (err && err.message) || String(err);
      if (attempt < maxRetries && msg.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Failed to read PNG blob'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Probes all frames in the tab (using `allFrames: true`) to see if a child `<frame>` / `<iframe>`
 * has more scrollable content than the top window.
 */
async function findScrollableChildFrame(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['frame_helper.js']
    });

    let bestChildFrame = null;
    for (const r of results || []) {
      if (r.frameId === 0) continue; // skip top frame
      try {
        const probe = await sendTabMessage(
          tabId,
          { type: 'SAVE_AS_PNG_FRAME_PROBE' },
          { frameId: r.frameId }
        );
        if (probe && probe.ok && probe.scrollableRange > 50) {
          if (!bestChildFrame || probe.scrollHeight > bestChildFrame.scrollHeight) {
            bestChildFrame = { frameId: r.frameId, ...probe };
          }
        }
      } catch (_) {}
    }
    return bestChildFrame;
  } catch (_) {
    return null;
  }
}

/**
 * Scrolls a specific child `<frame>` or `<iframe>` (even cross-origin!) via its `frameId`
 * and stitches the captured viewports.
 */
async function captureChildFrameViaScroll(tab, childFrame, topPrepInfo) {
  const tabId = tab.id;
  const frameId = childFrame.frameId;

  const prep = await sendTabMessage(
    tabId,
    { type: 'SAVE_AS_PNG_FRAME_PREPARE' },
    { frameId }
  );

  try {
    const dpr = topPrepInfo.dpr || 1;
    const totalWidth = Math.max(topPrepInfo.viewportWidth, prep.scrollWidth);
    const headerOffset = Math.max(0, topPrepInfo.viewportHeight - prep.viewportHeight);
    const totalHeight = headerOffset + prep.scrollHeight;

    const layout = computeCanvasLayout(totalWidth, totalHeight, dpr);
    const canvas = new OffscreenCanvas(layout.canvasWidth, layout.canvasHeight);
    const ctx = canvas.getContext('2d');

    const stepHeight = Math.max(100, prep.viewportHeight);
    const maxScrollY = Math.max(0, prep.scrollHeight - stepHeight);
    const ys = [];
    for (let y = 0; y < maxScrollY; y += stepHeight) {
      ys.push(y);
    }
    ys.push(maxScrollY);

    for (let i = 0; i < ys.length; i++) {
      const pct = Math.round((i / ys.length) * 100);
      await setBadge(tabId, `${pct}%`, '#2563EB');

      const stepRes = await sendTabMessage(
        tabId,
        { type: 'SAVE_AS_PNG_FRAME_SCROLL', targetX: 0, targetY: ys[i] },
        { frameId }
      );

      const dataUrl = await captureViewportWithRetry(tab.windowId);
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);

      try {
        const dprRatio = bitmap.width / topPrepInfo.viewportWidth;
        if (i === 0 && headerOffset > 0) {
          ctx.drawImage(
            bitmap,
            0,
            0,
            bitmap.width,
            Math.round(headerOffset * dprRatio),
            0,
            0,
            Math.round(topPrepInfo.viewportWidth * layout.effectiveScale),
            Math.round(headerOffset * layout.effectiveScale)
          );
        }

        const srcY = Math.round(headerOffset * dprRatio);
        const srcH = Math.min(bitmap.height - srcY, Math.round(prep.viewportHeight * dprRatio));
        const destY = Math.round((headerOffset + stepRes.actualY) * layout.effectiveScale);
        const destW = Math.round(topPrepInfo.viewportWidth * layout.effectiveScale);
        const destH = Math.round(prep.viewportHeight * layout.effectiveScale);

        if (srcH > 0) {
          ctx.drawImage(bitmap, 0, srcY, bitmap.width, srcH, 0, destY, destW, destH);
        }
      } finally {
        bitmap.close();
      }
    }

    const finalBlob = await canvas.convertToBlob({ type: 'image/png' });
    const dataUrl = await blobToDataUrl(finalBlob);
    return { title: topPrepInfo.title, dataUrl };
  } finally {
    try {
      await sendTabMessage(tabId, { type: 'SAVE_AS_PNG_FRAME_CLEANUP' }, { frameId });
    } catch (_) {}
  }
}

/**
 * Scroll & Stitch capture for the main document, inner scrollable containers, or iframes.
 */
async function captureViaScrollAndStitch(tab) {
  const tabId = tab.id;
  const prepInfo = await sendTabMessage(tabId, {
    type: 'SAVE_AS_PNG_PREPARE',
    mode: 'scroll'
  });
  if (!prepInfo || !prepInfo.ok) {
    throw new Error((prepInfo && prepInfo.error) || 'Failed to prepare page for scroll capture.');
  }

  // If the top frame only saw 1 step (no scrollable height in main doc), check if a child
  // `<frame>` / `<iframe>` holds the scrollable page (e.g., PHP frameset / cross-origin iframe)!
  if (prepInfo.steps.length <= 1) {
    const childFrame = await findScrollableChildFrame(tabId);
    if (childFrame) {
      await sendTabMessage(tabId, { type: 'SAVE_AS_PNG_CLEANUP' });
      return await captureChildFrameViaScroll(tab, childFrame, prepInfo);
    }
  }

  try {
    const { title, dpr, totalWidth, totalHeight, steps } = prepInfo;
    const layout = computeCanvasLayout(totalWidth, totalHeight, dpr);
    const canvas = new OffscreenCanvas(layout.canvasWidth, layout.canvasHeight);
    const ctx = canvas.getContext('2d');

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const pct = Math.round((i / steps.length) * 100);
      await setBadge(tabId, `${pct}%`, '#2563EB');

      const stepRes = await sendTabMessage(tabId, {
        type: 'SAVE_AS_PNG_SCROLL_STEP',
        targetX: step.targetX,
        targetY: step.targetY,
        isTopSlice: step.isTopSlice,
        isBottomSlice: step.isBottomSlice
      });

      if (!stepRes || !stepRes.ok) {
        throw new Error((stepRes && stepRes.error) || 'Failed during scroll step.');
      }

      const dataUrl = await captureViewportWithRetry(tab.windowId);
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);

      try {
        if (stepRes.containerRect) {
          const cr = stepRes.containerRect;
          const dprRatio = bitmap.width / stepRes.viewportWidth;

          if (step.isTopSlice && cr.top > 0) {
            ctx.drawImage(
              bitmap,
              0,
              0,
              bitmap.width,
              Math.round(cr.top * dprRatio),
              0,
              0,
              Math.round(stepRes.viewportWidth * layout.effectiveScale),
              Math.round(cr.top * layout.effectiveScale)
            );
          }

          const srcX = Math.max(0, Math.round(cr.left * dprRatio));
          const srcY = Math.max(0, Math.round(cr.top * dprRatio));
          const srcW = Math.min(bitmap.width - srcX, Math.round(cr.width * dprRatio));
          const srcH = Math.min(bitmap.height - srcY, Math.round(cr.height * dprRatio));

          const destX = Math.round((cr.left + stepRes.actualX) * layout.effectiveScale);
          const destY = Math.round((cr.top + stepRes.actualY) * layout.effectiveScale);
          const destW = Math.round(cr.width * layout.effectiveScale);
          const destH = Math.round(cr.height * layout.effectiveScale);

          if (srcW > 0 && srcH > 0) {
            ctx.drawImage(bitmap, srcX, srcY, srcW, srcH, destX, destY, destW, destH);
          }
        } else {
          const destX = Math.round(stepRes.actualX * layout.effectiveScale);
          const destY = Math.round(stepRes.actualY * layout.effectiveScale);
          const destW = Math.round(stepRes.viewportWidth * layout.effectiveScale);
          const destH = Math.round(stepRes.viewportHeight * layout.effectiveScale);

          ctx.drawImage(
            bitmap,
            0,
            0,
            bitmap.width,
            bitmap.height,
            destX,
            destY,
            destW,
            destH
          );
        }
      } finally {
        bitmap.close();
      }
    }

    const finalBlob = await canvas.convertToBlob({ type: 'image/png' });
    const dataUrl = await blobToDataUrl(finalBlob);
    return { title, dataUrl };
  } finally {
    try {
      await sendTabMessage(tabId, { type: 'SAVE_AS_PNG_CLEANUP' });
    } catch (_) {}
  }
}

async function captureFullPage(tab) {
  const tabId = tab.id;
  if (!tabId || activeCaptures.has(tabId)) {
    return;
  }

  const url = tab.url || '';
  if (
    !url ||
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.includes('chromewebstore.google.com') ||
    url.includes('chrome.google.com/webstore')
  ) {
    await setBadge(tabId, 'ERR', '#DC2626');
    clearBadgeLater(tabId, 2500);
    return;
  }

  activeCaptures.add(tabId);
  await setBadge(tabId, '0%', '#2563EB');

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });

    const result = await captureViaScrollAndStitch(tab);

    await setBadge(tabId, '99%', '#2563EB');

    const filename = buildFilename(result.title);
    await chrome.downloads.download({
      url: result.dataUrl,
      filename,
      saveAs: false
    });

    await setBadge(tabId, 'DONE', '#16A34A');
    clearBadgeLater(tabId, 2000);
  } catch (err) {
    console.error('[Save Full Page as PNG] Capture failed:', err);
    await setBadge(tabId, 'ERR', '#DC2626');
    clearBadgeLater(tabId, 3000);
  } finally {
    activeCaptures.delete(tabId);
  }
}

chrome.action.onClicked.addListener((tab) => {
  captureFullPage(tab);
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    computeCanvasLayout,
    buildFilename,
    MAX_CANVAS_DIMENSION,
    MAX_CANVAS_AREA
  };
}
