# Methods

This document records the extraction and normalization choices made by the AI Chat Exporter so that downstream researchers can reproduce the unit of analysis in each CSV.

## Overview

The exporter captures conversations from ChatGPT, Claude, Copilot, Microsoft 365 Copilot, Perplexity, Grok, DeepSeek, Mistral, and Google Search (classic AI Overview and AI Mode) and writes them to CSV files on the donor's machine. All processing runs locally in the browser; no data is transmitted to any third party. Every export is a ZIP containing a platform-specific messages CSV, a cross-platform canonical messages CSV and a manifest; most platforms add a metadata CSV and, when present, a sources CSV (ChatGPT also emits message URLs and donor context; Claude emits attachments). The grain of analysis is one row per message/turn in the messages files (one row per content block in Claude's platform-specific file), and one row per source or URL in the auxiliary files. Extraction rules for Perplexity, Grok, DeepSeek, Mistral and Microsoft 365 Copilot are documented only in the extractor sources (`platforms/<platform>/extractor.js`, `background.js`) for this release.

## Turn numbering (ChatGPT)

ChatGPT ships two conversation shapes. The *mapping* format stores a node tree keyed by node ID; turn numbers are computed by a breadth-first search from the single root node (the node whose `parent` is null), with the root at depth 0. The *messages-array* format stores a flat chronological list; turn number is the array index. Nodes that are unreachable from the root — which occurs in branched or regenerated threads where the mapping retains dangling nodes — are not visited by the BFS and receive an empty `turn_number` in the messages CSV. The count of such orphaned nodes is reported as `num_orphaned_nodes` in the metadata CSV and as `telemetry.orphaned_nodes` in the manifest.

## Content flattening

ChatGPT text is extracted per `content_type`: `text` and `multimodal_text` (string parts joined with `\n`), `thoughts` (`summary` with `content` fallback, joined with `\n\n`), `reasoning_recap` (string or parts joined with `\n`), and `execution_output` and `code` (both read from `content.text`). `user_editable_context` and `model_editable_context` nodes are excluded from the messages CSV and surfaced instead in `donor_context.csv`, keeping donor-level profile and model instructions out of the per-message grain. In the canonical CSV, Claude joins the text of every content block using `\n\n` — this includes extended-thinking blocks (`thinking`) and tool results, not only `type: 'text'` blocks; the platform-specific `claude_messages` CSV keeps one row per block with its type. Copilot does the same with its `content` parts. Google AI Mode captures per-turn text extracted from DOM ranges delimited by role headings; classic AI Overview captures a single text blob.

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

## Known limitations

Google selectors are brittle to Google's ongoing A/B tests of DOM structure and locale labels; a layout change may silently reduce the capture rate. The model identifier for Claude is not recorded (empty `model_identifier`); for Copilot the canonical `model_identifier` carries the conversation `mode` rather than a model name. Per-turn timestamps are not available on Google AI Mode.
