# Manual test checklist

Automated axe + harness coverage lives in `dev/baselines/` (see `dev/README.md`).
This file lists the things only a real Firefox + a real logged-in session on
each supported site can confirm. Run everything after any change that touches
`background.js`, `platforms/**`, `manifest.json`, or icons.

## Setup

```bash
# One-time per clone
npm install
npx playwright install firefox   # for `npm run baseline`

# Each session
npm run baseline -- --label before      # if you're about to change anything
./node_modules/.bin/web-ext run         # launches Firefox with the extension
# -> opens about:debugging#/runtime/this-firefox automatically
```

`web-ext run` opens a dedicated Firefox profile and loads the extension at
`manifest.json`. Pin the toolbar button so you can see icon state changes
during tab switches.

## 1. Icon states (step 6)

| Expected                                 | How to confirm                                   |
|------------------------------------------|--------------------------------------------------|
| Grey icon + "not supported" title tip    | Open any non-supported site (e.g. `example.com`); hover the toolbar button |
| Colour icon + "ready to export …" tip    | Open each supported site; hover the toolbar button on each |
| Icon flips on tab switch                 | Have supported + unsupported tabs; click between them |
| Icon flips on URL change in same tab     | Navigate from supported → unsupported URL inside one tab |
| `!` badge after a failed export          | On ChatGPT, open a brand-new empty chat, open popup, click Export; the toolbar button should show a red `!` |
| Badge clears on tab reload               | After the `!` badge is set, press Cmd/Ctrl+R on the tab; the badge should disappear |

## 2. Keyboard-only walkthrough (step 5)

Starting with focus in the URL bar, use **keyboard only**:

- Open the popup (Alt+Shift+T, or your custom shortcut)
- Focus should land on the primary action — consent checkbox on first
  install, export button on subsequent opens
- Tab through every control; order should be: platform badge → status card
  (if focusable) → file list → privacy settings disclosure → export button
  → about disclosure → footer links
- Each focused control should show a visible outline (not just a shadow)
- `Esc` should close the popup immediately
- `Esc` while focus is inside the study-code input should blur the input
  only (not close the popup)
- `Enter` on the privacy settings `<summary>` should open it; `Enter` again
  should close it

## 3. Dark theme parity (step 4)

- Switch Firefox to a dark theme (Preferences → Appearance → Dark)
- Open the popup on each supported site; everything should render in the
  dark palette: dark surfaces, lighter blue accent, bright-but-not-garish
  text
- All status cards (success / warning / error / loading / info) should
  pass visual legibility in both themes
- The Preview tag should stay orange-on-dark-orange; the Dev Preview
  banner should match

## 4. First-run flow (step 7)

Fresh profile only:

```bash
# force a fresh profile — do NOT run on your real one
./node_modules/.bin/web-ext run --firefox-profile=/tmp/wix-ext-fresh --profile-create-if-missing
```

- Click the toolbar button → consent panel renders (not the main UI)
- Focus should be on the consent checkbox
- Dev Preview banner should be visible above the consent panel
- Dismiss the banner → it should stay dismissed on subsequent opens
- Agree + continue → main UI opens; focus should move to export button
- Close the popup; reopen → main UI opens directly, no consent gate

## 5. Error flows (steps 8a–8e)

### Download / ZIP failure (8a)
Hard to reproduce reliably; close enough:
- In `about:config`, set `browser.download.folderList = 2` and point
  `browser.download.dir` at a read-only directory
- Export; popup should show "Download failed. …" instead of a stuck
  spinner; toolbar `!` badge should appear

### Empty export (8b)
- Open a brand-new ChatGPT chat with no messages yet
- Click Export
- Popup should show "No messages to export. This conversation looks
  empty…"; no file should be downloaded

### Auth failure (8c) — Claude only, option 2 coverage
- Open `claude.ai`, sign out via Claude's menu
- Reload the chat page
- Open the popup → should show "Please sign in to Claude to continue."
  with a red error card; export button disabled
- Close the popup
- Sign back in on the Claude tab
- Reopen the popup → should re-check and show the normal "Ready to
  export" state

### Stuck-state copy (8d)
- Open a supported-site tab that hasn't finished loading
- Open the popup within the first 15 s → should show
  "Capturing conversation data…" with the elapsed counter once past 3 s
- Wait past 15 s → copy should flip to "Still waiting on this page. …"
  with mechanism-specific wording:
  - ChatGPT/Claude/Copilot: "Reload the tab in your browser, then
    reopen this popup."
  - Google: "Close this popup, wait a second or two, then reopen it."

### Large-export confirm (8e)
- Open a ChatGPT conversation with more than 500 messages (or lower the
  threshold in `popup.js` temporarily)
- Click Export → the in-popup confirm card should appear (no
  `window.confirm` dialog)
- `Esc` or Cancel should dismiss; "Export anyway" should proceed

## 6. Trust surface sanity (step 7)

- Open the popup for the first time (fresh profile)
- Dev Preview banner is visible, with a working dismiss (×)
- "Preview" tag in the header is visible and stays after dismissal
- Footer reads "Your data stays on your device." + "Nothing is sent to
  any server. Files are saved to your Downloads folder."
- Expand About → "What's in the file?" lists the ZIP filename pattern +
  the four core CSVs with definitions

## 7. Build + lint parity

Every time before committing:

```bash
npm run lint:web-ext            # extension-level lint; must be 0/0/0
npm run baseline -- --label after
npm run baseline:compare -- before after   # delta must be <= 0
./node_modules/.bin/web-ext build --overwrite-dest --artifacts-dir /tmp/xpi
unzip -l /tmp/xpi/*.zip | grep -E "dev/|docs/|node_modules|package" \
  && echo "LEAK — fix web-ext-config.mjs ignoreFiles" \
  || echo "No dev-only files in .xpi"
```

## 8. Per-platform smoke test

Minimum, after any `platforms/**` change:

| Platform              | Steps                                                                  |
|-----------------------|------------------------------------------------------------------------|
| ChatGPT               | Open an existing chat → popup → Export → ZIP downloads with 3–5 CSVs   |
| Claude                | Same shape                                                             |
| Copilot               | Same                                                                   |
| Perplexity            | Same (new in 3.0.0)                                                    |
| Grok                  | Same (new in 3.0.0)                                                    |
| DeepSeek              | Same (new in 3.0.0)                                                    |
| Mistral               | Same (new in 3.0.0)                                                    |
| M365 Copilot          | Same — note this one uses WebSocket interception, not fetch hooks      |
| Google Search AI      | Run a query that triggers an AI Overview; open popup; Export           |
| Google AI Mode        | `?udm=50` tab; ask a question; wait for the reply; Export              |

In every case, open the resulting ZIP and sanity-check: `metadata.csv`
has at least one row; `messages.csv` row count matches what you can
count in the UI; `_manifest.json` has a `schema_versions` block.
