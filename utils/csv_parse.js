/**
 * Strict RFC 4180 CSV reader, the counterpart to utils/csv.js.
 *
 * Returns raw field strings exactly as written: no type coercion, no
 * trimming, and the CSV-injection `'` prefix that escapeCSVField adds is
 * left in place, so escapeCSVField(field) reproduces the original bytes.
 * A leading UTF-8 BOM is dropped. Malformed input (an unterminated quote,
 * text after a closing quote, or a row with the wrong number of fields)
 * throws CsvParseError instead of being guessed at.
 */

export class CsvParseError extends Error {}

/**
 * @param {string} text
 * @returns {{headers: string[], rows: string[][]}}
 */
export function parseCSV(text) {
  const s = text.startsWith('﻿') ? text.slice(1) : text;
  const records = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let quotedField = false;
  let line = 1;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (field.length > 0 || quotedField) throw new CsvParseError(`Unexpected quote on line ${line}.`);
      inQuotes = true;
      quotedField = true;
      continue;
    }
    if (ch === ',') { row.push(field); field = ''; quotedField = false; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      records.push(row);
      row = []; field = ''; quotedField = false;
      line++;
      continue;
    }
    if (quotedField) throw new CsvParseError(`Text after a closing quote on line ${line}.`);
    field += ch;
  }
  if (inQuotes) throw new CsvParseError('The file ends inside a quoted field.');
  if (field.length > 0 || quotedField || row.length > 0) { row.push(field); records.push(row); }

  if (records.length === 0) return { headers: [], rows: [] };
  const headers = records[0];
  const rows = records.slice(1);
  for (let r = 0; r < rows.length; r++) {
    if (rows[r].length !== headers.length) {
      throw new CsvParseError(`Row ${r + 1} has ${rows[r].length} fields; the header has ${headers.length}.`);
    }
  }
  return { headers, rows };
}
