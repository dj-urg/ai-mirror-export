# AMO reviewer notes — AI Chat Exporter 3.1.0

Paste everything below the line into the "Notes for reviewer" field when
submitting the 3.1.0 build on AMO. The first two sections are what changed
since 3.0.0; the rest is unchanged from the 3.0.0 notes and kept for
reference.

---

## What changed since 3.0.0

3.1.0 adds one supported site, Google Gemini, and nothing else that needs
a new permission.

- **One new host permission:** `https://gemini.google.com/*`. The other
  permissions (`activeTab`, `downloads`, `storage`, `scripting`) and the
  other host permissions are the same as in 3.0.0. `tabs` is still not
  requested.
- **One new content script:** `platforms/gemini/content.js`, matched on
  `https://gemini.google.com/*` at `document_start`. It runs in the
  isolated world only. There is no MAIN-world inject script and no
  `window.fetch`, `XMLHttpRequest` or WebSocket hook for Gemini.
- **No new network destination.** The Gemini content script talks only
  to `gemini.google.com`, same-origin (details below).
  `data_collection_permissions` is still `"none"`.
- **Fixes in local code:** the popup's Export button works again after
  an export, and the optional PII scrubber now also covers the query
  string of URLs in the export. Both run entirely in the browser.

## Google Gemini — how the content script reads a conversation

Gemini keeps conversation history behind its private `batchexecute` RPC
(`hNvQHb`), not a REST endpoint, and renders replies without
re-requesting the history. `platforms/gemini/content.js` therefore
requests the open conversation through that RPC itself, page by page
(at most 200 pages, each request aborted after 20 seconds). The request
goes to the same origin (`/_/BardChatUi/data/batchexecute`) with
`credentials: 'same-origin'`, so it carries only the cookies the user's
Gemini session already has. Nothing is sent to any other host.

When it runs: when a conversation page opens (including in-app
navigation between conversations), and again at **every** export, so
turns sent after the page loaded are included. Once a conversation has
been read, the popup's status check sends no further request for it.

**Gemini token handling.** The RPC rejects requests without the page's
XSRF token, so `readPageConfig` (`platforms/gemini/content.js`, line
173) reads the token Gemini itself embeds in the page HTML (`SNlM0e`),
together with the build label (`cfb2h`) and session id (`FdrFJe`). If
the build label or session id are not in the HTML yet, it reads them
from the URL of a `batchexecute` request Gemini has already made, via
`performance.getEntriesByType('resource')` (line 190). The token is
posted back to the same origin as the `at` form field of that one
request (line 313), the same way Gemini's own page sends it. It is read
fresh for each request and is never stored, logged, exported or sent
anywhere else. This mirrors the DeepSeek bearer-token handling described
below.

## Why the `scripting` permission is needed (unchanged since 3.0.0)

Used in `background.js` (the `ensurePerplexityContentScripts` block, line 1514, and the `tabs.onUpdated` injector inside it, line 1559) for Perplexity only. Two call sites:

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

Because the same files can therefore reach a page up to three times
(manifest, registered script, executeScript), both Perplexity files are
idempotent: `platforms/perplexity/inject.js` (line 24) returns early
when a non-enumerable `__aiChatExporterPerplexityInjectInstalled` flag
is already set on `window`, and `platforms/perplexity/content.js` (line
20) does the same in its isolated-world global. A second evaluation
therefore wraps nothing and registers no second listener.

**Root cause status: not fully identified.** The code comment above
`ensurePerplexityContentScripts` notes that the manifest entries for
Perplexity did not reliably take effect in some Firefox builds during
development, although structurally identical entries work for every
other platform. Which Firefox version(s) show it has not been isolated.

**Reproduction notes** for anyone trying to isolate the underlying bug:

1. `./node_modules/.bin/web-ext run --firefox=/path/to/firefox` from
   the repo root
2. Visit <https://www.perplexity.ai/> in the launched profile; sign in
3. Open a thread
4. In the page devtools console, check
   `Object.getOwnPropertyDescriptor(window, '__aiChatExporterPerplexityInjectInstalled')`
   — undefined means the MAIN-world hook did not install
5. Also check `window.fetch.toString().startsWith('async function')` —
   if false, the inject-world fetch hook isn't installed either

The `scripting` permission can be dropped from a future release once the
root cause is identified and the manifest entry fixed.

## Google Search access — why ten locale hosts (unchanged since 3.0.0)

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
page's DOM. When a classic AI Overview is not in the live DOM it
re-requests the same search URL the user is viewing (a same-origin
`fetch` with the user's own cookies) to read the server-rendered HTML,
**at most once per page and query** (`platforms/google_search/content.js`,
`fetchAttempted`, line 519) and never from the popup's status poll; AI
Mode is never re-requested. There is no `window.fetch` hook on Google.

## Network behaviour — nothing leaves the browser

The popup and background make **no network calls at all**: the Content
Security Policy for extension pages is `connect-src 'none'`, which blocks
`fetch` and `XMLHttpRequest` there. Content scripts talk only to the
site they run on, over the user's existing session: on claude.ai,
chat.deepseek.com, grok.com and chat.mistral.ai the content script
re-fetches the conversation the user has open from the site's own
conversation API when the passive hook has not seen it yet (page load,
in-app navigation, popup open, export); on gemini.google.com it uses the
site's own `hNvQHb` history RPC as described above; on Google it
re-requests the current search page as described above. Nothing is ever
sent to any third party. Processing is entirely local, and the ZIP is
written to the user's own Downloads folder via
`browser.downloads.download` with a local blob URL.

**DeepSeek token handling.** DeepSeek's `/api/v0/chat/history_messages`
endpoint rejects cookie-only requests, so
`platforms/deepseek/content.js` reads the bearer token DeepSeek itself
stores in the page's `localStorage` (`userToken`; `readUserToken`, line
146) and attaches it to that one same-origin request (line 215). The
extension repeats the site's own request with the site's own credential;
the token is never stored, logged, exported or sent anywhere else. The
request is made when a chat page opens, when the user exports, and while
the popup is open on a chat page, because DeepSeek streams new replies
without re-requesting its history. The open popup checks the page every
2 seconds: once the conversation has been read, the request is repeated
at most once every 30 seconds; until then (a new chat with no saved
messages yet, or after a failed request) every check repeats it.

`data_collection_permissions` is set to `"none"`.

## `window.fetch` and WebSocket hooks — what they do

Most supported platforms hook the host site's own transport so the
extension sees the conversation data the user is already loading. The
hooks themselves are read-only observers; they do not modify requests,
do not retry, do not fetch anything new. (The same-origin re-fetches
listed under "Network behaviour" are made by the content scripts, not
by the hooks. Gemini and Google Search have no hook: Gemini re-fetches
through the site's own RPC, and Google Search reads the rendered page.)

- `platforms/{chatgpt, claude, copilot, perplexity, grok, deepseek,
  mistral}/inject.js` — hook `window.fetch` (and, for claude, perplexity,
  grok, deepseek and mistral, also `XMLHttpRequest`) on
  conversation-API responses. The hook runs in the MAIN world (page
  context) and forwards the response bodies via HMAC-SHA256-signed
  `postMessage` to the ISOLATED-world content script, which validates
  the signature, a 30-second timestamp window and a once-only nonce
  (replays are rejected; `shared/message-security.js` line 187 and the
  per-platform content scripts) before accepting. The shared
  `window.MessageSecurity` API is defined once, read-only and
  non-enumerable. The content script also accepts a message only from the
  same window and origin, which keeps out messages from other frames and
  other origins. This does not protect against JavaScript running on the
  chat page itself: the site's own scripts, or anything else injected
  into that page, can produce messages the content script accepts.
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
- `platforms/gemini/content.js` — no inject hook; see "Google Gemini"
  above.

## Where the source lives

- Mozilla AMO version is cryptographically signed by Mozilla, so what
  users install matches what you review.
- Development history: <https://github.com/dj-urg/ai-mirror-export>
  (tag `v3.1.0` on `main` for this release; the extractor version in
  every export equals the add-on version).
- The source submitted matches the GitHub tree 1:1 — no bundler, no
  minifier, no build-time code generation. The `web-ext build` output
  is exactly the files on disk minus `dev/`, `docs/`, `testing/`,
  `test/`, `node_modules/`, `.github/`, the root Markdown files and
  config files (full ignore list in `web-ext-config.mjs`).

## Preview status

The listing identifies this release as a **Development Preview**. The
popup carries both a permanent "Preview" tag in the header and a
dismissible "Development Preview" banner on first open; dismissal is
persisted locally per install. Users are informed upfront that this is
beta software.
