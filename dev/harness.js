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

  async function reloadPopup() {
    const state = stateSelect.value;
    const outcome = outcomeSelect.value;
    const theme = currentTheme();

    const popupHtml = await originalPopupHtmlPromise;

    // Inject the mock and fixtures ahead of the shared scripts. Keep the
    // original popup.html untouched on disk.
    const injection = [
      `<base href="${repoRoot}">`,
      `<script>window.__HARNESS_STATE__ = ${JSON.stringify(state)};` +
        `window.__HARNESS_EXPORT_OUTCOME__ = ${JSON.stringify(outcome)};</script>`,
      `<script src="dev/fixtures.js"></script>`,
      `<script src="dev/mock-browser.js"></script>`
    ].join('\n');

    // The popup's <head> ends with the stylesheet; append our injection just
    // before </head> so the mock is defined before shared/logger.js runs.
    const modified = popupHtml.replace('</head>', `${injection}\n</head>`);

    // When the dark theme is forced, add a stylesheet override that bypasses
    // the host media query. Once the popup adds a real `prefers-color-scheme`
    // rule set, this hook lets us preview it without changing OS settings.
    const withTheme = theme === 'dark'
      ? modified.replace('</head>', `<style>:root { color-scheme: dark; }
        html[data-force-color-scheme="dark"] { color-scheme: dark; }</style>
        <script>document.documentElement.setAttribute('data-force-color-scheme','dark');</script>
        </head>`)
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
      case 'HARNESS_ICON_UPDATE': return logEvent(`action icon/title → ${d.iconState?.title || '(empty)'}`);
      default: return;
    }
  });

  // First render.
  applyStage();
  reloadPopup().catch((err) => logEvent(`load failed: ${err.message}`));
})();
