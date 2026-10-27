/**
 * Content script injected on demand to:
 * 1. Detect if the page wraps its real content inside an `<iframe>` or `<frame>`
 *    (very common in PHP systems / portals / legacy admin panels) and either
 *    unwrap/expand the iframe or scroll inside the iframe directly!
 * 2. Use center-point hit testing (`document.elementsFromPoint`) + full DOM/ShadowDOM
 *    inspection to find the exact scrollable element.
 * 3. Support both Single-Shot capture and Scroll & Stitch (with real scroll events).
 */
(() => {
  if (window.__saveAsPngMessageListener) {
    chrome.runtime.onMessage.removeListener(window.__saveAsPngMessageListener);
  }

  const STYLE_ID = '__save_as_png_helper_style__';
  let activeSession = null;

  const OVERRIDE_PROPS = [
    'height',
    'max-height',
    'min-height',
    'overflow',
    'overflow-y',
    'overflow-x',
    'position',
    'top',
    'bottom',
    'left',
    'right',
    'flex',
    'flex-grow',
    'flex-shrink',
    'flex-basis',
    'contain',
    'content-visibility'
  ];

  function snapshotStyles(el, props = OVERRIDE_PROPS) {
    const saved = [];
    for (const prop of props) {
      saved.push({
        prop,
        value: el.style.getPropertyValue(prop),
        priority: el.style.getPropertyPriority(prop)
      });
    }
    return { element: el, saved };
  }

  function restoreStyleSnapshots(records) {
    if (!records) return;
    for (let i = records.length - 1; i >= 0; i--) {
      const rec = records[i];
      const el = rec.element;
      if (!el) continue;
      for (const { prop, value, priority } of rec.saved) {
        if (value) {
          el.style.setProperty(prop, value, priority);
        } else {
          el.style.removeProperty(prop);
        }
      }
    }
  }

  function injectCaptureStylesIntoDoc(doc) {
    if (!doc) return;
    try {
      let styleEl = doc.getElementById(STYLE_ID);
      if (!styleEl) {
        styleEl = doc.createElement('style');
        styleEl.id = STYLE_ID;
        styleEl.textContent = `
          html, body, * {
            scroll-behavior: auto !important;
            scrollbar-width: none !important;
            -ms-overflow-style: none !important;
          }
          html::-webkit-scrollbar,
          body::-webkit-scrollbar,
          *::-webkit-scrollbar {
            display: none !important;
            width: 0 !important;
            height: 0 !important;
          }
        `;
        (doc.head || doc.documentElement).appendChild(styleEl);
      }
    } catch (_) {}
  }

  function removeCaptureStylesFromDoc(doc) {
    if (!doc) return;
    try {
      const styleEl = doc.getElementById(STYLE_ID);
      if (styleEl && styleEl.parentNode) {
        styleEl.parentNode.removeChild(styleEl);
      }
    } catch (_) {}
  }

  function collectAllElements(root = document) {
    const result = [];
    try {
      const walker = (root.ownerDocument || root).createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node = walker.currentNode;
      while (node) {
        if (node.nodeType === 1) {
          result.push(node);
          if (node.shadowRoot) {
            result.push(...collectAllElements(node.shadowRoot));
          }
        }
        node = walker.nextNode();
      }
    } catch (_) {}
    return result;
  }

  /**
   * Tests whether an element can actually be scrolled vertically, either via CSS overflow
   * or by probing `scrollTop`.
   */
  function isElementScrollable(el, win = window) {
    if (!el || el.nodeType !== 1) return false;
    const sh = el.scrollHeight;
    const ch = el.clientHeight;
    if (sh <= ch + 8) return false;

    const st = win.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;

    const oy = st.overflowY;
    if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') {
      return true;
    }

    // Even if overflowY is 'hidden' or custom, test if scrollTop already > 0 or can move
    if (el.scrollTop > 0) return true;
    const prev = el.scrollTop;
    el.scrollTop = 1;
    const moved = el.scrollTop > 0;
    if (moved) {
      el.scrollTop = prev;
      return true;
    }
    return false;
  }

  /**
   * Finds all large `<iframe`> or `<frame>` elements on the page.
   * Many PHP portals / ERP / admin systems load the entire working page inside an iframe!
   */
  function findLargeIframes() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const frames = [
      ...Array.from(document.querySelectorAll('iframe, frame'))
    ];

    const results = [];
    for (const frame of frames) {
      const rect = frame.getBoundingClientRect();
      if (rect.width < vw * 0.35 || rect.height < vh * 0.3) continue;

      let contentDoc = null;
      let contentWin = null;
      try {
        contentDoc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
        contentWin = frame.contentWindow;
      } catch (_) {
        // Cross-origin iframe
      }

      results.push({
        frameElement: frame,
        rect,
        area: rect.width * rect.height,
        sameOrigin: Boolean(contentDoc && contentWin),
        contentDoc,
        contentWin
      });
    }

    results.sort((a, b) => b.area - a.area);
    return results;
  }

  /**
   * Finds the best scrollable target inside a specific document/window (either main page or same-origin iframe).
   */
  function findScrollTargetInContext(doc, win) {
    const docEl = doc.documentElement;
    const body = doc.body;
    const scrollingEl = doc.scrollingElement || docEl || body;
    const vw = win.innerWidth || (docEl ? docEl.clientWidth : 800);
    const vh = win.innerHeight || (docEl ? docEl.clientHeight : 600);

    // 1. Check elements at center of viewport using elementsFromPoint (catches exact pane user sees)
    const centerCandidates = [];
    const samplePoints = [
      [vw * 0.5, vh * 0.5],
      [vw * 0.5, vh * 0.35],
      [vw * 0.5, vh * 0.7],
      [vw * 0.65, vh * 0.5]
    ];

    const seen = new Set();
    for (const [px, py] of samplePoints) {
      let hitList = [];
      try {
        hitList = doc.elementsFromPoint(px, py) || [];
      } catch (_) {}
      for (const hit of hitList) {
        let curr = hit;
        while (curr && curr !== doc && curr !== docEl && curr !== body) {
          if (!seen.has(curr) && curr.nodeType === 1) {
            seen.add(curr);
            const r = curr.getBoundingClientRect();
            if (r.width >= vw * 0.3 && r.height >= vh * 0.25 && isElementScrollable(curr, win)) {
              centerCandidates.push({
                element: curr,
                scrollHeight: curr.scrollHeight,
                area: r.width * r.height
              });
            }
          }
          curr = curr.parentElement || (curr.getRootNode && curr.getRootNode().host);
        }
      }
    }

    // 2. Scan all elements in document as backup
    const allElements = collectAllElements(doc);
    for (const el of allElements) {
      if (seen.has(el) || el === docEl || el === body || el === scrollingEl) continue;
      if (el.id === STYLE_ID) continue;
      const r = el.getBoundingClientRect();
      if (r.width >= vw * 0.3 && r.height >= vh * 0.25 && isElementScrollable(el, win)) {
        centerCandidates.push({
          element: el,
          scrollHeight: el.scrollHeight,
          area: r.width * r.height
        });
      }
    }

    centerCandidates.sort((a, b) => (b.scrollHeight * b.area) - (a.scrollHeight * a.area));

    const docScrollHeight = Math.max(
      scrollingEl ? scrollingEl.scrollHeight : 0,
      docEl ? docEl.scrollHeight : 0,
      body ? body.scrollHeight : 0
    );

    const bestInner = centerCandidates[0] || null;
    if (bestInner && (bestInner.scrollHeight > docScrollHeight || docScrollHeight <= vh + 12)) {
      return {
        type: 'element',
        element: bestInner.element,
        doc,
        win,
        innerContainers: centerCandidates.map((c) => c.element)
      };
    }

    return {
      type: 'window',
      element: scrollingEl,
      doc,
      win,
      innerContainers: centerCandidates.map((c) => c.element)
    };
  }

  /**
   * Master discovery function: checks both the main document AND any large `<iframe`> / `<frame>`
   * on the page to find what actually holds the long content!
   */
  function discoverPageScrollArchitecture() {
    const mainTarget = findScrollTargetInContext(document, window);
    const mainDocHeight = Math.max(
      document.scrollingElement ? document.scrollingElement.scrollHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0,
      document.body ? document.body.scrollHeight : 0,
      mainTarget.type === 'element' ? mainTarget.element.scrollHeight : 0
    );

    const largeIframes = findLargeIframes();
    for (const iframeInfo of largeIframes) {
      if (iframeInfo.sameOrigin) {
        const subTarget = findScrollTargetInContext(iframeInfo.contentDoc, iframeInfo.contentWin);
        const subHeight =
          subTarget.type === 'element'
            ? subTarget.element.scrollHeight
            : Math.max(
                iframeInfo.contentDoc.scrollingElement ? iframeInfo.contentDoc.scrollingElement.scrollHeight : 0,
                iframeInfo.contentDoc.documentElement ? iframeInfo.contentDoc.documentElement.scrollHeight : 0,
                iframeInfo.contentDoc.body ? iframeInfo.contentDoc.body.scrollHeight : 0
              );

        // If the iframe has scrollable content taller than its box (or taller than main page)
        if (subHeight > iframeInfo.rect.height + 15 && subHeight >= mainDocHeight * 0.8) {
          return {
            isIframe: true,
            sameOrigin: true,
            frameElement: iframeInfo.frameElement,
            frameRect: iframeInfo.rect,
            target: subTarget,
            innerContainers: subTarget.innerContainers
          };
        }
      }
    }

    return {
      isIframe: false,
      sameOrigin: true,
      frameElement: null,
      frameRect: null,
      target: mainTarget,
      innerContainers: mainTarget.innerContainers
    };
  }

  /**
   * Unclips a chain of elements up to their root document so they can expand to full height.
   */
  function unclipElementChain(startEl, targetHeightPx, modifiedList, visitedSet) {
    let curr = startEl;
    let first = true;
    while (curr && curr.nodeType === 1) {
      if (!visitedSet.has(curr)) {
        visitedSet.add(curr);
        const win = (curr.ownerDocument && curr.ownerDocument.defaultView) || window;
        const st = win.getComputedStyle(curr);
        modifiedList.push(snapshotStyles(curr));

        curr.style.setProperty('overflow', 'visible', 'important');
        curr.style.setProperty('overflow-y', 'visible', 'important');
        curr.style.setProperty('height', 'auto', 'important');
        curr.style.setProperty('max-height', 'none', 'important');
        curr.style.setProperty('contain', 'none', 'important');
        curr.style.setProperty('content-visibility', 'visible', 'important');

        if (first && targetHeightPx > 0) {
          curr.style.setProperty('min-height', `${targetHeightPx}px`, 'important');
          first = false;
        }

        if (st.flexShrink !== '0') {
          curr.style.setProperty('flex-shrink', '0', 'important');
        }

        if (st.position === 'fixed' || st.position === 'absolute') {
          const r = curr.getBoundingClientRect();
          if (r.width >= win.innerWidth * 0.45 && r.height >= win.innerHeight * 0.35) {
            curr.style.setProperty('position', 'relative', 'important');
            curr.style.setProperty('bottom', 'auto', 'important');
          }
        }
      }
      curr = curr.parentElement || (curr.getRootNode && curr.getRootNode().host);
    }
  }

  /**
   * Expands inner scroll containers AND same-origin iframes so the entire page can grow to its
   * full height in the top-level document.
   */
  function expandAllScrollableStructures(arch) {
    const modified = [];
    const visited = new Set();

    if (document.documentElement) {
      unclipElementChain(document.documentElement, 0, modified, visited);
    }
    if (document.body) {
      unclipElementChain(document.body, 0, modified, visited);
    }

    if (arch.isIframe && arch.sameOrigin && arch.frameElement) {
      const subDoc = arch.target.doc;
      if (subDoc.documentElement) {
        unclipElementChain(subDoc.documentElement, 0, modified, visited);
      }
      if (subDoc.body) {
        unclipElementChain(subDoc.body, 0, modified, visited);
      }
      for (const c of arch.innerContainers) {
        unclipElementChain(c, c.scrollHeight, modified, visited);
      }

      const subFullHeight = Math.max(
        arch.target.element ? arch.target.element.scrollHeight : 0,
        subDoc.documentElement ? subDoc.documentElement.scrollHeight : 0,
        subDoc.body ? subDoc.body.scrollHeight : 0
      );

      // Expand the `<iframe>` element itself to match its inner document's full height!
      modified.push(snapshotStyles(arch.frameElement));
      arch.frameElement.style.setProperty('height', `${subFullHeight + 20}px`, 'important');
      arch.frameElement.style.setProperty('min-height', `${subFullHeight + 20}px`, 'important');
      arch.frameElement.style.setProperty('max-height', 'none', 'important');
      unclipElementChain(arch.frameElement.parentElement, subFullHeight + 20, modified, visited);
    } else {
      for (const c of arch.innerContainers) {
        unclipElementChain(c, c.scrollHeight, modified, visited);
      }
    }

    // Also check if top-level document happens to be a `<frameset>`
    const frameset = document.querySelector('frameset');
    if (frameset && arch.frameElement) {
      // Framesets cannot be expanded via CSS height:auto; they must be scrolled directly
    }

    return modified;
  }

  function getScrollPos(target) {
    if (!target) return { x: 0, y: 0 };
    if (target.type === 'element' && target.element) {
      return {
        x: Math.round(target.element.scrollLeft),
        y: Math.round(target.element.scrollTop)
      };
    }
    const w = target.win || window;
    const se = (target.doc && target.doc.scrollingElement) || (target.doc && target.doc.documentElement);
    return {
      x: Math.round(w.scrollX || w.pageXOffset || (se ? se.scrollLeft : 0) || 0),
      y: Math.round(w.scrollY || w.pageYOffset || (se ? se.scrollTop : 0) || 0)
    };
  }

  function setScrollPos(target, x, y) {
    if (!target) return;
    if (target.type === 'element' && target.element) {
      const el = target.element;
      try {
        el.scrollTo({ left: x, top: y, behavior: 'instant' });
      } catch (_) {}
      el.scrollLeft = x;
      el.scrollTop = y;
      try {
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
      } catch (_) {}
    } else {
      const w = target.win || window;
      const d = target.doc || document;
      try {
        w.scrollTo({ left: x, top: y, behavior: 'instant' });
      } catch (_) {}
      if (d.scrollingElement) {
        d.scrollingElement.scrollLeft = x;
        d.scrollingElement.scrollTop = y;
      }
      if (d.documentElement) {
        d.documentElement.scrollTop = y;
      }
      if (d.body) {
        d.body.scrollTop = y;
      }
      try {
        w.dispatchEvent(new Event('scroll'));
      } catch (_) {}
    }
  }

  function collectFixedAndStickyElements(doc, win, excludeEl) {
    const fixedRecords = [];
    const vh = win.innerHeight;
    const vw = win.innerWidth;

    for (const el of collectAllElements(doc)) {
      if (el.id === STYLE_ID) continue;
      if (excludeEl && (el === excludeEl || (el.contains && el.contains(excludeEl)))) {
        continue;
      }
      const style = win.getComputedStyle(el);
      const pos = style.position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
        continue;
      }

      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (pos === 'fixed' && rect.width >= vw * 0.95 && rect.height >= vh * 0.95) {
        continue;
      }

      fixedRecords.push({
        element: el,
        win,
        position: pos,
        initialTop: rect.top,
        initialBottom: rect.bottom,
        originalVisibility: el.style.getPropertyValue('visibility'),
        originalVisibilityPriority: el.style.getPropertyPriority('visibility'),
        originalOpacity: el.style.getPropertyValue('opacity'),
        originalOpacityPriority: el.style.getPropertyPriority('opacity')
      });
    }

    return fixedRecords;
  }

  function updateFixedElementsVisibility(session, isTopSlice, isBottomSlice) {
    for (const rec of session.fixedRecords) {
      const el = rec.element;
      if (!el || !el.isConnected) continue;
      const vh = (rec.win && rec.win.innerHeight) || window.innerHeight;

      const isBottomAnchored =
        rec.position === 'fixed' &&
        rec.initialTop > vh * 0.65 &&
        rec.initialBottom >= vh - 40;

      const shouldShow = isBottomAnchored ? isBottomSlice : isTopSlice;

      if (shouldShow) {
        if (rec.originalVisibility) {
          el.style.setProperty('visibility', rec.originalVisibility, rec.originalVisibilityPriority);
        } else {
          el.style.removeProperty('visibility');
        }
        if (rec.originalOpacity) {
          el.style.setProperty('opacity', rec.originalOpacity, rec.originalOpacityPriority);
        } else {
          el.style.removeProperty('opacity');
        }
      } else {
        el.style.setProperty('visibility', 'hidden', 'important');
        el.style.setProperty('opacity', '0', 'important');
      }
    }
  }

  function restoreFixedElements(session) {
    if (!session || !session.fixedRecords) return;
    for (const rec of session.fixedRecords) {
      const el = rec.element;
      if (!el) continue;
      if (rec.originalVisibility) {
        el.style.setProperty('visibility', rec.originalVisibility, rec.originalVisibilityPriority);
      } else {
        el.style.removeProperty('visibility');
      }
      if (rec.originalOpacity) {
        el.style.setProperty('opacity', rec.originalOpacity, rec.originalOpacityPriority);
      } else {
        el.style.removeProperty('opacity');
      }
    }
  }

  function waitForAnimationFrames(count = 2) {
    return new Promise((resolve) => {
      function step(remaining) {
        if (remaining <= 0) {
          resolve();
        } else {
          requestAnimationFrame(() => step(remaining - 1));
        }
      }
      step(count);
    });
  }

  function buildScrollPlan(totalWidth, totalHeight, stepWidth, stepHeight) {
    const xs = [];
    const maxScrollX = totalWidth > stepWidth + 8 ? totalWidth - stepWidth : 0;
    for (let x = 0; x < maxScrollX; x += stepWidth) {
      xs.push(x);
    }
    xs.push(maxScrollX);

    const ys = [];
    const maxScrollY = Math.max(0, totalHeight - stepHeight);
    for (let y = 0; y < maxScrollY; y += stepHeight) {
      ys.push(y);
    }
    ys.push(maxScrollY);

    const steps = [];
    for (let yi = 0; yi < ys.length; yi++) {
      for (let xi = 0; xi < xs.length; xi++) {
        steps.push({
          targetX: xs[xi],
          targetY: ys[yi],
          isTopSlice: ys[yi] === 0,
          isBottomSlice: yi === ys.length - 1
        });
      }
    }
    return steps;
  }

  /**
   * Computes dimensions of the scrollable target + outer page.
   */
  function measureArchitectureDimensions(arch) {
    const vw = window.innerWidth || document.documentElement.clientWidth || 800;
    const vh = window.innerHeight || document.documentElement.clientHeight || 600;

    let totalWidth = Math.max(
      vw,
      document.documentElement ? document.documentElement.scrollWidth : 0,
      document.body ? document.body.scrollWidth : 0
    );
    let totalHeight = Math.max(
      vh,
      document.documentElement ? document.documentElement.scrollHeight : 0,
      document.body ? document.body.scrollHeight : 0
    );

    const t = arch.target;
    if (arch.isIframe && arch.frameElement) {
      const fRect = arch.frameElement.getBoundingClientRect();
      const subDoc = t.doc;
      const subHeight =
        t.type === 'element'
          ? t.element.scrollHeight
          : Math.max(
              subDoc.scrollingElement ? subDoc.scrollingElement.scrollHeight : 0,
              subDoc.documentElement ? subDoc.documentElement.scrollHeight : 0,
              subDoc.body ? subDoc.body.scrollHeight : 0
            );
      totalHeight = Math.max(totalHeight, Math.ceil(Math.max(0, fRect.top) + subHeight));
    } else if (t.type === 'element' && t.element) {
      const r = t.element.getBoundingClientRect();
      totalHeight = Math.max(totalHeight, Math.ceil(Math.max(0, r.top) + t.element.scrollHeight));
      totalWidth = Math.max(totalWidth, t.element.scrollWidth);
    }

    return {
      viewportWidth: vw,
      viewportHeight: vh,
      totalWidth: Math.ceil(totalWidth),
      totalHeight: Math.ceil(totalHeight)
    };
  }

  /**
   * Gets the visible bounding box (in main window viewport coordinates) of the scroll container
   * or iframe being scrolled.
   */
  function getTargetViewportBox(arch) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    if (arch.isIframe && arch.frameElement) {
      const fr = arch.frameElement.getBoundingClientRect();
      if (arch.target.type === 'element' && arch.target.element) {
        const er = arch.target.element.getBoundingClientRect();
        const left = Math.max(0, Math.round(fr.left + er.left));
        const top = Math.max(0, Math.round(fr.top + er.top));
        const right = Math.min(vw, Math.round(fr.left + er.right));
        const bottom = Math.min(vh, Math.round(fr.top + er.bottom));
        return {
          left,
          top,
          width: Math.max(50, right - left),
          height: Math.max(50, bottom - top),
          scrollWidth: arch.target.element.scrollWidth,
          scrollHeight: arch.target.element.scrollHeight
        };
      }
      const left = Math.max(0, Math.round(fr.left));
      const top = Math.max(0, Math.round(fr.top));
      const right = Math.min(vw, Math.round(fr.right));
      const bottom = Math.min(vh, Math.round(fr.bottom));
      const subDoc = arch.target.doc;
      const sh = Math.max(
        subDoc.scrollingElement ? subDoc.scrollingElement.scrollHeight : 0,
        subDoc.documentElement ? subDoc.documentElement.scrollHeight : 0,
        subDoc.body ? subDoc.body.scrollHeight : 0
      );
      const sw = Math.max(
        subDoc.scrollingElement ? subDoc.scrollingElement.scrollWidth : 0,
        subDoc.documentElement ? subDoc.documentElement.scrollWidth : 0,
        subDoc.body ? subDoc.body.scrollWidth : 0
      );
      return {
        left,
        top,
        width: Math.max(50, right - left),
        height: Math.max(50, bottom - top),
        scrollWidth: sw,
        scrollHeight: sh
      };
    }

    if (arch.target.type === 'element' && arch.target.element) {
      const er = arch.target.element.getBoundingClientRect();
      const left = Math.max(0, Math.round(er.left));
      const top = Math.max(0, Math.round(er.top));
      const right = Math.min(vw, Math.round(er.right));
      const bottom = Math.min(vh, Math.round(er.bottom));
      return {
        left,
        top,
        width: Math.max(50, right - left),
        height: Math.max(50, bottom - top),
        scrollWidth: arch.target.element.scrollWidth,
        scrollHeight: arch.target.element.scrollHeight
      };
    }

    return null;
  }

  async function handlePrepare(msg) {
    const mode = (msg && msg.mode) || 'scroll';
    if (activeSession) {
      await handleCleanup();
    }

    const arch = discoverPageScrollArchitecture();
    injectCaptureStylesIntoDoc(document);
    if (arch.isIframe && arch.sameOrigin && arch.target.doc) {
      injectCaptureStylesIntoDoc(arch.target.doc);
    }

    const originalWindowScroll = {
      x: Math.round(window.scrollX || window.pageXOffset || 0),
      y: Math.round(window.scrollY || window.pageYOffset || 0)
    };
    const originalTargetScroll = getScrollPos(arch.target);

    // Scroll to top
    setScrollPos(arch.target, 0, 0);
    window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
    await waitForAnimationFrames(2);

    const preDims = measureArchitectureDimensions(arch);
    let expandedRecords = [];

    if (mode === 'single') {
      expandedRecords = expandAllScrollableStructures(arch);
      await waitForAnimationFrames(2);
    }

    const postDims = measureArchitectureDimensions(arch);
    let totalWidth = Math.max(preDims.totalWidth, postDims.totalWidth);
    let totalHeight = Math.max(preDims.totalHeight, postDims.totalHeight);

    // Check if the main document actually grew to hold the full height in 'single' mode
    const mainDocGrewHeight = Math.max(
      document.scrollingElement ? document.scrollingElement.scrollHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0,
      document.body ? document.body.scrollHeight : 0
    );
    const canCaptureSingleShot =
      !document.querySelector('frameset') &&
      mainDocGrewHeight >= totalHeight - 25 &&
      !(arch.isIframe && !arch.sameOrigin);

    const box = getTargetViewportBox(arch);
    let stepWidth = postDims.viewportWidth;
    let stepHeight = postDims.viewportHeight;
    let planTotalWidth = totalWidth;
    let planTotalHeight = totalHeight;

    if (mode === 'scroll' && box) {
      stepWidth = box.width;
      stepHeight = box.height;
      planTotalWidth = Math.max(box.width, box.scrollWidth);
      planTotalHeight = Math.max(box.height, box.scrollHeight);
      totalHeight = Math.max(totalHeight, box.top + planTotalHeight);
    }

    const fixedRecords = [
      ...collectFixedAndStickyElements(document, window, arch.frameElement || arch.target.element),
      ...(arch.isIframe && arch.sameOrigin && arch.target.doc
        ? collectFixedAndStickyElements(arch.target.doc, arch.target.win, arch.target.element)
        : [])
    ];

    const steps = buildScrollPlan(planTotalWidth, planTotalHeight, stepWidth, stepHeight);

    activeSession = {
      mode,
      arch,
      originalWindowScroll,
      originalTargetScroll,
      expandedRecords,
      fixedRecords,
      dims: {
        viewportWidth: postDims.viewportWidth,
        viewportHeight: postDims.viewportHeight,
        totalWidth,
        totalHeight
      }
    };

    return {
      ok: true,
      title: document.title || 'page',
      url: location.href,
      dpr: window.devicePixelRatio || 1,
      viewportWidth: postDims.viewportWidth,
      viewportHeight: postDims.viewportHeight,
      totalWidth,
      totalHeight,
      canCaptureSingleShot,
      isInnerContainerOrIframe: Boolean(box),
      steps
    };
  }

  async function handleScrollStep(msg) {
    if (!activeSession) {
      throw new Error('No active capture session.');
    }

    const { targetX, targetY, isTopSlice, isBottomSlice } = msg;
    const { arch } = activeSession;

    updateFixedElementsVisibility(activeSession, isTopSlice, isBottomSlice);
    setScrollPos(arch.target, targetX, targetY);
    await waitForAnimationFrames(3);

    const actual = getScrollPos(arch.target);
    const box = getTargetViewportBox(arch);

    return {
      ok: true,
      actualX: actual.x,
      actualY: actual.y,
      viewportWidth: activeSession.dims.viewportWidth,
      viewportHeight: activeSession.dims.viewportHeight,
      containerRect: box
    };
  }

  async function handleCleanup() {
    if (activeSession) {
      try {
        restoreFixedElements(activeSession);
        restoreStyleSnapshots(activeSession.expandedRecords);
        window.scrollTo({
          left: activeSession.originalWindowScroll.x,
          top: activeSession.originalWindowScroll.y,
          behavior: 'instant'
        });
        setScrollPos(
          activeSession.arch.target,
          activeSession.originalTargetScroll.x,
          activeSession.originalTargetScroll.y
        );
        if (activeSession.arch.isIframe && activeSession.arch.sameOrigin && activeSession.arch.target.doc) {
          removeCaptureStylesFromDoc(activeSession.arch.target.doc);
        }
      } catch (_) {}
      activeSession = null;
    }
    removeCaptureStylesFromDoc(document);
    await waitForAnimationFrames(1);
    return { ok: true };
  }

  window.__saveAsPngMessageListener = (message, _sender, sendResponse) => {
    if (!message || !message.type) return false;

    if (message.type === 'SAVE_AS_PNG_PREPARE') {
      handlePrepare(message)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    if (message.type === 'SAVE_AS_PNG_SCROLL_STEP') {
      handleScrollStep(message)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    if (message.type === 'SAVE_AS_PNG_CLEANUP') {
      handleCleanup()
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    return false;
  };

  chrome.runtime.onMessage.addListener(window.__saveAsPngMessageListener);
})();
