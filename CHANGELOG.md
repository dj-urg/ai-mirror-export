# Changelog

## 3.1.0 — 2026-11-02

### What's new

- **Google Gemini support.** You can now export your conversations from Google Gemini (`gemini.google.com`), in the same ZIP of spreadsheet (CSV) files as the other sites. When you click Export, the extension reads the whole conversation again from Gemini, so messages you sent after opening the page are included. As with every site, everything happens in your browser and nothing is sent anywhere.

### Fixed

- **The Export button works again after an export.** After one export the button stopped responding until you closed and reopened the extension, so "try again" after a failed download did nothing. The extension also replaced "Exporting…" and the result of the export with "Ready to export" after about two seconds. The result now stays on screen until you export again or the page changes.
- **"Remove sensitive data" now also cleans web addresses.** When this option is on, emails, phone numbers and similar details are now also removed from inside links in the exported files, for example the Google search you typed. Before, they could stay in a link even though the rest of the file was cleaned.

### Why Firefox is asking for permission again

When this update installs, Firefox may ask you to approve one new permission: access to `gemini.google.com`. The extension needs it so it can read your Gemini conversations when you choose to export them. This is the only new permission. The extension does not ask for access to anything else. It only talks to the chat site you are exporting from, and your conversations are never sent anywhere else: they stay in your browser until you decide to share the downloaded file.

### For researchers

- **Four new schemas, all at `1.0.0`:** `gemini_metadata`, `gemini_messages`, `gemini_sources` (one row per citation, with the position of the answer passage it supports) and `gemini_messages_canonical`. The content script reads the open conversation through Gemini's own `hNvQHb` history RPC, same-origin with the site's existing cookies, and reads it again at every export. Column definitions are in [`METHODS.md`](METHODS.md).
- **`extractor_version` is `3.1.0`** in every CSV and manifest. No existing schema changed; with scrubbing off, exports from the other nine sites differ from 3.0.0 only in this value.
- **PII scrubbing now covers URL query strings.** With `pii_scrub_enabled`, the decoded value of every query-string parameter (and every fragment parameter, e.g. `#:~:text=…`) in URL columns (`url`, `url_clean`, `source_page_url`, `source_urls`, `image_link`, `conversation_url`) and in URL-valued keys inside `*_json` columns gets the text rules. Scheme, host, path and unchanged parameters keep their exact bytes; a changed value keeps its encoding style, with the placeholder written literally (`…/search?q=mail+<REDACTED:EMAIL>`). In 3.0.0 a Google search query survived in `source_page_url` (`…/search?q=…`) in all three Google files and the canonical `platform_specific_json`, as did `?email=` / `&token=` parameters in source links and Microsoft 365 Copilot's `seeMoreUrl`. Scrub-on exports only; scrub-off output is unchanged. `pii_ruleset_version` stays `1.0.0` (the patterns did not change, only where they apply). See "PII scrubbing coverage" in [`METHODS.md`](METHODS.md).

## 3.0.0 — 2026-10-14

### What's new

- **Six new supported sites.** Perplexity, Grok, Microsoft 365 Copilot, DeepSeek, Mistral, and Google Search AI Overview (including AI Mode). Everything already supported — ChatGPT, Claude, Copilot — still works the same way.
- **Dark mode.** The popup now follows your Firefox theme.
- **New export format: ZIP of CSVs.** Each export is now a single `.zip` named `<platform>_<conversation-id>_<timestamp>.zip`. Inside are `<platform>_metadata_…csv`, `<platform>_messages_…csv`, a cross-platform `<platform>_messages_canonical_…csv` and (depending on platform) `…_sources_…csv` and others, plus a short `<platform>_manifest_…json` describing what's inside and holding SHA-256 checksums. Every file name carries the same conversation id and timestamp as the ZIP.
- **Review your export.** After the download the popup asks you to open the ZIP and check what is in it before sharing it; "Show in Downloads" reveals the file. The popup no longer closes by itself.
- **Clearer errors and sign-in detection.** The popup now says specifically when a conversation is empty, too large, or incomplete, when a download has failed, or when Claude needs you to sign in again — instead of hanging on a loading spinner or showing internal messages. "Your ZIP will contain" lists the real files for each site.
- **Toolbar icon state.** The icon is in colour on supported sites and grey elsewhere, with a text title saying which, and shows a `!` badge when the last export on that tab failed.
- **Reliability fixes found in review and real-data validation.** DeepSeek exports a brand-new chat with content (the extension refreshes the conversation when the popup opens, at most once every 30 seconds while it stays open, and when you export); Grok exports are named after the conversation instead of `unknown`; Perplexity is injected once (no duplicate ZIPs, no debug output); Google is re-requested at most once per search and never while the popup polls.
- **Development Preview marker.** A permanent "Preview" tag in the header and a dismissible banner on first open make it obvious this is beta software.
- **Accessibility improvements.** Full keyboard operation (`Esc` closes the popup), visible focus rings that also work under high-contrast mode, respects `prefers-reduced-motion`, every status card is announced to screen readers.

### For researchers

- **`extractor_version` is `3.0.0`** in every CSV and manifest (it was stuck at `2.1.1`), and a test keeps it equal to the add-on version.
- **Branches are exported, with a visible-path marker.** ChatGPT and Claude exports contain every edited prompt and regenerated answer; `on_visible_path` says which messages were on the thread shown on screen.
- **Consent record.** The browser stores `consent_version` and `consent_given_at` next to `consent_given`, and every manifest's `telemetry` carries them (manifest schema `1.2.0`, additive; `null` for installs that consented before 3.0.0).
- **Verification.** `docs/validation.md` documents the automated suite, the accessibility baseline and the real-data validation method and log.
- **Breaking change: the export format changed from one CSV to a ZIP of CSVs.** Existing analysis scripts that read a single `.csv` need updating to unpack the `.zip` first and read the individual files inside. See [`METHODS.md`](METHODS.md) for the schema of each file in the bundle.
- **Donor identifiers are pseudonymous, not anonymous.** The `donor_id` in every CSV is a locally-generated UUID (not linked to any account), but it's stable across all of that donor's exports, so multiple exports from the same install can be joined. Add an optional **study code** in Privacy settings to turn `donor_id` into `HMAC-SHA256(uuid, salt)` so the same donor across different studies yields different IDs.
- **Optional PII scrubbing** (pattern-based, best-effort). Enable in Privacy settings to replace emails, phone numbers, IP addresses, API keys and other patterned secrets with placeholders. When it is on, every file in the ZIP is covered: the platform CSVs, the canonical CSV, the raw-JSON columns, sources, attachments and the custom-instructions file (and, on Google, the search query that names the files). Identifiers, timestamps and model names are left intact so files can still be joined; links are kept (except URLs that embed credentials). Names and addresses are not detected. See "PII scrubbing coverage" in [`METHODS.md`](METHODS.md).
- **ChatGPT schema 1.1.0.** `chatgpt_messages` gains `on_visible_path` (all branches of the mapping tree are exported; this marks the thread shown on screen, from `current_node` to the root); the canonical rows carry the same flag in `platform_specific_json`.
- **Claude schema 1.1.0.** `claude_messages` gains `thinking_summary` (Claude's reasoning summaries; the web interface does not expose full reasoning text), `thinking_mode` and `on_visible_path` (all branches are exported; this marks the chain the user last saw). In `claude_messages_canonical`, `text` is now the answer text only; thinking, summaries and tool results live in `platform_specific_json`.
- **DeepSeek schema 1.1.0.** `deepseek_messages` replaces the always-empty `model_class`/`model_name` columns with `model` (the key DeepSeek's API actually uses); `deepseek_sources` gains `cite_index` and stringified `fragment_id`. See the schema-version table in [`METHODS.md`](METHODS.md).
- **Google AI Mode schema 1.1.0.** AI Mode exports now carry a `conversation_id` (the search query) in the flat CSV, the canonical rows, the sources rows, the manifest and the file names, which were previously `…_unknown_…`.
- **Uniform CSV line endings.** Every CSV in the ZIP uses `\r\n` and ends with a newline (previously the flat Copilot, Microsoft 365 Copilot and Google files and the ChatGPT metadata and custom-instructions files used bare `\n`).
- **`text_cleaned` column and row validation.** Message CSVs now carry a `text_cleaned` column (whitespace/markup-normalised copy of `text`; the raw `text` is always kept) and the manifest records a per-file validation summary.

### Why Firefox is asking for permissions again

This update adds new permissions (the `tabs` permission is **not** requested; the toolbar icon state works from the host permissions):

- `scripting` — needed to load the Perplexity reader reliably.
- Host permissions for the new sites: `www.perplexity.ai`, `grok.com`, `chat.deepseek.com`, `chat.mistral.ai` and `m365.cloud.microsoft`.
- Ten Google-locale host permissions (`.com`, `.be`, `.nl`, `.fr`, `.de`, `.co.uk`, `.es`, `.it`, `.ca`, `.com.au`) — so the extension can read AI Overview text from Google search pages. The content script only runs on `/search*` paths. It never sends a new query; at most it re-requests the search page you are already viewing to read the overview text.

Nothing is sent to any server — all processing stays in your browser.

### Removed

- Removed the Reload Page button. Reload the tab yourself if the popup asks you to.
- Removed the large-export confirmation card; it could never appear, and exporting a large conversation is harmless.
- Removed the page-visible debug helpers (`__perplexityExporterProbe`, `__m365CopilotDebug`, `__mistralExporterIsInterestingRequest`).
