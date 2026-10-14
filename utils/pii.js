/**
 * PII scrubbing utilities for CSV exports.
 *
 * Pure string/regex module — safe for Firefox service worker and Node.js.
 * No external dependencies. No I/O. No globals.
 */

// Bump when any pattern below changes meaningfully, so exports can be traced
// back to the exact rules that produced them. Semver: patch for tightening a
// bounded regex, minor for adding/removing a category, major for anything a
// downstream parser could break on.
export const PII_RULESET_VERSION = '1.0.0';

// Option keys exposed in `_manifest.json` under `pii_scrub_options`.
// Scrubbing is otherwise all-or-nothing (via `pii_scrub_enabled`); the keys
// here are the ones that are individually togglable. Match the UPPERCASE
// vocabulary emitted by `countRedactions().byType` so the two manifest fields
// share one naming scheme.
export const PII_SCRUB_OPTION_KEYS = Object.freeze(['URL']);

// ---------------------------------------------------------------------------
// Regex patterns (order below in scrubText matters: emails -> phones -> IPs ->
// JWT -> URL -> CC -> SSN -> names -> generic token).
// ---------------------------------------------------------------------------

// RFC-5322-lite: local@domain.tld. Keep conservative.
const EMAIL_RE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}\b/g;

// International (+countrycode) + NANP styles. Requires 7+ digits of signal to
// avoid chewing on short numerics. Allows (), spaces, dots, dashes as separators.
const PHONE_RE = /(?:(?<![A-Za-z0-9])\+\d{1,3}[\s.\-]?)?(?:\(\d{2,4}\)[\s.\-]?|\d{2,4}[\s.\-])\d{2,4}[\s.\-]?\d{2,4}(?:[\s.\-]?\d{2,4})?(?![A-Za-z0-9])/g;

// IPv4 with each octet 0-255. Avoids matching inside longer digit runs.
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g;

// JWT: header.payload.signature, all base64url.
const JWT_RE = /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g;

// URL (http/https/ftp or protocol-relative). Scrubbed only when stripUrls=true.
const URL_RE = /\b(?:https?:\/\/|ftp:\/\/|\/\/)[^\s<>"')]+/gi;

// Credit-card-like: 13-19 digit runs, allowing spaces/dashes as separators.
// Enforces that the raw digit count lands in [13,19].
const CC_RE = /\b(?:\d[ \-]?){12,18}\d\b/g;

// US SSN pattern.
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;

// Explicit API-key / bearer / provider-key patterns (caught before TOKEN_RE so
// shorter known-prefixed secrets still get scrubbed).
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._\-]+/gi;
const SK_KEY_RE = /\b(?:sk|pk|rk|xoxb|xoxp|ghp|gho|ghs|ghr|AKIA|ASIA|AIza)[A-Za-z0-9_\-]{16,}\b/g;

// URL with embedded userinfo (e.g., https://user:pass@host/path).
const URL_USERINFO_RE = /\b(?:https?|ftp):\/\/[^\s/@"'<>]+:[^\s/@"'<>]*@[^\s"'<>]+/gi;

// Generic long token: 32+ alphanumeric (plus _ and -) run, bounded.
// Deliberately conservative — runs after everything else so it won't eat emails.
const TOKEN_RE = /(?<![A-Za-z0-9_\-])[A-Za-z0-9_\-]{32,}(?![A-Za-z0-9_\-])/g;

/**
 * Luhn checksum validator — reduces CC false positives.
 * @param {string} digits
 * @returns {boolean}
 */
function luhnValid(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// ---------------------------------------------------------------------------
// Column classification. When scrubbing is on, EVERY string cell of EVERY
// CSV goes through `scrubCell`, which decides per column:
//
//   structural  identifiers, timestamps, enums, counters: left untouched so
//               joins, ordering and provenance survive. A UUID or ISO date
//               would otherwise be eaten by the generic token / phone rules.
//   url         URL-valued columns: governed by the URL option. With
//               `stripUrls` the whole value becomes <REDACTED:URL>; without
//               it only credentials embedded in the URL are removed, so
//               sources stay usable for news / source studies.
//   json        `*_json` columns: parsed, walked, every prose string scrubbed,
//               re-serialised. Keys that denote ids, timestamps or URLs and
//               values that are bare UUIDs / ISO dates are preserved, so the
//               JSON stays valid and joinable.
//   text        everything else: full `scrubText`.
//
// A column that is not listed anywhere is treated as text (fail safe for
// privacy). test_pii.js asserts that every column emitted by the golden
// exports is classified explicitly, so a new column must be placed here on
// purpose.
// ---------------------------------------------------------------------------

export const STRUCTURAL_COLUMNS = Object.freeze(new Set([
  // provenance
  'donor_id', 'donor_id_type', 'download_time', 'platform', 'schema_version', 'extractor_version', 'api_format',
  // identifiers
  'conversation_id', 'message_id', 'node_id', 'parent_id', 'parent_message_id', 'request_id', 'fragment_id',
  'source_id', 'tool_use_id', 'entry_uuid', 'current_leaf_message_uuid', 'file_uuid', 'part_ids', 'image_ids',
  'xpost_ids', 'agent_id', 'organization_id', 'project_id', 'response_identifier',
  // positions and counters
  'turn_index', 'turn_number', 'turn_count', 'block_index', 'message_index', 'source_index', 'cite_index',
  'start_index', 'end_index', 'ref_index', 'ref_turn_index', 'page_count', 'version', 'version_count',
  'file_size', 'source_count', 'suggested_count', 'follow_up_count', 'chunk_count', 'fragment_count',
  'cited_source_count',
  // timestamps
  'created_at', 'create_time', 'created_at_iso', 'updated_at', 'update_time', 'modify_time', 'captured_at',
  'published_at', 'publication_date', 'pub_date', 'message_created_at', 'message_updated_at',
  'block_start_timestamp', 'block_stop_timestamp',
  // enums, flags, machine names
  'role', 'author_role', 'author_type', 'author', 'sender', 'content_type', 'fragment_type', 'fragment_types',
  'message_type', 'source_list', 'source_block_type', 'source', 'type', 'mode', 'status', 'quasi_status',
  'generation_status', 'turn_state', 'title_type', 'ref_type', 'file_type', 'model', 'model_alias',
  'model_identifier', 'model_slug', 'default_model_slug', 'model_type', 'channel', 'visibility', 'permission',
  'product_type', 'reaction', 'input_method', 'content_origin', 'offense', 'conversation_mode', 'chunk_types',
  'tool_name', 'tool_names', 'tools_used', 'provider', 'provider_name', 'site_name', 'domain', 'attribution',
  'features', 'integrations', 'libraries', 'reasoning_effort', 'memory_scope', 'message_stop_reason',
  'incomplete_message', 'moderation_category', 'moderation_blocked_category', 'feedback_labels', 'thinking_mode', 'on_visible_path',
  'system_prompt_name', 'media_types', 'end_turn', 'manual', 'partial', 'pinned', 'shared', 'temporary',
  'ban_regenerate', 'search_enabled', 'search_triggered', 'thinking_enabled', 'message_truncated',
  'enabled_web_search', 'enabled_monkeys_in_a_barrel', 'preview_feature_uses_artifacts'
]));

// Prefix rules for whole families of flag / counter columns.
const STRUCTURAL_PREFIX_RE = /^(num_|has_|is_)/;

export const URL_COLUMNS = Object.freeze(new Set([
  'url', 'url_clean', 'source_page_url', 'source_urls', 'image_link'
]));

export const TEXT_COLUMNS = Object.freeze(new Set([
  'text', 'text_cleaned', 'thinking_text', 'thinking_text_cleaned', 'thinking_summary', 'reasoning_text', 'reasoning_text_cleaned',
  'code_text', 'title', 'generated_title', 'user_title', 'conversation_name', 'conversation_title', 'summary',
  'snippet', 'query', 'search_query', 'ai_overview_text', 'ai_overview_text_cleaned', 'follow_up_questions',
  'source_titles', 'spoken_text', 'user_instructions', 'user_profile', 'file_name', 'extracted_text'
]));

// Columns that are free text on one platform although structural elsewhere.
// Google's conversation id is the search query.
export const PLATFORM_TEXT_COLUMNS = Object.freeze({
  google_search: new Set(['conversation_id'])
});

export const JSON_COLUMN_RE = /_json$/;

/**
 * @param {string} column
 * @param {string} [platform]
 * @returns {'structural'|'url'|'json'|'text'|'unknown'}
 */
export function classifyColumn(column, platform) {
  const override = platform && PLATFORM_TEXT_COLUMNS[platform];
  if (override && override.has(column)) return 'text';
  if (JSON_COLUMN_RE.test(column)) return 'json';
  if (URL_COLUMNS.has(column)) return 'url';
  if (STRUCTURAL_COLUMNS.has(column) || STRUCTURAL_PREFIX_RE.test(column)) return 'structural';
  if (TEXT_COLUMNS.has(column)) return 'text';
  return 'unknown';
}

/**
 * Escape a string for use inside a RegExp.
 * @param {string} s
 * @returns {string}
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a case-insensitive, word-bounded regex matching any of the given names.
 * @param {string[]} names
 * @returns {RegExp|null}
 */
function buildNamesRegex(names) {
  if (!Array.isArray(names) || names.length === 0) return null;
  const parts = names
    .filter(n => typeof n === 'string' && n.trim().length > 0)
    .map(n => escapeRegex(n.trim()));
  if (parts.length === 0) return null;
  // Sort longest-first so "Jane Doe" wins over "Jane".
  parts.sort((a, b) => b.length - a.length);
  return new RegExp(`\\b(?:${parts.join('|')})\\b`, 'gi');
}

/**
 * Scrub PII patterns from a string.
 * @param {string} text
 * @param {{stripUrls?: boolean, names?: string[]}} [options]
 * @returns {string}
 */
export function scrubText(text, options) {
  if (text === null || text === undefined) return text;
  if (typeof text !== 'string') return text;
  if (text.length === 0) return text;

  const opts = options || {};
  let out = text;

  // Order matters.
  out = out.replace(URL_USERINFO_RE, '<REDACTED:URL>');
  out = out.replace(EMAIL_RE, '<REDACTED:EMAIL>');
  out = out.replace(JWT_RE, '<REDACTED:JWT>');
  out = out.replace(BEARER_RE, '<REDACTED:TOKEN>');
  out = out.replace(SK_KEY_RE, '<REDACTED:TOKEN>');
  if (opts.stripUrls) {
    out = out.replace(URL_RE, '<REDACTED:URL>');
  }
  out = out.replace(SSN_RE, '<REDACTED:SSN>');
  out = out.replace(CC_RE, (m) => {
    const digits = m.replace(/[^\d]/g, '');
    if (digits.length < 13 || digits.length > 19) return m;
    return luhnValid(digits) ? '<REDACTED:CC>' : m;
  });
  out = out.replace(PHONE_RE, (m) => {
    const digits = m.replace(/[^\d]/g, '');
    return digits.length >= 7 && digits.length <= 15 ? '<REDACTED:PHONE>' : m;
  });
  out = out.replace(IPV4_RE, '<REDACTED:IP>');

  const namesRe = buildNamesRegex(opts.names);
  if (namesRe) out = out.replace(namesRe, '<REDACTED:NAME>');

  out = out.replace(TOKEN_RE, '<REDACTED:TOKEN>');

  return out;
}

/**
 * Return a shallow copy of `row` with the given columns scrubbed.
 * @param {Object} row
 * @param {string[]} columns
 * @param {{stripUrls?: boolean, names?: string[]}} [options]
 * @returns {Object}
 */
export function scrubRow(row, columns, options) {
  if (row === null || row === undefined || typeof row !== 'object') return row;
  const cols = Array.isArray(columns) ? columns : [];
  const out = { ...row };
  for (const col of cols) {
    if (Object.prototype.hasOwnProperty.call(out, col)) {
      out[col] = scrubText(out[col], options);
    }
  }
  return out;
}

/**
 * Return a new array of rows with the given columns scrubbed in each row.
 * @param {Object[]} rows
 * @param {string[]} columns
 * @param {{stripUrls?: boolean, names?: string[]}} [options]
 * @returns {Object[]}
 */
export function scrubRows(rows, columns, options) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(r => scrubRow(r, columns, options));
}

/**
 * URL-valued cell. With `stripUrls` the whole value is replaced; otherwise
 * only credentials embedded in a URL (user:pass@host) are removed.
 * @param {string} value
 * @param {{stripUrls?: boolean}} [options]
 * @returns {string}
 */
export function scrubUrlValue(value, options) {
  if (typeof value !== 'string' || value.length === 0) return value;
  if (options && options.stripUrls) return '<REDACTED:URL>';
  return value.replace(URL_USERINFO_RE, '<REDACTED:URL>');
}

// Inside JSON columns: keys and values that denote identifiers, timestamps
// or URLs rather than prose.
const JSON_ID_KEY_RE = /(^|[_-])(id|ids|uuid|uuids)$|(Id|Ids|Uuid)$/;
const JSON_TIME_KEY_RE = /(^|[_-])(at|time|timestamp|date|datetime)$|(At|Time|Timestamp|Date)$/;
const JSON_URL_KEY_RE = /(^|[_-])(url|urls|link|href|src)$|(Url|Urls|Link|Href|Src)$/;
const ISO_DATE_VALUE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const UUID_VALUE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function addCounts(acc, counts) {
  acc.total += counts.total;
  for (const [type, n] of Object.entries(counts.byType)) {
    acc.byType[type] = (acc.byType[type] || 0) + n;
  }
}

function scrubJsonValue(value, key, options, counts) {
  if (typeof value === 'string') {
    if (value.length === 0) return value;
    if (JSON_ID_KEY_RE.test(key) || JSON_TIME_KEY_RE.test(key)) return value;
    if (ISO_DATE_VALUE_RE.test(value) || UUID_VALUE_RE.test(value)) return value;
    const out = JSON_URL_KEY_RE.test(key) ? scrubUrlValue(value, options) : scrubText(value, options);
    addCounts(counts, countRedactions(value, out));
    return out;
  }
  if (Array.isArray(value)) return value.map(v => scrubJsonValue(v, key, options, counts));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubJsonValue(v, k, options, counts);
    return out;
  }
  return value;
}

/**
 * Scrub a JSON-encoded cell structurally: parse, scrub prose string values,
 * re-serialise. Placeholders therefore never break the JSON. Falls back to
 * plain text scrubbing if the cell does not parse.
 * @param {string} text
 * @param {{stripUrls?: boolean, names?: string[]}} [options]
 * @returns {{value: string, counts: {total: number, byType: Object<string, number>}}}
 */
export function scrubJsonText(text, options) {
  const counts = { total: 0, byType: {} };
  if (typeof text !== 'string' || text.length === 0) return { value: text, counts };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const out = scrubText(text, options);
    addCounts(counts, countRedactions(text, out));
    return { value: out, counts };
  }
  const scrubbed = scrubJsonValue(parsed, '', options, counts);
  return { value: JSON.stringify(scrubbed), counts };
}

/**
 * Scrub one CSV cell according to its column's classification.
 * @param {string} column
 * @param {*} value
 * @param {{stripUrls?: boolean, names?: string[]}} [options]
 * @param {string} [platform]
 * @returns {{value: *, counts: {total: number, byType: Object<string, number>}}}
 */
export function scrubCell(column, value, options, platform) {
  const counts = { total: 0, byType: {} };
  if (typeof value !== 'string' || value.length === 0) return { value, counts };
  switch (classifyColumn(column, platform)) {
    case 'structural':
      return { value, counts };
    case 'url': {
      const out = scrubUrlValue(value, options);
      addCounts(counts, countRedactions(value, out));
      return { value: out, counts };
    }
    case 'json':
      return scrubJsonText(value, options);
    default: {
      const out = scrubText(value, options);
      addCounts(counts, countRedactions(value, out));
      return { value: out, counts };
    }
  }
}

/**
 * Scrub every cell of a row (shallow copy, key order preserved).
 * @param {Object} row
 * @param {{stripUrls?: boolean, names?: string[]}} [options]
 * @param {string} [platform]
 * @returns {{row: Object, counts: {total: number, byType: Object<string, number>}}}
 */
export function scrubRowDeep(row, options, platform) {
  const counts = { total: 0, byType: {} };
  if (row === null || row === undefined || typeof row !== 'object') return { row, counts };
  const out = {};
  for (const [column, value] of Object.entries(row)) {
    const r = scrubCell(column, value, options, platform);
    out[column] = r.value;
    addCounts(counts, r.counts);
  }
  return { row: out, counts };
}

/**
 * Count `<REDACTED:*>` markers added by scrubbing.
 * @param {string} originalText
 * @param {string} scrubbedText
 * @returns {{total: number, byType: Object<string, number>}}
 */
export function countRedactions(originalText, scrubbedText) {
  const byType = {};
  let total = 0;
  if (typeof scrubbedText !== 'string') return { total, byType };

  const markerRe = /<REDACTED:([A-Z]+)>/g;
  const countIn = (str) => {
    const counts = {};
    let m;
    while ((m = markerRe.exec(str)) !== null) {
      counts[m[1]] = (counts[m[1]] || 0) + 1;
    }
    return counts;
  };

  const scrubbedCounts = countIn(scrubbedText);
  const originalCounts = typeof originalText === 'string'
    ? countIn(originalText)
    : {};

  for (const type of Object.keys(scrubbedCounts)) {
    const added = scrubbedCounts[type] - (originalCounts[type] || 0);
    if (added > 0) {
      byType[type] = added;
      total += added;
    }
  }
  return { total, byType };
}
