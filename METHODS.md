# Methods

This document records the extraction and normalization choices made by the AI Chat Exporter so that downstream researchers can reproduce the unit of analysis in each CSV.

## Overview

The exporter captures conversations from ChatGPT, Claude, Copilot, Microsoft 365 Copilot, Perplexity, Grok, DeepSeek, Mistral, and Google Search (classic AI Overview and AI Mode) and writes them to CSV files on the donor's machine. All processing runs locally in the browser; no data is transmitted to any third party. Every export is a ZIP containing a platform-specific messages CSV, a cross-platform canonical messages CSV and a manifest; most platforms add a metadata CSV and, when present, a sources CSV (ChatGPT also emits message URLs and donor context; Claude emits attachments). The grain of analysis is one row per message/turn in the messages files (one row per content block in Claude's platform-specific file), and one row per source or URL in the auxiliary files. Extraction rules for Perplexity, Grok, DeepSeek, Mistral and Microsoft 365 Copilot are documented only in the extractor sources (`platforms/<platform>/extractor.js`, `background.js`) for this release.

## Turn numbering (ChatGPT)

ChatGPT ships two conversation shapes. The *mapping* format stores a node tree keyed by node ID; turn numbers are computed by a breadth-first search from the single root node (the node whose `parent` is null), with the root at depth 0. The *messages-array* format stores a flat chronological list; turn number is the array index. Nodes that are unreachable from the root — which occurs in branched or regenerated threads where the mapping retains dangling nodes — are not visited by the BFS and receive an empty `turn_number` in the messages CSV. The count of such orphaned nodes is reported as `num_orphaned_nodes` in the metadata CSV and as `telemetry.orphaned_nodes` in the manifest.

## Content flattening

ChatGPT text is extracted per `content_type`: `text` and `multimodal_text` (string parts joined with `\n`), `thoughts` (`summary` with `content` fallback, joined with `\n\n`), `reasoning_recap` (string or parts joined with `\n`), and `execution_output` and `code` (both read from `content.text`). `user_editable_context` and `model_editable_context` nodes are excluded from the messages CSV and surfaced instead in `donor_context.csv`, keeping donor-level profile and model instructions out of the per-message grain. In the canonical CSV, Claude's `text` is the join (`\n\n`) of the message's `type: 'text'` blocks only; extended-thinking text, Claude's reasoning summaries and tool-result text are carried in `platform_specific_json` (`thinking_text`, `thinking_summary`, `tool_result_text`). The platform-specific `claude_messages` CSV keeps one row per block with its type, so thinking rows have `content_type = thinking`, their (usually empty) `text` and the `thinking_summary`. Copilot does the same with its `content` parts. Google AI Mode captures per-turn text extracted from DOM ranges delimited by role headings; classic AI Overview captures a single text blob.

## Timestamps

ChatGPT timestamps arrive as Unix seconds and are converted to ISO 8601 UTC via `unixToISO`; any falsy input becomes an empty string. Claude and Copilot timestamps are passed through as the strings supplied by the upstream API. Google captures a `captured_at` ISO timestamp at the moment of extraction for classic AI Overview; AI Mode records only the overall `captured_at` because Google's AI Mode DOM does not expose per-turn timestamps (known limitation).

## Source extraction

For ChatGPT, sources are drawn from two message-metadata lists and written to one CSV with a `source_list` discriminator: `search_result` rows come from `search_result_groups[].entries[]`, `grouped_webpages` rows come from `content_references[]` entries with `type: 'grouped_webpages'`. For every URL a `url_clean` column is produced by stripping the five standard UTM parameters. Image CDN URLs (`images.openai.com`) and URLs ending in common image extensions are excluded from the message URLs CSV because they are article thumbnails rather than linked sources. Google sources are the anchor tags inside the overview container; anchors pointing to Google-owned hosts (`google.*`, `googleusercontent.com`, `gstatic.com`, `googleadservices.com`, `googlesyndication.com`, `policies.google.com`, `support.google.com`) are filtered out.

## Google Search extraction

Classic AI Overview is parsed from a re-fetched HTML snapshot of the current search URL (fetched with the donor's cookies) so that extraction anchors on Google's own semantic markers rather than live-DOM CSS classes. AI Mode is parsed from the live DOM only because its content is injected client-side and is not present in the server HTML response. The overview container selector fallback chain, tried in order, is:

1. `[data-attrid*="SrpGenSumSummary"]`
2. `[data-attrid*="AioHostElement"]`
3. `[data-async-type="aiov"]`
4. `[data-async-type="agscls"]`
5. `[jsname="FFzE2"]`

If none match, the extractor falls back to locating a heading element whose exact text is one of the known AI Overview or AI Mode labels (English, Dutch, French, German, Spanish) and climbs up to five ancestors until it finds a container with 200–20000 characters of visible text.

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

## Known limitations

Google selectors are brittle to Google's ongoing A/B tests of DOM structure and locale labels; a layout change may silently reduce the capture rate. The model identifier for Claude is not recorded (empty `model_identifier`); for Copilot the canonical `model_identifier` carries the conversation `mode` rather than a model name. Per-turn timestamps are not available on Google AI Mode.
