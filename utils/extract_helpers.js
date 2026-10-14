/**
 * Helpers shared by every platform extractor (and the inline handlers in
 * background.js). Pure functions, no DOM, no browser.*; safe in Node tests.
 *
 * Kept in one place so a fix lands everywhere at once; the per-platform
 * golden tests pin the output.
 */

const UTM_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

/**
 * Remove the five standard UTM tracking parameters from a URL. Returns the
 * input unchanged when it does not parse as a URL, and '' for empty input.
 * @param {string} url
 * @returns {string}
 */
export function stripUtmParams(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    UTM_PARAMS.forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Serialise a value for a raw-JSON CSV column: '' for null/undefined or
 * anything JSON.stringify rejects.
 * @param {*} value
 * @returns {string}
 */
export function toJsonCell(value) {
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * Map a platform's role / sender vocabulary onto the canonical one:
 * user, assistant, system. Unknown values are returned lower-cased; empty
 * input returns ''.
 * @param {string} role
 * @returns {string}
 */
export function normalizeRole(role) {
  if (!role) return '';
  const r = String(role).toLowerCase();
  if (r === 'user' || r === 'human') return 'user';
  if (r === 'assistant' || r === 'bot' || r === 'ai') return 'assistant';
  if (r === 'system') return 'system';
  return r;
}
