/**
 * Cross-platform sources for the merge page: one combined sources table and
 * a per-domain count, built from the `<platform>_sources` files that
 * utils/merge.js has already verified and merged.
 *
 * Each platform's sources file has its own columns, so they cannot share one
 * table as-is. all_sources_canonical.csv keeps the columns every platform
 * has (or that map one-to-one), copied unchanged, plus `domain`, which is
 * the only derived value: the lowercased host of url_clean (or url) without
 * a leading "www.". `created_at_iso` is copied from the citing message in
 * all_messages_canonical.csv, so the table has a time for tools such as 4CAT;
 * it is empty when the source names no message (Microsoft 365 Copilot) or
 * the message is not in the merge.
 *
 * Pure (no DOM, no browser.*, no network).
 */

import { escapeCSVField } from './csv.js';

export const SOURCES_OUTPUT = 'all_sources_canonical';
export const SOURCES_COUNT_OUTPUT = 'sources_by_domain';

export const SOURCES_HEADERS = Object.freeze([
  'donor_id',
  'platform',
  'conversation_id',
  'message_id',
  'created_at_iso',
  'url',
  'url_clean',
  'domain',
  'title',
  'snippet',
  'source_schema',
  'source_file',
  'source_sha256'
]);

export const SOURCES_COUNT_HEADERS = Object.freeze([
  'platform',
  'domain',
  'citations',
  'unique_urls',
  'conversations',
  'participants'
]);

/**
 * How each sources schema maps to the shared columns. `platform` is the
 * value all_messages_canonical.csv uses (two schemas have no platform
 * column, and Google's canonical rows say google_ai_mode or
 * google_ai_overview rather than google_search). `message_id` is the
 * canonical message_id of the message that cites the source, so rows join
 * to all_messages_canonical.csv; it is left empty where the export does not
 * identify that message (Microsoft 365 Copilot records only the turn's
 * request id).
 */
const MAPPINGS = Object.freeze({
  chatgpt_sources: { platform: 'chatgpt', message_id: r => r.message_id },
  claude_sources: { platform: 'claude', message_id: r => r.message_id },
  deepseek_sources: { platform: 'deepseek', message_id: r => r.message_id },
  gemini_sources: { platform: 'gemini', message_id: r => r.message_id },
  grok_sources: { platform: 'grok', message_id: r => r.message_id },
  mistral_sources: { platform: 'mistral', message_id: r => r.message_id },
  perplexity_sources: {
    platform: 'perplexity',
    message_id: r => (r.entry_uuid ? `${r.entry_uuid}:assistant` : '')
  },
  google_sources: {
    platform: r => (r.mode === 'ai_overview' ? 'google_ai_overview' : 'google_ai_mode'),
    // Same ids the Google canonical rows use (background.js CANONICAL_MAPPERS).
    message_id: r => (r.mode === 'ai_overview' ? '0' : r.turn_index !== '' ? `turn_${r.turn_index}` : '')
  },
  m365_copilot_sources: { platform: 'm365_copilot', message_id: () => '' }
});

export function isSourcesSchema(schema) {
  return Object.hasOwn(MAPPINGS, schema);
}

/**
 * Host of a URL, lowercased, without a leading "www.". Empty when the value
 * is not an absolute URL.
 * @param {string} url
 * @returns {string}
 */
export function domainOf(url) {
  if (!url) return '';
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch (_err) {
    return '';
  }
}

/**
 * Key that joins a source to its message in all_messages_canonical.csv.
 * @returns {string}
 */
export function messageKey(donorId, platform, conversationId, messageId, downloadTime) {
  const parts = [donorId, platform, conversationId, messageId];
  if (downloadTime !== undefined) parts.push(downloadTime);
  return parts.join('\u0000');
}

function csvLine(fields) {
  return fields.map(escapeCSVField).join(',');
}

/**
 * created_at_iso of the message citing a source: the message from the same
 * export (same download_time) first, else the message's time when all its
 * exports agree, else empty.
 */
function timeOf(messageTimes, r, platform, messageId) {
  const base = [r.donor_id ?? '', platform, r.conversation_id ?? '', messageId];
  return messageTimes.get(messageKey(...base, r.download_time ?? '')) ??
    messageTimes.get(messageKey(...base)) ?? '';
}

/**
 * Build all_sources_canonical.csv and sources_by_domain.csv.
 *
 * @param {Array<{schema: string, headers: string[], rows: string[][], filename: string, sha256: string}>} files
 *   Sources files that were merged, in merge order.
 * @param {Map<string, string|null>} [messageTimes] created_at_iso per
 *   messageKey(donor_id, platform, conversation_id, message_id[, download_time]),
 *   from the merged canonical messages (null: exports disagree).
 * @returns {{sources: {content: string, rows: number}, counts: {content: string, rows: number}} | null}
 *   CSV contents without BOM, or null when there are no sources files.
 */
export function buildSourcesOutputs(files, messageTimes = new Map()) {
  const rows = [];
  for (const f of files) {
    const map = MAPPINGS[f.schema];
    if (!map) continue;
    for (const values of f.rows) {
      const r = {};
      f.headers.forEach((h, i) => { r[h] = values[i]; });
      const urlClean = r.url_clean ?? '';
      const platform = typeof map.platform === 'function' ? map.platform(r) : map.platform;
      const messageId = map.message_id(r) ?? '';
      rows.push([
        r.donor_id ?? '',
        platform,
        r.conversation_id ?? '',
        messageId,
        messageId ? timeOf(messageTimes, r, platform, messageId) : '',
        r.url ?? '',
        urlClean,
        domainOf(urlClean || r.url),
        r.title ?? '',
        r.snippet ?? '',
        f.schema,
        f.filename,
        f.sha256
      ]);
    }
  }
  if (files.length === 0) return null;

  // Counts per (platform, domain), plus an `all` row per domain.
  const col = Object.fromEntries(SOURCES_HEADERS.map((h, i) => [h, i]));
  const tally = new Map();
  const bump = (platform, row) => {
    const key = `${platform}\u0000${row[col.domain]}`;
    let t = tally.get(key);
    if (!t) {
      t = { platform, domain: row[col.domain], citations: 0, urls: new Set(), convs: new Set(), donors: new Set() };
      tally.set(key, t);
    }
    t.citations++;
    t.urls.add(row[col.url_clean] || row[col.url]);
    t.convs.add(`${row[col.donor_id]}\u0000${row[col.platform]}\u0000${row[col.conversation_id]}`);
    t.donors.add(row[col.donor_id]);
  };
  for (const row of rows) {
    bump(row[col.platform], row);
    bump('all', row);
  }
  const counted = [...tally.values()].sort((a, b) =>
    (a.platform === 'all' ? 0 : 1) - (b.platform === 'all' ? 0 : 1) ||
    (a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0) ||
    b.citations - a.citations ||
    (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));

  const sourcesContent = [csvLine(SOURCES_HEADERS), ...rows.map(csvLine)].join('\r\n') + '\r\n';
  const countsContent = [
    csvLine(SOURCES_COUNT_HEADERS),
    ...counted.map(t => csvLine([t.platform, t.domain, t.citations, t.urls.size, t.convs.size, t.donors.size]))
  ].join('\r\n') + '\r\n';
  return {
    sources: { content: sourcesContent, rows: rows.length },
    counts: { content: countsContent, rows: counted.length }
  };
}
