/**
 * Merge page controller (merge.html). UI only; the checking and merging
 * live in utils/merge.js so they can be tested in Node.
 *
 * Files are read into memory with File.arrayBuffer(), never stored, and the
 * result is saved through browser.downloads. The extension-page CSP blocks
 * every network request from this page.
 */

import { collectBundles, checkBundle, mergeBundles, selectForMerge, STATUS, SUPERSEDED } from './utils/merge.js';
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

const SUPERSEDED_COPY = {
  [SUPERSEDED.NEWER]: 'A newer export of this conversation was added; only the newer one will be merged.',
  [SUPERSEDED.VERIFIED]: 'A verified export of this conversation was added; only the verified one will be merged.',
  [SUPERSEDED.COPY]: 'This export was added more than once; it will be merged only once.'
};

const $ = (id) => document.getElementById(id);

// All files added so far, keyed by path so adding the same file twice is harmless.
const inputs = new Map();
// Files the browser could not read, shown with the ignored files.
let unreadable = [];
let checked = [];
let ignored = [];

function platformName(id) {
  return EXTENSION_CONFIG.platforms?.[id]?.name || id || 'Unknown';
}

function setProgress(text) {
  $('progress').textContent = text;
}

// ---------------------------------------------------------------------------
// One job at a time
// ---------------------------------------------------------------------------

// Adding, removing, starting over and merging all read or replace `inputs`
// and `checked`. They run one after another through this queue, so a merge
// never sees a half-checked list and a slow check cannot overwrite a newer
// one. While a job runs, the buttons that act on the current list are off.
let queue = Promise.resolve();
let jobs = 0;

function setBusy(busy) {
  $('checkSection').setAttribute('aria-busy', String(busy));
  for (const button of document.querySelectorAll('#mergeButton, #clearAll, .file-table__action button')) {
    button.disabled = busy;
  }
}

function runExclusive(job) {
  jobs++;
  setBusy(true);
  const run = queue.then(job).catch(() => {
    // Nothing here may leave the page stuck: show what we have and say so.
    try {
      render();
    } catch (_err) { /* the message below still tells the user what to do */ }
    setProgress('Something went wrong while reading these files. Try adding them again, or start over.');
  }).finally(() => {
    if (--jobs === 0) setBusy(false);
  });
  queue = run;
  return run;
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
    try {
      inputs.set(path, { name: path, bytes: new Uint8Array(await file.arrayBuffer()) });
    } catch (_err) {
      unreadable.push({ name: path, reason: 'The browser could not read this file.' });
    }
  }
  await recheck();
}

/** Row for an export whose check itself failed, so it is shown instead of stopping the page. */
function uncheckable(bundle) {
  return {
    label: bundle.label, sources: bundle.sources || [], status: STATUS.INVALID,
    problems: ['This export could not be checked.'], notes: [],
    platform: null, conversationId: null, donorId: null, donorIdType: null,
    downloadTime: null, piiScrubEnabled: null, files: []
  };
}

/** Check everything in `inputs` again. Only call from inside runExclusive. */
async function recheck() {
  setProgress('Checking files…');
  // Built on the side and swapped in at the end: `checked` is never partial.
  const next = [];
  let nextIgnored = [...unreadable];
  try {
    const result = await collectBundles([...inputs.values()]);
    nextIgnored = [...result.ignored, ...unreadable];
    for (let i = 0; i < result.bundles.length; i++) {
      try {
        next.push(await checkBundle(result.bundles[i]));
      } catch (_err) {
        next.push(uncheckable(result.bundles[i]));
      }
      // Yield so the page stays responsive on large drops.
      if (i % 25 === 24) {
        setProgress(`Checking ${i + 1} of ${result.bundles.length}…`);
        await new Promise(r => setTimeout(r, 0));
      }
    }
  } catch (_err) {
    next.length = 0;
    nextIgnored = [...inputs.keys()].map(name => ({ name, reason: 'Could not be checked.' })).concat(unreadable);
  }
  checked = next;
  ignored = nextIgnored;
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

const exportTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Export time in the viewer's local time, with the exact UTC value for screen readers and hover. */
function exportedCell(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return el('td', {}, 'Unknown');
  return el('td', { class: 'file-table__time' },
    el('time', { datetime: iso, title: iso }, exportTimeFormat.format(d)));
}

function removeButton(bundle) {
  const button = el('button', {
    type: 'button',
    class: 'button button--secondary button--small',
    'aria-label': `Remove ${bundle.label}`
  }, 'Remove');
  button.disabled = jobs > 0;
  button.addEventListener('click', () => {
    const buttons = [...document.querySelectorAll('.file-table__action button')];
    runExclusive(() => removeBundle(bundle, buttons.indexOf(button)));
  });
  return button;
}

/** Drop the files a row was built from, re-check, and keep keyboard focus nearby. */
async function removeBundle(bundle, index) {
  for (const source of bundle.sources) inputs.delete(source);
  await recheck();
  setProgress(`Removed ${bundle.label}. ${checked.length} export${checked.length === 1 ? '' : 's'} left.`);
  // The buttons are switched back on when the queue is empty; focus after that.
  setTimeout(() => {
    const remaining = document.querySelectorAll('.file-table__action button');
    (remaining[Math.min(index, remaining.length - 1)] || $('pickFiles')).focus();
  }, 0);
}

function render() {
  // "Start over" lives in the check section, so show it whenever anything was added.
  const has = checked.length > 0 || ignored.length > 0 || inputs.size > 0;
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

  $('changedOption').hidden = counts.changed === 0;
  // A hidden option must not stay switched on for files added later.
  if (counts.changed === 0) $('includeChanged').checked = false;
  renderRows();

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

  $('result').replaceChildren();
}

/**
 * The table of checked exports. Which export of a conversation will be
 * merged depends on the "include changed" option, so the rows are redrawn
 * when that option changes.
 */
function renderRows() {
  const { superseded } = selectForMerge(checked, { includeChanged: $('includeChanged').checked });
  const rows = checked
    .slice()
    .sort((a, b) =>
      Object.values(STATUS).indexOf(b.status) - Object.values(STATUS).indexOf(a.status) ||
      (b.downloadTime || '').localeCompare(a.downloadTime || ''))
    .map(b => {
      const copy = STATUS_COPY[b.status];
      const rowCount = b.files.reduce((n, f) => n + f.rows.length, 0);
      const notes = [...b.problems, ...(b.notes || [])];
      if (superseded.has(b)) notes.push(SUPERSEDED_COPY[superseded.get(b)]);
      const details = notes.length
        ? el('ul', { class: 'file-table__problems' }, ...notes.map(p => el('li', {}, p)))
        : 'All files match the original export.';
      return el('tr', { class: `file-table__row file-table__row--${b.status}` },
        el('td', {},
          el('span', { class: `status-pill status-pill--${b.status}` },
            el('span', { 'aria-hidden': 'true', class: 'status-pill__icon' }, copy.icon), copy.label)),
        el('td', { class: 'file-table__name' }, b.label),
        el('td', {}, platformName(b.platform)),
        exportedCell(b.downloadTime),
        el('td', { class: 'file-table__num' }, String(rowCount)),
        el('td', {}, details),
        el('td', { class: 'file-table__action' }, removeButton(b)));
    });
  $('fileRows').replaceChildren(...rows);
}

// ---------------------------------------------------------------------------
// Merge + download
// ---------------------------------------------------------------------------

function timestampSlug(d = new Date()) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

/**
 * Hand the ZIP to the browser and wait until it is really on disk.
 * downloads.download() resolves when the download starts, not when it ends.
 */
async function saveAndWait(url, filename) {
  let changes = 0;
  let wake = null;
  const onChanged = (delta) => {
    if (!delta.state) return;
    changes++;
    if (wake) wake();
  };
  browser.downloads.onChanged.addListener(onChanged);
  try {
    const id = await browser.downloads.download({ url, filename, saveAs: false });
    for (;;) {
      const seen = changes;
      const [item] = await browser.downloads.search({ id });
      if (item && item.state === 'complete') return;
      if (!item || item.state === 'interrupted') {
        throw new Error('the browser could not finish saving the file');
      }
      if (changes === seen) await new Promise(resolve => { wake = resolve; });
    }
  } finally {
    browser.downloads.onChanged.removeListener(onChanged);
  }
}

/** Only call from inside runExclusive, so `checked` cannot change underneath. */
async function handleMerge() {
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
    result.textContent = 'Saving…';
    try {
      await saveAndWait(url, filename);
    } finally {
      URL.revokeObjectURL(url);
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
    const reason = (err && err.message ? err.message : 'unknown error').replace(/\.$/, '');
    result.textContent = `The merge failed: ${reason}. No file was saved.`;
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function init() {
  const zone = $('dropzone');
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dropzone--active'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dropzone--active'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dropzone--active');
    // The entries must be taken from the event now; reading them can wait its turn.
    const entries = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
    runExclusive(async () => {
      const list = [];
      for (const entry of entries) list.push(...await filesFromEntry(entry));
      await addFiles(list);
    });
  });
  // Dropping a file outside the zone must not navigate the tab to it.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  $('pickFiles').addEventListener('click', () => $('fileInput').click());
  $('pickFolder').addEventListener('click', () => $('folderInput').click());
  for (const id of ['fileInput', 'folderInput']) {
    $(id).addEventListener('change', (e) => {
      const list = [...e.target.files].map(file => ({ file, path: file.webkitRelativePath || file.name }));
      e.target.value = '';
      runExclusive(() => addFiles(list));
    });
  }
  $('clearAll').addEventListener('click', () => {
    // Move focus first: the button is about to be switched off and hidden.
    $('pickFiles').focus();
    runExclusive(() => {
      inputs.clear();
      unreadable = [];
      checked = [];
      ignored = [];
      $('includeChanged').checked = false;
      render();
    });
  });
  $('includeChanged').addEventListener('change', renderRows);
  $('mergeButton').addEventListener('click', () => runExclusive(handleMerge));
  $('pickFiles').focus();
}

document.addEventListener('DOMContentLoaded', init);
