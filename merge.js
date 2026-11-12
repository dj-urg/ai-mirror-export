/**
 * Merge page controller (merge.html). UI only; the checking and merging
 * live in utils/merge.js so they can be tested in Node.
 *
 * Files are read into memory with File.arrayBuffer(), never stored, and the
 * result is saved through browser.downloads. The extension-page CSP blocks
 * every network request from this page.
 */

import { collectBundles, checkBundle, mergeBundles, STATUS } from './utils/merge.js';
import { buildZip } from './utils/zip.js';
import { EXTENSION_CONFIG } from './config/settings.js';

const MAX_FILES = 5000;
const LARGE_TOTAL_BYTES = 500 * 1024 * 1024;

const STATUS_COPY = {
  [STATUS.OK]: { icon: '✓', label: 'Verified' },
  [STATUS.CHANGED]: { icon: '!', label: 'Changed' },
  [STATUS.OUTDATED]: { icon: '✕', label: 'Older version' },
  [STATUS.INVALID]: { icon: '✕', label: 'Cannot use' }
};

const $ = (id) => document.getElementById(id);

// All files added so far, keyed by path so adding the same file twice is harmless.
const inputs = new Map();
let checked = [];
let ignored = [];

function platformName(id) {
  return EXTENSION_CONFIG.platforms?.[id]?.name || id || 'Unknown';
}

function setProgress(text) {
  $('progress').textContent = text;
}

// ---------------------------------------------------------------------------
// Reading files
// ---------------------------------------------------------------------------

/** Walk a dropped folder (FileSystemEntry API) into File objects. */
async function filesFromEntry(entry, path = '') {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    return [{ file, path: path + file.name }];
  }
  if (!entry.isDirectory) return [];
  const reader = entry.createReader();
  const out = [];
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) break;
    for (const child of batch) out.push(...await filesFromEntry(child, `${path}${entry.name}/`));
  }
  return out;
}

async function addFiles(list) {
  const items = list.filter(({ file }) => !file.name.startsWith('.'));
  if (inputs.size + items.length > MAX_FILES) {
    setProgress(`That is more than ${MAX_FILES} files. Please merge in smaller groups.`);
    return;
  }
  const total = items.reduce((n, { file }) => n + file.size, 0);
  if (total > LARGE_TOTAL_BYTES &&
      !window.confirm('These files are very large and may slow the browser down. Continue?')) {
    return;
  }

  let done = 0;
  for (const { file, path } of items) {
    setProgress(`Reading ${++done} of ${items.length}…`);
    inputs.set(path, { name: path, bytes: new Uint8Array(await file.arrayBuffer()) });
  }
  await recheck();
}

async function recheck() {
  setProgress('Checking files…');
  const result = await collectBundles([...inputs.values()]);
  ignored = result.ignored;
  checked = [];
  for (let i = 0; i < result.bundles.length; i++) {
    checked.push(await checkBundle(result.bundles[i]));
    // Yield so the page stays responsive on large drops.
    if (i % 25 === 24) {
      setProgress(`Checking ${i + 1} of ${result.bundles.length}…`);
      await new Promise(r => setTimeout(r, 0));
    }
  }
  render();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function render() {
  const has = checked.length > 0 || ignored.length > 0;
  $('checkSection').hidden = !has;
  $('mergeSection').hidden = !checked.some(b => b.status === STATUS.OK || b.status === STATUS.CHANGED);

  const counts = Object.fromEntries(Object.values(STATUS).map(s => [s, 0]));
  for (const b of checked) counts[b.status]++;
  const donors = new Set(checked.map(b => b.donorId).filter(Boolean)).size;
  setProgress(has ? `${checked.length} export${checked.length === 1 ? '' : 's'} checked.` : '');
  $('summary').textContent =
    `${counts.ok} verified, ${counts.changed} changed or unverified, ` +
    `${counts.outdated + counts.invalid} cannot be used. ` +
    `${donors} participant${donors === 1 ? '' : 's'}.`;

  const rows = checked
    .slice()
    .sort((a, b) => Object.values(STATUS).indexOf(b.status) - Object.values(STATUS).indexOf(a.status))
    .map(b => {
      const copy = STATUS_COPY[b.status];
      const rowCount = b.files.reduce((n, f) => n + f.rows.length, 0);
      const details = b.problems.length
        ? el('ul', { class: 'file-table__problems' }, ...b.problems.map(p => el('li', {}, p)))
        : 'All files match the original export.';
      return el('tr', { class: `file-table__row file-table__row--${b.status}` },
        el('td', {},
          el('span', { class: `status-pill status-pill--${b.status}` },
            el('span', { 'aria-hidden': 'true', class: 'status-pill__icon' }, copy.icon), copy.label)),
        el('td', { class: 'file-table__name' }, b.label),
        el('td', {}, platformName(b.platform)),
        el('td', { class: 'file-table__num' }, String(rowCount)),
        el('td', {}, details));
    });
  $('fileRows').replaceChildren(...rows);

  $('ignoredList').replaceChildren(...ignored.map(i =>
    el('li', {}, el('strong', {}, i.name), `: ${i.reason}`)));

  const platforms = [...new Set(checked
    .filter(b => b.status === STATUS.OK || b.status === STATUS.CHANGED)
    .map(b => b.platform).filter(Boolean))].sort();
  const previous = new Set([...document.querySelectorAll('#platformOptions input:not(:checked)')].map(i => i.value));
  $('platformOptions').replaceChildren(...platforms.map(p => {
    const input = el('input', { type: 'checkbox', value: p });
    input.checked = !previous.has(p);
    return el('label', { class: 'checkbox' }, input, el('span', {}, platformName(p)));
  }));
  $('platformGroup').hidden = platforms.length < 2;

  $('changedOption').hidden = counts.changed === 0;
  $('result').replaceChildren();
}

// ---------------------------------------------------------------------------
// Merge + download
// ---------------------------------------------------------------------------

function timestampSlug(d = new Date()) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

async function handleMerge() {
  const button = $('mergeButton');
  button.disabled = true;
  const result = $('result');
  result.className = 'result';
  result.textContent = 'Merging…';
  try {
    const selected = [...document.querySelectorAll('#platformOptions input:checked')].map(i => i.value);
    const all = document.querySelectorAll('#platformOptions input').length;
    const { files, report } = await mergeBundles(checked, {
      includeChanged: $('includeChanged').checked,
      platforms: selected.length === all ? null : selected
    });
    if (report.conversations === 0) {
      result.className = 'result result--warning';
      result.textContent = 'Nothing to merge with the current selection.';
      return;
    }
    const filename = `ai-chat-merge_${timestampSlug()}.zip`;
    const url = URL.createObjectURL(new Blob([buildZip(files)], { type: 'application/zip' }));
    try {
      await browser.downloads.download({ url, filename, saveAs: false });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    result.className = 'result result--success';
    const lines = report.outputs.map(o => el('li', {}, `${o.name}: ${o.rows} row${o.rows === 1 ? "" : "s"}`));
    result.replaceChildren(
      el('p', { class: 'result__title' },
        `Saved ${filename} to your Downloads folder: ${report.conversations} conversation${report.conversations === 1 ? '' : 's'} from ${report.participants} participant${report.participants === 1 ? '' : 's'}.`),
      el('ul', {}, ...lines),
      ...report.warnings.map(w => el('p', { class: 'result__warning' }, `Warning: ${w}`)));
    result.focus();
  } catch (err) {
    result.className = 'result result--error';
    result.textContent = `The merge failed: ${err && err.message ? err.message : 'unknown error'}. No file was saved.`;
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function init() {
  const zone = $('dropzone');
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dropzone--active'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dropzone--active'));
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('dropzone--active');
    const entries = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
    const list = [];
    for (const entry of entries) list.push(...await filesFromEntry(entry));
    await addFiles(list);
  });
  // Dropping a file outside the zone must not navigate the tab to it.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  $('pickFiles').addEventListener('click', () => $('fileInput').click());
  $('pickFolder').addEventListener('click', () => $('folderInput').click());
  for (const id of ['fileInput', 'folderInput']) {
    $(id).addEventListener('change', async (e) => {
      const list = [...e.target.files].map(file => ({ file, path: file.webkitRelativePath || file.name }));
      e.target.value = '';
      await addFiles(list);
    });
  }
  $('clearAll').addEventListener('click', () => {
    inputs.clear();
    checked = [];
    ignored = [];
    $('includeChanged').checked = false;
    render();
    $('pickFiles').focus();
  });
  $('mergeButton').addEventListener('click', handleMerge);
  $('pickFiles').focus();
}

document.addEventListener('DOMContentLoaded', init);
