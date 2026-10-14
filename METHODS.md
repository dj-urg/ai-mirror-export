# Methods

This document records the capture, extraction and normalisation choices made by the AI Chat Exporter (version 3.0.0) so that downstream researchers can reproduce the unit of analysis in each CSV and cite it in a methods section. How the exporter is verified is documented separately in [`docs/validation.md`](docs/validation.md).

## Overview

The exporter captures conversations from ChatGPT, Claude, Copilot, Microsoft 365 Copilot, Perplexity, Grok, DeepSeek, Mistral and Google Search (classic AI Overview and AI Mode) and writes them to CSV files on the donor's machine. All processing runs locally in the browser; no data is transmitted to any third party. Every export is a ZIP containing a platform-specific messages CSV, a cross-platform canonical messages CSV and a manifest; most platforms add a metadata CSV and, when present, a sources CSV (ChatGPT also emits message URLs and donor context; Claude emits attachments). The grain of analysis is one row per message or turn in the messages files (one row per content block in Claude's platform-specific file), one row per source, URL or attachment in the auxiliary files, and one row per conversation in the metadata files.

## How the data gets in

Each platform's content script runs only on that platform's own origin (see `manifest.json`). It receives the conversation payload in one of three ways:

| Platform | Capture | Active same-origin request |
|---|---|---|
| ChatGPT, Copilot | A `window.fetch` hook in the page context observes the site's own conversation API response. | none |
| Claude, Grok, Mistral | `window.fetch` and `XMLHttpRequest` hooks, plus a same-origin re-fetch of the open conversation through the site's own API when the hook has not seen it (page load, in-app navigation, popup open, export). | the site's own conversation endpoint |
| DeepSeek | As above. DeepSeek's history endpoint rejects cookie-only requests, so the content script reads the site's own bearer token from the page's `localStorage` (`userToken`) and attaches it to that same-origin request. The token is never stored, logged or exported. Because DeepSeek streams new replies without re-requesting its history, the conversation is refreshed when the popup opens (at most once every 30 seconds while the popup stays open and polls) and always once more at export. | `/api/v0/chat/history_messages` |
| Perplexity | `window.fetch` and `XMLHttpRequest` hooks on `/rest/thread/<uuid>`; paginated thread pages are merged by thread id. Read/write tokens are stripped from the payload in the page context before it is forwarded. | none |
| Microsoft 365 Copilot | A `WebSocket` proxy observes the Chathub frames; messages are assembled per conversation and exported once the reply is complete. | none |
| Google AI Overview / AI Mode | Read from the rendered page (DOM); see "Google Search extraction". For a classic AI Overview that is not yet in the DOM, the content script requests the same search URL once per page and query (never on the popup's status poll) and parses the server HTML. AI Mode is never re-requested. | the user's own search URL, at most once |

Page-context hooks forward data to the content script over HMAC-SHA256-signed `postMessage`; the content script verifies signature, source, a 30-second timestamp window and a once-only nonce. Captured conversations live in memory only (at most 50 per tab, discarded after one hour). The background script validates the payload (it must be an object, at most 50 MB when serialised as JSON, with the platform's required array present and non-empty) and then runs the extractor.

## Per-platform extraction rules

### ChatGPT

ChatGPT ships two conversation shapes. The *mapping* format stores a node tree keyed by node id; turn numbers are computed by a breadth-first search from the single root node (the node whose `parent` is null), with the root at depth 0. The *messages-array* format stores a flat chronological list; turn number is the array index. Nodes that are unreachable from the root (dangling nodes in branched threads) are not visited by the BFS and receive an empty `turn_number`; their count is reported as `num_orphaned_nodes` in the metadata CSV and as `telemetry.orphaned_nodes` in the manifest.

Text is extracted per `content_type`: `text` and `multimodal_text` (string parts joined with `\n`), `thoughts` (`summary` with `content` fallback, joined with `\n\n`), `reasoning_recap` (string or parts joined with `\n`), and `execution_output` and `code` (both read from `content.text`). `user_editable_context` and `model_editable_context` nodes are excluded from the messages CSV and surfaced instead in the donor-context CSV. Every node is exported, including hidden branches; `on_visible_path` marks the chain from `current_node` to the root (see "Branches"). Sources come from `search_result_groups[].entries[]` and `content_references[]` (`source_list` says which); message URLs come from `content_references` / `safe_urls` metadata, with image CDN URLs excluded.

### Claude

The platform-specific messages CSV has one row per content block (`text`, `thinking`, `tool_use`, `tool_result`, or any future type, whose raw block is always kept in `raw_block_json`). Block text: `text` blocks give their `text`; `thinking` blocks give `thinking` (or `text`); `tool_use` blocks give no text (their `name` and `input` are in `tool_name` / `tool_input_json`); `tool_result` blocks give their string content or the text of their nested text blocks. Claude's web interface sends extended thinking as `thinking: ""` with `thinking_hidden: true` and a list of `summaries[].summary`; those summaries are joined into `thinking_summary`. The per-message `thinking_mode` (for example `auto`) is exported. `on_visible_path` marks the chain from `current_leaf_message_uuid` through `parent_message_uuid`. Sources are the `citations[]` of every block; attachments are the union of `attachments`, `files`, `files_v2` and `sync_sources` (connected sources), with extracted file text in `extracted_text`. Claude does not expose a model identifier in this payload, so `model_identifier` is empty.

### Copilot

`results[]` gives one row per message. Text is the join (`\n\n`) of the `text` parts; `author.type` `human` / `ai` becomes `user` / `assistant`. The canonical `model_identifier` carries the conversation `mode` because no model name is sent. No branch or reasoning fields have been observed in this payload.

### Microsoft 365 Copilot

The WebSocket frames are assembled into `results[]`, one row per chat message with its raw frame in `raw_json`, adaptive cards in `adaptive_cards_json`, and one sources row per `sourceAttributions[]` entry. `author` `user` / `bot` becomes `user` / `assistant`; the canonical `model_identifier` carries the frame's `messageType`. This platform has not yet been validated against raw captures (see `docs/validation.md`).

### Perplexity

Each thread entry becomes two rows: a user row from `query_str` and an assistant row from the answer blocks (`markdown_block`, `answer`, …). Code blocks are joined into `code_text` and reasoning / plan blocks into `reasoning_text`; sources come from the web-result blocks. Paginated thread pages are merged before extraction, and `page_count` records how many were seen. Message ids are `<entry uuid>:user` / `<entry uuid>:assistant`, and `parent_id` chains each turn to the previous one.

### Grok

`responses[]` (or `conversation.responses[]`) gives one row per message, with `sender` normalised to `user` / `assistant`, `parentResponseId` as `parent_message_id`, the `model` as `model_identifier`, and web / X search results as sources. The conversation id is not in Grok's payload; it is taken from the request URL by the page hook, and, failing that, from the page URL by the popup.

### DeepSeek

Each message carries a `fragments[]` list. User text is the `REQUEST` fragment; assistant text is the join of `RESPONSE` / `TEMPLATE_RESPONSE` fragments; `THINK` fragments are joined into `thinking_text`; `SEARCH` / `TOOL_SEARCH` fragments give the sources rows, including DeepSeek's `cite_index`. `model` is the per-message model; `parent_id` is exported. Integer ids are stringified.

### Mistral

The API returns messages newest-first; they are reversed to conversation order. Display text prefers the message's top-level `content` (the rendered answer) and otherwise joins the text chunks that are not reasoning chunks; chunks whose `_context.type` is `reasoning` are joined into `reasoning_text`. Tool calls, files and the full chunk list are kept in `tool_names`, `files_json`, `content_chunks_json` and `raw_message_json`. Sources come from `citedSources[]` and from search-tool results inside `tool_call` chunks (`source_list` says which). `version` / `version_count` record message revisions.

### Google Search extraction

Classic AI Overview is read from the live DOM first; only when the overview is not in the DOM does the content script request the current search URL once (with the donor's cookies) and parse the server HTML, anchoring on Google's own semantic markers rather than CSS classes. AI Mode is parsed from the live DOM only because its content is injected client-side and is not present in the server HTML response. The overview container selector fallback chain, tried in order, is:

1. `[data-attrid*="SrpGenSumSummary"]`
2. `[data-attrid*="AioHostElement"]`
3. `[data-async-type="aiov"]`
4. `[data-async-type="agscls"]`
5. `[jsname="FFzE2"]`

If none match, the extractor falls back to locating a heading element whose exact text is one of the known AI Overview or AI Mode labels (English, Dutch, French, German, Spanish) and climbs up to five ancestors until it finds a container with 200–20000 characters of visible text.


## Branches and the visible path

Several platforms keep every branch of a conversation (edited prompts, regenerated answers). The exporter exports **all** of them, because revisions are research-relevant, and marks the path the user last saw where the payload allows it:

| Platform | Branches in payload | Visible-path marker |
|---|---|---|
| ChatGPT | yes (mapping tree; `parent_id` per node) | `on_visible_path` in `chatgpt_messages` and in the canonical `platform_specific_json`: the chain from `current_node` to the root. Always true in the flat messages-array format. |
| Claude | yes (`parent_message_uuid` per message) | `on_visible_path` in `claude_messages` and in the canonical `platform_specific_json`: the chain from `current_leaf_message_uuid` to the root. True for every message when no leaf is present. |
| Mistral | yes (`version` / `version_count`; previous and next version pointers are in `raw_message_json`) | none derived; filter on `version_count`/`version` or the raw pointers. |
| Grok, DeepSeek | parent ids are exported; whether hidden branches appear in the payload is not verified on real data | none |
| Copilot, Microsoft 365 Copilot, Perplexity, Google | no branch structure observed | not applicable |

To reproduce what the donor saw on screen, keep rows with `on_visible_path = true` (ChatGPT, Claude). To study revisions, keep everything and group by `parent_*` ids.

## Reasoning / thinking text

The exporter exports whatever reasoning text the platform's web interface sends and records precisely what is not available:

| Platform | What the web interface sends | Where it lands |
|---|---|---|
| Claude | **Full reasoning text is not exposed** (`thinking: ""`, `thinking_hidden: true`); only Claude's reasoning summaries (`summaries[].summary`) and `thinking_mode` (verified on real captures, 2026-10-14). | `thinking_summary` per thinking block; `thinking_text` (usually empty), `thinking_summary`, `thinking_mode` in the canonical `platform_specific_json`. |
| ChatGPT | `thoughts` blocks (a `summary` per thought) and `reasoning_recap` blocks; these are OpenAI's summaries, not raw reasoning. | Rows with `content_type = thoughts` / `reasoning_recap` in `chatgpt_messages`; their text is the summaries. |
| DeepSeek | `THINK` fragments, exported as received. Whether they are the complete reasoning is not verified on real data yet. | `thinking_text` / `thinking_text_cleaned`; `thinking_text` in the canonical `platform_specific_json`. |
| Perplexity | reasoning / plan blocks, exported as received; not verified on real data yet. | `reasoning_text`; also in the canonical `platform_specific_json`. |
| Mistral | chunks with `_context.type = reasoning`, exported as received; not verified on real data yet. | `reasoning_text` / `reasoning_text_cleaned`; `has_reasoning`. |
| Grok, Copilot, Microsoft 365 Copilot, Google | no reasoning field observed in the captured payloads. | none |

## Fields deliberately not exported as named columns

From the real-data field-coverage check (Claude, 2026-10-14):

| Raw field | Decision |
|---|---|
| `chat_messages[].text` (top-level) | Legacy; only read when a message has no `content[]` blocks. With blocks present it duplicates the text blocks and is not exported separately. |
| `sync_sources[]` | Exported: it is one of the four arrays that feed `claude_attachments` (`source = sync_sources`), with the full item in `raw_json`. |
| `content[].thinking` | Exported as the thinking row's `text` (empty when `thinking_hidden` is true); the summaries are in `thinking_summary`. |
| `content[].display_content.link.resource_type`, `.subtitles` | Display metadata for link previews; kept only inside `raw_block_json`. |
| `files[].thumbnail_asset.image_height` (and other thumbnail metadata) | Display metadata; kept only inside the attachment's `raw_json`. |

In general every raw block, message, citation or attachment object is preserved in a `raw_*_json` column, so a field without a named column is never lost.

## `text` and `text_cleaned`

`text` is the extracted text exactly as the platform sent it (after the block rules above). `text_cleaned` is the same text passed through `utils/text_cleaner.js`, intended for NLP without further preprocessing:

1. Grok's `<grok:render …>…</grok:render>` inline citation directives are removed.
2. HTML/XML tags are removed (only `<` followed by a letter counts as a tag, so `a < b` survives).
3. ChatGPT's inline citation placeholders (`citeturn0search1`, also with zero-width separators, and `【…†…】`) are removed.
4. Invisible characters are deleted without replacement: zero-width space / non-joiner / joiner, left-to-right and right-to-left marks, line and paragraph separators (U+2028, U+2029), the narrow no-break space (U+202F) and the other characters in U+200B–U+200F and U+2028–U+202F, U+205F, and the BOM. Note that deleting a narrow no-break space joins the words around it (e.g. a French `12 h` written with U+202F becomes `12h`).
5. Trailing spaces and tabs on each line are trimmed, runs of three or more newlines collapse to one blank line, and the result is trimmed.

Markdown is preserved. The same cleaner produces `thinking_text_cleaned` and `reasoning_text_cleaned`.

## CSV format and the formula-prefix rule

Every CSV is UTF-8 with a BOM, RFC 4180 quoting, `\r\n` record separators and a terminating newline. Fields containing commas, quotes or newlines are quoted, with quotes doubled.

To protect anyone who opens a file in a spreadsheet, `escapeCSVField` prefixes a single quote (`'`) to any cell whose **first character** is one of `=`, `+`, `-`, `@`, `|`, tab, carriage return, newline, or the fullwidth `＝`, `＋`, `－`, `＠`. This is applied to every column, including `text` and `text_cleaned`, so a message that begins with `- item` is stored as `'- item`, and the manifest's SHA-256 covers the prefixed bytes. For text analysis, strip one leading `'` from a cell when the next character is in that set. The rule is not perfectly reversible: a cell whose original text began with `'` followed by one of those characters is not prefixed and is therefore indistinguishable from a prefixed cell; this rare ambiguity is accepted in exchange for safe spreadsheet opening. The prefix is never applied to empty cells.

## Timestamps

ChatGPT timestamps arrive as Unix seconds and are converted to ISO 8601 UTC; falsy input becomes an empty string. Other platforms' timestamps are normalised with `toIsoUtc` (ISO strings, Unix seconds or milliseconds) and passed through unchanged when they cannot be parsed. Google captures a `captured_at` ISO timestamp at the moment of extraction; AI Mode records the same capture time on every turn because Google's AI Mode DOM does not expose per-turn timestamps.

## Source extraction

For ChatGPT, sources are drawn from two message-metadata lists and written to one CSV with a `source_list` discriminator: `search_result` rows come from `search_result_groups[].entries[]`, `grouped_webpages` rows come from `content_references[]` entries with `type: 'grouped_webpages'`. For every URL on every platform a `url_clean` column is produced by stripping the five standard UTM parameters (`utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`). Image CDN URLs (`images.openai.com`) and URLs ending in common image extensions are excluded from the ChatGPT message URLs CSV. Google sources are the anchor tags inside the overview container; anchors pointing to Google-owned hosts (`google.*`, `googleusercontent.com`, `gstatic.com`, `googleadservices.com`, `googlesyndication.com`, `policies.google.com`, `support.google.com`) are filtered out.

## Size limits

A conversation payload larger than 50 MB when serialised as JSON is refused before extraction (the popup reports it as too large); content scripts keep at most 50 captured conversations per tab for one hour. Perplexity response bodies above 100 MB are ignored by the hook.

## Donor identity and the study code

`donor_id` is a UUID generated in the browser on the first export, stored in `browser.storage.local` and regenerated after 365 days (if storage is unavailable a session-only id is used and `donor_id_type` says `session`). Without a study code the raw UUID is written into every CSV, so exports from the same installation can be joined across studies. With a study code (the "Study code" field in Privacy settings; stored locally, never written to the export) every `donor_id` becomes `HMAC-SHA256(uuid, code)`, so the same donor yields different ids under different codes and cross-study joins are blocked only when studies use distinct codes. The manifest's `donor_id_hashed` is `SHA-256(uuid)` without a code and the same HMAC value with one. Identifiers are pseudonymous, not anonymous: a donor's exports remain linkable to each other.

## Consent record

The first-run consent gate stores `consent_given: true`, `consent_version` (the version of the consent text the participant agreed to; `"1"` is the 3.0.0 wording) and `consent_given_at` (ISO 8601 UTC) in `browser.storage.local`. These values are not written into the export; a study that needs them must collect them separately. Exports are only possible after consent.

## Provenance manifest (`_manifest.json`)

Every ZIP includes a sidecar `{platform}_manifest_{slug}.json` describing the files inside, so researchers can audit what was emitted without re-running the extension. The outer schema version is `manifest_schema_version`; the current value is `1.1.0` (additive change from `1.0.0` — the fields below were added, no field was renamed or removed, so parsers that ignore unknown keys stay compatible).

The `telemetry` object carries PII-scrubbing provenance:

| Field | Shape | Meaning |
|---|---|---|
| `pii_scrub_enabled` | boolean | Whether the optional scrubber ran at all. If `false`, the next three fields describe an empty scrub pass. |
| `pii_scrub_options` | `{ URL: boolean }` | Per-category toggles that were in effect. Currently only `URL` is individually togglable; the other scrub rules are always on when `pii_scrub_enabled: true`. Keys match the UPPERCASE vocabulary used by `pii_redactions_by_type`. When `pii_scrub_enabled` is `false`, this field is `{}`. |
| `pii_ruleset_version` | string | SemVer tag of the regex set in [`utils/pii.js`](utils/pii.js) (`PII_RULESET_VERSION`). Bump when a pattern changes meaningfully — patch for tightening a bounded regex, minor for adding/removing a category, major for anything a downstream parser could break on. Lets an export be traced back to the exact rules that produced its redactions. |
| `pii_redactions_total` | integer | Count of `<REDACTED:…>` markers added across every scrubbed column. |
| `pii_redactions_by_type` | `{ EMAIL: n, URL: n, … }` | Same count broken out per marker type. Keys: `EMAIL`, `URL`, `PHONE`, `IP`, `JWT`, `TOKEN`, `CC`, `SSN`. Only non-zero types appear. |

Default behavior ships `URL: false` so URLs are preserved in exports; news / sources studies rely on them. There is no popup control for this option in 3.0.0; a researcher who wants URL stripping has to set `pii_scrub_options` to `{ "URL": true }` in the extension's local storage (for example via the add-on debugger) on each participant's browser before they export.

### PII scrubbing coverage

When `pii_scrub_enabled` is true, every string cell of every CSV in the ZIP is passed through the scrubber, including the cross-platform canonical files, the raw-JSON columns and the sources / attachments / donor-context files. What happens to a cell depends on its column (the classification lives in `utils/pii.js`):

| Column class | Columns | Treatment |
|---|---|---|
| text | message text and its `_cleaned` copy, thinking / reasoning / code text, titles, summaries, snippets, queries, follow-up questions, user profile and instructions, file names, extracted file text | Full rule set: emails, phone numbers, IPv4 addresses, JWTs, bearer / provider API keys, credit-card numbers (Luhn-checked), US SSNs, generic 32+ character tokens, URLs with embedded credentials. |
| json | every `*_json` column (`raw_block_json`, `tool_input_json`, `settings_json`, `raw_message_json`, `feedback_json`, `token_usage_json`, `raw_json`, `adaptive_cards_json`, `content_chunks_json`, `files_json`, `platform_specific_json`) | Parsed, walked and re-serialised: every prose string value gets the text rules; values under id / timestamp keys, bare UUIDs and ISO dates are preserved; values under URL keys get the URL treatment. Placeholders never break the JSON. |
| url | `url`, `url_clean`, `source_page_url`, `source_urls`, `image_link` | Embedded credentials (`user:password@host`) are always removed. With `pii_scrub_options.URL` the whole value becomes `<REDACTED:URL>`; otherwise the URL is kept so source analyses still work. |
| structural | identifiers, timestamps, roles and other enums, model names, counters and flags | Untouched, so joins, ordering and provenance survive. Exception: on Google the `conversation_id` is the search query and is scrubbed as text; the ZIP and file names, which derive from it, are built from the scrubbed value. |

`pii_redactions_total` and `pii_redactions_by_type` count every placeholder added in every cell of every file, so the same email in `text`, `text_cleaned` and the canonical row counts three times. Scrubbing is pattern-based and best-effort: personal names, addresses and free-form identifying statements are not detected. With scrubbing off, no cell is modified.

## Schema versions

Every CSV carries a `schema_version` column (per file type) next to `extractor_version`; the manifest repeats both per file. The version table lives in `utils/manifest.js` (`SCHEMA_VERSIONS`). Changes in 3.0.0:

| Schema | Version | Change |
|---|---|---|
| `deepseek_messages` | 1.1.0 | `model_class` and `model_name` (always empty: DeepSeek's API carries the model under `model`) replaced by a single `model` column. The canonical `model_identifier` is read from the same field. |
| `deepseek_sources` | 1.1.0 | `cite_index` added (DeepSeek's citation number for the result, when present); `fragment_id` is now always a string. |
| `chatgpt_messages` | 1.1.0 | `on_visible_path` added: true when the node is on the chain from the conversation's `current_node` through each node's `parent` (every branch is exported; this marks the thread the user last saw). Always true for the flat messages-array format, which carries no branches. |
| `chatgpt_messages_canonical` | 1.1.0 | `on_visible_path` key added to `platform_specific_json`. |
| `claude_messages` | 1.1.0 | `thinking_summary` (Claude's reasoning summaries, `content[].summaries[].summary`, joined with `\n\n`), `thinking_mode` (per message, e.g. `auto`) and `on_visible_path` (true when the message is on the chain from `current_leaf_message_uuid` through `parent_message_uuid`; every branch is exported) added. |
| `claude_messages_canonical` | 1.1.0 | `text` is now the message's `text` blocks only. Thinking text, thinking summaries and tool-result text moved into `platform_specific_json` (`thinking_text`, `thinking_summary`, `tool_result_text`), alongside `thinking_mode` and `on_visible_path`. Before 1.1.0 every block's text was joined into `text`. |
| `google_ai_mode` | 1.1.0 | `conversation_id` column added: the search query from the page URL, the same identifier classic AI Overview uses. It names the ZIP and the files (previously `unknown`), is the manifest's `conversation_id`, and is the `conversation_id` in the canonical and sources rows (previously the first user turn's text, via `conversation_title`, which is kept as a column). |

All other schemas remain at 1.0.0.

## Verification

Automated tests (unit, per-platform golden exports, a PII sweep, schema and version checks), the popup accessibility baseline and the real-data validation method and log are described in [`docs/validation.md`](docs/validation.md).

## Known limitations

Google selectors are brittle to Google's ongoing A/B tests of DOM structure and locale labels; a layout change may silently reduce the capture rate. Claude does not send a model identifier (empty `model_identifier`); for Copilot the canonical `model_identifier` carries the conversation `mode` and for Microsoft 365 Copilot the frame's `messageType` rather than a model name. Per-turn timestamps are not available on Google AI Mode. Microsoft 365 Copilot has not been validated against raw captures. Reasoning text is only as complete as the platform's web interface makes it (see "Reasoning / thinking text").
