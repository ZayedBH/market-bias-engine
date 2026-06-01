(function () {
  'use strict';

  // ── Config ─────────────────────────────────────────────────────────────────
  // Map path → external script URL for that page (null = inline <script> in HTML)
  const PAGE_SCRIPT = {
    '/':         '/js/app.js',
    '/quant':    '/js/quant.js',
    '/backtest': null,
  };
  const KNOWN_PATHS = new Set(Object.keys(PAGE_SCRIPT));

  // ── Cache ──────────────────────────────────────────────────────────────────
  const htmlCache   = new Map(); // path   → HTML string
  const scriptCache = new Map(); // script → JS text

  // ── State ──────────────────────────────────────────────────────────────────
  let currentPath = normPath(location.pathname);
  let dynScript   = null; // currently-injected dynamic <script> element

  function normPath(p) { return (!p || p === '') ? '/' : p; }

  // ── Chart cleanup ──────────────────────────────────────────────────────────
  function destroyAllCharts() {
    if (typeof Chart === 'undefined') return;
    // Chart.js 4.x: Chart.instances is an object keyed by internal id
    Object.values(Chart.instances).forEach(c => {
      try { c.destroy(); } catch (_) {}
    });
  }

  // ── Symbol propagation ─────────────────────────────────────────────────────
  function captureSymbol() {
    const sel = document.getElementById('symbolSelect');
    if (sel && sel.value) window._routerSymbol = sel.value;
  }

  // ── Fetch helpers ──────────────────────────────────────────────────────────
  function fetchText(url) {
    return fetch(url).then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    });
  }

  // ── IIFE wrapper for dynamic script injection ──────────────────────────────
  // Wraps code in an IIFE so its const/let don't pollute the global scope
  // (avoids "Identifier already declared" when the same script runs twice).
  // The IIFE must still expose `init` and `_pageCleanup` on window.
  function makeIIFE(code) {
    return [
      '(function(){\n',
      code,
      '\n// SPA router: expose page lifecycle hooks\n',
      'if(typeof init==="function")window.init=init;\n',
      '})();',
    ].join('');
  }

  // ── DOM transition ─────────────────────────────────────────────────────────
  function applyPage(path, html, scriptCode) {
    // 1. Run current page's cleanup (clears auto-refresh timers, etc.)
    if (typeof window._pageCleanup === 'function') {
      try { window._pageCleanup(); } catch (_) {}
      window._pageCleanup = null;
    }

    // 2. Destroy all Chart.js instances before canvases are replaced
    destroyAllCharts();

    // 3. Parse the fetched HTML
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // 4. Update page <title>
    const newTitle = doc.querySelector('title');
    if (newTitle) document.title = newTitle.textContent;

    // 5. Replace everything after <nav> in .app
    const appEl = document.querySelector('.app');
    const navEl = appEl && appEl.querySelector('nav');
    if (!appEl || !navEl) return;

    let sib = navEl.nextSibling;
    while (sib) {
      const next = sib.nextSibling;
      appEl.removeChild(sib);
      sib = next;
    }

    // Clone nodes from fetched doc, skipping <script> elements
    const fetchedApp = doc.querySelector('.app');
    if (fetchedApp) {
      const fetchedNav = fetchedApp.querySelector('nav');
      let node = fetchedNav ? fetchedNav.nextSibling : fetchedApp.firstChild;
      while (node) {
        const next = node.nextSibling;
        if (!(node.nodeType === 1 && node.tagName === 'SCRIPT')) {
          appEl.appendChild(document.importNode(node, true));
        }
        node = next;
      }
    }

    // 6. Mark active nav link
    document.querySelectorAll('.nav-links a').forEach(a => {
      try {
        const href = normPath(new URL(a.href, location.origin).pathname);
        a.classList.toggle('active', href === path);
      } catch (_) {}
    });

    // 7. Push history
    history.pushState({ path }, '', path);
    currentPath = path;

    // 8. Inject page script and call init()
    injectScript(path, doc, scriptCode);
  }

  // ── Script injection ───────────────────────────────────────────────────────
  function injectScript(path, fetchedDoc, scriptCode) {
    // Remove previously injected dynamic script
    if (dynScript) { dynScript.remove(); dynScript = null; }

    const s = document.createElement('script');

    if (scriptCode !== null) {
      // External script (app.js / quant.js) — wrap in IIFE to prevent
      // "Identifier already declared" from const/let at global scope
      s.textContent = makeIIFE(scriptCode);
      document.body.appendChild(s);
      dynScript = s;
      if (typeof window.init === 'function') window.init();
    } else {
      // Inline script (backtest) — extract from fetched HTML body
      // The backtest script now has a named init() thanks to our refactor
      const inline = fetchedDoc
        ? [...fetchedDoc.querySelectorAll('body script:not([src])')].map(n => n.textContent).join('\n')
        : '';
      if (inline) {
        s.textContent = makeIIFE(inline);
        document.body.appendChild(s);
        dynScript = s;
        if (typeof window.init === 'function') window.init();
      }
    }
  }

  // ── Navigate ───────────────────────────────────────────────────────────────
  function navigate(path) {
    path = normPath(path);
    if (path === currentPath || !KNOWN_PATHS.has(path)) return;

    captureSymbol();

    const htmlReady   = htmlCache.has(path)
      ? Promise.resolve(htmlCache.get(path))
      : fetchText(path).then(h => { htmlCache.set(path, h); return h; });

    const scriptSrc   = PAGE_SCRIPT[path];
    const scriptReady = scriptSrc === null
      ? Promise.resolve(null)                     // inline — extracted from HTML
      : scriptCache.has(scriptSrc)
        ? Promise.resolve(scriptCache.get(scriptSrc))
        : fetchText(scriptSrc).then(c => { scriptCache.set(scriptSrc, c); return c; });

    document.body.style.cursor = 'progress';

    Promise.all([htmlReady, scriptReady])
      .then(([html, code]) => {
        document.body.style.cursor = '';
        applyPage(path, html, code);
      })
      .catch(err => {
        document.body.style.cursor = '';
        console.error('[router] Navigation failed:', path, err);
      });
  }

  // ── Event wiring ───────────────────────────────────────────────────────────

  // Capture phase: intercept nav link clicks before any page handler
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    let url;
    try { url = new URL(a.href, location.origin); } catch (_) { return; }
    if (url.origin !== location.origin) return;
    const path = normPath(url.pathname);
    if (!KNOWN_PATHS.has(path)) return;
    e.preventDefault();
    navigate(path);
  }, true);

  // Browser back / forward
  window.addEventListener('popstate', e => {
    const path = normPath(e.state?.path ?? location.pathname);
    if (path !== currentPath && KNOWN_PATHS.has(path)) navigate(path);
  });

  // Prefetch HTML + scripts for all other pages 2 s after initial load
  // so subsequent navigations are served fully from cache (instant)
  window.addEventListener('load', () => {
    setTimeout(() => {
      KNOWN_PATHS.forEach(path => {
        // Prefetch HTML
        if (!htmlCache.has(path)) {
          fetchText(path)
            .then(h => htmlCache.set(path, h))
            .catch(() => {});
        }
        // Prefetch external script
        const src = PAGE_SCRIPT[path];
        if (src && !scriptCache.has(src)) {
          fetchText(src)
            .then(c => scriptCache.set(src, c))
            .catch(() => {});
        }
      });
    }, 2000);
  });

})();
