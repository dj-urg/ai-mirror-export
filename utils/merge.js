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
import { SCHEMAS } from './validators.js';
import {
  sha256Hex,
  canonicalHeaders,
  EXTRACTOR_VERSION,
  SCHEMA_VERSIONS,
  MANIFEST_SCHEMA_VERSION
} from './manifest.js';

export const MERGE_MANIFEST_SCHEMA_VERSION = '1.1.0';
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

function dirName(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isManifestName(name) {
  return /_manifest_.*\.json$|_manifest\.json$/.test(baseName(name));
}

// ---------------------------------------------------------------------------
// Step 1: turn dropped files into bundles
// ---------------------------------------------------------------------------

/** The only ZIP entries the merge needs; everything else stays packed. */
function isMergeInput(name) {
  return name.toLowerCase().endsWith('.csv') || isManifestName(name) ||
    baseName(name) === MERGE_MANIFEST_NAME;
}

/** CSV filenames a loose manifest lists (empty when the manifest is damaged). */
function listedFilenames(manifestText) {
  try {
    const files = JSON.parse(manifestText).files;
    if (!Array.isArray(files)) return [];
    return files.map(f => f?.filename).filter(name => typeof name === 'string');
  } catch (_err) {
    return [];   // reported as a damaged manifest by checkBundle
  }
}

/**
 * Group input files into bundles: one per export ZIP, one per loose manifest
 * (with the loose CSVs it lists), and one per loose CSV no manifest claims.
 * The result does not depend on the order the files were added in.
 *
 * @param {Array<{name: string, bytes: Uint8Array}>} inputs
 * @returns {Promise<{bundles: object[], ignored: Array<{name: string, reason: string}>}>}
 */
export async function collectBundles(inputs) {
  const bundles = [];
  const ignored = [];
  const looseCsvs = new Map();   // basename -> [{name, bytes}], unclaimed
  const looseManifests = [];

  const sorted = [...inputs].sort((a, b) => compareText(a.name, b.name));
  for (const input of sorted) {
    const lower = input.name.toLowerCase();
    if (lower.endsWith('.zip')) {
      let entries;
      try {
        entries = await readZip(input.bytes, { filter: isMergeInput });
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
        manifestProblem: manifests.length > 1 ? 'The ZIP contains more than one manifest.'
          : manifests.length === 1 && decodeText(manifests[0].bytes) == null ? 'The manifest file is damaged.'
          : null,
        csvs: csvs.map(e => ({ name: baseName(e.name), bytes: e.bytes }))
      });
    } else if (lower.endsWith('.csv')) {
      const name = baseName(input.name);
      if (!looseCsvs.has(name)) looseCsvs.set(name, []);
      looseCsvs.get(name).push(input);
    } else if (lower.endsWith('.json') && isManifestName(input.name)) {
      looseManifests.push(input);
    } else if (baseName(input.name) === MERGE_MANIFEST_NAME) {
      ignored.push({ name: input.name, reason: 'Part of an earlier merge, not an export.' });
    } else {
      ignored.push({ name: input.name, reason: 'Not an export file (expected .zip, .csv or a manifest .json).' });
    }
  }

  // A manifest claims the CSVs it lists. When the same filename was added
  // from several folders, the copy next to the manifest is the one it means;
  // without such a copy it takes every candidate and checkBundle sorts out
  // whether they are identical.
  const claim = (manifest, filename, sameFolderOnly) => {
    const candidates = looseCsvs.get(filename) || [];
    const folder = dirName(manifest.input.name);
    const hits = candidates.filter(c => !sameFolderOnly || dirName(c.name) === folder);
    for (const hit of hits) {
      manifest.csvs.push({ name: filename, bytes: hit.bytes });
      manifest.sources.push(hit.name);
      candidates.splice(candidates.indexOf(hit), 1);
    }
    return hits.length > 0;
  };
  const pending = looseManifests.map(input => {
    const text = decodeText(input.bytes);
    return { input, text, listed: text == null ? [] : listedFilenames(text), csvs: [], sources: [input.name], found: new Set() };
  });
  for (const sameFolderOnly of [true, false]) {
    for (const m of pending) {
      for (const filename of m.listed) {
        if (!m.found.has(filename) && claim(m, filename, sameFolderOnly)) m.found.add(filename);
      }
    }
  }
  for (const m of pending) {
    bundles.push({
      label: baseName(m.input.name),
      sources: m.sources,
      manifestText: m.text,
      manifestProblem: m.text == null ? 'The manifest file is damaged.' : null,
      csvs: m.csvs
    });
  }

  for (const [name, list] of looseCsvs) {
    for (const csv of list) {
      bundles.push({
        label: list.length > 1 ? csv.name : name,
        sources: [csv.name],
        manifestText: null,
        csvs: [{ name, bytes: csv.bytes }]
      });
    }
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
 * True when a parsed manifest has the shape the exporter writes, as far as
 * the merge relies on it. Unknown keys are fine (newer exports add some).
 */
function isManifestShape(manifest) {
  if (!isPlainObject(manifest)) return false;
  const optionalText = (v) => v == null || typeof v === 'string';
  for (const key of ['manifest_schema_version', 'extractor_version', 'platform', 'conversation_id',
    'donor_id_hashed', 'donor_id_type', 'download_time']) {
    if (!optionalText(manifest[key])) return false;
  }
  if (manifest.telemetry != null && !isPlainObject(manifest.telemetry)) return false;
  if (!Array.isArray(manifest.files)) return false;
  const names = new Set();
  for (const f of manifest.files) {
    if (!isPlainObject(f)) return false;
    if (typeof f.filename !== 'string' || typeof f.schema !== 'string' || typeof f.sha256 !== 'string') return false;
    if (!optionalText(f.schema_version)) return false;
    if (f.rows != null && typeof f.rows !== 'number') return false;
    if (names.has(f.filename)) return false;
    names.add(f.filename);
  }
  return true;
}

/**
 * Collapse CSVs that were added more than once under the same name.
 * Identical copies become one file (with a note); copies that differ cannot
 * be told apart, so none of them is used.
 */
function resolveDuplicates(csvs, note, fail) {
  const byName = new Map();
  for (const csv of csvs) {
    if (!byName.has(csv.name)) byName.set(csv.name, []);
    byName.get(csv.name).push(csv);
  }
  const out = [];
  for (const [name, copies] of byName) {
    if (copies.every(c => sameBytes(c.bytes, copies[0].bytes))) {
      if (copies.length > 1) note(`${name} was added more than once; the extra copy was ignored.`);
      out.push(copies[0]);
    } else {
      fail(STATUS.INVALID, `${name} was added more than once with different contents. ` +
        'Remove the extra copy, or add the original ZIP instead.');
    }
  }
  return out;
}

/**
 * Verify one bundle against its manifest and parse its CSVs.
 *
 * @param {object} bundle  From collectBundles.
 * @returns {Promise<object>} Checked bundle: label, sources[] (the input
 *   names it was built from), status, problems[], notes[] (remarks that do
 *   not affect the status), platform, conversationId, donorId, donorIdType,
 *   downloadTime, piiScrubEnabled,
 *   files[{filename, schema, headers, rows, sha256}].
 */
export async function checkBundle(bundle) {
  const result = {
    label: bundle.label,
    sources: bundle.sources || [],
    status: STATUS.OK,
    problems: [],
    notes: [],
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
    if (!bundle.manifestProblem) {
      fail(STATUS.CHANGED, 'No manifest, so these files cannot be checked against the original export.');
    }
  } else {
    try {
      manifest = JSON.parse(bundle.manifestText);
    } catch (_err) { /* handled below */ }
    if (!isManifestShape(manifest)) {
      manifest = null;
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
    if (manifest.extractor_version !== EXTRACTOR_VERSION) {
      fail(STATUS.OUTDATED,
        `Made with extension version ${manifest.extractor_version || 'unknown'}; ` +
        `this page merges version ${EXTRACTOR_VERSION} exports only. Export the conversation again.`);
    } else if (manifest.manifest_schema_version !== MANIFEST_SCHEMA_VERSION) {
      fail(STATUS.OUTDATED,
        'Made with a different build of the extension ' +
        `(manifest version ${manifest.manifest_schema_version || 'unknown'}, this page expects ${MANIFEST_SCHEMA_VERSION}). ` +
        'Export the conversation again.');
    }
  }

  const csvs = resolveDuplicates(bundle.csvs, (message) => result.notes.push(message), fail);
  const listed = new Map((manifest?.files || []).map(f => [f.filename, f]));
  for (const filename of listed.keys()) {
    if (!bundle.csvs.some(c => c.name === filename)) {
      fail(STATUS.CHANGED, `${filename} is listed in the manifest but missing.`);
    }
  }
  if (bundle.csvs.length === 0) {
    fail(STATUS.INVALID, 'No CSV files found.');
  }

  for (const csv of csvs) {
    const text = decodeText(csv.bytes);
    if (text == null) { fail(STATUS.INVALID, `${csv.name} is not valid UTF-8 text.`); continue; }
    const content = stripBom(text);
    const sha256 = await sha256Hex(content);
    const entry = listed.get(csv.name);
    const schema = entry?.schema ?? schemaFromFilename(csv.name);

    if (!schema || !Object.hasOwn(SCHEMA_VERSIONS, schema)) {
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
    // A file that already ends in the merge's own columns is merge output;
    // merging it again would shift every column of the files it is mixed with.
    if (parsed.headers.slice(-PROVENANCE_HEADERS.length).join(',') === PROVENANCE_HEADERS.join(',')) {
      fail(STATUS.INVALID, `${csv.name} comes from an earlier merge. Add the original exports instead.`);
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

/** Why an export was left out in favour of another export of the same conversation. */
export const SUPERSEDED = Object.freeze({
  NEWER: 'newer',        // a newer export exists
  VERIFIED: 'verified',  // a verified export exists and this one is changed
  COPY: 'copy'           // the same export was added twice
});

const SUPERSEDED_REASON = Object.freeze({
  [SUPERSEDED.NEWER]: 'A newer export of the same conversation was merged instead.',
  [SUPERSEDED.VERIFIED]: 'A verified export of the same conversation was merged instead.',
  [SUPERSEDED.COPY]: 'Another copy of the same export was merged instead.'
});

/** Fixed order for bundles: verified first, then oldest first, then by name. */
function bundleOrder(a, b) {
  return (a.status === STATUS.OK ? 0 : 1) - (b.status === STATUS.OK ? 0 : 1) ||
    compareText(a.downloadTime || '', b.downloadTime || '') ||
    compareText(a.label, b.label) ||
    compareText(a.sources.join('\n'), b.sources.join('\n'));
}

/**
 * One export per conversation: a verified export wins over a changed one,
 * then the newest wins. The others are superseded. The choice does not
 * depend on the order of `bundles`.
 * @param {object[]} bundles  Checked bundles.
 * @returns {Map<object, string>} Superseded bundle -> SUPERSEDED reason.
 */
export function pickLatest(bundles) {
  const groups = new Map();
  for (const b of bundles) {
    if (!b.platform || !b.conversationId || !b.donorId) continue;
    const key = `${b.donorId}\u0000${b.platform}\u0000${b.conversationId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  const superseded = new Map();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const verified = (b) => b.status === STATUS.OK;
    const [winner, ...losers] = group.slice().sort((a, b) =>
      (verified(a) ? 0 : 1) - (verified(b) ? 0 : 1) ||
      compareText(b.downloadTime || '', a.downloadTime || '') ||
      bundleOrder(a, b));
    for (const b of losers) {
      superseded.set(b,
        verified(winner) && !verified(b) ? SUPERSEDED.VERIFIED
          : (winner.downloadTime || '') > (b.downloadTime || '') ? SUPERSEDED.NEWER
          : SUPERSEDED.COPY);
    }
  }
  return superseded;
}

/**
 * Which checked bundles a merge with these options would use.
 * Shared by mergeBundles and the page, so the table always shows what the
 * Merge button will do.
 *
 * @param {object[]} checked
 * @param {object} [opts]  includeChanged, platforms (see mergeBundles).
 * @returns {{eligible: object[], superseded: Map<object, string>, used: object[]}}
 *   `used` is in a fixed order (see bundleOrder).
 */
export function selectForMerge(checked, opts = {}) {
  const { includeChanged = false, platforms = null } = opts;
  const eligible = checked.filter(b =>
    (b.status === STATUS.OK || (includeChanged && b.status === STATUS.CHANGED)) &&
    (!platforms || platforms.includes(b.platform)));
  const superseded = pickLatest(eligible);
  const used = eligible.filter(b => !superseded.has(b)).sort(bundleOrder);
  return { eligible, superseded, used };
}

/**
 * Count the conversations and participants in the merged bundles. A bundle
 * with a manifest is one conversation; without one, the ids are read from
 * the conversation_id / donor_id columns of its merged files.
 */
function countMerged(mergedBundles, isMergedFile) {
  const donorsByConversation = new Map();   // platform + conversation -> Set(donor, '' = unknown)
  const participants = new Set();
  let unidentified = 0;
  const see = (platform, conversation, donor) => {
    const key = `${platform || ''}\u0000${conversation}`;
    if (!donorsByConversation.has(key)) donorsByConversation.set(key, new Set());
    donorsByConversation.get(key).add(donor || '');
    if (donor) participants.add(donor);
  };
  for (const b of mergedBundles) {
    if (b.conversationId) { see(b.platform, b.conversationId, b.donorId); continue; }
    if (b.donorId) participants.add(b.donorId);
    let found = false;
    for (const f of b.files.filter(isMergedFile)) {
      const conversationAt = f.headers.indexOf('conversation_id');
      const donorAt = f.headers.indexOf('donor_id');
      if (conversationAt === -1) continue;
      for (const row of f.rows) {
        if (!row[conversationAt]) continue;
        see(b.platform, row[conversationAt], b.donorId || (donorAt === -1 ? '' : row[donorAt]));
        found = true;
      }
    }
    if (!found) unidentified++;
  }
  let conversations = unidentified;
  for (const donors of donorsByConversation.values()) {
    // A file without a donor column belongs to a donor we already counted.
    const known = [...donors].filter(Boolean).length;
    conversations += known || 1;
  }
  return { conversations, participants: participants.size };
}

/**
 * Merge checked bundles.
 *
 * Column layouts are never mixed. The shared `_canonical` files must have
 * exactly the layout this extension version writes. For the other file
 * types the layout is the one the verified exports agree on; a file with
 * any other header row is left out and named in the warnings.
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
  const { superseded, used } = selectForMerge(checked, opts);

  const warnings = [];
  const leftOut = new Map();   // file -> why it was not merged
  const skip = (file, why) => {
    leftOut.set(file, why);
    warnings.push(`${file.filename}: ${why}`);
  };
  const signature = (headers) => JSON.stringify(headers);

  // Pass 1: decide the column layout of every output.
  const candidates = new Map();   // schema -> [{bundle, file}]
  for (const b of used) {
    for (const f of b.files) {
      const missing = (SCHEMAS[f.schema]?.required || []).filter(c => !f.headers.includes(c));
      if (missing.length) {
        skip(f, `expected columns are missing (${missing.join(', ')}); not merged.`);
        continue;
      }
      if (!candidates.has(f.schema)) candidates.set(f.schema, []);
      candidates.get(f.schema).push({ bundle: b, file: f });
    }
  }
  const canonical = signature(canonicalHeaders());
  const layouts = new Map();   // schema -> header signature
  for (const [schema, list] of candidates) {
    if (schema.endsWith('_canonical')) { layouts.set(schema, canonical); continue; }
    const verified = list.filter(c => c.bundle.status === STATUS.OK);
    const votes = new Map();
    for (const { file } of (verified.length ? verified : list)) {
      const sig = signature(file.headers);
      votes.set(sig, (votes.get(sig) || 0) + 1);
    }
    const [winner] = [...votes].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))[0];
    layouts.set(schema, winner);
    if (!verified.length) {
      warnings.push(`${schema}.csv: none of these files could be verified, so their column layout could not be checked.`);
    }
  }

  // Pass 2: copy the rows, verified exports first.
  const bySchema = new Map();  // schema -> {lines[], rows}
  const add = (schema, file) => {
    let group = bySchema.get(schema);
    if (!group) {
      group = { lines: [csvLine([...file.headers, ...PROVENANCE_HEADERS])], rows: 0 };
      bySchema.set(schema, group);
    }
    for (const row of file.rows) group.lines.push(csvLine([...row, file.filename, file.sha256]));
    group.rows += file.rows.length;
  };
  const seenContent = new Set();   // schema + sha256 of files already merged
  for (const [schema, list] of candidates) {
    for (const { file } of list) {
      if (signature(file.headers) !== layouts.get(schema)) {
        skip(file, schema.endsWith('_canonical')
          ? 'columns differ from the shared layout; not merged.'
          : `columns differ from other ${schema} files; not merged.`);
        continue;
      }
      const contentKey = `${schema}\u0000${file.sha256}`;
      if (file.rows.length > 0 && seenContent.has(contentKey)) {
        skip(file, 'has the same content as a file that was already merged; not added again.');
        continue;
      }
      seenContent.add(contentKey);
      add(schema, file);
      if (schema.endsWith('_canonical')) add(CANONICAL_OUTPUT, file);
    }
  }

  const outputs = [];
  const schemaNames = [...bySchema.keys()].sort((a, b) =>
    a === CANONICAL_OUTPUT ? -1 : b === CANONICAL_OUTPUT ? 1 : compareText(a, b));
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

  const isMergedFile = (f) => !leftOut.has(f);
  const merged = used.filter(b => b.files.some(isMergedFile));
  const counts = countMerged(merged, isMergedFile);

  const scrubStates = new Set(merged.map(b => b.piiScrubEnabled).filter(v => v != null));
  if (scrubStates.size > 1) {
    warnings.push('Some exports were made with personal-information scrubbing on and others with it off. ' +
      'Rows from the two groups are not equally anonymised.');
  }
  const donorTypes = new Set(merged.map(b => b.donorIdType).filter(Boolean));
  if (donorTypes.size > 1) {
    warnings.push(`Exports use different kinds of participant IDs (${[...donorTypes].sort().join(', ')}); ` +
      'the same person may appear under more than one ID.');
  }

  const statusAllowed = (b) => b.status === STATUS.OK || (includeChanged && b.status === STATUS.CHANGED);
  const report = {
    merge_manifest_schema_version: MERGE_MANIFEST_SCHEMA_VERSION,
    extractor_version: EXTRACTOR_VERSION,
    merged_at: mergedAt,
    options: { include_changed: includeChanged, platforms: platforms ? [...platforms].sort() : 'all' },
    participants: counts.participants,
    conversations: counts.conversations,
    exports_merged: merged.length,
    inputs: checked.slice()
      .sort((a, b) => compareText(a.label, b.label) || compareText(a.sources.join('\n'), b.sources.join('\n')))
      .map(b => ({
        label: b.label,
        status: b.status,
        merged: merged.includes(b),
        not_merged_because: merged.includes(b) ? null
          : superseded.has(b) ? SUPERSEDED_REASON[superseded.get(b)]
          : used.includes(b) ? 'None of its files could be merged; see warnings.'
          : statusAllowed(b) ? 'Platform not selected.'
          : b.status === STATUS.CHANGED ? 'Changed or unverified file (include anyway was off).'
          : 'Could not be merged; see problems.',
        problems: b.problems,
        notes: b.notes || [],
        platform: b.platform,
        conversation_id: b.conversationId,
        download_time: b.downloadTime,
        files: b.files.map(f => ({
          filename: f.filename,
          schema: f.schema,
          rows: f.rows.length,
          sha256: f.sha256,
          merged: used.includes(b) && isMergedFile(f),
          not_merged_because: used.includes(b) ? (leftOut.get(f) ?? null) : 'Export not merged.'
        }))
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
    `Exports merged: ${merged.length}`,
    `Conversations merged: ${report.conversations}`,
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
      if (!/merged instead|Platform not selected/.test(i.not_merged_because || '')) {
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
