# Changelog

## 3.0.0 — 2026-10-13

### What's new

- **Six new supported sites.** Perplexity, Grok, Microsoft 365 Copilot, DeepSeek, Mistral, and Google Search AI Overview (including AI Mode). Everything already supported — ChatGPT, Claude, Copilot — still works the same way.
- **Dark mode.** The popup now follows your Firefox theme.
- **New export format: ZIP of CSVs.** Each export is now a single `.zip` containing a `metadata.csv`, `messages.csv`, and (depending on platform) `sources.csv`, `canonical.csv`, and others, plus a short `_manifest.json` describing what's inside and holding SHA-256 checksums.
- **Clearer errors and sign-in detection.** The popup now says specifically when a conversation is empty, when a download has failed, or when Claude needs you to sign in again — instead of hanging on a loading spinner.
- **Development Preview marker.** A permanent "Preview" tag in the header and a dismissible banner on first open make it obvious this is beta software.
- **Accessibility improvements.** Full keyboard operation (`Esc` closes the popup), visible focus rings that also work under high-contrast mode, respects `prefers-reduced-motion`, every status card is announced to screen readers.

### For researchers

- **Breaking change: the export format changed from one CSV to a ZIP of CSVs.** Existing analysis scripts that read a single `.csv` need updating to unpack the `.zip` first and read the individual files inside. See [`METHODS.md`](METHODS.md) for the schema of each file in the bundle.
- **Donor identifiers are pseudonymous, not anonymous.** The `donor_id` in every CSV is a locally-generated UUID (not linked to any account), but it's stable across all of that donor's exports, so multiple exports from the same install can be joined. Add an optional **study code** in Privacy settings to turn `donor_id` into `HMAC-SHA256(uuid, salt)` so the same donor across different studies yields different IDs.
- **Optional PII scrubbing** (pattern-based, best-effort). Enable in Privacy settings to replace emails, phone numbers, API keys, and other patterned secrets with placeholders. Links in message text are kept intact.

### Why Firefox is asking for permissions again

This update adds three categories of permission:

- `tabs` — so the popup can tell which site the active tab is on and show the right toolbar icon.
- `scripting` — needed to load the Perplexity reader reliably.
- Ten Google-locale host permissions — so the extension can read AI Overview text from Google search pages. The content script only runs on `/search*` paths; nothing is sent to Google.

Nothing is sent to any server — all processing stays in your browser.

### Removed

- Removed the Reload Page button. Reload the tab yourself if the popup asks you to.
