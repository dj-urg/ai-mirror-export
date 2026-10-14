/**
 * Preview harness — state controller.
 *
 * Loads popup.html into an iframe with mock-browser.js injected as the very
 * first script, so popup.js finds a usable window.browser the moment it runs.
 *
 * State is a two-dimensional product: (state preset) × (export outcome).
 * Theme and viewport are post-render overrides on the outer stage.
 */

(function () {
  const stateSelect = document.getElementById('statePreset');
  const outcomeSelect = document.getElementById('exportOutcome');
  const themeRadios = document.querySelectorAll('input[name="theme"]');
  const viewportRadios = document.querySelectorAll('input[name="viewport"]');
  const reloadBtn = document.getElementById('reloadFrame');
  const stage = document.getElementById('harnessStage');
  const iframe = document.getElementById('popupFrame');
  const log = document.getElementById('eventLog');

  // Repo root as an absolute URL — used for <base> inside srcdoc so the popup's
  // relative paths resolve to the same files the real extension loads.
  const repoRoot = new URL('..', location.href).href;

  const originalPopupHtmlPromise = fetch('../popup.html').then((r) => r.text());

  function logEvent(text) {
    const li = document.createElement('li');
    const t = new Date().toISOString().substring(11, 19);
    li.textContent = `[${t}] ${text}`;
    log.insertBefore(li, log.firstChild);
    // Trim to last 50 lines.
    while (log.children.length > 50) log.removeChild(log.lastChild);
  }

  function currentTheme() {
    const el = document.querySelector('input[name="theme"]:checked');
    return el ? el.value : 'light';
  }

  function currentViewport() {
    const el = document.querySelector('input[name="viewport"]:checked');
    return el ? el.value : '380';
  }

  function applyStage() {
    stage.dataset.theme = currentTheme();
    stage.dataset.viewport = currentViewport();
  }

  // Resolves when the mock inside the iframe has installed window.browser
  // and popup.js has had a tick to render. Replaced on every reload so
  // callers always get a Promise for the *current* reload.
  window.__harnessReady = Promise.resolve();

  // Presets whose point is an export outcome click Export for you once the
  // popup has rendered. The table lives in mock-browser.js (STATE_MAP[x]
  // .autoExport); the iframe exposes it as window.__HARNESS_STATE_MAP__.
  function autoExportFor(state) {
    try {
      const map = iframe.contentWindow && iframe.contentWindow.__HARNESS_STATE_MAP__;
      return map && map[state] && map[state].autoExport ? map[state].autoExport : null;
    } catch (_) { return null; }
  }

  function clickExportInPopup() {
    const doc = iframe.contentDocument;
    const btn = doc && doc.getElementById('exportBtn');
    if (btn && !btn.disabled) { btn.click(); return true; }
    return false;
  }

  function trackReady(state) {
    window.__harnessReady = new Promise((resolve) => {
      const handler = (ev) => {
        if (ev.data?.type === 'HARNESS_MOCK_READY') {
          window.removeEventListener('message', handler);
          // Give popup.js's init() + the first checkAndUpdateUI a tick.
          setTimeout(() => {
            const auto = autoExportFor(state);
            if (!auto) { resolve(); return; }
            const clicked = clickExportInPopup();
            logEvent(clicked ? `auto-export: clicked Export (${auto})` : 'auto-export: Export button not enabled');
            if (auto === 'rate_limit') {
              // The first click fails and popup.js re-enables the button
              // after ~500 ms; a second click inside the 2 s window trips
              // the popup's own rate limiter.
              setTimeout(() => {
                const again = clickExportInPopup();
                logEvent(again ? 'auto-export: second click' : 'auto-export: second click skipped (button disabled)');
              }, 900);
              setTimeout(resolve, 1600);
              return;
            }
            // Let the mock's response / EXPORT_RESULT broadcast land.
            setTimeout(resolve, 900);
          }, 400);
        }
      };
      window.addEventListener('message', handler);
    });
  }

  async function reloadPopup() {
    const state = stateSelect.value;
    const outcome = outcomeSelect.value;
    const theme = currentTheme();

    trackReady(state);
    const popupHtml = await originalPopupHtmlPromise;

    // Inject the mock and fixtures ahead of the shared scripts. Keep the
    // original popup.html untouched on disk.
    // An empty outcome means "whatever the preset says" (mock-browser.js
    // falls back to the preset's autoExport, then to plain success).
    const injection = [
      `<script>window.__HARNESS_STATE__ = ${JSON.stringify(state)};` +
        (outcome ? `window.__HARNESS_EXPORT_OUTCOME__ = ${JSON.stringify(outcome)};` : '') +
        `</script>`,
      `<script src="${repoRoot}dev/fixtures.js"></script>`,
      `<script src="${repoRoot}dev/mock-browser.js"></script>`
    ].join('\n');

    // Firefox's module loader ignores <base> inside srcdoc documents, so a
    // simple <base href> is not enough: popup.js would still resolve to this
    // file's directory and 404. Rewrite the four known relative references
    // in popup.html to absolute URLs. Internal imports *inside* popup.js
    // (e.g. ./config/settings.js) resolve correctly from the absolute URL.
    const absolutified = popupHtml
      .replace(/\b(src|href)="(popup\.(?:css|js)|shared\/[^"]+)"/g,
        (_, attr, p) => `${attr}="${repoRoot}${p}"`);
    const modified = absolutified.replace('<head>', `<head>\n${injection}`);

    // popup.css carries the full dark palette under `[data-force-color-scheme="dark"]`.
    // We just set the attribute; CSS does the rest. Playwright uses
    // `emulateMedia({ colorScheme })` instead and relies on the @media branch.
    const withTheme = theme === 'dark'
      ? modified.replace('<html lang="en">',
          '<html lang="en" data-force-color-scheme="dark">')
      : modified;

    iframe.srcdoc = withTheme;
    applyStage();
    logEvent(`load: ${state} / export=${outcome} / theme=${theme}`);
  }

  // Wire up controls.
  stateSelect.addEventListener('change', reloadPopup);
  outcomeSelect.addEventListener('change', reloadPopup);
  reloadBtn.addEventListener('click', reloadPopup);
  themeRadios.forEach((r) => r.addEventListener('change', reloadPopup));
  viewportRadios.forEach((r) => r.addEventListener('change', () => {
    applyStage();
    logEvent(`viewport: ${currentViewport()}px`);
  }));

  // Surface events from inside the iframe so you can see what the popup is
  // doing without opening devtools.
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || typeof d !== 'object') return;
    switch (d.type) {
      case 'HARNESS_MOCK_READY':  return logEvent(`mock ready (${d.state})`);
      case 'HARNESS_POPUP_CLOSE': return logEvent('popup requested window.close()');
      case 'HARNESS_TAB_RELOAD':  return logEvent('popup requested tabs.reload');
      case 'HARNESS_DOWNLOAD':    return logEvent(`downloads.download → ${d.details?.filename || '?'}`);
      case 'HARNESS_DOWNLOADS_SHOW': return logEvent(`downloads.show(${d.downloadId})`);
      case 'HARNESS_ICON_UPDATE': return logEvent(`action icon/title → ${d.iconState?.title || '(empty)'}`);
      default: return;
    }
  });

  // Programmatic control surface for test automation (Playwright etc.).
  // Setting values via .value/.checked bypasses the change-event listeners,
  // so we trigger exactly one reload and return a Promise for completion.
  window.__harness = {
    async setState(state, theme = 'light', outcome = '') {
      stateSelect.value = state;
      outcomeSelect.value = outcome;
      const themeInput = document.querySelector(`input[name="theme"][value="${theme}"]`);
      if (themeInput) themeInput.checked = true;
      await reloadPopup();
      return window.__harnessReady;
    },
    setViewport(width) {
      const v = String(width);
      const vInput = document.querySelector(`input[name="viewport"][value="${v}"]`);
      if (vInput) {
        vInput.checked = true;
        applyStage();
      }
    }
  };

  // First render.
  applyStage();
  reloadPopup().catch((err) => logEvent(`load failed: ${err.message}`));
})();
