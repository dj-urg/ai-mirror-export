# Release review: AI Chat Exporter 3.0.0 (unattended, 2026-10-13)


## Summary and hand-off (written last, read first)

### 1. Go / no-go: **NO-GO as it stands. GO after six small protected-zone fixes (≈1–2 h) plus a short manual pass.**

`release/3.0.0` is privacy-clean, lint-clean, builds a clean .xpi, passes all tests and axe, and the PII-options refactor is verified byte-identical. But three things make it unpublishable tonight, all in code I was told not to touch:

- **Mistral cannot export and tells the participant it succeeded** (A-B1). The background script has no Mistral wiring; the popup shows "Export complete!" and closes; no ZIP. Mistral is advertised in the changelog, README, AMO notes, manifest and popup.
- **PII scrubbing silently skips the canonical CSVs for Claude, Perplexity, Grok and DeepSeek and every raw-JSON column**, while the manifest certifies `pii_scrub_enabled: true` (A-B2, reproduced in 4.0.2 with a planted email). The canonical file is the one researchers are told to pool.
- **Every export is stamped `extractor_version: 2.1.1`** (B-S6/F-B2) — a provenance error for a research artefact.

And three should-fixes I would not upload without: `sanitizeErrorMessage` and `getPlatformByUrl` are called in `background.js` without being imported (download/processing failures never reach the popup; toolbar icon states never apply — two features the changelog and AMO notes advertise); Perplexity ships with `DEBUG_MODE = true` and a page-visible probe; no `strict_min_version` although MAIN-world content scripts need Firefox 128.

Everything else found is documented below as should-fix/later and does not block.

### 2. Repo privacy: nothing blocks the push

- **No secrets in history or working trees.** gitleaks over all 59 commits: two hits, both synthetic inputs in `testing/tests/test_pii.js` (a dummy JWT and a hex placeholder), both local-only. gitleaks over all uncommitted files: clean. The five tracked fixtures are synthetic. The real-origin captures (`testing/data/<site>/`, `dev/m365_ws_capture.json`, `dev/baselines/wip-backup-*`, `test/*.csv`, `submission.zip`) are all gitignored and were never committed on any branch.
- **Fixed on `release/3.0.0-fixes`:** `.claude/` and `*.har` are now ignored; the corrupted `.gitignore` block is gone; `web-ext` now also refuses to package stray CSV/log/env/key/HAR files.
- **Do not commit** `.claude/settings.local.json` (now ignored). **Your call (D1):** `CITATION.cff` carries your institutional email; I kept it (your domain is already public in the add-on ID).
- `origin` has only `main` at `0878abd`; nothing from today has been pushed.

### 3. Blockers

| # | Blocker | Status |
|---|---|---|
| B1 | Mistral export dead + false success (A-B1) | **open** — protected zone. Fix = port 5 files from `snapshot/mistral-wip` + 6-line adaptation (D3), or pull Mistral from 3.0.0. |
| B2 | PII scrub bypasses canonical CSVs + raw-JSON columns while manifest says scrubbed (A-B2/C-B2, verified 4.0.2) | **open** — protected zone (D10). |
| B3 | `EXTRACTOR_VERSION = '2.1.1'` in every export (B-S6/F-B2) | **open** — protected zone (D8). One-line bump. |
| S | `sanitizeErrorMessage` + `getPlatformByUrl` not imported in `background.js` (B-S1/A-S1/A-S2) | **open** — two import lines (D7). |
| S | Perplexity `IS_PRODUCTION=false / DEBUG_MODE=true` + probe + triple injection (B-S3/B-S5) | **open** (D11). |
| S | No `strict_min_version` (B-S7/F-B3) | **open** (D9). |
| — | `.gitignore` gaps, CI lockfile error, stale versions/descriptions, README broken images, 401 jargon, dead refresh copy, a11y name bugs, doc inaccuracies (19 items) | **fixed on `release/3.0.0-fixes`** (Part 5). |

### 4. Decisions for Daniel (each with my recommendation)

- **D1.** `CITATION.cff` email kept. *Recommend: keep.*
- **D2.** `.claude/` excluded everywhere and now ignored. *Recommend: agree.*
- **D3. Mistral.** Options: (a) hand-port the wiring from `snapshot/mistral-wip` — `utils/validators.js` Mistral schemas, `utils/manifest.js` + `utils/pii.js` entries, `shared/errors.js` copy, and the `background.js` import/validate/handler/type-map hunks, replacing `totalPiiRedactions += x.redactionCount` with `mergeScrubCounts(piiStats, x)` and passing `piiScrubOptions` to the three `scrubIfEnabled` calls (mirror the DeepSeek branch at background.js:1003–1024); then one real Mistral export in Firefox. (b) Remove Mistral from manifest/config/popup/CHANGELOG/README/AMO notes/`UNSUPPORTED_PLATFORM` copy/toolbar title and ship it in 3.1.0. *Recommend: (a) if you have a Mistral account and 30 min, else (b). Not shippable as-is.* I left every Mistral mention in the docs untouched so neither choice needs un-doing my edits.
- **D4.** `CITATION.cff` added with version 3.0.0. *Recommend: keep.*
- **D5.** DeepSeek `model` column fix (in `snapshot/mistral-wip`, verified against the API's key names) deferred to 3.1.0 with a schema-version bump. *Recommend: 3.1.0, or fold in if you are touching `background.js` anyway.*
- **D6.** `docs/images/` added because README already embeds them. *Recommend: keep.*
- **D7.** Add `import './shared/errors.js';` and change line 44 to `import { EXTENSION_CONFIG, getPlatformByUrl } from './config/settings.js';` in `background.js`. Test: force a download failure (read-only Downloads folder) and watch the toolbar icon switch grey/colour on tab change. *Recommend: do before upload.* Until then the AMO notes' claims about icon states and failure messages are untrue.
- **D8.** `utils/manifest.js:9` → `'3.0.0'`. *Recommend: do.* Golden tests import the constant and stay green.
- **D9.** `"strict_min_version": "128.0"` under `browser_specific_settings.gecko`. *Recommend: do in the same commit.*
- **D10. PII scrub blocker.** (a) regenerate the canonical CSV from the scrubbed rows in the four extractor branches the way the ChatGPT branch does (background.js:878–884), and scrub or drop raw-JSON columns when scrubbing is on; or (b) ship with popup/README/STUDENT_GUIDE/METHODS/CHANGELOG saying scrubbing covers only the text columns of the platform-specific CSVs and hide the checkbox for the four platforms. *Recommend: (a).* I did not hedge the docs because the hedge is wrong the moment you choose (a).
- **D11.** Perplexity: flip the two flags, remove `window.__perplexityExporterProbe`; test one export for duplicate ZIPs before adding an idempotency guard. *Recommend: flags before upload; guard if duplicates appear.*
- **D12.** ESLint: `caughtErrorsIgnorePattern: '^_'` and per-file scoping of the `readonly` globals so missing imports fail lint. *Recommend: with D7.*
- **D13.** CI: I removed `cache: 'npm'`. *Recommend: keep, or track `package-lock.json` and restore it.*
- **D14.** The manifest/package/config descriptions I rewrote list all nine sites including Mistral. If you choose D3(b), edit those three strings too.
- **D15.** Manual-tests §5 "8e" and the AMO notes' "in-popup confirmation card" describe the large-export card, which is unreachable (D-S3: `state.capture.conversations` is never set). *Recommend: either wire it (store the captured list on state) or drop the card and the two mentions before upload.*
- **D16.** Google content script re-fetches the user's search page on every 2 s popup poll with no negative cache (B-S2). Docs now say so honestly; the behaviour itself is a 3.1.0 fix. *Recommend: accept for 3.0.0.*

### 5. Branch overview and tomorrow's commands

| Branch | Head | Contents |
|---|---|---|
| `main` | `0878abd` | **unchanged** (= `origin/main`, 2.1.1) |
| `ux-audit-pass` | `bbe6649` | **unchanged** |
| `feature/mistral` | `9410dfc` | **unchanged** |
| `release/3.0.0` | `bbe6649` | = `ux-audit-pass`, nothing merged |
| `release/3.0.0-fixes` | 20 commits on top of `release/3.0.0` | Part 5 fixes + this report (`docs/release-review-3.0.0.md`) |
| `snapshot/main-wip` | `e6e38e5` (1 on top of `ux-audit-pass`) | DeepSeek content.js auth-token/force-refresh change, `CITATION.cff` (2.1.1), `docs/images/` |
| `snapshot/mistral-wip` | `2a343a4` (1 on top of `feature/mistral`) | Mistral background wiring (stale API), DeepSeek `model` fix, Mistral text-assembly change, schemas/copy |

Worktrees: `~/data_donation_ai_extension` is on **`release/3.0.0-fixes`** (clean); `~/ai-export-features` is on **`snapshot/mistral-wip`** (clean). No stashes. All temporary worktrees under /tmp were removed. Side files outside the repo: `~/release-review-3.0.0.md` (this report), `~/gitleaks-history.json`, `~/gitleaks-uncommitted-{main,mistral}.json`, `~/release-review-3.0.0-harness/` (Node harness + six synthetic fixtures, reusable as golden-test seeds).

```bash
cd ~/data_donation_ai_extension
git status                                              # clean, on release/3.0.0-fixes
git log --oneline release/3.0.0..release/3.0.0-fixes    # 20 commits
git diff release/3.0.0 release/3.0.0-fixes -- . ':!docs/release-review-3.0.0.md'   # review the fixes

# 1. apply the protected-zone fixes (D3, D7, D8, D9, D10, D11) on release/3.0.0-fixes, then
npm test && npm run lint && npx web-ext lint && npx web-ext build && npm run baseline -- --label pre-upload

# 2. manual pass in Firefox (section 6 below), then fold into the release branches
git checkout ux-audit-pass && git merge --ff-only release/3.0.0-fixes
git checkout main && git merge --ff-only ux-audit-pass      # main is a strict ancestor, so this fast-forwards
git push origin main
git tag -a v3.0.0 -m "AI Chat Exporter 3.0.0" && git push origin v3.0.0

# 3. optional: keep the WIP snapshots somewhere safe (they contain no secrets)
git push origin snapshot/main-wip snapshot/mistral-wip

# 4. upload web-ext-artifacts/ai_chat_exporter-3.0.0.zip to AMO with the reviewer note below
```
If you would rather not ship the review inside the repo, `git rm docs/release-review-3.0.0.md` on `release/3.0.0-fixes` before merging; it is in `docs/`, so it never enters the .xpi either way.

### 6. Changelog, AMO reviewer note, manual tests

**Changelog** — the current text is the one on `release/3.0.0-fixes` (`CHANGELOG.md`, commit `9ad6f04`). It still lists Mistral under "Six new supported sites" (D3) and does not list the toolbar icon states or the large-export card (both currently non-functional; add them only after D7/D15).

**AMO reviewer note** — paste the `scripting` section and everything from "## What this release adds" onward from `docs/amo-reviewer-notes.md` (commit `9844d54`). Two sentences in it become true only after D7 (icon colour/grey; failure messages) and one after D15 (confirmation card). It now states plainly that content scripts make same-origin re-fetches and that Google's search page is re-requested, which is what reviewers will see in the source.

**Manual-test checklist** (`docs/manual-tests.md`) — items that matter most, in order:
1. **§8 per-platform smoke test**, every row, on real logged-in sessions. Watch especially: **Mistral** (expected to fail until D3), **Perplexity** (look for duplicate ZIPs and `[DEBUG]` console output — D11), **M365 Copilot** (WebSocket path, no fixture), **Google AI Mode** (file name will be `google_ai_mode_unknown_…` — A-S5).
2. **PII scrub end-to-end:** export a Claude chat containing an email with scrubbing on; open `claude_messages_canonical_*.csv` and the `raw_block_json` column — both leak until D10.
3. **§5 8a download failure** and **§1 icon states** — both broken until D7; verify after the fix.
4. **§5 8c Claude auth failure** — the new sign-in copy.
5. **2.1.1 → 3.0.0 update on a profile that has 2.1.1 installed** — confirm the permission prompt and what declining does (README claim removed; F-S4).
6. **§2 keyboard walkthrough** — check that focus actually lands on Export when ready in real Firefox (D-S11 suspects it stays on `<body>`).
7. **§4 first-run** — consent gate, banner.
8. §3 dark theme, §6 trust surface, §7 build parity (automated equivalents already green).
Skip §5 8e (large-export confirm) — unreachable (D15).

### 7. 3.1.0 candidates

- **Review-your-ZIP step** (deferred; nothing claims it ships — verified).
- **Gemini** from scratch (stub added `9ae2760`, deleted `b6e49ee`; CSS leftovers removed tonight).
- **From `snapshot/mistral-wip`:** DeepSeek `model` column + `cite_index` + stringified `fragment_id` (verified correct; bump `deepseek_messages`/`deepseek_sources` schema versions); Mistral `assembleDisplayText` preferring `content` and excluding reasoning chunks (verify against a real payload first); Mistral wiring if not shipped in 3.0.0.
- **From `snapshot/main-wip`:** DeepSeek active-fetch with Bearer token from `localStorage`, force-refresh on popup open/export, agent-slug regex, empty-session handling (needs reviewer-note text; drop the ineffective `history.pushState` wrapper).
- **Golden tests for ChatGPT, Copilot, M365 Copilot, Google** — the six synthetic fixtures and harness in `~/release-review-3.0.0-harness/` already drive `background.js` end-to-end and can be turned into tracked tests; this also fixes the local-vs-CI suite mismatch.
- **Harness states** for Perplexity, Grok, DeepSeek, Mistral, M365 Copilot (+ EXPORT_RESULT outcomes, non-Claude auth failure, rate limit; fix the mock so `no_data`/`export_failed` presets render — D-S10).
- **Replace the real ChatGPT fixture** with a synthetic one (`testing/data/chatgpt.com/` + gitignored `test_chatgpt_golden.js`).
- Google AI Mode conversation id (A-S5); negative cache for the Google re-fetch (B-S2); narrow Google `host_permissions` to `/search*` and reconsider `tabs`/`activeTab` (B-L6).

### 8. "Later" list, as follow-up issues

1. **Popup live-region chatter:** diff-before-write in `updatePlatformBadge`/`updateFilePreview`; drop `aria-live` from badge/file list; move the elapsed counter out of the atomic card (D-S1); stop toggling the Google tip every poll (D-S2).
2. **Large-export card:** wire `state.capture.conversations` or delete the card, CSS, manual test and AMO mention (D-S3/D15).
3. **Raw internal strings in the status card** (`detail.reason`): map `validation.code` to plain copy; keep exceptions in the log (D-S5).
4. **Platform naming:** one name per platform across `config/settings.js`, `popup.js`, `shared/errors.js`, `background.js` (M365 Copilot vs Microsoft 365 Copilot; Google AI Overview vs Google Search AI Overview) (D-S7).
5. **`PLATFORM_TROUBLESHOOTING`** entries for perplexity, mistral, m365_copilot, google_search; `claude.noConversationId` (D-S8).
6. **File-list copy** per platform ("Your ZIP will contain:" rows incl. canonical + manifest) (D-S9/A-S4/C-S10).
7. **Focus-on-open race:** call `focusInitialTarget()` after the first `checkAndUpdateUI()` resolves (D-S11).
8. **Status semantics:** `NO_CONVERSATION_ID`/`UNSUPPORTED_PLATFORM` as polite info, not assertive error; `role="status"` + assertive is contradictory (D-L4/L5); keydown Enter/Space double-fire (D-L12); "Network error" copy for non-network failures (D-L10); input border contrast (D-S15); banner dismiss 24 px (D-L8).
9. **Dead code sweep:** popup.js no-op functions, `verifyRuntimeIntegrity` + the untrue `popup.html` header comment, `utils/helpers.js`, `generateFilename`/`createCSVBlob`, unused imports, `updates.json`, unused CSS blocks/tokens, duplicated `.btn` rules, `#privacySettings` (4(e)).
10. **Duplicated helpers** into `shared/` (`logger` factory, secret handoff, `verifySignature`, capture store, `validateResponse`, UUID/safe-id regexes, `stripUtmParams`, `toJsonCell`, `normalizeRole`) (4(e)).
11. **CSV formula-prefix mutation** (`escapeCSVField` prepends `'`): document the exact character list in METHODS or remove it and document the spreadsheet caveat (A-S6/C-S1); mixed `\n`/`\r\n` line endings inside one ZIP (A-L1).
12. **Research docs:** METHODS extraction rules for Perplexity, Grok, DeepSeek, Mistral, M365; `text_cleaned` rules; 50 MB cap; U+202F handling; consent-gate "What data is collected" vs what is actually exported (C-S8, PI decision); consent version/timestamp in storage.
13. **HMAC bridge nonce** actually tracked (30 s replay window today) (B-L3); `GET_AUTH_STATE` sender check (B-L2); page-visible debug globals (`__m365CopilotDebug`, `__mistralExporterIsInterestingRequest`, `MessageSecurity`) (B-L5).
14. **Icon lights up on mail./docs./drive.google.com** because `config/settings.js` matches every subdomain (B-L7/A-L3); Perplexity apex vs `www.` mismatch.
15. **`pii_scrub_options` has no UI** — add a URL-stripping toggle or document the storage-only path (B-L8, already documented in METHODS tonight); chatgpt sources/urls scrub coverage (C-S9).
16. **ESLint** warnings (D12), `npm audit fix` for dev deps, `.gitleaks.toml` allowlist for `test_pii.js`, `f39910c` bisect hole (note only).
17. Empty-CSV edge case when every Copilot row throws (A-L5); silent return when `csvFiles` is empty.
18. **README/dev README port mismatch** (8000 vs 8766) — cosmetic.

---

Baseline recorded at start (must be identical tomorrow):

| Branch | Commit at start |
|---|---|
| `main` | `0878abded0cdb51c8d0f152614779f439cd86c30` |
| `ux-audit-pass` | `bbe6649bebf6495e4ad63a408994a6f4bb9a147b` |
| `feature/mistral` | `9410dfc9e6dd14522cc162871dc5c43a0a05b90f` |

Worktrees at start: `~/data_donation_ai_extension` on `ux-audit-pass`, `~/ai-export-features` on `feature/mistral`. No stashes.

---

## Part 1: Privacy of the repo itself

### 1.1 gitleaks over full history (all branches)

Command: `gitleaks git --redact --log-opts="--all" --report-path ~/gitleaks-history.json` (59 commits, 1.2 MB scanned). Report saved outside the repo at `~/gitleaks-history.json`.

| # | File | Line | Commit | Rule | Severity | Assessment |
|---|---|---|---|---|---|---|
| 1 | `testing/tests/test_pii.js` | 96 | `f39910c` (local-only, on `ux-audit-pass`) | `jwt` | none (false positive) | A hand-built HS256 JWT used as *input* to the PII scrubber test. Payload is a placeholder subject/name. Not a credential. |
| 2 | `testing/tests/test_pii.js` | 100 | `f39910c` (local-only) | `generic-api-key` | none (false positive) | A sequential hex placeholder string used to test the "long token" scrub rule. Not a credential. |

Both findings are in a commit that is **not** on `origin/main`. No findings at all in the public history. Nothing needs rewriting.

Recommendation (optional, later): add a `.gitleaks.toml` allowlist for `testing/tests/test_pii.js` so future scans stay clean.

### 1.2 gitleaks over uncommitted, non-ignored files

Files copied to the session scratchpad and scanned with `gitleaks dir --redact`; reports at `~/gitleaks-uncommitted-main.json` and `~/gitleaks-uncommitted-mistral.json`.

| Folder | Paths scanned | Result |
|---|---|---|
| `~/data_donation_ai_extension` | `platforms/deepseek/content.js` (modified), `CITATION.cff`, `docs/images/` (3 PNGs), `.claude/settings.local.json` | **no leaks** |
| `~/ai-export-features` | `background.js`, `platforms/deepseek/extractor.js`, `platforms/mistral/extractor.js`, `shared/errors.js`, `utils/manifest.js`, `utils/pii.js`, `utils/validators.js` | **no leaks** |

Gitignored capture files were *not* scanned (per instructions). Their ignore status was verified with `git check-ignore -v`:

| Path | Ignored by | Status |
|---|---|---|
| `dev/m365_ws_capture.json` (27 KB) | `.gitignore:141` | ignored, never tracked on any branch |
| `dev/captures/` | `.gitignore:143` | ignored |
| `testing/data/chatgpt.com/`, `claude.ai/`, `co-pilot.com/`, `deepseek.com/` | `.gitignore:242` (`testing/data/*`) | ignored, never tracked on any branch |
| `.playwright-mcp/` | `.gitignore:135` | ignored |
| `dev/baselines/` (contains `wip-backup-2026-10-13-*.tar.gz/.patch/.list`) | `.gitignore:176` | ignored, never tracked |
| `submission.zip` | `*.zip` | ignored |
| `testing/tests/test_chatgpt_golden.js` | `testing/tests/*` (not in allowlist) | ignored, never tracked |

Git history check (`git log --all --name-only`): no path matching `capture`, `.har`, `backup`, `.bak`, `.playwright`, `.claude` or `.env` was ever committed on any branch. The only data files ever added are the five synthetic fixtures in commit `2057cd1`.

### 1.3 Manual review of tracked fixtures, images and JSON/log files

- **Tracked JSON files:** `manifest.json`, `package.json`, `updates.json`, and the five `testing/data/synthetic/*_golden_v1.json` fixtures. No tracked `.log`, `.har`, `.csv` or `.txt` files on any branch.
- **Synthetic fixtures (5 files, 0.9–1.2 KB each):** no email addresses, no cookies/tokens/authorization headers, no account/tenant/org IDs. Conversation IDs are obvious placeholders (e.g. repeated-digit UUIDs, `deepseek-golden-0001`). Conversation text is synthetic. **Clean.**
- **`docs/images/` (untracked):** `icon.png` (899 B) and two harness renders `popup-light.png` / `popup-dark.png` (~97 KB each) showing the popup in the "Capturing conversation data…" loading state with the Claude badge. No conversation content, no user names. **Safe to track.**
- **`.claude/settings.local.json` (untracked, 72 B):** a Claude Code permissions allowlist. Not sensitive, but machine-local and should not be committed.
- **`CITATION.cff` (untracked):** contains the author's institutional email and affiliation. This is standard citation metadata, and the same institutional address already appears publicly as the add-on ID domain (`ai-chat-exporter@daniel.jurg.vub.be`) in `manifest.json` and `updates.json` on `origin/main`. Not a leak, but it is a deliberate publication choice (see Decisions). Note: `CITATION.cff` says `version: "2.1.1"`, not 3.0.0 (see Part 2.4 / Part 5).
- **`updates.json` (tracked, public):** a legacy self-hosted update manifest pointing to a v1.0.0 GitHub release. Contains only the add-on ID and a GitHub URL. Not sensitive; relevance to packaging is covered in Part 4(f).
- **HMAC key / study codes:** the donor-ID HMAC key (`study_salt`) is entered by the participant in the popup and stored only in `browser.storage.local`. No default or real salt is committed anywhere (`config/settings.js` has none). No study codes found in tracked files.
- **Emails in tracked files:** only the add-on ID (`manifest.json`, `updates.json`), the `package.json` author field, and obvious placeholders (`a@b.co`, `x@y.co`) in `test_pii.js`. All already public on `origin/main` or synthetic.
- **`nodes.md`** (present on `origin/main`, deleted on `ux-audit-pass`) is a 1-byte empty file. Nothing sensitive.
- **Secret-handling code** (`platforms/*/inject.js` + `content.js`): the per-page HMAC signing secret is generated at runtime in the MAIN world and never persisted or committed. Design detail reviewed in Part 4(b).

### 1.4 Commit metadata
Author names/emails in commit metadata are present as expected and were not flagged.

### 1.5 Remote state
`git fetch origin` completed. `git ls-remote --heads origin` lists exactly one branch: `main` at `0878abd`. All 39 commits on `ux-audit-pass` and all 19 on `feature/mistral` are local-only.

| Finding | Location | Public (on `origin/main`)? |
|---|---|---|
| gitleaks #1, #2 (false positives) | `f39910c` | **No**, local-only |
| CITATION.cff email | untracked | No (not yet committed anywhere) |
| Add-on ID containing institutional domain | `manifest.json`, `updates.json` | **Yes**, already public since 1.x |

Nothing on `origin/main` needs attention. Nothing local requires history rewriting.

### 1.6 `.gitignore` review

Confirmed gaps (as expected):

| Pattern | Status | Risk |
|---|---|---|
| `.claude/` | **not ignored** (`git check-ignore .claude/` → no match; shows as `??` in status) | would commit a local tool allowlist; low sensitivity, but noise |
| `*.har` | **not ignored** (`git check-ignore foo.har` → no match) | a HAR capture dropped anywhere in the tree would be staged by `git add -A`; HARs contain cookies and full conversation bodies. **Highest-value gap.** |

Other observations:

| Item | Detail | Recommendation |
|---|---|---|
| Corrupted block at `.gitignore` lines 71–124 | A bare `tests` pattern, ~55 blank lines, then a bare `https:` line, sitting under the "IDE and Editor Files" header. Looks like an accidental paste. `tests` silently ignores any file or directory named `tests` anywhere (the tracked `testing/tests/` survives only because of the explicit allowlist and because tracked files stay tracked). `https:` is harmless. | Remove the stray lines in Part 5 (safe, no behaviour change for tracked files). |
| `data/` and `test/` global patterns | Ignore any directory named `data` or `test` at any depth. Intentional for the local `test/` dir, but surprising. | Leave; note only. |
| `*.log` global | Fine. | — |
| `dev/baselines/` | Ignored; currently holds a WIP backup tarball + patch created today by another agent. Not inspected. | Leave; it is not pushed. |
| `.gitignore` in `~/ai-export-features` (`feature/mistral`) | Older version: lacks the `testing/` allowlist block. Irrelevant for pushing since that branch is fully contained in `ux-audit-pass`. | — |

**Part 1 verdict:** no real secrets in history or in the working trees. Safe to push `ux-audit-pass` (and the branches derived from it tonight) as far as repo privacy goes, provided `.claude/` stays uncommitted and the two `.gitignore` gaps are closed first (done in Part 5 on `release/3.0.0-fixes`).

---

## Part 2: Inventory and snapshots

### 2.1 Inventory (before snapshots)

| Branch | Head | vs `main` (ahead/behind) | Notes |
|---|---|---|---|
| `main` | `0878abd` | — | tracks `origin/main`; 2.1.1 |
| `ux-audit-pass` | `bbe6649` | 39 / 0 | 3.0.0 release candidate; checked out in `~/data_donation_ai_extension` |
| `feature/mistral` | `9410dfc` | 20 / 0 | fully contained in `ux-audit-pass` (0 ahead, 19 behind it); was checked out in `~/ai-export-features` |
| `origin/main` | `0878abd` | — | the only remote branch |

- **Worktrees:** `~/data_donation_ai_extension` (`ux-audit-pass`), `~/ai-export-features` (`feature/mistral`).
- **Stashes:** none.
- **Uncommitted in main folder:** `platforms/deepseek/content.js` (M), untracked `CITATION.cff`, `docs/images/` (3 PNGs), `.claude/settings.local.json`.
- **Uncommitted in `~/ai-export-features`:** 7 modified files (`background.js`, `platforms/deepseek/extractor.js`, `platforms/mistral/extractor.js`, `shared/errors.js`, `utils/manifest.js`, `utils/pii.js`, `utils/validators.js`), +184/−18 lines.

### 2.2 Snapshots created

| Branch | Base | Commit | Contents |
|---|---|---|---|
| `snapshot/main-wip` | `ux-audit-pass` | `e6e38e5` "WIP snapshot: main folder, 2026-10-13" | `platforms/deepseek/content.js`, `CITATION.cff`, `docs/images/{icon,popup-light,popup-dark}.png` |
| `snapshot/mistral-wip` | `feature/mistral` | `2a343a4` "WIP snapshot: ai-export-features worktree, 2026-10-13" | the 7 modified files |

- Main folder was switched back to `ux-audit-pass` afterwards (working tree clean apart from the untracked `.claude/`).
- `~/ai-export-features` is left on `snapshot/mistral-wip`.
- **Left out:** `.claude/settings.local.json` (machine-local Claude Code allowlist). Nothing else was flagged sensitive in Part 1.
- Verified after snapshotting: `main`, `ux-audit-pass`, `feature/mistral` still at their baseline commits.

### 2.3 Assessment of `snapshot/mistral-wip`

**Headline:** the 7 edits are one coherent bundle: *finish wiring Mistral into the background export pipeline* (background.js, manifest.js, pii.js, validators.js, errors.js) plus a *DeepSeek schema correction* (deepseek/extractor.js, validators.js) and a *Mistral text-assembly change* (mistral/extractor.js). None of it has landed on `ux-audit-pass` in any form.

This matters because **`ux-audit-pass` currently cannot export from Mistral at all** (see Part 4(a) blocker B1): `platforms/mistral/content.js` sends `MISTRAL_CONVERSATION_DATA`, but `background.js`'s `MESSAGE_TYPE_TO_PLATFORM` (line 1208) has no such key, so the listener returns `false` and the payload is dropped. There is no Mistral import, no `case 'mistral'` in `validateConversationData`, no handler branch, no schemas, no scrub columns, no schema versions. The tracked golden test even says so in a comment ("its background.js dispatch branch is still pending"). The CHANGELOG, README, manifest and AMO notes nevertheless list Mistral as supported.

A textual dry-run merge (`git merge-tree`, no working tree touched) of `snapshot/mistral-wip` onto `ux-audit-pass` is **conflict-free**, and the full test suite passes on the merged tree (130 assertions, 10/10 files; run in a detached temporary worktree). **But the merge is semantically stale:** the WIP's Mistral branch in `background.js` was written against the pre-refactor PII API and references `totalPiiRedactions` (3 places) and calls `scrubIfEnabled(rows, cols, enabled)` without the new `piiScrubOptions` argument. The PII-options refactor (`15518e3`) removed `totalPiiRedactions` in favour of `piiStats` + `mergeScrubCounts(...)`. A straight merge would therefore throw `ReferenceError: totalPiiRedactions is not defined` on the first Mistral export. No test covers `background.js`, so the suite cannot catch this.

Per-file verdicts:

| File | What the edit does | Relation to `ux-audit-pass` | Verdict |
|---|---|---|---|
| `background.js` (+44) | Imports the Mistral extractor; adds `mistralChat` fallback in `resolveConversationId`; `case 'mistral'` validation; a Mistral handler branch producing `mistral_metadata/messages/sources/messages_canonical` CSVs; adds `MISTRAL_CONVERSATION_DATA` to the type map. | **Newer, but written against stale API.** Merges cleanly, runs broken (see above). Needs a 6-line port: replace `totalPiiRedactions += x.redactionCount` with `mergeScrubCounts(piiStats, x)` and pass `piiScrubOptions` to the three `scrubIfEnabled` calls, mirroring the DeepSeek branch at lines 1003–1024. | **Needs Daniel's judgment** — port by hand (not merge). Required if Mistral stays in 3.0.0. |
| `utils/validators.js` (+102/−2) | Adds `mistral_metadata`, `mistral_messages`, `mistral_sources` schemas; renames DeepSeek `model_class`/`model_name` → `model`; adds `cite_index` to `deepseek_sources`. | Additive for Mistral (nothing landed since). DeepSeek rename is coupled to the extractor change below. | **Port** (Mistral schemas with the wiring; DeepSeek columns together with the extractor change). |
| `utils/manifest.js` (+4) | Adds four `mistral_*` entries to `SCHEMA_VERSIONS`. | Additive; `ux-audit-pass` only changed `MANIFEST_SCHEMA_VERSION` to 1.1.0 in this file. No overlap. | **Port** with wiring. |
| `utils/pii.js` (+3) | Adds `mistral_*` entries to `DEFAULT_SCRUB_COLUMNS`. | Additive; no overlap with the `PII_RULESET_VERSION`/`PII_SCRUB_OPTION_KEYS` additions that landed. | **Port** with wiring. |
| `shared/errors.js` (+5) | Adds `PLATFORM_TROUBLESHOOTING.mistral` copy (noConversationId / noData / exportFailed). | Additive copy, no overlap with the auth-failure copy that landed. Pure user-facing text. | **Port** (low risk; could go in 3.0.0 alongside the wiring). |
| `platforms/deepseek/extractor.js` (+13/−6) | Reads `m.model` instead of `m.model_class`/`m.model_name` (CSV columns renamed accordingly); stringifies `fragment_id`; adds `cite_index` to sources. | **Correctness fix.** Key-name check of the ignored real-origin DeepSeek capture (keys only, no values) confirms message objects carry `model`, not `model_class`/`model_name`; the synthetic fixture agrees. So 3.0.0 currently exports **empty** model columns for DeepSeek. The fix changes the `deepseek_messages`/`deepseek_sources` CSV headers, so `SCHEMA_VERSIONS.deepseek_messages`/`deepseek_sources` must be bumped (1.0.0 → 1.1.0) when it lands; the WIP forgot that. Golden test still passes with the change. | **Port to 3.1.0** (with schema-version bump), or 3.0.0 if Daniel wants correct model columns now. Not a release blocker: output is wrong-but-stable (empty columns), not corrupt. |
| `platforms/mistral/extractor.js` (+15/−10) | `assembleDisplayText` now prefers the top-level `content` string over concatenated `contentChunks`, and excludes chunks whose `_context.type === 'reasoning'`. | Changes what text lands in `text`/`text_cleaned` for Mistral assistant turns. Golden still passes only because the synthetic fixture has no top-level `content` field. I cannot verify against a real payload (no Mistral capture on disk; `dev/mistral_message_all.json` is listed in `.gitignore` but absent). | **Needs Daniel's judgment** — verify against a real Mistral payload before porting. |

Recommendation: do **not** merge `snapshot/mistral-wip` as a branch. Instead, cherry-pick the Mistral wiring files (`validators.js` Mistral section, `manifest.js`, `pii.js`, `errors.js`) and hand-port the `background.js` branch onto whichever release branch you choose, then run a real Mistral export in Firefox. See Decision D3.

### 2.4 Assessment of `snapshot/main-wip`

**`platforms/deepseek/content.js` (+128/−33, protected zone: capture hook / content script).** What it does:

1. **Auth token bridge:** reads DeepSeek's Bearer token from `localStorage['userToken']` (JSON `{value: ...}` or raw string) and attaches it as an `Authorization` header on the extension's own same-origin active fetch of `/api/v0/chat/history_messages`. Rationale in the comments: cookies alone are rejected with `INVALID_TOKEN`, and for brand-new chats DeepSeek never calls `history_messages` itself, so passive interception sees nothing.
2. **Force-refresh semantics:** `activelyFetchAndStore(convId, {force})`; `GET_CAPTURED_CONVERSATIONS` (popup open) and `EXPORT_CONVERSATION` now always re-fetch, so exports reflect messages sent after the first capture.
3. **Error / empty handling:** treats non-zero `code`/`biz_code` as a miss; does not cache empty sessions (`is_empty` or 0 messages).
4. **URL matching:** accepts any agent slug (`/a/<agent>/s/<uuid>`), not only `/a/chat/`.
5. **SPA navigation:** a 1 s poll plus wrappers on `history.pushState`/`replaceState` and a `popstate` listener, with an 800 ms delay before the forced re-fetch.

Assessment:
- Plausibly a real UX fix (new chats exporting empty / stale). Not verifiable tonight without a logged-in DeepSeek session.
- **Privacy/reviewer angle:** the token is read from the page's own `localStorage` and sent only to the page's own origin over the same request DeepSeek itself makes. Nothing leaves the device. But it *is* an extension reading an auth credential, which AMO reviewers notice; `docs/amo-reviewer-notes.md` would need a sentence about it. It is also a behaviour the consent/trust copy does not currently describe.
- **Technical nit:** in a Firefox content script, `history.pushState = ...` assigns to the content script's Xray view, not the page's `history` object, so the wrapper never fires for the page's own navigations. Harmless (the `setInterval` fallback does the work), but dead weight.
- Forced re-fetch on every popup open adds one network request per open; fine.
- **No tests** touch content scripts.

Verdict: **not for 3.0.0** (protected zone, unverified, needs reviewer-note update). **Needs Daniel's judgment for 3.1.0**; keep on `snapshot/main-wip`.

**`CITATION.cff`:** well-formed CFF 1.2.0, correct repo and AMO URLs, author/affiliation/email. Two issues: `version: "2.1.1"` (should be 3.0.0), and it is not referenced from README. Already excluded from the AMO build (`bbe6649` "Ignore CITATION.cff in web-ext build"), which suggests the release agent expected it to exist. **Safe to include once the version is fixed** (see Part 5 / Decision D4).

**`docs/images/`:** three harness renders (light/dark popup, icon). No personal data. README on `ux-audit-pass` does not reference them (checked in Part 5), so they are an unfinished README-illustration task rather than a broken link. **Safe to include**; purely cosmetic. Excluded from the AMO build? `docs/` is ignored by `web-ext-config.mjs` (verified in Part 4(f)).

### 2.5 Gemini

Confirmed:
- `9ae2760` ("first full version", 2025-11-19) added `platforms/gemini/content.js`: a 19-line placeholder that only logged "Content script loaded (not yet implemented)".
- `b6e49ee` ("injection fixes", same day, 70 min later) deleted it with no mention in the commit message.
- No `platforms/gemini/` directory, no Gemini manifest entry, no Gemini entry in `config/settings.js` or `popup.js` on `ux-audit-pass`.

Leftovers on `ux-audit-pass`:
- `popup.css`: `--badge-gemini-strong/bg/text` tokens in all three palettes (lines 59–61 light, 180–182 dark media query, 248–250 forced-dark) and the `.platform-badge--gemini` rules (lines 656–661). Dead CSS; removed in Part 5.
- `docs/ux-audit.md` line 82 (finding M5) mentions "Gemini blue" in the hard-coded palette list. Historical note, harmless.
- `STUDENT_GUIDE.md` line 273 mentions Gemini only as the model behind Google's AI Mode. Correct as written, not a leftover.

For 3.1.0, Gemini is a from-scratch build (inject/content/extractor/config/manifest/popup/docs/tests).

---

## Part 3: `release/3.0.0`

Created `release/3.0.0` from `ux-audit-pass` (`bbe6649`). **Nothing merged.**

- `snapshot/mistral-wip`: not merged — entirely protected zone, and semantically stale against the PII refactor (Part 2.3).
- `snapshot/main-wip`: not merged — it contains a protected-zone content-script change (`platforms/deepseek/content.js`), so the branch as a whole does not qualify. The two non-code additions in it (`CITATION.cff`, `docs/images/`) are handled individually in Part 5 as documentation items, where they qualify.


---

## Decisions for Daniel (running list, consolidated in Part 6)

- **D1.** `CITATION.cff` includes your institutional email. I treated it as intentional citation metadata (your institutional domain is already public in the add-on ID), so it is *not* flagged as a leak and *is* included in the WIP snapshot. If you would rather not publish the address, remove the `email:` line before pushing. Recommendation: keep it; `CITATION.cff` emails are standard.
- **D2.** `.claude/settings.local.json` is excluded from every snapshot/commit tonight and `.claude/` is added to `.gitignore` in Part 5. Recommendation: agree.
- **D3.** Mistral is advertised in 3.0.0 but cannot export (blocker B1). I did not touch the protected zone. Options: (a) hand-port the Mistral wiring from `snapshot/mistral-wip` (≈60 lines across 5 files, plus a 6-line adaptation in `background.js`) and test one real Mistral export in Firefox before publishing; (b) drop Mistral from the 3.0.0 claims (CHANGELOG, README, AMO notes, `UNSUPPORTED_PLATFORM` copy, `manifest.json` host/content-script entries, `config/settings.js`, `popup.js`) and ship it in 3.1.0. Recommendation: (a) if you have 30 minutes and a Mistral account; otherwise (b). Shipping as-is is not an option: participants would hit a silent failure.
- **D4.** `CITATION.cff` was committed only on `snapshot/main-wip`. In Part 5 I add it to `release/3.0.0-fixes` with `version` corrected to 3.0.0 (documentation-only, excluded from the .xpi). Recommendation: keep.
- **D5.** The DeepSeek `model` column fix (in `snapshot/mistral-wip`) is real and verified against the API key names, but it changes two CSV headers. I left it for 3.1.0 with a schema-version bump. Recommendation: 3.1.0, unless you are already touching `background.js` for D3.

---

## Part 4: Independent review of `release/3.0.0` (= `bbe6649`)

Six read-only review agents (one per lens) analysed the tree in parallel; every test, lint, build, baseline and comparison below was run by the coordinator one at a time. Lens reports follow in 4(a)–4(f); this section records the runs they depend on.

### 4.0 Runs performed (all on `bbe6649`)

| Check | Command | Result |
|---|---|---|
| Unit/golden tests (local) | `node testing/tests/run_all.js` | **11/11 files, 130 assertions, 0 failed.** Includes the untracked, gitignored `test_chatgpt_golden.js` (13 assertions, reads a real-origin fixture; pass only reported). **CI runs 10 files**, one fewer. |
| ESLint | `eslint . --ext .js` | **0 errors, 103 warnings** (98 `no-unused-vars`, 4 `prefer-const`, 1 unclassified). Hot files: `popup.js` 12, `background.js` 10, `platforms/mistral/inject.js` 7, `dev/mock-browser.js` 6, `platforms/google_search/content.js` 6. |
| web-ext lint | `web-ext lint` | **0 errors, 0 warnings, 0 notices.** |
| web-ext build | `web-ext build --overwrite-dest` | `web-ext-artifacts/ai_chat_exporter-3.0.0.zip`, 187 KB, 60 entries. Contents: `manifest.json`, `background.js`, `popup.{html,css,js}`, `icon.png`, `icons/` (10 PNGs), `config/settings.js`, `platforms/{chatgpt,claude,copilot,deepseek,google_search,grok,m365_copilot,mistral,perplexity}/*`, `shared/{errors,logger,message-security}.js`, `utils/{csv,helpers,manifest,pii,text_cleaner,validators,zip}.js`. **Nothing from `dev/`, `docs/`, `testing/`, `node_modules/`, `package*.json`, `eslint.config.mjs`, `web-ext-config.mjs`, `CLAUDE.md`, `CITATION.cff`, `.claude/`, `.playwright-mcp/`, `.kiro/`, `.vscode/`, `.github/`, `updates.json`, `submission.zip`, captures or baselines.** |
| npm audit | `npm audit` | 13 vulnerabilities (3 critical, 7 high, 3 moderate), **all dev-only, all transitively via `web-ext`** (adbkit/node-forge, addons-linter/ajv/image-size, adm-zip, firefox-profile, fx-runner/shell-quote, tmp, uuid/node-notifier). `fixAvailable: true` for all. Nothing ships. |
| Duplicate ESLint | `find node_modules -path '*/eslint/package.json'` | `eslint@9.39.5` (top-level, used by `npm run lint`) and `eslint@8.57.1` nested under `node_modules/addons-linter/` (web-ext's linter). Expected, harmless. |
| Baseline + axe | `node dev/baseline.mjs --label release-3.0.0` | **13 states × 2 themes captured, 0 axe violations in all 26.** States: ready (chatgpt, claude, copilot, google_overview, google_ai_mode_capturing), loading_data, tab_navigating, error_unsupported, error_no_conversation_id, error_content_script_not_loaded, error_no_data_google, auth_failed_claude, consent_first_run. `--compare final-3.0.0 release-3.0.0` (another agent's earlier capture of the same commit): identical axe counts in every state. Note: the compare script diffs axe-violation counts per state, not pixels; visual regressions need eyes on `dev/baselines/<label>/*.png`. |
| Failing commit between `f39910c` and `15518e3` | per-commit `run_all.js` in a detached temp worktree | `git log f39910c..15518e3` contains only `15518e3`; the range's **failing commit is `f39910c` itself**: it tracks `test_pii.js`, which imports `PII_RULESET_VERSION` from `utils/pii.js`, but that export only appears in `15518e3`. `15518e3` passes. `d6809b9` (before) has no `run_all.js`. Net: a one-commit bisect hole; harmless for the release, matters only for `git bisect`. |

### 4.0.1 Byte-identical CSV check for the PII-options refactor (`15518e3`)

Method: a Node harness (saved outside the repo at `~/release-review-3.0.0-harness/`, with README) imports `background.js` under a mocked `browser.*` (fixed donor id, frozen clock, storage stub), invokes the real `runtime.onMessage` listener with a synthetic payload and a sender tab on the right origin, and captures the ZIP handed to `downloads.download`. The same six hand-written synthetic fixtures were run against the parent commit `f39910c` (temporary detached worktree under `/tmp`) and `release/3.0.0`, with `pii_scrub_enabled` off and on (12 scenario pairs). Fixtures contain planted emails, phone numbers, IPs and UTM-tagged URLs so the scrub paths actually fire.

| Platform / path | Fixture | Scrub off | Scrub on | CSVs compared |
|---|---|---|---|---|
| Copilot (inline handler) | `copilot.json` | identical | identical | `copilot_conversation`, `copilot_messages_canonical` |
| M365 Copilot (inline handler + sources) | `m365.json` | identical | identical | `m365_copilot_conversation`, `…_messages_canonical`, `m365_copilot_sources` |
| Google AI Overview (inline handler + sources + telemetry) | `google_overview.json` | identical | identical | `google_ai_overview`, `…_canonical`, `google_sources` |
| Google AI Mode | `google_ai_mode.json` | identical | identical | `google_ai_mode`, `…_canonical`, `google_sources` |
| ChatGPT donor-context block (content fallback) | `chatgpt.json` | identical | identical | `chatgpt_donor_context`, `chatgpt_metadata`, `chatgpt_messages`, `…_canonical` |
| ChatGPT donor-context block (`user_context_message_data` path) | `chatgpt_meta.json` | identical | identical | same four |

**Every CSV in every scenario is byte-identical** (BOM, headers, rows, CRLF). The only differences are in the manifest JSON, and they are the intended additive ones: `manifest_schema_version` 1.0.0 → 1.1.0, and three new keys under `telemetry`: `pii_scrub_options` (`{}` when scrubbing is off, `{"URL": false}` when on), `pii_ruleset_version` (`"1.0.0"`), `pii_redactions_by_type` (e.g. `{"EMAIL": 3, "IP": 2}`). `pii_redactions_total` matches before/after in every scrub-on scenario. No keys removed or changed. **Refactor verified; no blocker.**

Side observations from the harness (not refactor-related):
- Google **AI Mode** exports are named `google_ai_mode_unknown_<timestamp>.csv` / `google_search_manifest_unknown_…json` because `resolveConversationId` finds no id in an AI-Mode payload (it ignores `conversation_title`). AI Overview uses the query slug. *Later*: give AI Mode a stable id (e.g. hashed title or the `udm=50` search URL). Confidence: high in the harness; medium that the real content script does not stamp an id (not checked at runtime).
- The harness exposes `ensurePerplexityContentScripts` throwing when `browser.scripting.getRegisteredContentScripts` returns `undefined` (mock artefact, swallowed by its `catch`). In Firefox the API returns an array; not a real bug.

---

### Decisions added during Part 4
- **D6.** README on `release/3.0.0` already embeds `docs/images/icon.png`, `popup-light.png` and `popup-dark.png` (lines 3, 24–25), but those files are untracked, so the GitHub README would show broken images after the push. I treat adding them on `release/3.0.0-fixes` as a documentation fix (they are harness renders with no personal data and `docs/` is excluded from the .xpi). Recommendation: keep.

### 4(d) UX and accessibility (static lens + automated runs)

Automated: baseline + axe on all 13 harness states × 2 themes = **0 violations** (see 4.0). Static review findings below (line numbers from `bbe6649`).

**Blockers:** none.

**Should-fix**

| # | Finding | Where | Conf. |
|---|---|---|---|
| D-S1 | The 2 s poll (`startPolling(2000)`) rebuilds the platform badge (`aria-live="polite"`), the whole file list (`role="status"`) and the elapsed counter inside the `aria-atomic` status card on every tick, even when unchanged. Screen-reader users hear the badge and file list re-announced every two seconds. Fix: diff-before-write (as `updateStatus` already does) and/or drop `aria-live` from badge/file list. | popup.js:512, 874, 227; popup.html:53, 130, 192 | high |
| D-S2 | Google tip is hidden at the top of `checkAndUpdateUI`, then shown again after an awaited `tabs.query`; flips `hidden` every poll → layout flicker + polite re-announcement (`#googleTip` is `role="note" aria-live`). | popup.js:1255, 1299; popup.html:178 | high/med |
| D-S3 | **Large-export confirm card is unreachable.** `confirmLargeExport` reads `state.capture?.conversations`, which nothing ever sets, so size is always `null` and it resolves `true`. The card, its CSS and manual-tests §5 "8e" describe a feature that never shows. | popup.js:1635–1639; popup.html:257; docs/manual-tests.md:115–120 | high |
| D-S4 | Jargon to participants: "The last request got a 401 — …" (`formatAuthFailureCopy`) and the popup fallback "The last request returned 401." The plainer `PLATFORM_TROUBLESHOOTING.claude.authFailed` exists but is never read. | shared/errors.js:75, 92; popup.js:1129 | high |
| D-S5 | Raw internal strings reach the status card via `detail.reason` (`invalid_data` shows `validation.error` verbatim, e.g. "ChatGPT mapping is not a plain object."; `download_failed`/`processing_failed` show sanitised exception text). | popup.js:1050, 1059, 1076; background.js:499–593, 837, 1180, 1189 | high |
| D-S6 | "Click refresh to re-capture." (AI Mode ready detail) references a control that was removed. | popup.js:1523 | high |
| D-S7 | Platform naming inconsistent: `Co-pilot` (config/settings.js:36, manifest.json:15, package.json:4) vs `Copilot` (popup.js:43, errors.js:17) — `Co-pilot` leaks into the toolbar title and the auth-failure card; `M365 Copilot` vs `Microsoft 365 Copilot`; `Google AI Overview` vs `Google Search AI Overview`. | config/settings.js:36,71,78; popup.js:43,52,108,1114; shared/errors.js:17; background.js:1473–1485 | high |
| D-S8 | `PLATFORM_TROUBLESHOOTING` lacks perplexity, mistral, m365_copilot, google_search; `claude` lacks `noConversationId` although it `requiresConversationId`. | shared/errors.js:83–109 | high |
| D-S9 | File-list copy wrong for non-ChatGPT platforms: "1 file will be downloaded" with the conversation *title* as file name; heading "N files will be downloaded" conflicts with one ZIP / "Export ZIP". | popup.js:857–872; popup.html:200, 280 | high |
| D-S10 | Harness "Export outcome" presets `no_data`, `rate_limit`, `export_failed` all render as NETWORK_ERROR because the mock *rejects* `sendMessage` instead of resolving `{success:false}`. | dev/mock-browser.js:155–175; dev/harness.html:46–53 | high |
| D-S11 | Focus-on-open race: `focusInitialTarget()` checks `exportBtn.disabled` one frame after an async `checkAndUpdateUI()`; in real Firefox the button is still disabled, so focus stays on `<body>`. Harness passes only because the mock resolves synchronously. | popup.js:2190–2199, 1958–1974 | medium |
| D-S12 | Nested live regions: spinner `role="status" aria-label="Loading"` inside the `role="status"` card (whose icon wrapper is `aria-hidden`) → double announcement. | popup.html:131, 154 | high |
| D-S13 | `aria-label` on a bare `<span class="preview-tag">` — prohibited on generic role (axe `aria-prohibited-attr` in 4.4+). | popup.html:51 | high |
| D-S14 | Label-in-name (WCAG 2.5.3): `<summary aria-label="Toggle extension information">` vs visible "About this extension"; `#exportBtn aria-label="Export conversation to ZIP file"` vs "Export ZIP" (and "Exporting..."); `#consentBtn aria-label` vs "I Agree — Continue". | popup.html:51, 122, 270, 285 | high/med |
| D-S15 | Text-field border contrast 1.44:1 light / 2.23:1 dark (WCAG 1.4.11 asks 3:1). | popup.css:41, 162, 1457 | medium |

**Later:** D-L1 dead status branches for claude/perplexity (popup.js:1412–1440, 1589); D-L2 `startCaptureTicker` never called (189); D-L3 M365 long-wait states lack the stuck helper/counter (1280, 1453, 1472); D-L4/L5 `NO_CONVERSATION_ID` on a home page renders as an assertive red error, and `role="status"`+`aria-live="assertive"` is contradictory (613–617); D-L6 badge palette only for 4 platforms + dead Gemini set; D-L7 focus-ring convention gaps (popup.css:594, 1470, 1481); D-L8 banner dismiss 22×22 px; D-L9 contrast margins (claude badge 4.51:1, success text 4.56:1; light success/warning *icons* 2.27/2.04:1, decorative); D-L10 "Network error … check your internet connection" for any non-"Receiving end" rejection (1797); D-L11 terminology drift (chat/conversation/thread, "Export complete!" vs ".", "Rate limit:" jargon, "Report issues on GitHub." without a link); D-L12 keydown Enter/Space → `click()` double-fires with key repeat (1907–1921); D-L13 `alertdialog` without modal semantics (moot until D-S3); D-L14 width media queries only meaningful in the harness; D-L15 harness state `supported_ready_google_ai_mode_capturing` actually renders the *ready* state; D-L16 `config/settings.js:13` `version: '2.1.1'` and description lists only three platforms (also package.json:4, manifest.json:15 lists four); D-L17 `sanitizeErrorMessage` port/path regexes can mangle benign copy.

**Verified good:** reduced-motion override; Escape handling incl. consent panel and text-input blur; consent checkbox `required`, button disabled until checked, focus on checkbox first run; every `<details>` labelled; PII toggles and study-code input labelled; decorative SVGs hidden; status meaning carried by text; toolbar title set alongside icon. Consent-gate copy (popup.html:82–124) appears nowhere else in the repo, so nothing can drift from it. No "review/preview your ZIP" copy anywhere in popup.html/popup.js.

**Harness coverage (verified):** 13 states; ready fixtures only for ChatGPT, Claude, Copilot, Google Overview, Google AI Mode; no fixtures for Perplexity, Grok, DeepSeek, Mistral, M365 Copilot. Not renderable in the harness: all `EXPORT_RESULT` outcomes (mock `onMessage.addListener` is a no-op), auth-failed for non-Claude platforms, export-time `EXPORT_FAILED`/`NO_DATA_AVAILABLE`, rate-limit, `NO_ACTIVE_TAB`/`PERMISSION_DENIED`/`UNKNOWN_ERROR`, every M365 state, dismissed preview banner.

### 4(b) Privacy and security of the extension

**Headline:** no code path sends conversation data, tokens or cookies anywhere but the user's own disk. No remote fonts/CDN, no analytics, no `chrome.*`, no `eval`/`new Function`, no third-party bundled code, no `update_url`, strict CSP. The problems are an error-path bug in the background script, network behaviour that the reviewer notes deny, Perplexity shipping in debug mode, and reviewer-facing docs that the code contradicts. The coordinator re-verified B-S1, B-S3 and B-S6 directly.

**Blockers:** none strictly (the happy path is sound). B-S1 and B-S3 are the ones to fix before upload.

| # | Finding | Where | Conf. |
|---|---|---|---|
| B-S1 | **`sanitizeErrorMessage` is undefined in `background.js`.** It is called at lines 1180 and 1189 but never imported; `shared/errors.js` attaches it to `self` only in pages that load that file, and the manifest loads only `background.js` as a module. Effect: on a **download failure** the `.catch` throws `ReferenceError` before `broadcastExportResult({outcome:'download_failed'})`, so the popup never learns of it (the "Error 6a" feature from `ed7b45c` is dead); on a **processing failure** the ReferenceError replaces the original error and the `processing_failed` message is lost (the toolbar `!` badge still appears). One-line fix: `import './shared/errors.js';` as a side-effect import at the top of `background.js` (the file's IIFE already anticipates a `self` global), or export the function and import it by name. **Not applied tonight (background.js, protected zone).** See Decision D7. | background.js:1180, 1189; shared/errors.js:173–179 | high (verified) |
| B-S2 | **Google content script re-fetches the user's own search URL with cookies, repeatedly.** `fetch(window.location.href, {credentials:'include'})` runs whenever DOM extraction finds no overview, with no negative cache: on every `/search` load, every URL-change poll, every debounced DOM mutation burst and **every 2 s popup poll** (`GET_CAPTURED_CONVERSATIONS` → `needFetch`). Same-origin, the user's own query, no exfiltration, but it is extension-generated traffic to Google that `docs/amo-reviewer-notes.md` explicitly denies ("No search queries are sent to Google by the extension"), and it could plausibly trip rate limits/CAPTCHA or pollute search history. Fix: cache negative results per key / fetch at most once per page, and correct the docs. | platforms/google_search/content.js:512–547, 583–637, 650; popup.js:1510, 2176 | high (behaviour), medium (frequency) |
| B-S3 | **Perplexity ships with debug on.** `IS_PRODUCTION=false; DEBUG_MODE=true` in both `platforms/perplexity/inject.js:23–24` and `content.js:18–19` (all 15 other platform files are `true`/`false`). Consequences: unconditional `console.log` lines (8-char id prefix + HTTP status; no message text, verified), a page-visible `window.__perplexityExporterProbe`, and a `data-perplexity-exporter-content-loaded` attribute. Flip both flags and remove the probe before AMO submission. Protected zone; not applied. | platforms/perplexity/inject.js:23–24, 35–44; content.js:18–30 | high (verified) |
| B-S4 | **Reviewer notes / README contradict the code.** (i) notes:95–100 and README:130 say CSP `connect-src 'none'` means zero outbound calls — CSP covers extension pages only; content scripts make same-origin fetches on claude.ai (`/api/organizations…`), DeepSeek, Grok, Mistral (tRPC) and Google. (ii) notes:106–109 "hooks are read-only observers, do not fetch anything new" — true for `inject.js`, false for the content scripts' active fetch on load / SPA nav / popup poll / export. (iii) notes:84–86 justify broad Google `host_permissions` with a "background re-fetch" that does not exist (background cannot fetch under its CSP; same-origin content-script fetch needs no host permission) — Google host permissions could be narrowed to `/search*`. (iv) notes:88–91 "no search queries are sent to Google" — see B-S2. (v) notes:115–116 "validates the signature + nonce" — the nonce is signed but never recorded or compared; only the 30 s timestamp window is enforced. (vi) notes:5 cites `background.js:1354–1424`; actual block is 1355–1438. (vii) `popup.html:9–33` comment claims periodic integrity verification "implemented in background.js" and points to a non-existent `SECURITY.md`; the check actually lives in `popup.js:2256–2305`, runs once, and its `window[funcName]` lookup always fails inside a module. Doc items (i)–(vi) are fixable in Part 5 where they are pure wording. | docs/amo-reviewer-notes.md:5, 84–116; README.md:130; popup.html:9–33 | high |
| B-S5 | **Perplexity may be injected up to three times** (manifest `content_scripts` + `scripting.registerContentScripts` + `scripting.executeScript` on every `tabs.onUpdated` loading event). The comment "Firefox dedupes matching script IDs" only covers registerContentScripts vs itself. Neither Perplexity file has an install guard; N `content.js` instances = N `onMessage` listeners → potentially N ZIPs per export; N `inject.js` instances chain-wrap `fetch` with different secrets. Needs a real-Firefox check (manual test). | background.js:1363–1438; platforms/perplexity/{inject,content}.js | medium |
| B-S6 | **Provenance strings stale.** `utils/manifest.js:9 EXTRACTOR_VERSION = '2.1.1'` is written into every `_manifest.json` and every CSV `extractor_version` column while the add-on is 3.0.0. Also `config/settings.js:13 version: '2.1.1'` and the `manifest.json` description lists only four platforms. For a research artefact the extractor version in the manifest must match the release. `utils/manifest.js` is protected zone → Decision D8; `config/settings.js` and `manifest.json` description handled in Part 5. | utils/manifest.js:9; config/settings.js:13; manifest.json:15 | high (verified) |
| B-S7 | No `strict_min_version`, although `world: "MAIN"` content scripts and `scripting.executeScript({world})` need Firefox ≥ 128. On older Firefox the inject scripts would run isolated and hook nothing, failing silently. Adding `strict_min_version: "128.0"` is a manifest change (not a permission); see Decision D9. | manifest.json `browser_specific_settings.gecko` | medium |

**Later:** B-L1 ungated `console.*` in background.js (lines 10, 1370–1437, 1564; tab ids only); B-L2 `GET_AUTH_STATE` accepts any tabId from any extension context (add `!sender.tab` check); B-L3 HMAC nonce unused → 30 s replay window (no forgery possible); B-L4 secret handoff attribute could be raced by another document_start extension (low value to an attacker who already has the page); B-L5 page-visible globals (`window.MessageSecurity`, `__m365CopilotDebug` exposing `chatTitle`, `__mistralExporterIsInterestingRequest`, `__perplexityExporterProbe`) make the extension fingerprintable; B-L6 `tabs` is probably droppable (host_permissions + `urls:` filters suffice; ux-audit §7 agrees) and `activeTab` adds nothing on top; B-L7 `config/settings.js` Google domains match every `*.google.<tld>` subdomain, so the toolbar lights up on mail./docs./drive.google.com and then the popup says CONTENT_SCRIPT_NOT_LOADED; B-L8 `pii_scrub_options` is read but never written by any UI (URL stripping is therefore always off — consistent with the docs, but the option is dead), `study_salt` stored in plaintext in `storage.local`, and without a salt the raw persistent `donor_id` UUID goes into every CSV (cross-study linkable by design; state it in METHODS); B-L9 object URL revoked 1 s after `download()` resolves (Firefox snapshots blobs; low); B-L10 `updates.json` tracked, unreferenced, excluded from the build — delete; B-L11 six content scripts carry their own copy of `verifySignature` instead of `MessageSecurity`.

**Verified facts (quotable):**
- CSP `extension_pages`: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. No `update_url`. `data_collection_permissions.required: ["none"]`. No `strict_min_version`. No `web_accessible_resources`. Background is an event page (`scripts` + `type: module`), not a service worker.
- Google: `content_scripts.matches` are all `https://www.google.<tld>/search*` (10 TLDs); `host_permissions` are the same hosts with `/*`; the in-script guard `currentQuery()` requires `pathname === '/search'` and a non-empty `q`. **Google content scripts only act on /search pages**; the broader host permission is unused.
- `scripting` is used only in `background.js:1366–1438` for Perplexity (`registerContentScripts` + `executeScript` of the three shipped files, `injectImmediately`). The reviewer-note claim "only injects files already declared in the manifest" is accurate; the *reason* it is needed (document_start timing on Perplexity's SPA) is plausible but the triple-injection (B-S5) undermines it.
- Network calls in shipped code: passive `window.fetch`/XHR wrappers (7 platforms) and a `WebSocket` proxy (M365, instrumenting only `wss://substrate.office.com/m365Copilot/Chathub/*`; the socket URL containing `access_token` is kept in memory and never exported); **active same-origin fetches** in claude, deepseek, grok, mistral and google content scripts; none in background/popup. No `sendBeacon`, `Image()`, or `src=` assignment.
- Storage keys (`browser.storage.local` only; nothing in `storage.session`; content scripts use no storage): `consent_given`, `donor_id` + `donor_id_created` (regenerated after 365 d), `pii_scrub_enabled`, `pii_scrub_options` (read only), `include_donor_context`, `study_salt` (≤256 chars, plaintext), `preview_banner_dismissed`. No conversation content, tokens, cookies or headers persisted; captures live in content-script `Map`s (max 50, 1 h TTL).
- Downloads: in-house STORE-only ZIP writer (`utils/zip.js`) → Blob → `downloads.download({filename: <platform>_<slug>.zip, saveAs:false})`; filename slug is sanitised to `[A-Za-z0-9_-]`, ≤40 chars. Nothing else is written to disk.
- Message passing: inject→content messages are HMAC-SHA256 signed with a 32-byte secret generated in the MAIN world at document_start and handed over via a `data-*-exporter-secret` attribute that content.js reads and removes; listeners check `event.source === window`, `origin`, type, source, 30 s window, constant-time compare. content→background: `sender.id === runtime.id`, `sender.tab.url` present, `frameId === 0`, `https:`, hostname matches the platform's domain list (fixed type→platform map); `AUTH_FAILED`/`AUTH_RECOVERED` validate `message.platform` the same way. Popup→content only via `tabs.sendMessage` to the active tab; all DOM sinks are `textContent`/`createElement` (`innerHTML` only ever set to `''`).
- **D7.** `background.js` calls `sanitizeErrorMessage` without importing it (B-S1), so download/processing failures never reach the popup. The fix is one line (`import './shared/errors.js';`) but it is in `background.js`, which you asked me not to touch. Recommendation: apply it on `release/3.0.0` yourself, re-run `npm test` + `web-ext lint`, and test one forced download failure (set Downloads to a read-only folder). If you would rather not, ship anyway: exports still work, only the failure *message* is lost.
- **D8.** `EXTRACTOR_VERSION` in `utils/manifest.js` is still `'2.1.1'` and is stamped into every manifest and CSV (B-S6). Protected zone, not touched. Recommendation: bump to `'3.0.0'` before publishing; golden tests import the constant, so they stay green. A 3.0.0 export that says extractor 2.1.1 is a provenance error for the study.
- **D9.** `manifest.json` has no `strict_min_version` although MAIN-world content scripts need Firefox 128+ (B-S7). Adding one is a manifest edit (not a permission change) but AMO treats compatibility as listing metadata; I left it. Recommendation: add `"strict_min_version": "128.0"` in the same commit as D7/D8.

### 4(a) Correctness

**Platform coverage matrix (verified by the lens, spot-checked by the coordinator)**

| Platform | manifest + files | background dispatch | Golden test tracked | Synthetic fixture | README | STUDENT_GUIDE | METHODS | AMO notes | CHANGELOG | Harness ready | Harness idle |
|---|---|---|---|---|---|---|---|---|---|---|---|
| chatgpt | yes | yes | **no** (local, gitignored, real-origin fixture) | **no** | yes | yes | yes | yes | yes | yes | yes |
| claude | yes | yes | yes | yes | yes | yes | yes | yes | yes | yes | no |
| copilot | yes | yes (inline) | no | no | yes | yes | yes | yes | yes | yes | no |
| m365_copilot | yes | yes (inline) | no | no | yes | **no** | **no** | yes | yes | **no** | no |
| perplexity | yes (+ scripting) | yes | yes (+ extractor test) | yes | yes | **no** | **no** | yes | yes | **no** | no |
| grok | yes | yes | yes | yes | yes | **no** | **no** | yes | yes | **no** | no |
| deepseek | yes | yes | yes | yes | yes | **no** | **no** | yes | yes | **no** | no |
| mistral | yes | **NO** | yes | yes | yes | **no** | **no** | yes | yes | **no** | no |
| google_search | yes (10 locales, `/search*`) | yes (inline) | no | no | yes | yes | yes | yes | yes | yes (overview + AI mode) | no |

Expectations confirmed: tracked golden tests exist only for Claude, Perplexity, Grok, DeepSeek, Mistral; harness "ready" states only for ChatGPT, Claude, Copilot, Google. Only idle state is ChatGPT's `supported_loading_data`. `METHODS.md:7` and `STUDENT_GUIDE.md:22–25` document four platforms; `METHODS.md:7` also claims the other platforms "produce a single flat messages CSV", which is false (Claude up to 5 files, Perplexity/Grok/DeepSeek 3–4, M365 2–3).

**Dispatch table:** all nine content scripts send `<PLATFORM>_CONVERSATION_DATA`; eight are in `MESSAGE_TYPE_TO_PLATFORM` (background.js:1208–1217); **`MISTRAL_CONVERSATION_DATA` is not**, and Mistral also lacks a `validateConversationData` case, a handler branch, an extractor import, `SCHEMA_VERSIONS` and `DEFAULT_SCRUB_COLUMNS` entries. `AUTH_FAILED`/`AUTH_RECOVERED` are sent only by `claude/content.js`.

**Refactor 15518e3:** code reading agrees with the harness result in 4.0.1: `scrubText(text, {stripUrls:false})` is byte-equivalent to the old call (`utils/pii.js:146,155`); the donor-context block and the inline handlers only gained the options argument and `mergeScrubCounts`; no header arrays touched. Verified byte-identical.

**Findings**

| # | Sev. | Finding | Where | Conf. |
|---|---|---|---|---|
| A-B1 | **blocker** | Mistral export is dead end-to-end **and reports false success**: `mistral/content.js:396–401` resolves `sendResponse({success:true})` as soon as `runtime.sendMessage` resolves (which it does even though background dropped the message), so the popup shows "Export complete! Check your Downloads folder." and auto-closes after 3 s (popup.js:1801–1819). No ZIP is written. | background.js:12–66, 497, 1111, 1208–1217; platforms/mistral/content.js:18, 396–401; utils/manifest.js:11–44; utils/pii.js:86–108 | high (verified) |
| A-B2 | **blocker** | **PII scrubbing does not reach the canonical CSVs for Claude, Perplexity, Grok and DeepSeek.** The extractors build `messagesCanonicalCSV` from the raw payload and background pushes it unchanged (background.js:953, 976, 999, 1022), while the manifest records `pii_scrub_enabled: true` and a non-zero redaction count. Only ChatGPT rebuilds canonical from scrubbed rows (878–884); Copilot/M365/Google build canonical from scrubbed rows. Raw-JSON side columns (`raw_block_json`, `tool_input_json`, `settings_json`, `raw_message_json`, `feedback_json`, `raw_json`, `adaptive_cards_json`, `content_chunks_json`) are also outside `DEFAULT_SCRUB_COLUMNS`, so every "scrubbed" export still carries the original text. ChatGPT `chatgpt_sources` title/snippet and `chatgpt_message_urls` are not scrubbed either, although Claude's equivalents are. Contradicts popup.html:235 "Remove sensitive data from the exported files", README:144, STUDENT_GUIDE:46/368, CHANGELOG:18. Coordinator verification by harness: see 4.0.2 below. Protected zone (PII scrubbing + CSV output) → not fixed tonight; Decision D10. | background.js:878–884, 953, 976, 999, 1022; utils/pii.js:86–108; platforms/{claude,perplexity,grok,deepseek}/extractor.js | high (verified) |
| A-S1 | should-fix | **Toolbar icon state feature is dead.** `applyIconStateForTab` calls `getPlatformByUrl(url)` (background.js:1479) but `background.js:44` imports only `EXTENSION_CONFIG`; `getPlatformByUrl` is exported from `config/settings.js:127` and never imported. Every call with a string URL throws `ReferenceError` outside the `try`; `tabs.onUpdated` and the startup loop do not catch it. Net: icon never greys/colours, per-tab title never set. Introduced in `0ef9835`; masked by `eslint.config.mjs:27` declaring it a global. CLAUDE.md lists icon transitions as manual-test-only, which is why nobody saw it. One-line fix: `import { EXTENSION_CONFIG, getPlatformByUrl } from './config/settings.js';`. Same file as D7 → Decision D7 extended. | background.js:44, 1479, 1525, 1559; eslint.config.mjs:27 | high (verified) |
| A-S2 | should-fix | `sanitizeErrorMessage` undefined in background.js (= B-S1). The lens adds: in the download `.catch` the ReferenceError becomes an unhandled rejection with **no badge either**, because `handleConversationData` already resolved and cleared the badge. | background.js:1174–1194, 1309–1314 | high |
| A-S3 | should-fix | Stale metadata: manifest description names 4 platforms; `config/settings.js:12` `version: '2.1.1'`; `EXTRACTOR_VERSION = '2.1.1'`. | manifest.json:14; config/settings.js:12–14; utils/manifest.js:9 | high |
| A-S4 | should-fix | Popup ZIP preview disagrees with the ZIP: Claude/Copilot/M365/Google get a generic one-row fallback; every platform's "N files" heading omits the canonical CSV and manifest; Mistral described although nothing is produced. | popup.js:724–872 | high |
| A-S5 | should-fix | Google AI Mode exports get `conversation_id: null` and an `unknown_<ts>` filename (payload has only `conversation_title`; `resolveConversationId` ignores it). Confirms the harness side-observation in 4.0.1. | platforms/google_search/content.js:413–424; background.js:94–124 | high |
| A-S6 | should-fix | `escapeCSVField` silently prefixes `'` to any cell starting with `= + - @ \|`, tab/CR/LF or fullwidth variants, including message `text`. "- item" becomes "'- item"; the manifest SHA-256 covers the mutated text. Undocumented in METHODS/STUDENT_GUIDE/README. | utils/csv.js:36–45 | high (behaviour) |

**Later:** A-L1 mixed line endings inside one ZIP (`generateCSV` uses `\n`, no trailing newline — copilot/m365/google flat files and `chatgpt_metadata`/`chatgpt_donor_context`; everything else `\r\n`); A-L2 `mistral/extractor.js:83–85` comment promises a secondary sort by `turn` that is not implemented; A-L3 `config/settings.js` domains broader than the manifest (`perplexity.ai` apex vs `www.`; every `*.google.<tld>` subdomain); A-L4 local `npm test` and CI run different suites (gitignored ChatGPT golden); A-L5 silent return with no broadcast when `csvFiles.length === 0`, and an all-rows-throw Copilot payload would ship an empty CSV; A-L6 harness lacks idle/ready states for five platforms; A-L7 code comment at background.js:129–134 says `pii_scrub_options` "always has the same shape" but it is `{}` when scrubbing is off (METHODS documents the `{}` correctly).

### 4(c) Research integrity

**Blockers:** C-B1 = A-B1 (Mistral, false success). C-B2/C-B3 = A-B2 (canonical CSVs and raw-JSON columns unscrubbed). The lens adds that the canonical file is precisely the one `STUDENT_GUIDE.md:100–105` tells researchers to pool across platforms, and that DeepSeek `platform_specific_json.thinking_text` and Perplexity `code_text`/`reasoning_text` inside canonical rows are also raw.

**Should-fix**

| # | Finding | Where | Conf. |
|---|---|---|---|
| C-S1 | `escapeCSVField` formula-injection prefix alters data (= A-S6); document the exact character list or remove it and document the spreadsheet caveat. | utils/csv.js:35–43 | high |
| C-S2 | `extractor_version` 2.1.1 in a 3.0.0 release; `STUDENT_GUIDE.md:122` ("Current `2.1.1`") and `:352` make it a provenance field. (= B-S6, D8) | utils/manifest.js:9 | high |
| C-S3 | Claude canonical `text` concatenates thinking blocks and tool results with the reply (`extractBlockText` returns `block.thinking`), while METHODS:15 says only `type: 'text'` blocks are joined and STUDENT_GUIDE:339 says "full concatenated text of the message". Material for content analysis; document or restrict. | platforms/claude/extractor.js:84–108, 485 | high |
| C-S4 | METHODS.md stale: lists 4 platforms (:7) and the false "single flat CSV" claim; says orphaned-node count "is not reported" (:11, :53) but it is (`num_orphaned_nodes`, `telemetry.orphaned_nodes`); :51 tells researchers to set `pii_scrub_options.URL` "in extension storage" although no UI writes it (unreachable for participants); :55 says Copilot model id is not recorded (canonical uses `mode`); :49 lists `NAME` as a possible by-type key but names are never passed; no extraction method for Perplexity, Grok, DeepSeek, M365, Mistral; `text_cleaned` undocumented everywhere. | METHODS.md:7, 11, 46–55 | high |
| C-S5 | STUDENT_GUIDE.md vs code: 4 platforms (:21–26); "Click **Export this chat**" (:41) vs button "Export ZIP"; donor context "off by default" (:48) vs default ON; "13 columns" (:100, :328) vs 14; `manifest_schema_version` "Currently 1.0.0" (:351) vs 1.1.0; `donor_id_hashed` "without exposing the raw ID" (:356) — with a salt it equals `donor_id`, without one the raw UUID is in every row anyway; "line endings `\r\n`" (:89) is only true for some files; :38 points to "Load Temporary Add-on" instead of AMO. | STUDENT_GUIDE.md | high |
| C-S6 | README: "No DOM scraping … what you see is what you export" (:92) contradicts the DOM-based Google capture (:135, AMO notes:126–131); "every CSV starts with the same five donor columns" (:118) is false for canonical files; "cross-study joins are blocked" (:142) only holds with distinct salts. | README.md:92, 118, 142 | high |
| C-S7 | "Anonymization" wording: AMO notes:64–65, background.js:147 comment; popup.html:246 "keeping your identity hidden" (study-code label, outside the consent gate — the salt prevents cross-study linkage, it does not hide identity). CHANGELOG:17 gets it right ("pseudonymous, not anonymous"). | docs/amo-reviewer-notes.md:64–65; popup.html:246 | high |
| C-S8 | Consent gate "What data is collected" (popup.html:87–92) under-describes the export: not mentioned are extracted text of uploaded files (`claude_attachments.extracted_text`), extended-thinking/reasoning text, tool inputs/results, conversation settings, raw message frames. `consent_given` is a bare boolean with no consent-text version or timestamp. **Methodological; flagged to the PI, not edited.** | popup.html:87–92; popup.js:2126 | high |
| C-S9 | ChatGPT scrub coverage inconsistent (`chatgpt_metadata.title`, `chatgpt_sources.title/snippet`, `chatgpt_message_urls` never scrubbed). | utils/pii.js:86–88 | high |
| C-S10 | Popup "What's in the file?" says `_manifest.json`; actual name `{platform}_manifest_{slug}.json`; inner CSV names are `{platform}_{schema}_{slug}.csv`, not `metadata.csv` (also CHANGELOG:9). | popup.html:318–328; CHANGELOG.md:9 | high |

**Later:** AMO-notes line references drift (`background.js:1354–1424` vs ~1360–1432); `text_cleaner.js` deletes U+202F/U+2028/9 without a space and strips generics like `List<String>` (raw `text` preserved; document); the 50 MB payload cap is undocumented; CHANGELOG:18 "links are kept intact" except URLs with embedded credentials; STUDENT_GUIDE:3 disclaims itself as "AI-generated, not authoritative"; background has no consent check of its own (popup gate only; acceptable, since no non-popup caller can emit `EXPORT_CONVERSATION`).

**Verified good:** no "review your ZIP / preview before saving" claim anywhere (ux-audit.md:234 records the deferral); no "fully anonymous"/"all personal data removed"/"no data stored" claims; `study_salt` never written to the ZIP or manifest; `pii_scrub_options`/`pii_redactions_by_type` vocabularies consistent (UPPERCASE; `URL` ↔ `stripUrls`); URL stripping off by default; manifest fields live under `telemetry` (table in the lens report, matches the harness output in 4.0.1).

**Donor-ID flow (verified):** `donor_id` UUID generated on first export, stored in `storage.local`, regenerated after 365 days (session-scoped fallback if storage fails). `study_salt` is free text the participant types into "Study code"; stored in plaintext in `storage.local`; never written to the ZIP. `donor_id` column = raw UUID without a salt, HMAC-SHA256(uuid, salt) with one. Manifest `donor_id_hashed` = SHA-256(uuid) without a salt, the same HMAC with one. Accurate description: pseudonymous, stable per install, cross-study-unlinkable only with distinct salts.

### 4(f) Release readiness

**Blockers (lens):** F-B1 = Mistral (A-B1). F-B2 = `EXTRACTOR_VERSION` 2.1.1 (D8). F-B3 = no `strict_min_version` with MAIN-world content scripts (Firefox ≥ 128; D9). Coordinator classification: B1 blocker; B2 blocker for research provenance unless Daniel declares extractor versioning independent; B3 should-fix (on Firefox < 128 everything but Google fails silently, but AMO's current ESR/release are ≥ 128).

| # | Sev. | Finding | Where | Conf. |
|---|---|---|---|---|
| F-S1 | should-fix | Stale shipped metadata: `config/settings.js:13–15` version 2.1.1 + 3-platform description; `manifest.json:15` description lists 4 platforms (this is the about:addons text); `package.json:4` same. | as cited | high |
| F-S2 | should-fix | STUDENT_GUIDE:122 "Current 2.1.1", :351 schema 1.0.0; STUDENT_GUIDE and METHODS have zero mentions of five platforms while CHANGELOG:16 sends researchers to METHODS for the schema. | as cited | high |
| F-S3 | should-fix | CHANGELOG permission section says "three categories" (tabs, scripting, 10 Google hosts) but omits the **five new non-Google host permissions** (`www.perplexity.ai`, `grok.com`, `chat.deepseek.com`, `chat.mistral.ai`, `m365.cloud.microsoft`) that also trigger the re-approval prompt; CHANGELOG:9 names inner files `metadata.csv` etc. | CHANGELOG.md:9, 22–26 | high |
| F-S4 | should-fix | README:135 "declining the prompt disables the Google capture only" is probably wrong: declining a new-permissions prompt on update blocks the whole update (user stays on 2.1.1). Verify with a real 2.1.1→3.0.0 update or delete the sentence. | README.md:135 | medium |
| F-S5 | should-fix | AMO reviewer notes: `:111–112` says chatgpt/copilot inject.js hook XHR (they do not); `:84–86`/`:130–131` background re-fetch justification is wrong (= B-S4); `:90–91` vs `:126` contradiction; `:138` says release branch is `ux-audit-pass`; `:45–47` "paste the sections below" sits after the `scripting` section; `:51` counts Mistral; `:139–143` ignore list incomplete (also `testing/`, `test/`, root `*.md`, `updates.json`, `submission.zip`). | docs/amo-reviewer-notes.md | high |
| F-S6 | should-fix | Perplexity debug flags + triple injection without idempotency guard (= B-S3/B-S5). | platforms/perplexity/*, background.js:1374–1429 | medium |
| F-S7 | should-fix | **CI will fail:** `.github/workflows/ci.yml:18,34` set `cache: 'npm'` but `package-lock.json` is gitignored (`.gitignore:197`); `actions/setup-node` errors "Dependencies lock file is not found" when `cache` is set without a lockfile. Either track the lockfile or drop `cache:`. Verified by the coordinator (file read). Fixable in Part 5 (config error). | .github/workflows/ci.yml:18, 34 | high |
| F-S8 | should-fix | README images broken (`docs/images/*` untracked) — see D6, fixed in Part 5. | README.md:3, 24–25 | high |
| F-S9 | should-fix | Packaging: `.gitignore`-only patterns with no `web-ext` counterpart would ship if present on disk: root `*.csv` exports, `*.log/*.tmp/*.bak`, `.env*`, `secrets.json`, `*.key/*.pem/*.cert`, `coverage/`, `dist/`, `build/`, `.idea/`. None present now. Add them to `ignoreFiles` (Part 5, config). | web-ext-config.mjs | high |

**Later:** `updates.json` vestigial (1.0.0, GitHub xpi link; not shipped); root `icon.png` ships but is unreferenced (manifest uses `icons/`); no `homepage_url`; `test/` on disk holds four real-looking ChatGPT export CSVs (ignored by git and web-ext; names only checked); CHANGELOG omits shipping changes (large-export card `50a20f0` — which is unreachable anyway per D-S3, consent gate `76a8cc3`, toolbar `!` badge `0ef9835`, `text_cleaned`/validators `ee56dd9`, Claude one-row-per-content-block `325d597`); "Development Preview" wording consistent across popup/README/CLAUDE.md/AMO notes.

**Verified facts:** version table — `manifest.json:4` 3.0.0 ✓, `package.json:3` 3.0.0 ✓, `CHANGELOG.md:3` ✓, `utils/manifest.js:9` **2.1.1**, `config/settings.js:13` **2.1.1**, `MANIFEST_SCHEMA_VERSION` 1.1.0 ✓, `PII_RULESET_VERSION` 1.0.0 ✓, `STUDENT_GUIDE.md:122` **2.1.1**, `:351` **1.0.0**, `METHODS.md:39` 1.1.0 ✓, AMO notes 3.0.0 ✓, `updates.json` 1.0.0 (vestigial). Manifest diff 2.1.1 → 3.0.0: `permissions` + `tabs`, + `scripting`; `host_permissions` + 5 chat hosts + 10 Google locales; `content_scripts` + 13 entries; `data_collection_permissions` unchanged `["none"]`; icons `icon.png`@48 → `icons/*`; `action.default_title` "Export Chat" → "AI Chat Exporter". Firefox minimum implied by the code: **128** (MAIN-world content scripts), not declared. Predicted .xpi contents match the actual build listed in 4.0.

### 4.0.2 Coordinator verification of the PII-scrub blocker (A-B2 / C-B2)

Ran the tracked synthetic Claude fixture with a planted address appended to the first message through `release/3.0.0`'s `background.js` (same Node harness as 4.0.1) with `pii_scrub_enabled: true`:

| ZIP entry | Planted email present? | `<REDACTED:EMAIL>` present? |
|---|---|---|
| `claude_metadata_*.csv` | no | no |
| `claude_messages_*.csv` | **no** | yes |
| `claude_messages_canonical_*.csv` | **YES, in clear** | no |
| manifest `telemetry` | `pii_scrub_enabled: true`, `pii_redactions_total: 2`, `by_type: {EMAIL: 2}` | — |

So a participant who ticks "Remove sensitive data" and hands over the ZIP ships their raw text in the canonical file (the one the student guide tells researchers to pool), and the manifest certifies the opposite. **Confirmed blocker.** Same code path for Perplexity, Grok and DeepSeek (lines 976, 999, 1022). Raw-JSON side columns were not exercised by this run but are unscrubbed by construction (`DEFAULT_SCRUB_COLUMNS` lists text columns only).

### 4(e) Code health (report only)

The lens's four "functionally broken" items duplicate A-S1 (icon feature dead: `getPlatformByUrl` not imported), A-S2/B-S1 (`sanitizeErrorMessage`), A-B1 (Mistral) and B-S3 (Perplexity debug). New insight: **`eslint.config.mjs:13–33` declares `getPlatformByUrl`, `sanitizeErrorMessage`, `ERROR_TYPES`, `logDebug`… as `readonly` globals for every file**, which disables `no-undef` exactly where `background.js` forgot its imports. Scope those globals with `files:` blocks (popup.js + content scripts) so `background.js`, extractors and utils stay strictly import-checked. (Config change, but it would turn two hidden bugs into lint errors, so it belongs with the D7 fix, not in Part 5.)

**Dead code (verified by the lens; coordinator spot-checked Gemini + `updates.json`):**
- popup.js: `startCaptureTicker` (189, never started; `stopCaptureTicker` called at 1515/1550/1573), `stopPolling` (1165), `maintainFocus` (1980), `handleFocusDuringStateChange` (2068); `verifyNoKeyboardTraps`/`setupTabOrder` only log; `verifyRuntimeIntegrity` (2256–2308) tests `window.detectPlatform`, which can never exist in a module → always "failed", silently; `popup.html:24–34` header comment describes integrity checks that do not exist and points to a missing `SECURITY.md`.
- Content/inject: `logError` unused in chatgpt/claude/copilot content.js; `normalizeText` (google_search/content.js:201); `isMessageAllRequest`/`isChatByIdRequest` (mistral/inject.js:118,122); unused imports `scrubRows` (background.js:58) and `toIsoUtc` (chatgpt/extractor.js:20).
- Files/exports: `utils/helpers.js` (190 lines, CommonJS, imported by nothing, ships in the .xpi); `utils/csv.js` `generateFilename`/`createCSVBlob`; `shared/logger.js` `logInfo`/`logWarn`/`LogLevel`; `config/settings.js` `getEnabledPlatforms`, `.csv`, `.debug`, `.description`, `.version`, `contentScript`/`injectScript` fields; `updates.json`.
- popup.css: legacy `.status*` (343–376), `.info*` (426–450), `.hidden` (456), `.visually-hidden` (460) reported unused (**not removed tonight; only the Gemini set was independently verified**); `.platform-badge--gemini` + `--badge-gemini-*` ×3 (removed in Part 5); `.platform-badge--perplexity` uses hard-coded hex without dark tokens; no badge rules for grok/mistral/m365_copilot/google_search although `popup.js:522` builds `platform-badge--${id}` dynamically; duplicated `.btn`/`.btn--primary` blocks (382–420 vs 905–985; first disabled style dead); duplicate "CONSENT PANEL" header; 8 tokens defined ×3 and never used (`--font-weight-normal`, `--space-xl`, `--space-2xl`, `--radius-lg`, `--transition-slow`, `--shadow-sm/md/lg`).
- popup.html: `#privacySettings` unreferenced.

**Duplicated helpers (table from the lens, abbreviated):** per-platform logger + `redactSensitiveData` (16 files → `shared/logger.js` factory); MAIN→ISOLATED secret handoff (8 inject + 8 content → `message-security.js`); hand-rolled `verifySignature` in 6 content scripts (chatgpt/perplexity already use `MessageSecurity`); `storeConversation`/`cleanupOldConversations` LRU (6 files); `validateResponse` (7 inject.js, 5 byte-identical); fetch-arg→URL extraction; safe-id and UUID regex literals (7+ files, popup.js ×4); `stripUtmParams` (6 extractors byte-identical + 2 inline copies in background.js); `toJsonCell` (4 extractors); `normalizeRole` (4 extractors + 2 handlers, 3 variants); `safeGet`, `unixToISO`/`toIsoUtc`; `IS_PRODUCTION`/`_console` shim (popup + background); ad-hoc `assert` harness in every test file.

**Debug leftovers / TODOs:** no `debugger`, no FIXME/XXX/HACK, no commented-out blocks ≥ 5 lines. One stale TODO: `METHODS.md:55` says the orphaned-node count "is not reported (TODO)" but it is (`num_orphaned_nodes`, `telemetry.orphaned_nodes`). Raw `console.*` outside the loggers: `background.js:10`, `1370–1437` (Perplexity scaffolding), `1564`; Perplexity inject/content (B-S3).

**ESLint:** measured 103 warnings (lens predicted ~108): 98 `no-unused-vars` (the bulk are unused `catch (e)` bindings — ESLint 9 defaults `caughtErrors: "all"` and the config sets `argsIgnorePattern`/`varsIgnorePattern: '^_'` but not `caughtErrorsIgnorePattern`), 4 `prefer-const`, 1 other. One-line fix: add `caughtErrorsIgnorePattern: '^_'` to the rule options (config change; left for Daniel since it also hides real unused catches — Decision D12). Two ESLint versions: 9.39.5 (ours) and 8.57.1 under `addons-linter` (required by web-ext); nothing to fix. `--ext .js` is accepted by 9.39.5 in flat-config mode.

**npm audit:** 13 dev-only advisories, all transitively via `web-ext` (see 4.0). `npm audit fix` claims fixes are available; not applied tonight (dependency change).

**Failing commit:** `f39910c` (see 4.0) — the lens independently reached the same conclusion (its `test_pii.js` imports exports that only arrive in `15518e3`; `test_manifest.js` also asserts schema 1.1.0 before the bump). Caveat it raised and I confirm: the gitignored `test_chatgpt_golden.js` is picked up by `run_all.js` at every local checkout, so local per-commit runs can fail for unrelated reasons at older commits.

### Decisions added after the lens reports
- **D10. PII-scrub blocker (A-B2/C-B2, verified 4.0.2).** The canonical CSVs for Claude, Perplexity, Grok and DeepSeek and every `raw_*`/`*_json` column bypass scrubbing while the manifest says scrubbing was on. Protected zone (PII + CSV output), so untouched. Options: (a) fix the code before 3.0.0 — scrub at row level before *any* CSV is generated, or regenerate the canonical CSV from scrubbed rows the way the ChatGPT branch already does (background.js:878–884), and either scrub or drop the raw-JSON columns when scrubbing is on; (b) ship 3.0.0 with the PII checkbox copy and README/STUDENT_GUIDE/METHODS/CHANGELOG changed to say scrubbing covers only the `text`/`text_cleaned`-type columns of the platform-specific CSVs and **not** the canonical CSVs or raw JSON columns. Recommendation: (a); it is a research-integrity defect in a feature participants are told to rely on. If (b), I would also hide the checkbox for the four affected platforms. I did not hedge the docs tonight because the hedge becomes wrong the moment you choose (a).
- **D11. Perplexity debug flags + triple injection (B-S3/B-S5).** Two flag flips in protected content/inject scripts and an idempotency guard. Recommendation: flip the flags before upload (reviewers will see `[DEBUG]` chatter and a page-visible probe); test one Perplexity export in Firefox to see whether you get duplicate ZIPs before deciding on the guard.
- **D12. ESLint config:** add `caughtErrorsIgnorePattern: '^_'` (removes ~60 warnings) and scope the `readonly` globals per file so missing imports fail lint. Recommendation: do both in the same commit as D7; not done tonight because it changes which lint errors CI reports.
- **D13. CI config (F-S7):** I dropped `cache: 'npm'` from both jobs on `release/3.0.0-fixes` (no lockfile is tracked, so the cache step errors). Alternative: track `package-lock.json`. Recommendation: keep my change until you decide to track the lockfile.

---

## Part 5: Safe fixes on `release/3.0.0-fixes`

Branch `release/3.0.0-fixes` was created from `release/3.0.0` (`bbe6649`). Nineteen commits, one concern each. After **every** commit I ran `node testing/tests/run_all.js`, `eslint . --ext .js`, `web-ext lint`, `web-ext build` (and checked the .xpi still contains only the 50 shipping files), and for the five UI commits also `dev/baseline.mjs` (axe on 13 states × 2 themes) plus a compare against the `release-3.0.0` baseline. **All nineteen passed on the first run; nothing was reverted.** Results on the final commit: tests 11/11 files (130 assertions), ESLint 0 errors / 103 warnings (unchanged), web-ext lint 0/0/0, axe 0 violations.

| # | Commit | Concern | Files |
|---|---|---|---|
| 1 | `170483c` | `.gitignore`: add `.claude/` and `*.har`; delete the stray `tests` / blank / `https:` block (lines 71–124). Verified afterwards that no previously ignored file became visible. | .gitignore |
| 2 | `3862c77` | Remove dead Gemini badge tokens (×3 palettes) and `.platform-badge--gemini` rules. Baseline + axe clean. | popup.css |
| 3 | `5d7c375` | Add `CITATION.cff` from the WIP snapshot with `version` corrected to 3.0.0 (excluded from the .xpi). | CITATION.cff |
| 4 | `01cbe22` | Add `docs/images/` (icon + two harness renders) that README already embeds. | docs/images/* |
| 5 | `9d0d2d4` | `dev/README.md` still referred to `web-ext-config.cjs`. | dev/README.md |
| 6 | `4c15200` | CI: drop `cache: 'npm'` from both jobs (no lockfile tracked → setup-node errors). | .github/workflows/ci.yml |
| 7 | `406482f` | `web-ext-config.mjs`: also ignore `*.csv`, logs/tmp/bak, `.env*`, keys/certs, `*.har`, `coverage/`, `dist/`, `build/`, `.idea/` so a stray local file can never ship. Build output unchanged. | web-ext-config.mjs |
| 8 | `c8ecb11` | `EXTENSION_CONFIG.version` 2.1.1 → 3.0.0 (unused by code; ships in the .xpi). | config/settings.js |
| 9 | `99e2b9e` | Extension descriptions (manifest.json → shown in about:addons, package.json, config/settings.js) listed 3–4 platforms and "Co-pilot"; now the nine sites. No permission/host change. | manifest.json, package.json, config/settings.js |
| 10 | `cecbf0d` | Platform display name `Co-pilot` → `Copilot` (feeds toolbar tooltip and sign-in card; not in any CSV). | config/settings.js |
| 11 | `1085d5e` | AI Mode ready copy said "Click refresh to re-capture" (button removed). | popup.js |
| 12 | `70334c1` | Sign-in prompt no longer says "401". | shared/errors.js, popup.js |
| 13 | `d1fb4bd` | "What's in the file?" now shows the real file-name pattern; study-code label no longer claims to keep "your identity hidden". Consent gate untouched. | popup.html |
| 14 | `47fbee2` | A11y: spinner no longer a nested `role="status"`; `aria-label` removed from the generic `<span>` (prohibited attr); `aria-label`s that did not contain the visible text removed from the About summary and the Export button (WCAG 2.5.3). `<details>` keep their own `aria-label`. Consent button untouched. | popup.html |
| 15 | `9ad6f04` | CHANGELOG: real file names; five chat-site host permissions added to the permission section; "nothing is sent to Google" qualified; `text_cleaned` + validation line added. | CHANGELOG.md |
| 16 | `9844d54` | AMO reviewer notes: network claims now match the code (content-script same-origin fetches; Google re-fetch; no background fetch); XHR hook list; signature + timestamp (no nonce); "pseudonymisation"; branch name; ignore list; line refs; paste instructions. | docs/amo-reviewer-notes.md |
| 17 | `636806b` | README: network/CSP wording, Google DOM exception, `scripting` is Perplexity-only, canonical CSV columns, removed the "declining the prompt only disables Google" claim, cross-study wording. | README.md |
| 18 | `50f4a52` | STUDENT_GUIDE: nine sites; AMO install; "Export ZIP"; donor context on by default; 14 canonical columns incl. `text_cleaned`; Claude canonical text includes thinking/tool results; manifest schema 1.1.0; `donor_id_hashed`; line endings; `extractor_version` no longer pinned to "2.1.1" in prose. | STUDENT_GUIDE.md |
| 19 | `f9a6f97` | METHODS: nine platforms and real file layout; orphan count *is* reported; Claude canonical text rule; `NAME` removed from by-type keys; URL option has no UI; Copilot model id = `mode`. | METHODS.md |

**Deliberately not done in Part 5** (left for Daniel, see Decisions): anything in `background.js`, extractors, content/inject scripts, `utils/manifest.js`, `utils/pii.js`, `utils/validators.js`; `strict_min_version`; ESLint config; `npm audit fix`; removing `updates.json`, `utils/helpers.js` or the reported-unused `.status*`/`.info*`/`.hidden` CSS (not independently verified); any Mistral or PII-scrub wording that depends on D3/D10; `docs/manual-tests.md` §5 8e (large-export card) which depends on D-S3.

The report itself is committed as a twentieth commit (`docs/release-review-3.0.0.md`).
