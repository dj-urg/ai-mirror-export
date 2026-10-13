# UX audit — AI Chat Exporter

**Date:** 2026-10-13
**Branch:** `ux-audit-pass`
**Scope:** popup, toolbar icon, injected UI (none), notifications (none).
**Baseline:** `v2.1.1` on AMO (`0878abd`) + the uncommitted WIP on `main`
(adds Google Search, `tabs` permission, new util modules, Claude extractor).

This document is the output of a five-lens parallel audit (surface inventory,
accessibility, UX flows, visual + Firefox-native fit, copy + trust) plus the
synthesis into an ordered implementation plan. Each finding has a `file:line`
anchor and a severity: **blocker** (ships broken for a user class), **major**
(noticeable barrier), or **minor** (polish).

---

## 1. Methodology

Five independent subagents reviewed the working tree:

| Lens | What they looked at |
|------|---------------------|
| Surface map | every rendered UI (popup, options, injected, badges, icon states, notifications) |
| Accessibility | keyboard, focus, labels, contrast, motion, aria-live, semantics |
| UX flows & states | per-platform flows and every error/empty state |
| Visual + Firefox-native | design tokens, dark theme, popup fit, icon states, injected UI isolation |
| Copy & trust | user-facing strings, permissions justification, preview-status honesty |

Findings were cross-checked (several agents flagged the same issue from
different angles — those are prioritised higher).

Baselines are captured against the preview harness at `dev/harness.html` via
`dev/baseline.mjs` on Firefox (never Chromium — the popup depends on
`-moz-system-ui` and Firefox-specific form control rendering).

---

## 2. UI surface inventory

**One user-facing surface: the browser-action popup.** No options page, no
injected UI on host sites, no browser notifications, a single static toolbar
icon with no state changes.

| Surface | File | States |
|---------|------|--------|
| Popup | `popup.html`, `popup.js`, `popup.css` | 15+ (see §4) |
| Options page | — | does not exist (`manifest.json` has no `options_ui`) |
| Injected UI | — | none; `platforms/*/content.js` + `inject.js` intercept data only, no DOM injection |
| Toolbar icon | `manifest.json:132–138` | single `icon.png` at 48px, same for every state, no `setIcon`/`setBadgeText`/`setTitle` calls in `background.js` |
| Notifications | — | zero uses of `browser.notifications.*` |
| Downloads | `background.js:701` | `browser.downloads.download` triggers; no completion notification |
| First-run gate | `popup.html:58–101`, `popup.js:1683–1730` | consent panel with checkbox + agree button; dismissible once, cannot be re-shown |

Latent surface: `confirmLargeExport()` at `popup.js:1318` uses a native
`window.confirm()` — the only control flow outside the popup's own visual
system.

---

## 3. Findings

### 3.1 Blockers

| # | Issue | File:line | Lens |
|---|-------|-----------|------|
| B1 | **Download / ZIP failures surface as a hung spinner forever.** `browser.downloads.download` and the ZIP builder's errors are swallowed into `_console.error()`; no message is sent back to the popup. User sees "Exporting…" indefinitely. | `background.js:701–710` | UX |
| B2 | **Zero-row exports complete silently.** When the conversation has no messages, the ZIP ships with header-only CSVs. The popup shows "Export complete!" and the user has no idea the file is empty. | `background.js:288, 297, 652–655`, `popup.js:1479–1481` | UX |
| B3 | **Auth failures are invisible.** 401 from the Claude API, missing cookies on Copilot, logged-out ChatGPT — all collapse into generic "Reload the page" after 15 s. Users have no way to know they need to log in. | `claude/content.js:223–229`, `background.js:477–480` | UX |
| B4 | **"Development Preview" is not visible in-popup.** README says it, AMO listing may say it, but every user-facing surface in the extension itself is silent. Non-technical research participants have no cue that this is beta software. | `popup.html` (absent), `manifest.json:15` | Copy |
| B5 | **ZIP filename pattern + CSV columns are undiscoverable.** The popup announces "1 file will be downloaded" but the ZIP contains 2–5 CSVs the user has never seen described. Column schemas live only in README.md. | `popup.html:168–179`, no CSV docs in-popup | Copy |
| B6 | **Study-code input has no `label[for=…]` association and no focus styling.** Inline `style="…"` with `border:1px solid #ccc` means focus is browser-default on all surfaces, barely visible on light. | `popup.html:227–231` | A11y |
| B7 | **`outline: none` in seven places with only `box-shadow` for the focus affordance.** If any extension or OS setting suppresses box-shadow (e.g., Windows High Contrast), focus becomes invisible. | `popup.css:238, 727, 755, 943, 1092` + two more | A11y |

### 3.2 Major

| # | Issue | File:line | Lens |
|---|-------|-----------|------|
| M1 | **No dark theme.** Zero `prefers-color-scheme: dark` rules anywhere. A Firefox user with a dark theme sees a stark white popup. | `popup.css` (whole file) | Visual |
| M2 | **No toolbar icon states.** Same icon on supported / unsupported / exporting / error. Also only a 48 px icon — missing 16, 32, 96, 128 for high-DPI and context menus. | `manifest.json:132–138`, `background.js` (no `setIcon`/`setTitle`) | Visual |
| M3 | **Focus ring is 30 % opacity blue** — marginal on white, nearly invisible on dark surfaces. | `popup.css:40` | A11y |
| M4 | **No focus-on-open; no Escape handler.** Focus lands on `<body>`; keyboard users tab from nothing. Esc may or may not close natively (depends on Firefox popup chrome). | `popup.js:1813–1817` | A11y |
| M5 | **Platform palette hard-coded.** ChatGPT green, Claude orange, Copilot blue, Deepseek violet, Gemini blue — none are tokens. | `popup.css:366–428` | Visual |
| M6 | **Font stack missing `-moz-system-ui`.** Popup doesn't fully match Firefox chrome typography. | `popup.css:43–44` | Visual |
| M7 | **Error copy is generic and sometimes blames the user.** `"Please navigate to a supported chat platform"` reads as "you did it wrong." No next step on most. | `shared/errors.js:14–53` | Copy |
| M8 | **Inconsistent stuck-state UX across sites.** ChatGPT/Copilot: "Reload Page" button. Claude: silent 15 s timeout. Google: "Close and reopen this popup." | `popup.js:1088–1226` | UX |
| M9 | **`<details>` elements have `role="group"` but no `aria-labelledby`.** Screen readers hear a grouped region with no name. | `popup.html:199, 252` | A11y |
| M10 | **Native `window.confirm()` for large-export warning.** Breaks visual consistency with everything else in the popup. | `popup.js:1318–1327` | UX |
| M11 | **File-list heading is a `<span>`, not a heading.** Breaks heading navigation. | `popup.html:176` (`#fileListHeading`) | A11y |
| M12 | **Consent gate doesn't disclose preview status.** Participants consent to the study but not to testing beta software. (The user has instructed us *not* to change the consent gate copy — flagging only.) | `popup.html:58–101` | Copy |
| M13 | **`aria-required="true"` on the consent checkbox without the native `required` attribute.** Mixed signal to AT. | `popup.html:93` | A11y |
| M14 | **PII-scrub label uses "scrub"** — users don't know whether that modifies files, hides fields, or something else. | `popup.html:217` | Copy |
| M15 | **"Study code" label is cryptic.** No explanation of why a researcher would give one or what it protects. | `popup.html:228` | Copy |

### 3.3 Minor

| # | Issue | File:line | Lens |
|---|-------|-----------|------|
| m1 | Animations don't check `prefers-reduced-motion`. | `popup.css:643, 992` |
| m2 | File-list description uses `--color-text-tertiary` at 11 px — 4.87:1 on white, close to the 4.5:1 AA floor. | `popup.css:884` |
| m3 | `outline-offset: 2px` + 2 px outline may clip on 320 px viewports (1–2 px). | `popup.css:1069, 1082` |
| m4 | File-list badge font-size is a hard-coded `10px`, every other badge uses `--font-size-xs` (11px). | `popup.css:831` |
| m5 | Icons sit visually mis-aligned by `margin-top: 2px` in several places. | `popup.css:453, 828, 1232, 1262` |
| m6 | `.file-list { overflow: hidden }` can clip the focus ring on the last item. | `popup.css:780` |
| m7 | Status detail text can wrap unpredictably on long platform-specific tips. | `popup.css` (no truncation) |
| m8 | Chevron rotation on `<details>` toggle has no reduced-motion variant. | `popup.css:976–978` |
| m9 | Google-tip wording ("close and reopen this popup if it stays here") buries the actionable step. | `popup.js:1215, 1220, 1236` |
| m10 | Reload button says "Reload Page" with no tooltip explaining what happens to the conversation. | `popup.html:193–196` |
| m11 | Data-notice says "store securely" with no concrete guidance. | `popup.html:189` |
| m12 | Footer line "All data stays local in your browser" is a single quiet line — easy to miss on first open. | `popup.html:296` |

### 3.4 Strengths — do not regress

- **Comprehensive CSS custom-property system** at `popup.css:10–87`. Expanding
  it (not replacing it) is the right path.
- **`aria-live` is used consistently** on status card, file list, and platform
  badge (`popup.html:106, 168, 52`).
- **Decorative icons are correctly hidden** with `aria-hidden="true"`.
- **Error taxonomy is centralized** in `shared/errors.js` — a good shape to
  improve, not rip up.
- **Sanitization of error messages** in `shared/errors.js:84–132` strips
  UUIDs, emails, paths, tokens — keep that behavior for anything we add.
- **ISO-8601 timestamps in filenames** (sortable, researcher-friendly).

---

## 4. Per-platform flows and state matrix

### Happy paths (one sentence each)

- **ChatGPT:** popup detects `/c/<id>` → content script already captured
  `mapping` + metadata via fetch interception → background validates →
  generates 3–5 CSVs (metadata, messages, canonical, optionally sources +
  donor-context) → ZIPs with a `_manifest.json` sidecar → downloads.
- **Claude:** content script actively fetches
  `/api/organizations/.../chat_conversations/<uuid>` on page load → stores
  result → export generates 4 CSVs (metadata, messages, sources, canonical).
- **Copilot:** content script receives a signed message with a `results`
  array on page load → stores → export generates 2 CSVs (flat + canonical).
- **Google Search:** content script observes `/search` responses + scans the
  DOM for AI Overview/AI Mode → caches by `(query::mode)` → export
  flattens turns, generates 2–3 CSVs. Capture **continues after popup
  close** via MutationObserver — unique and user-invisible today.

### State matrix

| State | ChatGPT | Claude | Copilot | Google | Severity | Where |
|-------|---------|--------|---------|--------|----------|-------|
| Unsupported page | handled | handled | handled | handled | minor | `popup.js:1043` |
| Logged out | **invisible** | **invisible** | **invisible** | n/a (page-level cookies) | **blocker** (B3) | `claude/content.js:223`, `background.js:477` |
| Conversation not loaded | "Capturing…" → "Reload Page" after 15 s | silent 15 s timeout | same as ChatGPT | "Checking for AI Overview…" | minor | `popup.js:1086–1226` |
| Host API changed | n/a (page-JS intercept) | silent catch | n/a | logged, buried in timeout | **blocker** (B3) | `claude/content.js:223–229` |
| Empty export (0 messages) | prevented upstream | validation at `background.js:288`, generic error | validation at `background.js:297`, generic error | **zero-row CSV ships** | **blocker** (B2) | `background.js:652–655` |
| Export in progress | spinner + "Exporting…" | same | same | same | minor | `popup.js:1384` |
| Export succeeded | "Export complete!" + auto-close in 3 s | same | same | same | minor | `popup.js:1454–1466` |
| Rate limit | handled, user can retry | same | same | same | minor | `popup.js:1335–1368` |
| `browser.downloads.download` fails | **spinner hangs forever** | same | same | same | **blocker** (B1) | `background.js:701–710` |
| ZIP build fails | **spinner hangs forever** | same | same | same | **blocker** (B1) | `background.js:707` |
| Content script not loaded | "Extension not ready" | same | same | less actionable ("Try again in a few seconds") | minor | `popup.js:1107–1113` |
| Large conversation (>500 msgs) | native `window.confirm()` | same | same | n/a | major (M10) | `popup.js:1318` |

---

## 5. Revised flow — target behavior

### 5.1 Popup open

1. Focus lands on the primary action (the export button when ready, the
   consent checkbox on first run).
2. `Escape` closes (if Firefox doesn't already do this natively — we'll
   verify first and avoid duplicating the browser behavior).
3. A permanent "Preview" tag sits in the header. On first install, a
   dismissible "Development Preview — in active development" banner
   appears below. Dismissal is stored in `storage.local`.

### 5.2 Status card

- Platform detected → platform badge + a short line naming what will be
  exported ("ChatGPT — this conversation, all messages and metadata").
- While capturing → animated spinner (respects `prefers-reduced-motion`)
  with a visible elapsed-time counter so "stuck" is unambiguous.
- Auth failure detected → "Please sign in to <platform>" with a direct
  link if we have one.
- Download / ZIP failure → "Download failed. Check your Downloads folder
  permissions, then try again."

### 5.3 Trust footer + "What's in the file?"

- Footer: one bold line + one short line stating "nothing is sent
  anywhere; files go to your Downloads folder."
- Collapsible "What's in the file?" section in About, listing the ZIP
  filename pattern (`<platform>_<id-short>_<ISO-timestamp>.zip`) and
  the top CSV columns per platform.

### 5.4 Toolbar icon

- Four states: **supported** (colour icon), **unsupported** (grey icon),
  **exporting** (optional subtle badge indicator), **error** (badge "!").
- Every state also sets `browser.action.setTitle` with plain-language
  text so nothing is color-only.

### 5.5 Dark theme

- Palette inverts: surfaces 10%→92% lightness, text 92%→10%, accent
  (`--color-primary`) lightens from `#0060df` to approximately
  `#4891ff` until it clears 4.5:1 against the dark surface.
- `axe-core` verifies in the harness for every state in dark.

---

## 6. Implementation plan

Each step is one commit, ships independently, keeps the extension working.
Numbers match the tasks in the task list.

| # | Step | Scope | Verification |
|---|------|-------|--------------|
| 1 | Preview harness (**done**, commit `bf0d951`) | `dev/*` | web-ext lint + build, dev/ excluded from .xpi |
| 2 | Baselines (`before`) | `dev/baseline.mjs` run | 24 captures (12 states × 2 themes), axe JSON per state |
| 3 | This document | `docs/ux-audit.md` | you reading it |
| 4 | Design tokens + dark theme | `popup.css`, `popup.html` (study-code input class only) | axe clean on dark, Firefox-native fit visually |
| 5 | Accessibility + keyboard | `popup.html`, `popup.css`, `popup.js` | axe regression delta, keyboard walk-through |
| 6 | Toolbar icon states | `manifest.json`, `background.js`, `icons/*` | all four states observable in `web-ext run` |
| 7 | Trust surface + preview banner | `popup.html`, `popup.css`, `popup.js` | banner dismissal persists; permanent tag visible |
| 8 | 6a: download/ZIP failures surface | `background.js`, `popup.js` | harness state covers it |
| 9 | 6b: empty-export validation | `background.js` | zero-row export produces specific message, no file |
| 10 | 6c: auth detection (**gated**) | TBD — if it needs touching `window.fetch` hooks, stop and show the diff first | — |
| 11 | 6d: unified stuck-state copy | `popup.js`, `shared/errors.js` | all platforms share the message pattern |
| 12 | 6e: in-popup confirm card | `popup.html`, `popup.css`, `popup.js` | replaces `window.confirm()` |
| 13 | Microcopy sweep | `shared/errors.js`, `popup.html`, `popup.js` | all user-facing strings reviewed |
| 14 | `docs/manual-tests.md` + `CLAUDE.md` | docs only | checklist runnable with `web-ext run` |
| 15 | Google Search release gating (**pending**) | `manifest.json` strip for 2.2.0 release build | AMO existing users don't get re-prompt |
| 16 | Independent final review | fresh subagent | fixes land in a final commit |
| 17 | Version bump + changelog | `manifest.json`, `package.json`, `CHANGELOG.md` | 2.2.0 |

---

## 7. Permissions investigation — can we drop `tabs`?

The uncommitted WIP in `manifest.json` **adds `tabs`** to `permissions`. The
AMO-published 2.1.1 does not have it. Shipping 2.2.0 with `tabs` would
trigger a re-approval prompt for every existing user on update. If `tabs`
is removable, we avoid that prompt.

**What the extension does with the `tabs` API:**

| Call | Purpose | Needs `tabs` permission? |
|------|---------|--------------------------|
| `browser.tabs.query({active, currentWindow})` | find the currently active tab | **No** — returns `{id, url}` without `tabs` **only if** the extension has a matching `host_permission` for that URL. For other URLs, `url` is omitted. |
| `browser.tabs.sendMessage(tabId, msg)` | message the content script | **No** — gated by `host_permissions`, not by `tabs`. |
| `browser.tabs.reload(tabId, {bypassCache})` | reload the current tab from the popup's "Reload Page" button | **No** on Firefox — allowed by `host_permissions` for the matching URL. (`activeTab` also permits it on the current tab if the user clicked the browser action.) |
| `browser.tabs.onUpdated.addListener` in `popup.js` | re-check UI when the active tab finishes navigating | **Yes** — this listener fires for *all* tabs, so it requires either `tabs` or a host-permission filter. However, popup lifetime is short; the listener is attached on open and torn down on close. A tab-targeted alternative is `browser.webNavigation.onCompleted` (needs `webNavigation`) or polling the active tab. |

**Reading of Firefox MV3 docs** (verify in-session once in Firefox):

- Access to `tab.url` **in `browser.tabs.query` results** is granted by
  `host_permissions` on URLs that match. We already have host permissions
  for every URL we care about. The `tabs` permission is only needed to see
  `url` / `title` for tabs we don't have host permission for — which this
  extension never does.
- `onUpdated` with no filter sees every tab. If we attach the listener on
  popup open with `{urls: [...our host permissions...]}` as a filter, it
  should be scoped by host permissions alone.

**Proposed path** (not in this commit — a follow-up PR after 2.2.0):

1. Replace `browser.tabs.onUpdated.addListener((tabId, changeInfo) => …)`
   at `popup.js:846–847` with a filtered form:
   `browser.tabs.onUpdated.addListener(handler, { properties: ['status', 'url'], urls: HOST_URLS })`
   where `HOST_URLS` is built from `EXTENSION_CONFIG.platforms` so it
   mirrors `host_permissions`.
2. Remove `"tabs"` from `permissions`.
3. Verify in the harness **and** in `web-ext run`: popup opens cleanly on
   each site; the tab-navigation handler still re-fires on URL changes
   within those sites; nothing is logged about missing permissions.

If step 1 reveals that `tabs.query` returns `url: undefined` for the
active tab without the `tabs` permission (we don't *think* it does for
URLs matching our host permissions, but Firefox has edge cases), we keep
`tabs` and document the reason.

**Verdict for 2.2.0:** we keep the current state (`tabs` present in WIP;
not committed yet). The investigation lands as this section; the removal
is a separate release.

---

## 8. AMO reviewer-note draft — Google locale hosts

If a 2.3.0 release ships Google Search support, the following paragraph is
ready to paste into AMO reviewer notes:

> **Why ten Google locales?** The Google Search handler captures AI
> Overview and AI Mode responses from the user's own search results.
> Google serves these from locale-specific domains (`www.google.de`,
> `www.google.fr`, etc.) — the content differs by locale even for the
> same query, and the HTML structure can diverge. We require the ten
> top-of-mind locales for the European and English-speaking research
> populations in our study: `.com, .be, .nl, .fr, .de, .co.uk, .es,
> .it, .ca, .com.au`. The handler only runs on `/search*` paths. All
> data is processed locally and saved to Downloads; no network
> requests are issued by the extension beyond the user's own
> navigation. `data_collection_permissions` is set to `"none"`.

---

## 9. Release implications (noted for later; no action taken here)

The uncommitted WIP on `main` substantially expands the extension beyond
what's shipping as 2.1.1 on AMO. If any of this merges into the next
release, there are three downstream decisions to make. **This section
records them; it does not act on them.**

- **New permissions trigger a user re-approval prompt.** The WIP adds
  `tabs` to `permissions` and ten Google locale hosts (`.com, .be, .nl,
  .fr, .de, .co.uk, .es, .it, .ca, .com.au`) to `host_permissions`. Firefox
  will **disable the extension on update** until each existing user
  explicitly re-approves the elevated scope. Expect a measurable drop-off
  on the dialog. Mitigation: time the release deliberately, call it out in
  the release notes, and consider shipping two releases — a UX-only pass
  (no new permissions, no re-prompt) followed by a feature release that
  earns the re-prompt in exchange for new platforms.
- **AMO reviewer notes need updating.** The new release surface includes
  four platforms not in the 2.1.1 listing (Perplexity, Grok, Microsoft 365
  Copilot, Google Search AI Overview). The M365 Copilot handler uses a
  **WebSocket interception** path rather than `window.fetch`-only hooks;
  AMO reviewers will question that. Prepare a short justification: what
  it does, why it's needed, and that nothing leaves the browser. The
  draft reviewer note for the Google locale hosts (§8 above) is a
  starting template.
- **Version should be 3.0.0, not 2.2.0.** The planned UX-only release
  was framed as a minor bump. The WIP goes well beyond that: new
  platforms, new permissions, new privacy pipeline (PII scrubbing,
  per-row validation, HMAC donor-ID anonymization), new export format
  (ZIP with manifest sidecar), new `tabs` permission. Semver says
  major bump. Whether you ship the WIP in one release (3.0.0) or split
  it into two (2.2.0 UX-only, 3.0.0 platforms + pipeline) is a
  release-strategy call for you to make, not a technical one — this
  note just flags that the current `manifest.json: 2.1.1 → 2.2.0`
  plan under-reflects the scope.

## 10. Risks and non-goals

- **Not touching parsing / fetch hooks.** If any step appears to need
  changes under `platforms/*/inject.js` or `platforms/*/extractor.js`,
  we stop and ask. CSV output on synthetic fixtures must be byte-identical
  before and after.
- **Not changing permissions in this pass.** The permission investigation
  (§7) is explicitly non-blocking — a follow-up release.
- **Not touching consent-gate copy.** The user has instructed this
  explicitly; the preview-status disclosure lives outside the consent
  flow.
- **No new network requests, remote fonts, CDNs, or analytics.**
- **No bundler, no minifier.** AMO reviewers compare the submitted .xpi
  to this repo; code stays unbundled and readable.
