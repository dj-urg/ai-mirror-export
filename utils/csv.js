/**
 * CSV Generation Utility Module
 * 
 * Provides functions for generating CSV content from flattened data structures.
 * Handles proper escaping according to RFC 4180.
 */

/**
 * Escapes a field value for CSV format according to RFC 4180
 * Also prevents CSV injection attacks
 *
 * Rules:
 * - Fields containing comma, quote, or newline must be wrapped in quotes
 * - Quotes within fields must be escaped by doubling them
 * - Empty/null values become empty strings
 * - Values starting with dangerous characters (=, +, -, @, tab, CR) are prefixed with single quote
 *   to prevent formula execution in Excel/Google Sheets
 *
 * @param {*} value - The value to escape
 * @returns {string} Escaped CSV field value
 */
export function escapeCSVField(value) {
  // Handle null/undefined
  if (value === null || value === undefined) {
    return '';
  }

  // Convert to string
  let stringValue = String(value);

  // Prevent CSV injection: sanitize values starting with dangerous characters.
  // Covers Excel/LibreOffice/Google Sheets/Numbers formula triggers plus the
  // DDE pipe and Unicode variants (fullwidth equals/plus/minus/at) that some
  // spreadsheets normalize before evaluation.
  const dangerousChars = [
    '=', '+', '-', '@', '|',
    '\t', '\r', '\n',
    '＝', '＋', '－', '＠'
  ];
  if (stringValue.length > 0 && dangerousChars.includes(stringValue.charAt(0))) {
    // Prefix with single quote to treat as text
    stringValue = "'" + stringValue;
  }

  // Check if field needs escaping (contains comma, quote, or newline)
  if (stringValue.includes(',') || stringValue.includes('"') ||
      stringValue.includes('\n') || stringValue.includes('\r')) {
    // Escape quotes by doubling them, then wrap in quotes
    return '"' + stringValue.replace(/"/g, '""') + '"';
  }

  return stringValue;
}

/**
 * Generates CSV content from an array of objects
 *
 * @param {Array<Object>} data - Array of objects to convert to CSV
 * @param {Array<string>} headers - Optional array of header names. If not provided, uses all keys from first object.
 * @returns {string} CSV formatted string
 */
export function generateCSV(data, headers = null) {
  if (!data || data.length === 0) {
    return '';
  }

  if (!headers) {
    headers = Object.keys(data[0]);
  }

  const headerRow = headers.map(escapeCSVField).join(',');
  const rows = [headerRow];
  for (const row of data) {
    const values = headers.map(header => escapeCSVField(row[header]));
    rows.push(values.join(','));
  }

  // RFC 4180 record separator with a terminating newline, matching every
  // other CSV writer in the extension so one ZIP never mixes line endings.
  return rows.join('\r\n') + '\r\n';
}

/**
 * Generates a CSV file with UTF-8 BOM for Excel compatibility
 *
 * @param {string} csvContent - The CSV content
 * @returns {Blob} Blob object ready for download
 */
export function createCSVBlob(csvContent) {
  // Add UTF-8 BOM for Excel compatibility
  const BOM = '\uFEFF';
  return new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
}

/**
 * Generates a filename with timestamp.
 *
 * Safety rules applied (cross-platform best practices):
 *  - Only [A-Za-z0-9_.-] in the base name.
 *  - No reserved characters (/, \, :, *, ?, ", <, >, |) — these would be
 *    rejected or silently rewritten by Windows/macOS/Linux filesystems.
 *  - No leading dot (hidden file on Unix) and no trailing dot/space (invalid
 *    on Windows).
 *  - Total length capped at 180 chars (well under the 255-byte filesystem
 *    limit even with multi-byte characters).
 *  - ISO 8601-like UTC timestamp so file listings sort chronologically.
 *
 * @param {string} prefix - Filename prefix (e.g., 'claude_conversation')
 * @param {string} [suffix] - Optional suffix (e.g., conversation id/query)
 * @returns {string} Generated filename ending in .csv
 */
export function generateFilename(prefix = 'export', suffix = '') {
  const safe = (s) => String(s || '')
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '')
    .replace(/_+/g, '_');

  const now = new Date();
  // UTC timestamp so the same conversation exported from any timezone sorts
  // identically.
  const pad = (n) => String(n).padStart(2, '0');
  const timestamp =
    `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}-${pad(now.getUTCMinutes())}-${pad(now.getUTCSeconds())}Z`;

  const safePrefix = safe(prefix) || 'export';
  const safeSuffix = safe(suffix);

  let base = safeSuffix
    ? `${safePrefix}_${safeSuffix}_${timestamp}`
    : `${safePrefix}_${timestamp}`;

  // Guard against filesystem length limits.
  if (base.length > 180) base = base.substring(0, 180).replace(/[._-]+$/, '');

  return `${base}.csv`;
}


