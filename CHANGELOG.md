# Changelog

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
