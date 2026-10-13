# AMO reviewer notes — AI Chat Exporter 3.0.0

Paste the sections below into the "Notes for reviewer" field when submitting
the 3.0.0 build on AMO. They explain what's new and why the elevated
permissions are needed.

## What this release adds

- **Six new supported platforms:** Perplexity, Grok, Microsoft 365 Copilot,
  DeepSeek, Mistral, and **Google Search AI Overview / AI Mode**.
- **New permissions:**
  - `tabs` — the popup needs the active tab's URL to decide which platform
    is on screen and whether the toolbar icon should be colour or grey.
  - `scripting` — some Perplexity rollouts don't honour the manifest
    `content_scripts` entry at tab-navigation time; `scripting.executeScript`
    at `tabs.onUpdated(loading)` is the belt-and-suspenders fallback. It
    only ever injects the same shipped files already declared in the
    manifest; it doesn't fetch anything from the network.
  - **10 Google locale host permissions** (`.com, .be, .nl, .fr, .de, .co.uk,
    .es, .it, .ca, .com.au`). See §Google below for the full justification.
- **ZIP export format:** every export is now a ZIP of CSVs plus a
  `_manifest.json` sidecar (checksums, schema versions, HMAC donor-ID
  anonymization when a study salt is set). Replaces the previous
  single-CSV download.
- **UX overhaul:** dark theme (`prefers-color-scheme: dark`), WCAG 2.2 AA
  keyboard + focus pass, in-popup confirmation card (replaces
  `window.confirm`), Development Preview banner + tag, trust footer,
  "What's in the file?" section describing the ZIP contents.
- **Error handling:** downloads/ZIP failures, empty exports, Claude 401
  (auth) failures, and timeouts now surface specific messages instead of
  hung spinners. Toolbar `!` badge when the most recent export on a tab
  failed.

## Google Search access — why ten locale hosts

Google serves AI Overview and AI Mode responses from locale-specific
domains (`www.google.de`, `www.google.fr`, etc.); the content differs by
locale even for the same query. The ten locales cover the European +
English-speaking populations the extension's research-study use case
targets. The content script's `matches` is restricted to `/search*` paths
only — the extension does nothing on the rest of Google (Maps, News,
Images, account settings). `host_permissions` is listed broader than
`matches` so background's optional re-fetch of the user's own search
page (to recover AI Overview text that renders late) can run.

No search queries are sent to Google by the extension. The extension
observes the user's **own already-performed** search results in the
page's DOM; the `window.fetch` hook mirrors the fetches the page itself
makes.

## Network behaviour — nothing leaves the browser

The extension makes **zero outbound network calls at runtime**. The
Content Security Policy for extension pages is
`connect-src 'none'`, which blocks `fetch` and `XMLHttpRequest` from the
popup and background. Processing is entirely local, and the ZIP is
written to the user's own Downloads folder via `browser.downloads.download`
with a local blob URL.

`data_collection_permissions` is set to `"none"`.

## `window.fetch` and WebSocket hooks — what they do

Every supported platform hooks the host site's own transport so the
extension sees the conversation data the user is already loading. These
hooks are read-only observers; they do not modify requests, do not
retry, do not fetch anything new.

- `platforms/{chatgpt, claude, copilot, perplexity, grok, deepseek,
  mistral}/inject.js` — hook `window.fetch` and `XMLHttpRequest` on
  conversation-API responses. The hook runs in the MAIN world (page
  context) and forwards the response bodies via HMAC-SHA256-signed
  `postMessage` to the ISOLATED-world content script, which validates
  the signature + nonce before accepting (see
  `shared/message-security.js`). This stops other page scripts (ad
  trackers, unrelated extensions, userscripts) from forging fake
  conversation data into exports.
- `platforms/m365_copilot/inject.js` — hooks the `WebSocket`
  constructor's `send` and `message` events because M365 Copilot
  streams responses over WebSocket rather than HTTP. Same signed-
  postMessage path to the content script. **This is novel for this
  extension; if you'd like a demo capture, I'm happy to send a
  synthetic WebSocket frame log.**
- `platforms/google_search/content.js` — no inject hook; Google
  renders the AI Overview as HTML, so the content script reads it from
  the DOM via a chain of CSS selectors + ARIA labels (fallbacks for
  layout drift). Opportunistically re-fetches the user's own
  `/search?q=…&…` URL when the overview renders late (hence the broader
  `host_permissions`).

## Where the source lives

- Mozilla AMO version is cryptographically signed by Mozilla, so what
  users install matches what you review.
- Development history: <https://github.com/dj-urg/AI-Dialogue-Insight-Extension>
  (branch `ux-audit-pass` for this release).
- The source submitted matches the GitHub tree 1:1 — no bundler, no
  minifier, no build-time code generation. The `web-ext build` output
  is exactly the files on disk minus `dev/`, `docs/`, `node_modules/`,
  `.github/`, and config files (full ignore list in
  `web-ext-config.mjs`).

## Preview status

The listing identifies this release as a **Development Preview**. The
popup carries both a permanent "Preview" tag in the header and a
dismissible "Development Preview" banner on first open; dismissal is
persisted locally per install. Users are informed upfront that this is
beta software.
