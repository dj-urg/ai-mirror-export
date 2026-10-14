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
