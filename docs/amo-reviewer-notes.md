# AMO reviewer notes — AI Chat Exporter 3.0.0

### Why the `scripting` permission is needed

Used in `background.js` (the `ensurePerplexityContentScripts` block near line 1360 and the `tabs.onUpdated` injector that follows it) for Perplexity only. Two call sites:

1. `scripting.registerContentScripts` at background startup — re-registers
   the Perplexity content scripts via the scripting API as a fallback
   because the manifest `content_scripts` entries don't reliably take
   effect on perplexity.ai (was observed during development).
2. `scripting.executeScript` on `tabs.onUpdated(status: 'loading')` for
   perplexity.ai URLs — belt-and-suspenders tab-navigation injector.

Both call sites only inject files that are already declared in the
manifest's `content_scripts` array (`shared/message-security.js`,
`platforms/perplexity/inject.js`, `platforms/perplexity/content.js`).
No file is fetched from the network; no code is generated at runtime.

**Root cause status: not fully identified.** The code comment at
`background.js:1357` notes "manifest content_scripts entries for
Perplexity do not reliably take effect in some Firefox builds, even
though structurally identical entries work for every other platform."
Which Firefox version(s) show it and a reduced test case have not been
isolated. The `scripting` fallback is a defensive measure that has
worked reliably in dogfood use.

**Reproduction notes** for anyone trying to isolate the underlying bug:

1. `./node_modules/.bin/web-ext run --firefox=/path/to/firefox` from
   the repo root
2. Visit <https://www.perplexity.ai/> in the launched profile; sign in
3. Open a thread
4. In the page devtools console, check:
   `document.documentElement.getAttribute('data-perplexity-exporter-content-loaded')`
   — a null result means the content script didn't inject
5. Also check `window.fetch.toString().startsWith('async function')` —
   if false, the inject-world fetch hook isn't installed either

The `scripting` permission can be dropped from a future release once the
root cause is identified and the manifest entry fixed. Tracked in
`docs/ux-audit.md` §10.



Paste the `scripting` section above and the sections below into the "Notes for
reviewer" field when submitting the 3.0.0 build on AMO. They explain what's new and why the elevated
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
  `<platform>_manifest_…json` sidecar (checksums, schema versions, HMAC
  donor-ID pseudonymisation when a study salt is set). Replaces the previous
  single-CSV download.
- **UX overhaul:** dark theme (`prefers-color-scheme: dark`), WCAG 2.2 AA
  keyboard + focus pass, a "Review your export" step after the download
  (with a "Show in Downloads" button that calls `downloads.show`),
  Development Preview banner + tag, trust footer, "What's in the file?"
  section describing the ZIP contents.
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
Images, account settings). `host_permissions` is currently listed as
`/*` rather than `/search*`; the content script is what restricts
activity to search pages. Narrowing the host pattern is planned.

No new search queries are sent to Google by the extension. The content
script observes the user's **own already-performed** search in the
page's DOM. When the AI Overview renders late it re-requests the same
search URL the user is viewing (a same-origin `fetch` with the user's
own cookies) to read the server-rendered HTML. There is no `window.fetch`
hook on Google.

## Network behaviour — nothing leaves the browser

The popup and background make **no network calls at all**: the Content
Security Policy for extension pages is `connect-src 'none'`, which blocks
`fetch` and `XMLHttpRequest` there. Content scripts talk only to the
site they run on, over the user's existing session: on claude.ai,
chat.deepseek.com, grok.com and chat.mistral.ai the content script
re-fetches the conversation the user has open from the site's own
conversation API when the passive hook has not seen it yet (page load,
in-app navigation, popup open, export); on Google it re-requests the
current search page as described above. Nothing is ever sent to any
third party. Processing is entirely local, and the ZIP is written to
the user's own Downloads folder via `browser.downloads.download` with a
local blob URL.

`data_collection_permissions` is set to `"none"`.

## `window.fetch` and WebSocket hooks — what they do

Every supported platform hooks the host site's own transport so the
extension sees the conversation data the user is already loading. The
hooks themselves are read-only observers; they do not modify requests,
do not retry, do not fetch anything new. (The same-origin re-fetches
listed under "Network behaviour" are made by the content scripts, not
by the hooks.)

- `platforms/{chatgpt, claude, copilot, perplexity, grok, deepseek,
  mistral}/inject.js` — hook `window.fetch` (and, for claude, perplexity,
  grok, deepseek and mistral, also `XMLHttpRequest`) on
  conversation-API responses. The hook runs in the MAIN world (page
  context) and forwards the response bodies via HMAC-SHA256-signed
  `postMessage` to the ISOLATED-world content script, which validates
  the signature and a 30-second timestamp window before accepting (see
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
  `/search?q=…&…` URL when the overview renders late (same-origin).

## Where the source lives

- Mozilla AMO version is cryptographically signed by Mozilla, so what
  users install matches what you review.
- Development history: <https://github.com/dj-urg/AI-Dialogue-Insight-Extension>
  (branch `release/3.0.0` for this release).
- The source submitted matches the GitHub tree 1:1 — no bundler, no
  minifier, no build-time code generation. The `web-ext build` output
  is exactly the files on disk minus `dev/`, `docs/`, `testing/`,
  `test/`, `node_modules/`, `.github/`, the root Markdown files,
  `updates.json`, and config files (full ignore list in
  `web-ext-config.mjs`).

## Preview status

The listing identifies this release as a **Development Preview**. The
popup carries both a permanent "Preview" tag in the header and a
dismissible "Development Preview" banner on first open; dismissal is
persisted locally per install. Users are informed upfront that this is
beta software.
