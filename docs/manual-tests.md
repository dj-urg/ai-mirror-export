# Manual test checklist

Automated axe + harness coverage lives in `dev/baselines/` (see `dev/README.md`);
the automated test suite and the real-data validation method are described in
`docs/validation.md`. This file lists the things only a real Firefox + a real
logged-in session on each supported site can confirm. Run everything after any
change that touches `background.js`, `platforms/**`, `manifest.json`, or icons.

**Ordered by risk for the 3.0.0 release**, highest first: §8 (Mistral, Perplexity,
DeepSeek, M365 Copilot, Google), §9 (PII end to end), §5 8a, §1, §5 8c, §10
(review step), §11 (update from 2.1.1), §4, §2.

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
| Grey icon + "not supported" title tip    | Open any non-supported site (e.g. `example.com`); hover the toolbar button. (No `tabs` permission: the icon logic relies on host permissions, so this is the case most worth checking.) |
| Colour icon + "ready to export …" tip    | Open each supported site; hover the toolbar button on each |
| Icon flips on tab switch                 | Have supported + unsupported tabs; click between them |
| Icon flips on URL change in same tab     | Navigate from supported → unsupported URL inside one tab (the URL is not delivered for the unsupported page; the icon must still turn grey) |
| Icon stays grey on mail./docs./drive.google.com | Open Gmail or Docs; the icon must be grey and the popup must say the page is not supported |
| `!` badge after a failed export          | On ChatGPT, open a brand-new empty chat, open popup, click Export; the toolbar button should show a red `!` |
| Badge clears on tab reload               | After the `!` badge is set, press Cmd/Ctrl+R on the tab; the badge should disappear |

## 2. Keyboard-only walkthrough (step 5)

Starting with focus in the URL bar, use **keyboard only**:

- Open the popup (Alt+Shift+T, or your custom shortcut)
- Focus should land on the primary action — consent checkbox on first
  install, export button on subsequent opens (it is set after the first
  status check resolves; on a slow page it may take a moment)
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
- In the add-on debugger, `browser.storage.local.get()` shows
  `consent_given: true`, `consent_version: "1"` and an ISO timestamp in
  `consent_given_at`

## 5. Error flows (steps 8a–8d)

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
  empty…"; no file should be downloaded; the status card never shows an
  internal message such as "mapping is not a plain object"

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
| Perplexity            | One export → **exactly one ZIP**; no `[DEBUG]`/`[Perplexity]` lines in the page console; `window.__perplexityExporterProbe` is undefined |
| Grok                  | Same (new in 3.0.0)                                                    |
| DeepSeek              | Start a **brand-new chat**, send one message, wait for the reply, open the popup → Ready; Export → the ZIP contains both messages. Also an agent other than `chat` if available |
| Mistral               | **Compare the ZIP with what is on screen:** every message present in order; `text` of an assistant turn equals the rendered answer (not a draft with `search-result://` placeholders, not the reasoning); reasoning only in `reasoning_text` |
| M365 Copilot          | Same — uses WebSocket interception, not fetch hooks; no synthetic fixture and no raw-capture validation yet (HARs do not include WebSocket frames; use a proxy to capture) |
| Google Search AI      | Run a query that triggers an AI Overview; open popup; Export. In the Network tab, the search URL is requested **at most once** by the extension, and not again while the popup stays open |
| Google AI Mode        | `?udm=50` tab; ask a question; wait for the reply; Export. ZIP and file names carry the query, not `unknown`; no re-request of the search URL in the Network tab |
| Grok                  | ZIP and file names carry the conversation id, not `unknown`            |

In every case, open the resulting ZIP and sanity-check: the metadata CSV
has one row; the messages CSV row count matches what you can count in
the UI (per content block for Claude; every branch for ChatGPT and
Claude, with `on_visible_path` marking the visible thread); every CSV
ends with CRLF; the manifest's `extractor_version` is `3.0.0` and each
`files[]` entry has a `schema_version`.

## 9. PII scrubbing end to end

- On Claude, send a message containing a planted email, phone number, IP
  address and an `sk-`-style token; upload a small .txt file containing
  the email; ask a question that triggers web search
- Turn on "Remove sensitive data", export, and open **every** file in
  the ZIP: none of the planted values may appear in `claude_messages`,
  `claude_messages_canonical`, `claude_sources`, `claude_attachments`
  (`extracted_text` and `raw_json`), `raw_block_json`, `tool_input_json`
  or the manifest; `<REDACTED:…>` placeholders appear instead and
  `telemetry.pii_redactions_by_type` lists EMAIL, PHONE, IP and TOKEN
- Export again with scrubbing off: the values are present (this is the
  "plain" export the validation toolkit compares against)
- Repeat the scripted test with the external capture-validation toolkit
  on this build (see `docs/validation.md`, "Re-validation checklist"):
  expected PII PASS, and the new `thinking_summary`, `thinking_mode` and
  `on_visible_path` columns present

## 10. Review-your-export step

- Export on any platform → after "Export complete." a green "Review your
  export" card appears with "Open the ZIP and check what's in it before
  sharing it." and focus on **Show in Downloads**
- Click it → Firefox's Downloads panel/window opens with the ZIP selected
- Enter a study code in Privacy settings, export again → the copy ends
  "…before sharing it with the researcher."
- The popup stays open (no auto-close) until you close it

## 11. Update from 2.1.1

- In a profile with 2.1.1 installed, install the 3.0.0 .xpi over it
- Firefox shows a permission prompt listing the `scripting` permission and
  the new hosts; **no** "Access browser tabs" warning
- Accept → the extension updates and works; decline → note what Firefox
  does (expected: the update is blocked and 2.1.1 stays installed) and
  record it in `docs/validation.md`
