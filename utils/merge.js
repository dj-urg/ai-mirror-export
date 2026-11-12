/**
 * Merge logic for the "Merge exported files" page (merge.html).
 *
 * Takes export bundles (the ZIPs the extension downloads, or their unpacked
 * files) that may come from many participants, checks each one against its
 * `_manifest.json`, and combines the rows schema by schema. Cell contents
 * are never changed: every field is parsed as a raw string and re-written
 * with the exporter's own escapeCSVField, so each merged row is
 * byte-identical to the row it came from, plus two provenance columns.
 *
 * Pure (no DOM, no browser.*, no network). Tested in Node by
 * testing/tests/test_merge.js.
 */

import { escapeCSVField } from './csv.js';
import { parseCSV, CsvParseError } from './csv_parse.js';
import { readZip, ZipReadError } from './zip_read.js';
import {
  sha256Hex,
  canonicalHeaders,
  EXTRACTOR_VERSION,
  SCHEMA_VERSIONS,
  MANIFEST_SCHEMA_VERSION
} from './manifest.js';

export const MERGE_MANIFEST_SCHEMA_VERSION = '1.0.0';
export const CANONICAL_OUTPUT = 'all_messages_canonical';
export const PROVENANCE_HEADERS = Object.freeze(['source_file', 'source_sha256']);

const UTF8_BOM = '﻿';
const MERGE_MANIFEST_NAME = 'merge_manifest.json';

/**
 * Bundle status, worst first. Only `ok` bundles are merged by default;
 * `changed` bundles can be added with the "include anyway" option; the
 * others are never merged.
 *  - invalid:  unreadable, or not an export from this extension
 *  - outdated: made by an older (or newer) extension version
 *  - changed:  a CSV no longer matches its manifest checksum, or has no
 *              manifest to check against
 *  - ok:       every CSV verified
 */
export const STATUS = Object.freeze({
  OK: 'ok',
  CHANGED: 'changed',
  OUTDATED: 'outdated',
  INVALID: 'invalid'
});

const decoder = new TextDecoder('utf-8', { fatal: true });

function decodeText(bytes) {
  try {
    return decoder.decode(bytes);
  } catch (_err) {
    return null;
  }
}

function stripBom(text) {
  return text.startsWith(UTF8_BOM) ? text.slice(1) : text;
}

function baseName(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** Longest SCHEMA_VERSIONS key that a CSV filename starts with. */
export function schemaFromFilename(filename) {
  const name = baseName(filename);
  let best = null;
  for (const schema of Object.keys(SCHEMA_VERSIONS)) {
    if ((name === `${schema}.csv` || name.startsWith(`${schema}_`)) &&
        (!best || schema.length > best.length)) {
      best = schema;
    }
  }
  return best;
}

function platformFromSchema(schema) {
  if (schema.startsWith('m365_copilot_')) return 'm365_copilot';
  if (schema.startsWith('google_')) return 'google_search';
  return schema.slice(0, schema.indexOf('_'));
}

function isManifestName(name) {
  return /_manifest_.*\.json$|_manifest\.json$/.test(baseName(name));
}

// ---------------------------------------------------------------------------
// Step 1: turn dropped files into bundles
// ---------------------------------------------------------------------------

/**
 * Group input files into bundles: one per export ZIP, one per loose manifest
 * (with the loose CSVs it lists), and one per loose CSV no manifest claims.
 *
 * @param {Array<{name: string, bytes: Uint8Array}>} inputs
 * @returns {Promise<{bundles: object[], ignored: Array<{name: string, reason: string}>}>}
 */
export async function collectBundles(inputs) {
  const bundles = [];
  const ignored = [];
  const looseCsvs = new Map();   // basename -> {name, bytes}
  const looseManifests = [];

  for (const input of inputs) {
    const lower = input.name.toLowerCase();
    if (lower.endsWith('.zip')) {
      let entries;
      try {
        entries = await readZip(input.bytes);
      } catch (err) {
        const reason = err instanceof ZipReadError ? err.message : 'Could not read this ZIP file.';
        bundles.push({ label: input.name, sources: [input.name], manifestText: null, csvs: [], fatal: reason });
        continue;
      }
      if (entries.some(e => baseName(e.name) === MERGE_MANIFEST_NAME)) {
        bundles.push({
          label: input.name, sources: [input.name], manifestText: null, csvs: [],
          fatal: 'This is already a merged file. Add the original exports instead.'
        });
        continue;
      }
      const manifests = entries.filter(e => isManifestName(e.name));
      const csvs = entries.filter(e => e.name.toLowerCase().endsWith('.csv'));
      bundles.push({
        label: input.name,
        sources: [input.name],
        manifestText: manifests.length === 1 ? decodeText(manifests[0].bytes) : null,
        manifestProblem: manifests.length > 1 ? 'The ZIP contains more than one manifest.' : null,
        csvs: csvs.map(e => ({ name: baseName(e.name), bytes: e.bytes }))
      });
    } else if (lower.endsWith('.csv')) {
      looseCsvs.set(baseName(input.name), input);
    } else if (lower.endsWith('.json') && isManifestName(input.name)) {
      looseManifests.push(input);
    } else if (baseName(input.name) === MERGE_MANIFEST_NAME) {
      ignored.push({ name: input.name, reason: 'Part of an earlier merge, not an export.' });
    } else {
      ignored.push({ name: input.name, reason: 'Not an export file (expected .zip, .csv or a manifest .json).' });
    }
  }

  for (const m of looseManifests) {
    const text = decodeText(m.bytes);
    let listed = [];
    try {
      listed = (JSON.parse(text).files || []).map(f => f.filename);
    } catch (_err) { /* reported as invalid manifest below */ }
    const csvs = [];
    const sources = [m.name];
    for (const filename of listed) {
      const hit = looseCsvs.get(filename);
      if (hit) {
        csvs.push({ name: filename, bytes: hit.bytes });
        sources.push(hit.name);
        looseCsvs.delete(filename);
      }
    }
    bundles.push({ label: baseName(m.name), sources, manifestText: text, csvs });
  }

  for (const [name, csv] of looseCsvs) {
    bundles.push({ label: name, sources: [csv.name], manifestText: null, csvs: [{ name, bytes: csv.bytes }] });
  }

  return { bundles, ignored };
}

// ---------------------------------------------------------------------------
// Step 2: check each bundle
// ---------------------------------------------------------------------------

function worse(a, b) {
  const order = [STATUS.OK, STATUS.CHANGED, STATUS.OUTDATED, STATUS.INVALID];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

/**
 * Verify one bundle against its manifest and parse its CSVs.
 *
 * @param {object} bundle  From collectBundles.
 * @returns {Promise<object>} Checked bundle: label, sources[] (the input
 *   names it was built from), status, problems[],
 *   platform, conversationId, donorId, donorIdType, downloadTime,
 *   piiScrubEnabled, files[{filename, schema, headers, rows, sha256}].
 */
export async function checkBundle(bundle) {
  const result = {
    label: bundle.label,
    sources: bundle.sources || [],
    status: STATUS.OK,
    problems: [],
    platform: null,
    conversationId: null,
    donorId: null,
    donorIdType: null,
    downloadTime: null,
    piiScrubEnabled: null,
    files: []
  };
  const fail = (status, message) => {
    result.status = worse(result.status, status);
    result.problems.push(message);
  };

  if (bundle.fatal) { fail(STATUS.INVALID, bundle.fatal); return result; }
  if (bundle.manifestProblem) fail(STATUS.INVALID, bundle.manifestProblem);

  let manifest = null;
  if (bundle.manifestText == null) {
    fail(STATUS.CHANGED, 'No manifest, so these files cannot be checked against the original export.');
  } else {
    try {
      manifest = JSON.parse(bundle.manifestText);
    } catch (_err) {
      fail(STATUS.INVALID, 'The manifest file is damaged.');
    }
  }

  if (manifest) {
    result.platform = manifest.platform ?? null;
    result.conversationId = manifest.conversation_id ?? null;
    result.donorId = manifest.donor_id_hashed ?? null;
    result.donorIdType = manifest.donor_id_type ?? null;
    result.downloadTime = manifest.download_time ?? null;
    result.piiScrubEnabled = manifest.telemetry?.pii_scrub_enabled ?? null;
    if (manifest.manifest_schema_version !== MANIFEST_SCHEMA_VERSION ||
        manifest.extractor_version !== EXTRACTOR_VERSION) {
      fail(STATUS.OUTDATED,
        `Made with extension version ${manifest.extractor_version || 'unknown'}; ` +
        `this page merges version ${EXTRACTOR_VERSION} exports only. Export the conversation again.`);
    }
  }

  const listed = new Map((manifest?.files || []).map(f => [f.filename, f]));
  for (const filename of listed.keys()) {
    if (!bundle.csvs.some(c => c.name === filename)) {
      fail(STATUS.CHANGED, `${filename} is listed in the manifest but missing.`);
    }
  }
  if (bundle.csvs.length === 0 && !manifest) {
    fail(STATUS.INVALID, 'No CSV files found.');
  }

  for (const csv of bundle.csvs) {
    const text = decodeText(csv.bytes);
    if (text == null) { fail(STATUS.INVALID, `${csv.name} is not valid UTF-8 text.`); continue; }
    const content = stripBom(text);
    const sha256 = await sha256Hex(content);
    const entry = listed.get(csv.name);
    const schema = entry?.schema ?? schemaFromFilename(csv.name);

    if (!schema || !(schema in SCHEMA_VERSIONS)) {
      fail(STATUS.INVALID, `${csv.name} is not a file type this extension produces.`);
      continue;
    }
    if (manifest && !entry) {
      fail(STATUS.CHANGED, `${csv.name} is not listed in the manifest.`);
    } else if (entry) {
      if (entry.schema_version !== SCHEMA_VERSIONS[schema]) {
        fail(STATUS.OUTDATED, `${csv.name} uses an older file layout (version ${entry.schema_version}).`);
      }
      if (entry.sha256 !== sha256) {
        fail(STATUS.CHANGED, `${csv.name} was changed after it was exported.`);
      }
    }

    let parsed;
    try {
      parsed = parseCSV(content);
    } catch (err) {
      fail(STATUS.INVALID, `${csv.name} could not be read: ${err instanceof CsvParseError ? err.message : 'unknown error'}`);
      continue;
    }
    if (entry && typeof entry.rows === 'number' && entry.rows !== parsed.rows.length) {
      fail(STATUS.CHANGED, `${csv.name} has ${parsed.rows.length} rows; the manifest says ${entry.rows}.`);
    }
    if (!result.platform) result.platform = platformFromSchema(schema);
    result.files.push({ filename: csv.name, schema, headers: parsed.headers, rows: parsed.rows, sha256 });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Step 3: merge
// ---------------------------------------------------------------------------

function csvLine(fields) {
  return fields.map(escapeCSVField).join(',');
}

/**
 * The newest export of each conversation wins; older copies are superseded.
 * @param {object[]} bundles  Checked bundles.
 * @returns {Set<object>} The superseded bundles.
 */
export function pickLatest(bundles) {
  const latest = new Map();
  const superseded = new Set();
  for (const b of bundles) {
    if (!b.platform || !b.conversationId || !b.donorId) continue;
    const key = `${b.donorId}\u0000${b.platform}\u0000${b.conversationId}`;
    const prev = latest.get(key);
    if (!prev) { latest.set(key, b); continue; }
    const newer = (b.downloadTime || '') > (prev.downloadTime || '') ? b : prev;
    superseded.add(newer === b ? prev : b);
    latest.set(key, newer);
  }
  return superseded;
}

/**
 * Merge checked bundles.
 *
 * @param {object[]} checked  From checkBundle.
 * @param {object} [opts]
 * @param {boolean} [opts.includeChanged=false]  Also merge `changed` bundles.
 * @param {string[]|null} [opts.platforms=null]  Only these platforms (null = all).
 * @param {string} [opts.mergedAt]  ISO time to record (defaults to now).
 * @returns {Promise<{files: Array<{name: string, content: string}>, report: object}>}
 *   `files` are ready for buildZip (CSV contents carry a BOM like exports do).
 */
export async function mergeBundles(checked, opts = {}) {
  const { includeChanged = false, platforms = null } = opts;
  const mergedAt = opts.mergedAt || new Date().toISOString();

  const eligible = checked.filter(b =>
    (b.status === STATUS.OK || (includeChanged && b.status === STATUS.CHANGED)) &&
    (!platforms || platforms.includes(b.platform)));
  const superseded = pickLatest(eligible);
  const used = eligible.filter(b => !superseded.has(b));

  const bySchema = new Map();  // schema -> {headers, lines[], sourceRows}
  const add = (schema, headers, row, file) => {
    let group = bySchema.get(schema);
    if (!group) {
      group = { headers, lines: [csvLine([...headers, ...PROVENANCE_HEADERS])], rows: 0 };
      bySchema.set(schema, group);
    }
    group.lines.push(csvLine([...row, file.filename, file.sha256]));
    group.rows++;
  };

  const canonical = canonicalHeaders().join(',');
  const layoutProblems = [];
  for (const b of used) {
    for (const f of b.files) {
      const group = bySchema.get(f.schema);
      if (group && group.headers.join(',') !== f.headers.join(',')) {
        layoutProblems.push(`${f.filename}: columns differ from other ${f.schema} files; skipped.`);
        continue;
      }
      for (const row of f.rows) add(f.schema, f.headers, row, f);
      if (f.schema.endsWith('_canonical')) {
        if (f.headers.join(',') === canonical) {
          for (const row of f.rows) add(CANONICAL_OUTPUT, f.headers, row, f);
        } else {
          layoutProblems.push(`${f.filename}: columns differ from the shared layout; not added to ${CANONICAL_OUTPUT}.csv.`);
        }
      }
    }
  }

  const outputs = [];
  const schemaNames = [...bySchema.keys()].sort((a, b) =>
    a === CANONICAL_OUTPUT ? -1 : b === CANONICAL_OUTPUT ? 1 : a.localeCompare(b));
  for (const schema of schemaNames) {
    const g = bySchema.get(schema);
    const content = g.lines.join('\r\n') + '\r\n';
    outputs.push({
      name: `${schema}.csv`,
      schema,
      schema_version: schema === CANONICAL_OUTPUT ? null : SCHEMA_VERSIONS[schema],
      rows: g.rows,
      sha256: await sha256Hex(content),
      content
    });
  }

  const scrubStates = new Set(used.map(b => b.piiScrubEnabled).filter(v => v != null));
  const warnings = [...layoutProblems];
  if (scrubStates.size > 1) {
    warnings.push('Some exports were made with personal-information scrubbing on and others with it off. ' +
      'Rows from the two groups are not equally anonymised.');
  }
  const donorTypes = new Set(used.map(b => b.donorIdType).filter(Boolean));
  if (donorTypes.size > 1) {
    warnings.push(`Exports use different kinds of participant IDs (${[...donorTypes].sort().join(', ')}); ` +
      'the same person may appear under more than one ID.');
  }

  const report = {
    merge_manifest_schema_version: MERGE_MANIFEST_SCHEMA_VERSION,
    extractor_version: EXTRACTOR_VERSION,
    merged_at: mergedAt,
    options: { include_changed: includeChanged, platforms: platforms ? [...platforms].sort() : 'all' },
    participants: new Set(used.map(b => b.donorId).filter(Boolean)).size,
    conversations: used.length,
    inputs: checked.map(b => ({
      label: b.label,
      status: b.status,
      merged: used.includes(b),
      not_merged_because: used.includes(b) ? null
        : superseded.has(b) ? 'A newer export of the same conversation was merged instead.'
        : !eligible.includes(b) && platforms && b.status === STATUS.OK ? 'Platform not selected.'
        : b.status === STATUS.CHANGED ? 'Changed or unverified file (include anyway was off).'
        : b.status === STATUS.OK ? null
        : 'Could not be merged; see problems.',
      problems: b.problems,
      platform: b.platform,
      conversation_id: b.conversationId,
      download_time: b.downloadTime,
      files: b.files.map(f => ({ filename: f.filename, schema: f.schema, rows: f.rows.length, sha256: f.sha256 }))
    })),
    outputs: outputs.map(({ name, schema, schema_version, rows, sha256 }) => ({ name, schema, schema_version, rows, sha256 })),
    superseded_exports: superseded.size,
    warnings
  };

  const files = outputs.map(o => ({ name: o.name, content: UTF8_BOM + o.content }));
  files.push({ name: MERGE_MANIFEST_NAME, content: JSON.stringify(report, null, 2) + '\n' });
  files.push({ name: 'MERGE_REPORT.txt', content: formatReport(report) });
  return { files, report };
}

/**
 * Plain-language summary for students, written into the merged ZIP.
 * @param {object} report
 * @returns {string}
 */
export function formatReport(report) {
  const merged = report.inputs.filter(i => i.merged);
  const skipped = report.inputs.filter(i => !i.merged);
  const lines = [
    'AI Chat Exporter: merge report',
    '==============================',
    '',
    `Merged on: ${report.merged_at}`,
    `Extension version: ${report.extractor_version}`,
    `Conversations merged: ${merged.length}`,
    `Participants: ${report.participants}`,
    `Platforms: ${Array.isArray(report.options.platforms) ? report.options.platforms.join(', ') : 'all'}`,
    `Changed files included: ${report.options.include_changed ? 'YES (see below)' : 'no'}`,
    '',
    'Files in this ZIP',
    '-----------------'
  ];
  for (const o of report.outputs) lines.push(`  ${o.name}: ${o.rows} rows`);
  lines.push(
    '  merge_manifest.json: the same information as this report, for scripts',
    '',
    'Every merged row is copied unchanged from an export. Two columns are added',
    'at the end: source_file (the CSV the row came from) and source_sha256 (its',
    'checksum, which matches that export\'s manifest).',
    ''
  );
  if (report.warnings.length) {
    lines.push('Warnings', '--------');
    for (const w of report.warnings) lines.push(`  ! ${w}`);
    lines.push('');
  }
  if (report.options.include_changed) {
    const changed = merged.filter(i => i.status === STATUS.CHANGED);
    if (changed.length) {
      lines.push('Included although changed or unverified', '---------------------------------------');
      for (const i of changed) {
        lines.push(`  ${i.label}`);
        for (const p of i.problems) lines.push(`      ${p}`);
      }
      lines.push('');
    }
  }
  if (skipped.length) {
    lines.push('Not merged', '----------');
    for (const i of skipped) {
      lines.push(`  ${i.label}: ${i.not_merged_because || 'not merged'}`);
      if (!/newer export|Platform not selected/.test(i.not_merged_because || '')) {
        for (const p of i.problems) lines.push(`      ${p}`);
      }
    }
    lines.push('');
  }
  lines.push(
    'Opening the files',
    '-----------------',
    'Analyse the merged files in 4CAT, the main toolkit for this project: upload',
    'all_messages_canonical.csv as a custom (CSV) dataset. How to use 4CAT is',
    'explained at https://4cat.nl/.',
    '',
    'Do not open or save the files in Microsoft Excel first: it cuts cells longer',
    'than 32,767 characters, can turn IDs and timestamps into numbers or dates, and',
    'saving from Excel changes the file. For a quick look outside 4CAT, use',
    'LibreOffice Calc, R or Python.',
    ''
  );
  return lines.join('\r\n');
}
