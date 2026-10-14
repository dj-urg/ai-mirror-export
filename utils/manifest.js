/**
 * Provenance utilities: schema versions, SHA-256 checksums, HMAC donor ID,
 * and the `_manifest.json` sidecar emitted alongside every export bundle.
 *
 * Works in a WebExtension service worker (crypto.subtle) and in Node 20+
 * tests (globalThis.crypto.subtle). No DOM, no browser.*, no deps.
 */

export const EXTRACTOR_VERSION = '3.0.0';

export const SCHEMA_VERSIONS = Object.freeze({
  chatgpt_metadata: '1.0.0',
  chatgpt_messages: '1.0.0',
  chatgpt_sources: '1.0.0',
  chatgpt_message_urls: '1.0.0',
  chatgpt_donor_context: '1.0.0',
  chatgpt_messages_canonical: '1.0.0',
  claude_metadata: '1.0.0',
  claude_messages: '1.0.0',
  claude_sources: '1.0.0',
  claude_attachments: '1.0.0',
  claude_messages_canonical: '1.0.0',
  copilot_conversation: '1.0.0',
  copilot_messages_canonical: '1.0.0',
  m365_copilot_conversation: '1.0.0',
  m365_copilot_sources: '1.0.0',
  m365_copilot_messages_canonical: '1.0.0',
  perplexity_metadata: '1.0.0',
  perplexity_messages: '1.0.0',
  perplexity_sources: '1.0.0',
  perplexity_messages_canonical: '1.0.0',
  grok_metadata: '1.0.0',
  grok_messages: '1.0.0',
  grok_sources: '1.0.0',
  grok_messages_canonical: '1.0.0',
  deepseek_metadata: '1.0.0',
  // 1.1.0: `model_class`/`model_name` (always empty: the API carries `model`)
  // replaced by `model`; `cite_index` added to sources; fragment ids stringified.
  deepseek_messages: '1.1.0',
  deepseek_sources: '1.1.0',
  deepseek_messages_canonical: '1.0.0',
  mistral_metadata: '1.0.0',
  mistral_messages: '1.0.0',
  mistral_sources: '1.0.0',
  mistral_messages_canonical: '1.0.0',
  // 1.1.0: `conversation_id` column added (the search query), so AI Mode
  // exports stop being named `unknown` and canonical rows carry a real id.
  google_ai_mode: '1.1.0',
  google_ai_mode_canonical: '1.0.0',
  google_ai_overview: '1.0.0',
  google_ai_overview_canonical: '1.0.0',
  google_sources: '1.0.0'
});

// 1.1.0 added additive telemetry fields: pii_scrub_options, pii_ruleset_version,
// pii_redactions_by_type. Downstream parsers that ignore unknown keys stay
// compatible. Bump major when a field is renamed or removed.
export const MANIFEST_SCHEMA_VERSION = '1.1.0';

const CANONICAL_HEADERS = Object.freeze([
  'donor_id',
  'platform',
  'conversation_id',
  'message_id',
  'parent_message_id',
  'turn_index',
  'role',
  'text',
  'text_cleaned',
  'created_at_iso',
  'model_identifier',
  'schema_version',
  'extractor_version',
  'platform_specific_json'
]);

/**
 * Canonical columns, in order, for messages_canonical.csv across platforms.
 * @returns {string[]}
 */
export function canonicalHeaders() {
  return [...CANONICAL_HEADERS];
}

/**
 * Compute SHA-256 of a string, returned as lowercase hex.
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text ?? '');
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  const arr = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, '0');
  return out;
}

/**
 * HMAC-SHA256 the donor ID with a study salt so IDs cannot be joined across
 * studies. If salt is empty, returns the raw ID unchanged so single-study use
 * still works.
 * @param {string} donorId
 * @param {string} studySalt
 * @returns {Promise<string>}
 */
export async function hmacDonorId(donorId, studySalt) {
  if (!studySalt) return donorId;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(studySalt),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(donorId));
  const arr = new Uint8Array(sig);
  let out = '';
  for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, '0');
  return out;
}

/**
 * Count CSV data rows (excludes the header line). CSV-aware: newlines inside
 * quoted fields don't inflate the count. RFC 4180 quoting rules: a `"` toggles
 * quoted mode unless immediately followed by another `"` (escaped quote).
 * @param {string} csv
 * @returns {number}
 */
export function countRows(csv) {
  if (!csv) return 0;
  let records = 0;
  let inQuotes = false;
  let fieldLen = 0;
  let recordLen = 0;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (inQuotes) {
      if (ch === '"') {
        if (csv[i + 1] === '"') { fieldLen++; i++; }
        else { inQuotes = false; }
      } else {
        fieldLen++;
      }
      recordLen = Math.max(recordLen, fieldLen);
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && csv[i + 1] === '\n') i++;
      if (recordLen > 0 || fieldLen > 0) records++;
      fieldLen = 0;
      recordLen = 0;
      continue;
    }
    fieldLen++;
    recordLen = Math.max(recordLen, fieldLen);
  }
  if (recordLen > 0) records++; // trailing record without newline
  return Math.max(0, records - 1); // subtract header
}

/**
 * Build a `_manifest.json` sidecar describing one export bundle.
 * @param {object} params
 * @param {string} params.platform
 * @param {string} params.conversationId
 * @param {string} params.donorIdHashed
 * @param {string} params.donorIdType
 * @param {string} params.downloadTime
 * @param {string} [params.apiFormat]
 * @param {Array<{filename:string,content:string,schemaName:string,rowCount?:number}>} params.files
 * @param {object} [params.extras]  Freeform telemetry: validation summary, PII counts, selector fallbacks.
 * @returns {Promise<string>}  JSON string ready to download.
 */
export async function buildManifest({
  platform,
  conversationId,
  donorIdHashed,
  donorIdType,
  downloadTime,
  apiFormat,
  files,
  extras
}) {
  const fileEntries = [];
  for (const f of files) {
    fileEntries.push({
      filename: f.filename,
      schema: f.schemaName,
      schema_version: SCHEMA_VERSIONS[f.schemaName] || 'unknown',
      rows: typeof f.rowCount === 'number' ? f.rowCount : countRows(f.content),
      bytes: new TextEncoder().encode(f.content).length,
      sha256: await sha256Hex(f.content)
    });
  }
  const manifest = {
    manifest_schema_version: MANIFEST_SCHEMA_VERSION,
    extractor_version: EXTRACTOR_VERSION,
    platform,
    conversation_id: conversationId || null,
    api_format: apiFormat || null,
    donor_id_hashed: donorIdHashed,
    donor_id_type: donorIdType,
    download_time: downloadTime,
    files: fileEntries,
    ...(extras ? { telemetry: extras } : {})
  };
  return JSON.stringify(manifest, null, 2);
}

/**
 * Normalize any timestamp input to an RFC 3339 UTC string, or '' if unparseable.
 * Accepts: ISO strings, Unix seconds (number), Unix milliseconds (number).
 * @param {string|number|null|undefined} v
 * @returns {string}
 */
export function toIsoUtc(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  }
  return '';
}
