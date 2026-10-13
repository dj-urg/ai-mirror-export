# Preview harness

Dev-only tooling for previewing the popup across every UI state without having
to open a real chat site. Not shipped with the extension (`dev/` is in
`web-ext-config.mjs` ignoreFiles).

## Run it

The harness is static HTML; it just needs a local HTTP server because
`fetch('../popup.html')` and the `<base>` injection need http(s), not `file://`.

From the repo root:

```bash
python3 -m http.server 8000
# or:  npx http-server -p 8000
```

Then open <http://localhost:8000/dev/harness.html>.

## What you get

- **State preset** dropdown — every state the popup can land in (supported +
  ready for each platform, loading, each error, consent gate).
- **Export outcome** dropdown — click Export in the popup; the mock resolves
  or rejects per this setting. Covers success, hang, network error, rate
  limit, no-data, generic export failure.
- **Theme** — Light / Dark (forced via `data-force-color-scheme`) / System.
- **Viewport width** — 320, 380, 600 to check the popup's responsive range.
- **Event log** — side panel shows every call the popup makes into the
  mocked `browser.*` (downloads, reload, close, icon updates).

## How it works

- `harness.html` has a sidebar of controls and an iframe for the popup.
- `harness.js` fetches `popup.html`, injects `<base href="…repo-root…">`
  plus `dev/fixtures.js` and `dev/mock-browser.js` just before `</head>`,
  then sets the modified HTML as `iframe.srcdoc`. The real `popup.html`
  on disk is never modified.
- `mock-browser.js` installs `window.browser` with just enough surface to
  satisfy `popup.js`: `tabs.{query, sendMessage, reload, onUpdated}`,
  `runtime.{id, onMessage, sendMessage, getURL, getManifest}`,
  `storage.local.{get, set, remove, clear}`, `downloads.download`,
  `action.{setIcon, setTitle, setBadgeText}`.
- `fixtures.js` holds the synthetic tab shapes and `GET_CAPTURED_CONVERSATIONS`
  responses for each state. **All data is fabricated — never put a real
  conversation here.**

## Adding a new state

1. Add a tab shape and/or response to `dev/fixtures.js`.
2. Add a `STATE_MAP` entry in `dev/mock-browser.js` describing what
   `tabs.query` returns and what `GET_CAPTURED_CONVERSATIONS` replies with.
3. Add an `<option>` to the State preset `<select>` in `dev/harness.html`.

## Playwright / axe

The harness is designed to be driven by Playwright for before/after
screenshotting and automated axe runs. See `docs/manual-tests.md` (once that
exists) for the current test matrix.

Rough recipe:

```js
// Playwright: iterate states and shoot
await page.goto('http://localhost:8000/dev/harness.html');
for (const state of STATES) {
  await page.selectOption('#statePreset', state);
  await page.waitForFunction(() => {
    const f = document.getElementById('popupFrame');
    return f?.contentDocument?.readyState === 'complete';
  });
  await page.screenshot({ path: `baselines/${state}-light.png` });
  // then flip dark theme and shoot again
}
```

## Not shipped

`web-ext-config.mjs` excludes `dev/` and `dev/**` from `web-ext build`, so
nothing in this directory ends up in the published `.xpi`.
