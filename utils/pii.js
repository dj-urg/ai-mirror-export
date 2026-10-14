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

/**
 * Default columns to scrub per CSV filename.
 * Keys match the base names used by the extension's CSV writers.
 */
export const DEFAULT_SCRUB_COLUMNS = Object.freeze({
  chatgpt_messages: ['text', 'text_cleaned'],
  chatgpt_donor_context: ['user_profile', 'user_instructions'],
  claude_metadata: ['conversation_name', 'summary'],
  claude_messages: ['text', 'text_cleaned'],
  claude_sources: ['title', 'snippet'],
  claude_attachments: ['file_name', 'extracted_text'],
  copilot_conversation: ['text', 'text_cleaned'],
  m365_copilot_conversation: ['text', 'text_cleaned', 'spoken_text'],
  m365_copilot_sources: ['title', 'snippet'],
  perplexity_metadata: ['title'],
  perplexity_messages: ['text', 'text_cleaned', 'code_text', 'reasoning_text'],
  perplexity_sources: ['title', 'snippet'],
  grok_metadata: ['title'],
  grok_messages: ['text', 'text_cleaned'],
  grok_sources: ['title', 'snippet'],
  deepseek_metadata: ['title'],
  deepseek_messages: ['text', 'text_cleaned', 'thinking_text', 'thinking_text_cleaned'],
  deepseek_sources: ['title', 'snippet'],
  mistral_metadata: ['title', 'generated_title', 'user_title'],
  mistral_messages: ['text', 'text_cleaned', 'reasoning_text', 'reasoning_text_cleaned'],
  mistral_sources: ['title', 'snippet'],
  google_ai_mode: ['text', 'text_cleaned', 'conversation_title', 'conversation_id'],
  google_ai_overview: ['query', 'ai_overview_text', 'ai_overview_text_cleaned'],
  google_sources: ['title']
});

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
