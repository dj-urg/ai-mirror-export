# Student Guide — AI Chat Exporter

> **About this document.** Drafted with AI assistance from the extension's source code and its synthetic test fixtures, then checked against the 3.0.0 test suite. Where this guide and the code disagree, the code wins; the extraction rules are in `METHODS.md` and the verification status in `docs/validation.md`.

---

## 0. Who this guide is for

You are a student (digital methods, communication science, computational social science) encountering the **AI Chat Exporter** browser extension for the first time. The goal of this guide is to help you get comfortable with:

1. **what the tool does** and how to run an export yourself,
2. **what you get back** — the shape of the ZIP file,
3. **what every CSV and column means** so you can read an export and know what you're looking at.

Statistical analysis, coding workflows, and cross-corpus modelling are **out of scope** here. Once you understand the data, further processing (filtering, aggregating, network analysis, text analysis) can be done in **[4CAT](https://4cat.nl/)**, which accepts these CSVs directly. If you need the research-methods justification for the schema choices, see `METHODS.md`.

---

## 1. What the tool is

The **AI Chat Exporter** is a browser extension (Firefox) that lets a user export one of their own AI chat conversations as a ZIP of CSV files. It supports:

- **ChatGPT** — `chatgpt.com` and `chat.openai.com`
- **Claude** — `claude.ai/chat/*`
- **Copilot** — `copilot.microsoft.com` and `copilotstudio.microsoft.com`
- **Microsoft 365 Copilot** — `m365.cloud.microsoft`
- **Perplexity** — `www.perplexity.ai`
- **Grok** — `grok.com`
- **DeepSeek** — `chat.deepseek.com`
- **Mistral** — `chat.mistral.ai`
- **Google Search AI** — the AI Overview box and AI Mode conversations on `google.com` and nine other Google locales

Everything runs **locally in the browser**. No data leaves the user's machine during extraction. The extension reads what the chat platform already sent to the user's browser, formats it as CSV, and triggers a download.

This matters for research: donors stay in control of what they share, and you (the researcher) receive a clean, documented file rather than a scraped HTML blob.

---

## 2. Running an export

Walk through this once yourself on your own account — it is the fastest way to understand the data.

1. Install the extension from [addons.mozilla.org](https://addons.mozilla.org/firefox/addon/local-ai-chat-exporter/) (see `README.md`).
2. Open a conversation on one of the supported platforms.
3. Click the extension icon in the toolbar. A popup appears with the page's detected status.
4. Click **Export ZIP**.
5. A single ZIP file is downloaded. The popup then shows a **Review your export** step: open the ZIP and check what is in it before sharing it; **Show in Downloads** reveals the file.

**Settings worth knowing about** (visible in the popup):

- **PII scrubbing** — optional pattern-based pass that redacts emails, phone numbers, IP addresses, API keys and tokens, SSNs and credit-card patterns in **every file of the ZIP**: the platform CSVs, the canonical CSV, the raw-JSON columns, sources, attachments and the custom-instructions file. Redactions appear as `<REDACTED:EMAIL>`, etc. Identifiers, timestamps and URLs are left intact so files can still be joined (see "PII scrubbing coverage" in `METHODS.md`). It does not detect names or addresses.
- **Study code** (salt) — optional string that hashes the donor ID per study, so the same donor's exports under different study codes cannot be joined.
- **Include donor context** — ChatGPT only; includes the user's custom instructions ("About you" / "How ChatGPT should respond"). Sensitive; on by default, can be switched off in Privacy settings.

The manifest inside each ZIP records which settings were on, so you always know what you are looking at.

---

## 3. What one export looks like

Every ZIP is named:

```
{platform}_{conversation_id_short}_{timestamp}.zip
```

e.g. `claude_c6a2d8dc_2026-10-13T11-58-12Z.zip`.

**Every file inside the ZIP carries the same `{conversation_id_short}_{timestamp}` suffix as the ZIP itself.** CSVs are often moved around after unzipping — attached to emails, dropped into shared folders, copied into analysis directories — and once separated from the archive, bare names like `claude_messages.csv` become ambiguous. Repeating the slug on every inner file means any single CSV can always be traced back to the ZIP (and manifest) it came from.

A typical Claude export (with slug `c6a2d8dc_2026-10-13T11-58-12Z`) contains:

```
claude_c6a2d8dc_2026-10-13T11-58-12Z.zip
├── claude_metadata_c6a2d8dc_2026-10-13T11-58-12Z.csv              (one row, conversation-level)
├── claude_messages_c6a2d8dc_2026-10-13T11-58-12Z.csv              (one row per content block)
├── claude_sources_c6a2d8dc_2026-10-13T11-58-12Z.csv               (one row per citation; may be absent)
├── claude_attachments_c6a2d8dc_2026-10-13T11-58-12Z.csv           (one row per uploaded file; may be absent)
├── claude_messages_canonical_c6a2d8dc_2026-10-13T11-58-12Z.csv    (one row per message, cross-platform shape)
└── claude_manifest_c6a2d8dc_2026-10-13T11-58-12Z.json             (checksums, row counts, validation summary)
```

The schema prefix (`claude_messages`, `claude_metadata`, …) still lets scripts glob by schema with a trailing wildcard, e.g. `**/claude_messages_*.csv`.

The other platforms follow the same `{stem}_{conversation_id_short}_{timestamp}` pattern:

- **ChatGPT:** `chatgpt_metadata`, `chatgpt_messages`, `chatgpt_sources`, `chatgpt_message_urls`, `chatgpt_donor_context`, `chatgpt_messages_canonical`, `chatgpt_manifest`
- **Copilot:** `copilot_conversation`, `copilot_messages_canonical`, `copilot_manifest`
- **Microsoft 365 Copilot:** `m365_copilot_conversation`, `m365_copilot_sources`, `m365_copilot_messages_canonical`, `m365_copilot_manifest`
- **Perplexity, Grok, DeepSeek, Mistral:** `<platform>_metadata`, `<platform>_messages`, `<platform>_sources`, `<platform>_messages_canonical`, `<platform>_manifest`
- **Google Search:** `google_ai_overview` or `google_ai_mode`, plus `google_sources`, the matching `_canonical`, and `google_search_manifest`

**File characteristics worth knowing:**

- Every CSV begins with a UTF-8 BOM so Excel opens it with the right encoding.
- Field separator: `,` — quoting: RFC 4180 — line endings: `\r\n` (CRLF) in every CSV, each file ending with a newline.
- Empty "optional" CSVs (sources, attachments, donor context) are only emitted when there is at least one row. Don't assume every file is always present.

---

## 4. The two layers of CSVs

Each export has **two layers**:

**(a) Platform-specific CSVs** — e.g. `claude_messages.csv`, `chatgpt_sources.csv`. These keep every detail the platform exposed: Claude's thinking blocks, ChatGPT's conversation tree, Google's follow-up questions, Copilot's channel ID. Shape and columns differ per platform.

**(b) A canonical CSV per export** — `{platform}_messages_canonical.csv`. Every platform produces one, and they all share **the same 14 columns in the same order**. This is the layer to use when you want to pool exports across platforms into one dataset.

Rule of thumb:

- Looking at **one platform in depth** → read the platform-specific CSVs.
- **Comparing or pooling across platforms** → start from the canonical CSVs. Platform-specific extras are preserved as JSON in the `platform_specific_json` column of the canonical file, so nothing is lost.

---

## 5. Variable reference

Each table below lists columns, their meaning, type, and a **confidence score**:

- **High** — present in a synthetic fixture and pinned end-to-end by the test suite (`docs/validation.md` says which platforms have also been checked against real captures).
- **Medium** — follows the platform's observed API shape, matched by the extractor's defensive code, but not exercised by a fixture.
- **Low** — the extractor codes for the shape defensively; not yet seen in fixtures or real data. Verify against your own exports.

### 5.1 Shared donor columns (every CSV)

| Column | Type | Meaning | Confidence |
|---|---|---|---|
| `schema_version` | string | Version of that CSV's schema (`1.0.0`, or `1.1.0` for the files that gained columns in 3.0.0; see the table in `METHODS.md`). | High |
| `extractor_version` | string | Version of the extension build that produced the file. | High |
| `donor_id` | string | A UUID (or HMAC thereof) identifying the donor across their exports. **Not** a real-world identity. | High |
| `donor_id_type` | string | `persistent` (stored in browser storage) or `session` (fallback if storage unavailable). | High |
| `download_time` | ISO 8601 | UTC timestamp when the export was generated. | High |

### 5.2 ChatGPT CSVs

#### 5.2.1 `chatgpt_metadata.csv` — one row per conversation

| Column | Type | Meaning | Confidence |
|---|---|---|---|
| `api_format` | string | `mapping` (old ChatGPT API) or `messages_array` (new API). Lets you flag mixed corpora. | High |
| `conversation_id` | string | OpenAI's conversation UUID. | High |
| `title` | string | User- or model-assigned conversation title. | High |
| `create_time` | ISO 8601 | When the conversation was first created on OpenAI's side. | High |
| `update_time` | ISO 8601 | When it was last updated. | High |
| `default_model_slug` | string | e.g. `gpt-4o`, `gpt-6`. May be empty on very old conversations. | High |
| `memory_scope` | string | e.g. `global_enabled`. Whether ChatGPT Memory was active. | Medium |
| `is_do_not_remember` | boolean | True if the user flagged this conversation as not to be remembered. | Medium |
| `num_messages` | int | Count excluding `user_editable_context` / `model_editable_context` nodes. | High |
| `num_user_messages` | int | Human-authored messages. | High |
| `num_assistant_messages` | int | Model replies. | High |
| `num_tool_messages` | int | Tool/function-call messages (e.g. web search, code interpreter). | High |
| `num_orphaned_nodes` | int | Nodes present in the mapping but unreachable from the root — signals branched/regenerated turns silently dropped. Only applies to `mapping` format. | High |

#### 5.2.2 `chatgpt_messages.csv` — one row per node

| Column | Type | Meaning | Confidence |
|---|---|---|---|
| `conversation_id` | string | Links to metadata. | High |
| `message_id` | string | ChatGPT's internal node ID (unique within the conversation). | High |
| `parent_id` | string | Parent node ID, or empty for the root. Lets you rebuild the conversation tree. | High |
| `turn_number` | int / empty | BFS depth from root (0 = root). Empty = orphaned. | High |
| `author_role` | string | `user`, `assistant`, `system`, or `tool`. | High |
| `tool_name` | string | For `author_role = tool`, the name of the tool (e.g. `web_search`). | High |
| `content_type` | string | `text`, `multimodal_text`, `thoughts`, `reasoning_recap`, `execution_output`, `code`. | High |
| `text` | string | Extracted plaintext for the node. Thought/reasoning nodes surface OpenAI's summaries. | High |
| `text_cleaned` | string | `text` with markup, citation placeholders and invisible characters removed (see `METHODS.md`). | High |
| `create_time` | ISO 8601 | When the message was created. | High |
| `model_slug` | string | The specific model that produced the message (may differ from the conversation's default). | High |
| `on_visible_path` | boolean | True when the node is on the thread the user last saw (from `current_node` to the root). Every branch is exported, so filter on this to reproduce the screen. Always true for the messages-array format. | High |

#### 5.2.3 `chatgpt_sources.csv` — one row per source

| Column | Type | Meaning | Confidence |
|---|---|---|---|
| `conversation_id`, `message_id` | string | Which message cited this source. | High |
| `source_list` | string | `search_result` (from `search_result_groups`) or `grouped_webpages` (from `content_references`). | High |
| `type` | string | Entry type as returned by ChatGPT (varies by product version). | High |
| `url` | string | Raw URL as provided. | High |
| `url_clean` | string | URL with `utm_*` tracking parameters stripped — safer for deduplication. | High |
| `title`, `snippet` | string | Human-readable label and excerpt. | High |
| `ref_turn_index`, `ref_type`, `ref_index` | int / string | Pointer back into the message's inline citation markers. | Medium |
| `pub_date` | ISO 8601 | Publication date (if ChatGPT returns one). | Medium |
| `attribution` | string | e.g. the news outlet name. | Medium |

#### 5.2.4 `chatgpt_message_urls.csv` — one row per non-image URL

| Column | Type | Meaning | Confidence |
|---|---|---|---|
| `message_id` | string | Which message mentioned this URL. | High |
| `url`, `url_clean` | string | Raw + UTM-stripped. Image CDN URLs (openai thumbnails) are excluded. | High |

#### 5.2.5 `chatgpt_donor_context.csv` — one row per conversation

| Column | Type | Meaning | Confidence |
|---|---|---|---|
| `user_profile` | string | The "About you" text the user set in ChatGPT custom instructions. **Sensitive.** | High |
| `user_instructions` | string | The "How ChatGPT should respond" text. **Sensitive.** | High |

Only generated if the donor opted in (see `include_donor_context` in the manifest).

### 5.3 Claude CSVs

#### 5.3.1 `claude_metadata.csv` — one row per conversation

| Column | Type | Meaning | Confidence |
|---|---|---|---|
| `conversation_id` | string | Claude's UUID. | High |
| `conversation_name` | string | The chat's display title. | High |
| `summary` | string | Claude-generated summary; often empty. | High |
| `created_at`, `updated_at` | ISO 8601 | Conversation-level timestamps. | High |
| `enabled_web_search` | boolean | Whether web search was enabled for the conversation. **Important confound for content analysis.** | High |
| `enabled_monkeys_in_a_barrel` | boolean | Internal Anthropic feature flag — probably not meaningful. | Medium |
| `preview_feature_uses_artifacts` | boolean | Whether Artifacts (code/document panels) were enabled. | High |
| `settings_json` | JSON string | Raw `settings` object for any future keys not surfaced as named columns. | High |
| `is_starred` | boolean | User bookmarked the conversation. | High |
| `is_temporary` | boolean | "Temporary chat" mode — not saved to history. Important privacy/behavior signal. | High |
| `current_leaf_message_uuid` | string | ID of the end-of-conversation message. Points to the active branch if there are edits. | Medium |
| `num_messages`, `num_user_messages`, `num_assistant_messages` | int | Message counts. | High |
| `num_text_blocks`, `num_thinking_blocks`, `num_tool_use_blocks`, `num_tool_result_blocks` | int | Counts of each content block type across all messages. | Medium |

#### 5.3.2 `claude_messages.csv` — one row **per content block** (not per message)

A single Claude assistant message with `[thinking, tool_use, text]` produces **three rows**, each with a shared `message_id` but distinct `block_index` and `content_type`. Watch out for this when counting messages — see §7 pitfalls.

| Column | Type | Meaning | Confidence |
|---|---|---|---|
| `conversation_id` | string | Claude's conversation UUID. | High |
| `message_id` | string | The message UUID; same across all blocks of one message. | High |
| `parent_message_id` | string | UUID of the parent message. | High |
| `message_index` | int | Position of the message in the conversation (from Claude's `index`). | High |
| `block_index` | int | Position of this block within the message's `content[]`. | High |
| `sender` | string | `human` or `assistant`. (For cross-platform, use canonical `role` where `human → user`.) | High |
| `content_type` | string | `text`, `thinking`, `tool_use`, `tool_result`, or something new. | Medium (defensive) |
| `text` | string | For `text`: the message body. For `thinking`: Claude's raw thinking, which the web interface sends **empty** (`thinking_hidden`). For `tool_result`: the result text. Empty for `tool_use`. | High |
| `text_cleaned` | string | `text` cleaned for NLP (see `METHODS.md`). | High |
| `thinking_summary` | string | For `thinking` blocks: Claude's reasoning summaries, joined with blank lines. This is the only reasoning text Claude's web interface exposes. | High |
| `tool_name` | string | Only populated for `tool_use` blocks (e.g. `web_search`). | High |
| `tool_input_json` | JSON string | For `tool_use`: the tool's arguments. e.g. `{"query": "weather Brussels"}`. | High |
| `tool_use_id` | string | Links a `tool_use` block to its matching `tool_result` block. | High |
| `block_start_timestamp`, `block_stop_timestamp` | ISO 8601 | Per-block generation timing — useful for latency analysis. | Medium |
| `message_created_at`, `message_updated_at` | ISO 8601 | Message-level timestamps (same across all blocks). | High |
| `message_truncated` | boolean | Whether Claude stopped mid-generation. | High |
| `message_stop_reason` | string | e.g. `stop_sequence`, `max_tokens`, `tool_use`. | High |
| `thinking_mode` | string | Claude's per-message thinking setting (e.g. `auto`). | High |
| `on_visible_path` | boolean | True when the message is on the chain from `current_leaf_message_uuid` to the root, i.e. what the user last saw. Edited prompts and regenerated answers are exported too, with `false`. | High |
| `raw_block_json` | JSON string | **The full raw content block, for future-proofing.** If a new Claude content type appears, you can parse it from here even before the extractor is updated. | High |

#### 5.3.3 `claude_sources.csv` — one row per citation

Generated only when at least one content block has a non-empty `citations[]` array. Expect this to be populated for conversations where web search was enabled.

| Column | Type | Meaning | Confidence |
|---|---|---|---|
| `platform` | string | Always `claude`. Lets you concat with `chatgpt_sources.csv` and `google_sources.csv`. | High |
| `conversation_id`, `message_id`, `block_index` | string / int | Which block cited this source. | High |
| `source_list` | string | Always `citation` for Claude. | High |
| `type` | string | Citation type (e.g. `web_search_result_location`, `char_location`, `page_location`). | Low |
| `url` | string | Source URL, if the citation is a web location. | Low |
| `url_clean` | string | UTM-stripped. | Low |
| `title` | string | Source title (or `document_title` for file citations). | Low |
| `snippet` | string | The quoted/cited text (from `cited_text` or `excerpt`). | Low |
| `start_index`, `end_index` | int / string | Character / block / page offsets inside the source. | Low |
| `raw_json` | JSON string | Full raw citation object — authoritative when the named fields are empty. | High |

#### 5.3.4 `claude_attachments.csv` — one row per uploaded file

| Column | Type | Meaning | Confidence |
|---|---|---|---|
| `source` | string | `attachments`, `files`, `files_v2`, or `sync_sources` — which array it came from. | High |
| `file_uuid` | string | Claude's internal file ID. | Medium |
| `file_name`, `file_type`, `file_size` | string, string, int | Standard file metadata. | Medium |
| `extracted_text` | string | If Claude extracted text from the file (PDFs, docs), it lives here. Scrubbed when PII scrubbing is on. | High |
| `raw_json` | JSON string | Full raw item — same future-proofing role as `raw_block_json`. | High |

#### 5.3.5 `claude_messages_canonical.csv` — one row per message

See §5.11 for the shared canonical schema. Claude-specific fields in `platform_specific_json` include:

- `sender` — the raw `human`/`assistant` value before role normalization.
- `content_types` — array of block types in document order (e.g. `["thinking", "tool_use", "text"]`).
- `on_visible_path`, `thinking_mode` — as in `claude_messages`.
- `thinking_text`, `thinking_summary`, `tool_result_text` — the reasoning and tool-result text that is kept **out** of the canonical `text` column (which holds the answer's text blocks only).
- `has_thinking`, `has_tool_use`, `has_tool_result`, `has_attachments` — convenience booleans.
- `truncated`, `stop_reason`, `updated_at`.

### 5.4 Google Search CSVs

Two modes: **AI Overview** (the summary box above search results) and **AI Mode** (the conversational Gemini interface).

#### 5.4.1 `google_ai_overview.csv` — one row per Overview

| Column | Type | Meaning | Confidence |
|---|---|---|---|
| `query` | string | The search query that produced the Overview. | High |
| `source_page_url` | string | The Google results URL. | High |
| `captured_at` | ISO 8601 | When the content script read the DOM. | High |
| `ai_overview_text` | string | The full Overview text. | High |
| `ai_overview_text_cleaned` | string | Cleaned for NLP. | High |
| `source_urls`, `source_titles` | string | Comma-joined. For a cleaner per-row shape, use `google_sources.csv`. | High |
| `follow_up_questions` | string | Comma-joined suggested follow-ups. | High |
| `follow_up_count` | int | Convenience count. | High |

#### 5.4.2 `google_ai_mode.csv` — one row per turn in an AI Mode conversation

| Column | Type | Meaning | Confidence |
|---|---|---|---|
| `conversation_id` | string | The search query from the page URL; also names the ZIP and the files. | High |
| `conversation_title` | string | The first user turn's text (or the query). | High |
| `turn_index` | int | Position of the turn (0-based). | High |
| `role` | string | `user` or `assistant`. | High |
| `text`, `text_cleaned` | string | Turn content, raw and cleaned. | High |
| `source_urls`, `source_titles` | string | Comma-joined per turn. | High |

#### 5.4.3 `google_sources.csv` — one row per source URL

| Column | Type | Meaning | Confidence |
|---|---|---|---|
| `platform` | string | Always `google_search`. | High |
| `mode` | string | `ai_overview` or `ai_mode`. | High |
| `conversation_id` | string | The search query (both modes). | High |
| `turn_index` | int / empty | Turn position (mode only). | High |
| `url`, `url_clean` | string | Raw + UTM-stripped. | High |
| `title` | string | Source title. | High |

### 5.5 Copilot CSVs

#### 5.5.1 `copilot_conversation.csv` — one row per Copilot result

| Column | Type | Meaning | Confidence |
|---|---|---|---|
| `conversation_id` | string | Copilot's conversation ID. | High |
| `message_id` | string | Result ID. | High |
| `role` | string | `user` or `assistant` (normalized from Copilot's `human`/`ai`). | High |
| `text`, `text_cleaned` | string | Message text, raw and cleaned. | High |
| `created_at` | ISO 8601 | Message timestamp. | High |
| `channel` | string | Copilot channel (e.g. `web`). | Medium |
| `mode` | string | Copilot mode / model identifier. | Medium |
| `part_ids` | string | Comma-joined content-part IDs. | Medium |
| `author_type` | string | Raw author type (`human` / `ai`) before role normalization. | High |

Note: Copilot does not currently emit a dedicated sources CSV because the extractor does not surface Copilot's source array yet.

### 5.6 Microsoft 365 Copilot CSVs

Captured from the Chathub WebSocket frames; **not yet validated against raw captures** (see `docs/validation.md`).

#### 5.6.1 `m365_copilot_conversation.csv` — one row per message

| Column | Type | Meaning | Confidence |
|---|---|---|---|
| `conversation_id`, `message_id`, `request_id` | string | Conversation, message and request identifiers from the frame. | Medium |
| `author`, `role` | string | Raw `user`/`bot` and the normalised `user`/`assistant`. | Medium |
| `text`, `text_cleaned`, `spoken_text` | string | Message text (raw, cleaned) and the spoken-text variant if present. | Medium |
| `message_type`, `content_origin`, `turn_state`, `response_identifier`, `offense`, `input_method` | string | Frame metadata as sent by the service. | Medium |
| `turn_count` | int | Turn number within the conversation. | Medium |
| `created_at` | ISO 8601 | Frame timestamp. | Medium |
| `source_count`, `suggested_count` | int | Number of cited sources / suggested follow-ups on the message. | Medium |
| `adaptive_cards_json`, `raw_json` | JSON string | Adaptive cards and the full raw frame. | Medium |

#### 5.6.2 `m365_copilot_sources.csv` — one row per cited source

`platform`, `conversation_id`, `request_id`, `message_type`, `source_index`, `provider_name`, `title`, `snippet`, `url`, `url_clean`, `search_query`, `image_link`, `raw_json`. (Medium.)

### 5.7 Perplexity CSVs

#### 5.7.1 `perplexity_metadata.csv` — one row per thread

`conversation_id`, `title`, `created_at`, `updated_at`, `num_turns`, `num_sources`, `page_count` (how many paginated thread pages were merged). (High.)

#### 5.7.2 `perplexity_messages.csv` — two rows per turn (user, assistant)

| Column | Type | Meaning | Confidence |
|---|---|---|---|
| `conversation_id` | string | Thread UUID. | High |
| `message_id`, `parent_id` | string | `<entry uuid>:user` / `<entry uuid>:assistant`; each turn's user row points at the previous assistant row. | High |
| `entry_uuid`, `turn_index` | string, int | The thread entry and its position. | High |
| `role` | string | `user` or `assistant`. | High |
| `text`, `text_cleaned` | string | The question (user row) or the answer (assistant row). | High |
| `code_text` | string | Code blocks of the answer, joined. | Medium |
| `reasoning_text` | string | Perplexity's reasoning / plan blocks, as sent (not verified on real data). | Medium |
| `created_at` | ISO 8601 | Entry timestamp. | High |
| `model_identifier`, `status`, `source_count` | string, string, int | Display model, entry status, number of sources. | High |

#### 5.7.3 `perplexity_sources.csv` — one row per cited web result

`conversation_id`, `entry_uuid`, `turn_index`, `source_index`, `source_block_type`, `url`, `url_clean`, `title`, `snippet`, `domain`, `publication_date`. (High.)

### 5.8 Grok CSVs

#### 5.8.1 `grok_metadata.csv` — one row per conversation

`conversation_id`, `title`, `create_time`, `modify_time`, `temporary`, `system_prompt_name`, `media_types`, `num_messages`, `num_user_messages`, `num_assistant_messages`, `num_messages_with_web_search`, `num_messages_with_attachments`, `num_messages_with_generated_images`. (High; the id comes from the page URL because Grok's payload carries none.)

#### 5.8.2 `grok_messages.csv` — one row per message

| Column | Type | Meaning | Confidence |
|---|---|---|---|
| `conversation_id`, `message_id`, `parent_message_id` | string | Identifiers; `parent_message_id` is Grok's `parentResponseId`. | High |
| `turn_index` | int | Position in the response list. | High |
| `sender`, `role` | string | Raw `human`/`assistant` and the normalised role. | High |
| `text`, `text_cleaned` | string | Message text; `text_cleaned` strips Grok's inline citation markup. | High |
| `model_identifier` | string | Model name on the response. | High |
| `created_at` | ISO 8601 | Response timestamp. | High |
| `manual`, `partial`, `shared` | boolean | Grok flags on the response. | Medium |
| `has_web_search`, `has_attachments`, `has_generated_images`, `tools_used`, `xpost_ids`, `feedback_labels` | boolean / string | Feature signals and references. | Medium |
| `raw_message_json` | JSON string | The full raw response. | High |

#### 5.8.3 `grok_sources.csv` — one row per web / X result

Mirrors the other sources files (`url`, `url_clean`, `title`, `snippet`, …). (Medium.)

### 5.9 DeepSeek CSVs

#### 5.9.1 `deepseek_metadata.csv` — one row per session

`conversation_id`, `title`, `title_type`, `model_type`, `pinned`, `version`, `updated_at`, `num_messages`, `num_user_messages`, `num_assistant_messages`, `num_messages_with_search`, `num_messages_with_thinking`, `num_messages_with_files`. (High.)

#### 5.9.2 `deepseek_messages.csv` — one row per message

| Column | Type | Meaning | Confidence |
|---|---|---|---|
| `conversation_id`, `message_id`, `parent_message_id` | string | Session id and DeepSeek's integer message ids (stringified). | High |
| `turn_index` | int | Position in the message list. | High |
| `role`, `sender` | string | Normalised role and the raw `USER`/`ASSISTANT`. | High |
| `text`, `text_cleaned` | string | The request (user) or the response fragments (assistant). | High |
| `thinking_text`, `thinking_text_cleaned` | string | DeepSeek's `THINK` fragments, as sent. | High |
| `model` | string | Model on the message (schema 1.1.0). | High |
| `created_at`, `status`, `quasi_status`, `conversation_mode` | string | Message metadata. | Medium |
| `search_enabled`, `search_triggered`, `thinking_enabled`, `ban_regenerate`, `has_pending_fragment`, `has_search_fragment`, `has_tool_fragment`, `has_file_fragment` | boolean | Feature flags and fragment signals. | Medium |
| `fragment_count`, `fragment_types`, `incomplete_message` | int / string | Fragment summary. | High |
| `feedback_json`, `token_usage_json`, `raw_message_json` | JSON string | Feedback, token usage and the full raw message. | High |

#### 5.9.3 `deepseek_sources.csv` — one row per search result

`platform`, `conversation_id`, `message_id`, `fragment_id`, `fragment_type`, `source_index`, `cite_index` (DeepSeek's citation number), `url`, `url_clean`, `title`, `snippet`, `site_name`, `provider`, `published_at`, `raw_json`. (High.)

### 5.10 Mistral CSVs

#### 5.10.1 `mistral_metadata.csv` — one row per chat

`conversation_id`, `title`, `generated_title`, `user_title`, `product_type`, `visibility`, `permission`, `pinned`, `created_at`, `updated_at`, `organization_id`, `project_id`, `model_alias`, `reasoning_effort`, `features`, `integrations`, `libraries`, `num_messages`, `num_user_messages`, `num_assistant_messages`, `num_messages_with_tool_call`, `num_messages_with_reasoning`, `num_messages_with_search`, `num_messages_with_files`, `num_cited_sources`. (Medium; the chat half of the payload can be absent, in which case these are empty.)

#### 5.10.2 `mistral_messages.csv` — one row per message

| Column | Type | Meaning | Confidence |
|---|---|---|---|
| `conversation_id`, `message_id`, `parent_message_id` | string | Identifiers. | High |
| `turn_index` | int | Mistral's `turn`, in conversation order (the API sends newest-first; the export is oldest-first). | High |
| `role` | string | `user` or `assistant`. | High |
| `text`, `text_cleaned` | string | The rendered answer (top-level `content`), or the non-reasoning text chunks joined. | High |
| `reasoning_text`, `reasoning_text_cleaned` | string | Chunks Mistral marks as reasoning, as sent. | High |
| `model_identifier`, `created_at`, `status`, `generation_status` | string | Model and generation metadata. | Medium |
| `moderation_category`, `moderation_blocked_category`, `reaction`, `visibility`, `is_accelerated_answer`, `agent_id` | string / boolean | Message metadata. | Low |
| `version`, `version_count` | int | Revision number and count for edited / regenerated messages. | Medium |
| `chunk_count`, `chunk_types`, `tool_names`, `has_reasoning`, `has_tool_call`, `has_search_result`, `has_files`, `cited_source_count` | int / string / boolean | Chunk summary. | High |
| `content_chunks_json`, `files_json`, `raw_message_json` | JSON string | The chunk list, files and the full raw message. | High |

#### 5.10.3 `mistral_sources.csv` — one row per cited source or search result

`platform`, `conversation_id`, `message_id`, `source_list` (`cited` or `tool_call`), `source_index`, `source_id`, `type`, `url`, `url_clean`, `title`, `snippet`, `site_name`, `published_at`, `tool_name`, `raw_json`. (Medium.)

### 5.11 Canonical schema (all platforms)

Every `*_messages_canonical.csv` has these 14 columns, in this order:

| Column | Meaning |
|---|---|
| `donor_id` | HMAC(donor UUID, study salt) if a salt is configured; raw UUID otherwise. |
| `platform` | `chatgpt`, `claude`, `copilot`, `m365_copilot`, `perplexity`, `grok`, `deepseek`, `mistral`, `google_ai_overview`, or `google_ai_mode`. |
| `conversation_id` | Platform's native conversation ID. |
| `message_id` | Platform's native message ID. |
| `parent_message_id` | Parent in the conversation tree, if applicable. |
| `turn_index` | Message position (BFS depth for ChatGPT, raw `index` for Claude, turn number for Google AI Mode). |
| `role` | Normalized to `user` / `assistant` / `system` / `tool`. (Claude's `human` → `user`.) |
| `text` | The message's answer text. For Claude this is the `text` blocks only; thinking summaries and tool results are in `platform_specific_json`. For Perplexity and DeepSeek, code and reasoning text are likewise kept in `platform_specific_json`. |
| `text_cleaned` | `text` with whitespace and markup normalised (see `utils/text_cleaner.js`); the raw `text` is always kept alongside. |
| `created_at_iso` | ISO 8601 UTC. |
| `model_identifier` | Model slug if known; empty for Claude in the current version. |
| `schema_version`, `extractor_version` | Provenance. |
| `platform_specific_json` | JSON with everything that doesn't fit the canonical columns — content types, tool-use flags, has_attachments, status fields, etc. |

### 5.12 `{platform}_manifest_{slug}.json`

Every ZIP contains a manifest describing itself (e.g. `claude_manifest_c6a2d8dc_2026-10-13T11-58-12Z.json`). Open it in any text editor — it is the first thing to read when you receive a new export, because it tells you what settings produced the file and which CSVs are supposed to be in the archive.

| Field | Meaning |
|---|---|
| `manifest_schema_version` | Currently `1.1.0`. |
| `extractor_version` | Extension version that produced the export. |
| `platform` | Which platform. |
| `conversation_id` | Native conversation ID (same as the CSVs). |
| `api_format` | ChatGPT only: `mapping` or `messages_array`. |
| `donor_id_hashed` | SHA-256 of the donor UUID when no study code is set; when a study code is set it is the same HMAC value as `donor_id` in the CSVs. |
| `donor_id_type` | `persistent` or `session`. |
| `download_time` | ISO 8601 UTC. |
| `files[]` | One entry per CSV: filename, schema name, schema version, row count, byte size, SHA-256. |
| `telemetry` | PII scrub summary, orphaned node count, per-schema validation results, extraction telemetry. |

---

## 6. Privacy and donor identity

- **`donor_id`** is a UUID generated locally in the browser the first time the donor exports. It is stored for one year, then rotated. It is not linked to any OpenAI / Anthropic / Google / Microsoft account.
- **Study salt (optional):** if the donor configures a `study_salt`, the `donor_id` in every CSV is `HMAC-SHA256(uuid, salt)`. Donors across studies cannot be joined, so pooling data across studies is safe.
- **PII scrubbing (optional):** if the donor enables PII scrubbing, every string cell of every file is passed through the scrubber (emails, phone numbers, IPs, JWTs, API keys, SSNs, credit cards, long tokens); JSON columns are scrubbed inside their string values so they stay valid, and identifiers, timestamps and URLs are preserved. Redactions become `<REDACTED:EMAIL>` etc. The manifest's `telemetry.pii_redactions_total` counts redactions across all files. Names and addresses are not detected.
- **Consent record:** the browser stores when, and to which version of the consent text, the donor agreed (`consent_version`, `consent_given_at`). This is not written into the export.

---

## 7. Common pitfalls when reading an export

1. **Per-block vs per-message grain for Claude.** `claude_messages.csv` has multiple rows per message. If you count rows thinking you're counting messages, you'll over-count any Claude conversation that used extended thinking or tool calls. Use the canonical CSV (one row per message) when that's what you need.
2. **Role vocabulary differs across platforms.** ChatGPT uses `user`/`assistant`/`system`/`tool`. Claude uses `human`/`assistant`. Google uses `user`/`assistant`. Copilot normalizes to `user`/`assistant`. The canonical CSV normalizes all of these.
3. **Branches.** ChatGPT and Claude exports contain every branch: edited prompts and regenerated answers appear as extra messages that share a parent. Filter on `on_visible_path == true` to get the thread the donor saw on screen; keep everything to study revisions. ChatGPT nodes unreachable from the root have `turn_number == ""`.
8. **Leading `'` in cells.** Any cell that starts with `=`, `+`, `-`, `@`, `|` or a tab gets a `'` prefix so spreadsheets do not run it as a formula; a message beginning with `- item` is stored as `'- item`. Strip it in your pipeline (rule in `METHODS.md`).
4. **Timestamps.** All times are normalized to ISO 8601 UTC.
5. **`platform_specific_json` is a string, not a parsed object.** You will need to parse it before accessing nested keys.
6. **Empty CSVs.** `claude_sources.csv`, `claude_attachments.csv`, `chatgpt_sources.csv`, `chatgpt_message_urls.csv`, and `chatgpt_donor_context.csv` are only emitted when there is at least one row. Check for file presence before loading.
7. **BOM.** Every CSV starts with a UTF-8 BOM. Spreadsheet tools handle this automatically; naive loaders may leave `﻿` in the first column name — point them at UTF-8-with-BOM encoding.

---

## 8. Where to look if something is wrong

- **CSV won't open in Excel:** should not happen (BOM + UTF-8). If it does, check for a corrupted ZIP.
- **A column is empty but you expected data:** check `raw_block_json` / `raw_json` for Claude; check `platform_specific_json` for the canonical CSV; check `extraction_telemetry` in the manifest for Google.
- **Row counts don't match the manifest:** report it — the manifest's `rows` field is computed by a CSV-aware counter that respects quoted newlines. A mismatch usually means the file was edited after export.
- **Validation failures:** `manifest.telemetry.validation[schema]` lists them with row indices.

---

## 9. Next step: further processing

Once you are comfortable with what a single export contains, further processing — filtering, aggregating, counting, searching, text analysis, network analysis across many exports — is done in **[4CAT](https://4cat.nl/)**. 4CAT accepts these CSVs directly and provides the analytical layer that is intentionally left out of this guide. Treat this document as the preparation: it gets you to the point where the data makes sense, and 4CAT takes over from there.

---

**Document provenance.** Generated by Claude (Anthropic) on 2026-10-13, based on direct reads of this repository's source code and a Claude test fixture. The confidence annotations reflect what could be verified in-repo; they are not editorial opinions about Anthropic/OpenAI/Google/Microsoft APIs. When this document and the code disagree, the code wins.
