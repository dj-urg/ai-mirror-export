# How the exporter is verified

This is the single place that documents how AI Chat Exporter is tested: the
automated suite, the popup accessibility baseline, and the validation of real
exports against raw captures. It is deliberately content-free: no
conversation text, no identifiers from real chats.

Status: **3.0.0 release candidate, 2026-10-14** (`release/3.0.0-final`).

## 1. Automated tests

Run with `npm test` (`testing/tests/run_all.js` imports every `test_*.js`
file; any uncaught error fails the run). CI (`.github/workflows/ci.yml`)
runs exactly the same suite on Node 20 with `npm ci`, plus ESLint,
`web-ext lint` and a gitleaks secret scan over the full history. Local and
CI suites are identical: every test file and every fixture it reads is
tracked; real-origin captures are gitignored and no test reads them.

| File | What it proves | Last result |
|---|---|---|
| `test_background_golden.js` | Drives the real `background.js` end to end (mocked `browser.*`, frozen clock, fixed donor id) for every platform fixture, scrubbing off and on, plus a salted donor-id run, and compares every ZIP entry (CSVs and manifest) byte for byte with `testing/data/synthetic/golden/`. Also checks BOM, manifest/file consistency, SHA-256 per file, frozen timestamps, the consent record in the manifest telemetry, and that no export is named `unknown`. Goldens change only via `UPDATE_GOLDEN=1` in an intentional-change commit. | 964 passed |
| `test_pii_sweep.js` | Plants an email, phone number, IPv4 and API-key-like token in every prose field of every fixture, exports with scrubbing on, and asserts none of them appears in any CSV column (raw-JSON and canonical columns included), the manifest or any file name; every `*_json` cell still parses; `pii_redactions_total` equals the sum of `by_type`; the Claude fixture with an attachment, citations, a tool call and thinking is scrubbed in each of those files. | 1284 passed |
| `test_pii.js` | Unit tests of every scrub rule, the column classification (every column in the golden exports is classified structural / url / json / text), JSON-aware scrubbing (ids, timestamps and URLs preserved, output still valid JSON) and row scrubbing. | 89 passed |
| `test_background_outcomes.js` | Empty and invalid payloads on several platforms broadcast `empty_export` / `invalid_data` with a validation code and download nothing; the Grok URL-id fallback; a platform/origin mismatch is dropped. | 38 passed |
| `test_chatgpt_golden.js`, `test_claude_golden.js`, `test_perplexity_golden.js`, `test_grok_golden.js`, `test_deepseek_golden.js`, `test_mistral_golden.js` | Per-extractor invariants on the synthetic fixtures: row counts, roles, canonical header, provenance columns, and the 3.0.0 behaviours (visible path, thinking summaries, DeepSeek `model`/`cite_index`, Mistral display text). | 29 / 29 / 12 / 14 / 26 / 23 passed |
| `test_perplexity_extractor.js` | Perplexity block parsing variants. | 32 passed |
| `test_validators.js` | Row validators and every CSV schema. | 130 passed |
| `test_manifest.js` | SHA-256, HMAC donor id, row counting, manifest building (schema 1.2.0), timestamp normalisation, canonical headers. | 38 passed |
| `test_text_cleaner.js` | `text_cleaned` rules. | 10 passed |
| `test_version_consistency.js` | `EXTRACTOR_VERSION` = `manifest.json` version = `package.json` = `config/settings.js` = `CITATION.cff`. | 5 passed |
| `test_settings_domains.js` | Configured platform domains match the manifest's content-script and host-permission hosts both ways; Gmail/Docs and the Perplexity apex are not platforms. | 85 passed |
| `test_message_security.js` | Signed page→content messages: sign/verify, tamper, wrong secret, stale timestamp, replayed nonce rejected. | 9 passed |
| `test_extract_helpers.js` | The shared `stripUtmParams` / `toJsonCell` / `normalizeRole`. | 12 passed |

Last full run (2026-10-14, final build): **18 files, 2 829 assertions, 0 failures**; ESLint 0 errors / 0 warnings; `web-ext lint` 0 / 0 / 0; `web-ext build` 49 files, nothing from `dev/`, `docs/`, `testing/` or the configs.

Fixtures (`testing/data/synthetic/`) are hand-written: ChatGPT (mapping,
metadata-context and branched variants), Claude (plain, rich: thinking +
tool use + citation + attachment, branched), Copilot, Microsoft 365
Copilot, Perplexity, Grok, DeepSeek (plain and search/thinking), Mistral
(plain and reasoning), Google AI Overview and AI Mode. They contain planted
synthetic emails, phone numbers, IPs and UTM-tagged URLs so the scrub paths
fire.

## 2. UI checks

`dev/harness.html` renders the popup over a mocked `browser.*` in 36 states
(ready and idle per platform, loading, every error, sign-out, consent gate
and the export outcomes, which click Export for you). `dev/baseline.mjs`
drives it with Playwright/Firefox, runs axe-core (WCAG 2.x A/AA + best
practice) on every state in light and dark theme, and records the status
card text, the review-card copy and the focused element for each capture.

Last run (label `p7-c1`, 2026-10-14): **36 states × 2 themes = 72
captures, 0 axe violations**, every ready state focuses the export button,
the consent state focuses the checkbox, the review step shows both copy
variants. A baseline was run after every popup-affecting commit of the
release branch (labels `p1-…` to `p7-…`), all at 0 violations.

What the harness cannot show (real Firefox only): toolbar icon state
transitions, `downloads.show`, the first-run consent flow on a fresh
profile, the 2.1.1 → 3.0.0 update prompt. These are in
`docs/manual-tests.md`.

## 3. Real-data validation method

Synthetic fixtures prove the pipeline is deterministic and complete for
the shapes we know; they cannot prove that a platform's live payload still
has those shapes. For that, exports are compared against raw captures with
a capture-validation toolkit maintained by the project owner **outside this
repository** (captures contain real conversations, cookies and tokens, so
the toolkit, the HAR files and the reports never enter the repo).

Method, per platform:

1. Run a scripted test conversation in Firefox with harmless, planted
   content (fake PII values, a long answer with code and a table, non-Latin
   text and emoji, web search with citations, extended thinking, a file
   upload, an image, an edited prompt and a regenerated answer).
2. Save the network traffic as a HAR; export the chat twice with the
   extension, PII scrubbing off and on; write an `expected.json` of what was
   visible on screen.
3. The toolkit sanitises the HAR (keeps only the conversation API
   responses, drops cookies and headers) and runs seven checks:
   - **completeness** — every raw message id is in the export, in order;
   - **fidelity** — exported text equals raw text;
   - **expectations** — the export matches what was seen on screen;
   - **field coverage** — raw fields that reach no CSV column;
   - **PII** — planted values present in the plain export, absent in the
     scrubbed one;
   - **format drift** — raw structure versus the previous capture;
   - **manifest sanity**.
4. It writes content-free reports (hashed ids, no message text), which are
   what the log below summarises.

## 4. Validation log

| Date | Platform | Build | Capture | Completeness | Fidelity | Expectations | Field coverage | PII | Drift | Manifest |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-14 | Claude | pre-fix `ux-audit-pass` @ `bbe6649` (reports extractor 2.1.1) | short chat, 2 user / 2 assistant turns, plain text | PASS | PASS | PASS | PASS | n/a | n/a | PASS |
| 2026-10-14 | Claude | pre-fix `bbe6649` | scripted full-feature chat (planted PII, long answer with code and table, Arabic/Chinese/Russian + emoji, web search with citations, extended thinking, uploaded .txt with the planted email, image, edited prompt, regenerated answer) | PASS (17 raw, 17 exported, order matches) | PASS (0 mismatches / 17) | 7+7 turns visible; export has 8 user + 9 assistant: the 3 extra are hidden branches (see §5). Branches 2 ✓, sources 3 ✓, attachments 3 ✓ | 84 / 90 raw key paths covered (see §5) | **FAIL** — all 4 planted values present in the scrubbed export | no removed fields; 73 added, all explained by the features used | PASS, but extractor 2.1.1 |
| pending | Claude | final 3.0.0 build | re-run of the scripted chat | | | expect branch rows marked with `on_visible_path` | | expect PASS | | expect extractor 3.0.0 |
| pending | ChatGPT | final 3.0.0 build | scripted chat | | | | | | | |
| pending | Copilot | final 3.0.0 build | scripted chat | | | | | | | |
| pending | Microsoft 365 Copilot | final 3.0.0 build | needs a proxy capture (see §6) | | | | | | | |
| pending | Perplexity | final 3.0.0 build | scripted thread | | | | | | | |
| pending | Grok | final 3.0.0 build | scripted chat | | | | | | | |
| pending | DeepSeek | final 3.0.0 build | scripted chat incl. a brand-new chat | | | | | | | |
| pending | Mistral | final 3.0.0 build | scripted chat | | | | | | | |
| pending | Google AI Overview / AI Mode | final 3.0.0 build | expectations + on-screen comparison only (see §6) | | | | | | | |

Other observations from real exports made on the pre-fix build
(2026-10-13, outside the toolkit runs): a Grok export was named
`grok_unknown_<timestamp>.zip`; a Mistral export made with the then-
uncommitted wiring produced a real ZIP.

## 5. Findings and decisions from validation

| Finding | Decision | Implemented in |
|---|---|---|
| PII scrubbing left all four planted values in the scrubbed Claude export (the manifest certified scrubbing). The likely leaks were the canonical CSV, the attachment's extracted text and the raw-JSON columns; the code review found the same by reading (`A-B2`). | Scrubbing covers every string cell of every file when it is on; columns are classified structural / url / json / text; JSON columns are scrubbed inside their strings so they stay valid. The PII sweep test plants values in every prose field, including attachment text, citations, tool input and thinking, and checks every entry. | `d408c89`, `81fede0` |
| The export has more messages than were visible: edited prompts and regenerated answers are separate messages that share a parent. | Keep exporting every branch (revisions are research-relevant) and mark the visible path. Claude: `on_visible_path` from `current_leaf_message_uuid`; ChatGPT: from `current_node`. Other platforms documented in `METHODS.md` ("Branches and the visible path"). | `5d7f258`, `3da5223` |
| Claude's web interface sends `thinking: ""` with `thinking_hidden: true` and reasoning *summaries* (`content[].summaries[].summary`), plus a per-message `thinking_mode`. The full reasoning text is not available. | Export what the platform provides and say so: `thinking_summary` and `thinking_mode` columns; the canonical `text` holds the answer text only, with thinking, summaries and tool results kept apart in `platform_specific_json`; `METHODS.md` states per platform what reasoning text exists. | `5d7f258`, `7239a96` |
| Six raw key paths reached no named column: `content[].thinking`, top-level `text`, `sync_sources[]`, `display_content.link.resource_type` / `.subtitles`, `files[].thumbnail_asset.image_height`. | `thinking` is the thinking row's `text` (empty when hidden); top-level `text` is legacy and only read when a message has no blocks; `sync_sources[]` already feeds `claude_attachments`; the display and thumbnail metadata stay inside the raw-JSON columns. Documented in `METHODS.md` ("Fields deliberately not exported as named columns"). | `7239a96` |
| A Grok export was named `grok_unknown_…`. | The content script sends the id from the page URL with the export message and background uses it when the payload yields none; the golden test asserts no fixture ever produces an `unknown` name or a null manifest id. | `1034e15` |
| Mistral exported a real ZIP with the (then uncommitted) wiring. | Confirms the hand-port approach; the wiring was ported against the current PII API. A real Mistral export on the final build is on the manual checklist. | `c4d0f31`, `142278a` |
| Every export was stamped extractor 2.1.1. | `EXTRACTOR_VERSION` is 3.0.0 and a test keeps it equal to the add-on version. | `03f88c8` |

## 6. Known limitations of validation

- Firefox HAR files do not reliably include WebSocket frames, so
  **Microsoft 365 Copilot** (captured over a WebSocket) needs another
  capture route, such as a local proxy, and is **not yet validated against
  raw data**. It also has no synthetic fixture for its WebSocket path.
- **Google AI Overview / AI Mode** are read from the rendered page (DOM),
  so there is no raw API response to compare against; validation there
  relies on the expectations check and on-screen comparison.
- Validation is **per build and per date**. Platforms change their payload
  formats without notice; the drift check only compares against the
  previous capture. Repeat the scripted tests monthly and before each
  study, on the build that participants will install.
- The synthetic fixtures were written from documented/observed shapes and
  the reviewed captures; they cannot anticipate fields a platform adds
  later (the raw-JSON columns preserve them until the extractor catches
  up).
- The working-tree gitleaks scan reports findings only in gitignored local
  Playwright console logs (`.playwright-mcp/`); the tracked history is
  clean. Those logs are never committed.

## 7. Re-validation checklist

For each platform, on the build participants will install:

1. Note the build (add-on version, git tag, `extractor_version`).
2. In a test account, run the scripted conversation: two plain turns; a
   long answer with a code block and a table; Arabic, Chinese and Russian
   text and emoji; web search with citations; extended thinking / reasoning
   where the platform has it; an uploaded `.txt` containing the planted
   email; an image; an edited prompt; a regenerated answer. Plant one fake
   email, phone number, IPv4 address and `sk-`-style token in the prompts.
3. Save the HAR (for M365 Copilot: a proxy capture that includes WebSocket
   frames). Export twice with the extension (scrubbing off, then on).
4. Write `expected.json` from what is on screen (turn counts, sources,
   attachments, branches).
5. Run the toolkit's seven checks; file the content-free report.
6. Add a row to §4 with the date, platform, build and the result per
   check; add anything new to §5 with the decision and the commit.
7. For Google, compare the export with the screen manually (text, sources,
   follow-ups; AI Mode turns and their order) and record the result in §4
   under "expectations".
8. If any check fails, open an issue with the report attached (never the
   capture), and do not use the build in a study until it is fixed and
   re-validated.
