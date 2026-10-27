/**
 * Helper injected into ALL frames (`allFrames: true`) so that even if a PHP portal
 * or web app embeds its content inside a cross-origin or nested `<frame>` / `<iframe`>,
 * we can discover the exact scrollable frame, scroll it step-by-step, and stitch it!
 */
(() => {
  if (window.__saveAsPngFrameHelperListener) {
    chrome.runtime.onMessage.removeListener(window.__saveAsPngFrameHelperListener);
  }

  const STYLE_ID = '__save_as_png_frame_style__';
  let frameState = null;

  function findBestScrollElement() {
    const doc = document;
    const win = window;
    const docEl = doc.documentElement;
    const body = doc.body;
    const scrollingEl = doc.scrollingElement || docEl || body;
    const vw = win.innerWidth || (docEl ? docEl.clientWidth : 0);
    const vh = win.innerHeight || (docEl ? docEl.clientHeight : 0);

    let bestEl = null;
    let bestHeight = Math.max(
      scrollingEl ? scrollingEl.scrollHeight : 0,
      docEl ? docEl.scrollHeight : 0,
      body ? body.scrollHeight : 0
    );

    const all = doc.querySelectorAll('*');
    for (const el of all) {
      if (el === docEl || el === body || el === scrollingEl) continue;
      if (el.scrollHeight <= el.clientHeight + 10) continue;
      const st = win.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      const oy = st.overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay' && el.scrollTop === 0) {
        continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width >= vw * 0.4 && r.height >= vh * 0.35 && el.scrollHeight > bestHeight) {
        bestEl = el;
        bestHeight = el.scrollHeight;
      }
    }

    return {
      type: bestEl ? 'element' : 'window',
      element: bestEl || scrollingEl,
      scrollHeight: bestHeight,
      scrollWidth: bestEl
        ? bestEl.scrollWidth
        : Math.max(docEl ? docEl.scrollWidth : 0, body ? body.scrollWidth : 0, vw),
      viewportWidth: bestEl ? Math.round(bestEl.clientWidth) : vw,
      viewportHeight: bestEl ? Math.round(bestEl.clientHeight) : vh
    };
  }

  function getScroll(target) {
    if (target.type === 'element' && target.element) {
      return {
        x: Math.round(target.element.scrollLeft),
        y: Math.round(target.element.scrollTop)
      };
    }
    const se = document.scrollingElement || document.documentElement;
    return {
      x: Math.round(window.scrollX || window.pageXOffset || (se ? se.scrollLeft : 0) || 0),
      y: Math.round(window.scrollY || window.pageYOffset || (se ? se.scrollTop : 0) || 0)
    };
  }

  function setScroll(target, x, y) {
    if (target.type === 'element' && target.element) {
      const el = target.element;
      try {
        el.scrollTo({ left: x, top: y, behavior: 'instant' });
      } catch (_) {}
      el.scrollLeft = x;
      el.scrollTop = y;
    } else {
      try {
        window.scrollTo({ left: x, top: y, behavior: 'instant' });
      } catch (_) {}
      if (document.scrollingElement) {
        document.scrollingElement.scrollLeft = x;
        document.scrollingElement.scrollTop = y;
      }
      if (document.documentElement) document.documentElement.scrollTop = y;
      if (document.body) document.body.scrollTop = y;
    }
  }

  function injectStyle() {
    let s = document.getElementById(STYLE_ID);
    if (!s) {
      s = document.createElement('style');
      s.id = STYLE_ID;
      s.textContent = `
        html, body, * {
          scroll-behavior: auto !important;
          scrollbar-width: none !important;
        }
        *::-webkit-scrollbar {
          display: none !important;
          width: 0 !important;
          height: 0 !important;
        }
      `;
      (document.head || document.documentElement).appendChild(s);
    }
  }

  function removeStyle() {
    const s = document.getElementById(STYLE_ID);
    if (s && s.parentNode) s.parentNode.removeChild(s);
  }

  window.__saveAsPngFrameHelperListener = (msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return false;

    if (msg.type === 'SAVE_AS_PNG_FRAME_PROBE') {
      const info = findBestScrollElement();
      sendResponse({
        ok: true,
        isTop: window === window.top,
        href: location.href,
        scrollHeight: info.scrollHeight,
        scrollWidth: info.scrollWidth,
        viewportWidth: info.viewportWidth,
        viewportHeight: info.viewportHeight,
        scrollableRange: info.scrollHeight - info.viewportHeight
      });
      return true;
    }

    if (msg.type === 'SAVE_AS_PNG_FRAME_PREPARE') {
      injectStyle();
      const target = findBestScrollElement();
      const orig = getScroll(target);
      setScroll(target, 0, 0);
      frameState = { target, orig };
      sendResponse({
        ok: true,
        scrollHeight: target.scrollHeight,
        scrollWidth: target.scrollWidth,
        viewportWidth: target.viewportWidth,
        viewportHeight: target.viewportHeight
      });
      return true;
    }

    if (msg.type === 'SAVE_AS_PNG_FRAME_SCROLL') {
      if (!frameState) {
        frameState = { target: findBestScrollElement(), orig: { x: 0, y: 0 } };
      }
      setScroll(frameState.target, msg.targetX || 0, msg.targetY || 0);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const actual = getScroll(frameState.target);
          sendResponse({
            ok: true,
            actualX: actual.x,
            actualY: actual.y,
            viewportWidth: frameState.target.viewportWidth,
            viewportHeight: frameState.target.viewportHeight
          });
        });
      });
      return true;
    }

    if (msg.type === 'SAVE_AS_PNG_FRAME_CLEANUP') {
      if (frameState) {
        setScroll(frameState.target, frameState.orig.x, frameState.orig.y);
        frameState = null;
      }
      removeStyle();
      sendResponse({ ok: true });
      return true;
    }

    return false;
  };

  chrome.runtime.onMessage.addListener(window.__saveAsPngFrameHelperListener);
})();
