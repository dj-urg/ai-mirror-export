# Preview harness

Dev-only tooling for previewing the popup across every UI state without having
to open a real chat site. Not shipped with the extension (`dev/` is in
`web-ext-config.mjs` ignoreFiles).

## Run it

The harness is static HTML; it just needs a local HTTP server because
`fetch('../popup.html')` and the `<base>` injection need http(s), not `file://`.

From the repo root:

```bash
python3 -m http.server 8766
# or:  npx http-server -p 8766
```

Then open <http://localhost:8766/dev/harness.html>.

## What you get

- **State preset** dropdown — every state the popup can land in: ready and
  idle for each of the nine platforms, loading, each error, sign-out, the
  consent gate, and the export outcomes (those presets click Export for
  you, including the review-your-export step with and without a study
  code).
- **Export outcome** dropdown — click Export in the popup; the mock answers
  per this setting: success, success confirmed by background, hang, network
  error, missing content script, no data, generic failure, the four
  background outcomes (download failed, processing failed, empty, invalid)
  and the popup's own rate limiter.
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
  `runtime.{id, onMessage, sendMessage, getURL, getManifest}` (the
  `onMessage` listeners are kept so the mock can deliver `EXPORT_RESULT`
  broadcasts), `storage.local.{get, set, remove, clear}`,
  `downloads.{download, show}`, `action.{setIcon, setTitle, setBadgeText}`.
- `fixtures.js` holds the synthetic tab shapes and `GET_CAPTURED_CONVERSATIONS`
  responses for each state. **All data is fabricated — never put a real
  conversation here.**

## Adding a new state

1. Add a tab shape and/or response to `dev/fixtures.js`.
2. Add a `STATE_MAP` entry in `dev/mock-browser.js` describing what
   `tabs.query` returns and what `GET_CAPTURED_CONVERSATIONS` replies with.
3. Add an `<option>` to the State preset `<select>` in `dev/harness.html`.

## Playwright / axe

`dev/baseline.mjs` drives the harness with Playwright (Firefox only):
every state × light/dark, one PNG and one axe report per combination, plus
the status-card text, review-card copy and focused element in each
`.axe.json`. Run `npm run baseline -- --label <name>` and
`npm run baseline:compare -- <before> <after>`; the run exits non-zero if
any capture produced no axe result.

Rough recipe:

```js
// Playwright: iterate states and shoot
await page.goto('http://localhost:8766/dev/harness.html');
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

## Secret scanning (gitleaks)

CI runs [gitleaks](https://github.com/gitleaks/gitleaks) over the full
history on every push and pull request (`.gitleaks.toml` allowlists only the
synthetic inputs in `testing/tests/test_pii.js`). To catch a slip before it
is committed, install gitleaks (`brew install gitleaks`) and add a
pre-commit hook:

```bash
cat > .git/hooks/pre-commit <<'HOOK'
#!/bin/sh
exec gitleaks git --pre-commit --staged --redact --config .gitleaks.toml --no-banner
HOOK
chmod +x .git/hooks/pre-commit
```

The hook scans only the staged changes and prints redacted findings.
Captures (HAR files, real-origin fixtures) must never be staged in the
first place; see `.gitignore`.

## Not shipped

`web-ext-config.mjs` excludes `dev/` and `dev/**` from `web-ext build`, so
nothing in this directory ends up in the published `.xpi`.
