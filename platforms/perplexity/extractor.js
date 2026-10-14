/**
 * Perplexity Platform - Extractor
 *
 * Produces CSVs from a merged Perplexity thread payload (one object built by
 * content.js from one or more /rest/thread/{uuid} responses).
 *
 *   CSV A: perplexity_metadata            (one row per thread)
 *   CSV B: perplexity_messages            (two rows per turn: user prompt + assistant answer)
 *   CSV C: perplexity_sources             (one row per cited web source)
 *   CSV D: perplexity_messages_canonical  (cross-platform canonical, one row per message)
 *
 * The extractor is deliberately tolerant of block/field name variation.
 * Perplexity's thread API is unofficial; blocks have been seen as
 *   markdown_block, text_block, code_block, plan_block, reasoning_block,
 *   reasoning_plan_block, web_result_block, web_citation_block, citation_block
 * with content under different keys per block type.
 */

import { escapeCSVField } from '../../utils/csv.js';
import {
  SCHEMA_VERSIONS,
  EXTRACTOR_VERSION,
  canonicalHeaders,
  toIsoUtc
} from '../../utils/manifest.js';
import { cleanText } from '../../utils/text_cleaner.js';
import { stripUtmParams } from '../../utils/extract_helpers.js';


// ---------------------------------------------------------------------------
// Shape-tolerant readers
// ---------------------------------------------------------------------------

function firstString(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

function readEntryBlocks(entry) {
  if (!entry || typeof entry !== 'object') return [];
  if (Array.isArray(entry.blocks)) return entry.blocks;
  if (Array.isArray(entry.answer_blocks)) return entry.answer_blocks;
  if (Array.isArray(entry.content_blocks)) return entry.content_blocks;
  return [];
}

// Block names we treat as answer text. Order determines reading precedence
// when a single block carries multiple candidate fields.
const ANSWER_BLOCK_TYPES = Object.freeze([
  'markdown_block', 'text_block', 'answer_block'
]);
const CODE_BLOCK_TYPES = Object.freeze(['code_block']);
const REASONING_BLOCK_TYPES = Object.freeze([
  'plan_block', 'reasoning_plan_block', 'reasoning_block'
]);
const SOURCE_BLOCK_TYPES = Object.freeze([
  'web_result_block', 'web_citation_block', 'citation_block'
]);


function readBlockText(blockValue, candidateKeys) {
  if (typeof blockValue === 'string') return blockValue;
  if (!blockValue || typeof blockValue !== 'object') return '';
  return firstString(blockValue, candidateKeys);
}

function readBlockPayload(block, typeNames) {
  if (!block || typeof block !== 'object') return null;
  for (const name of typeNames) {
    if (name in block) return { typeName: name, value: block[name] };
  }
  return null;
}

function readSources(blockValue) {
  if (!blockValue || typeof blockValue !== 'object') return [];
  if (Array.isArray(blockValue.web_results)) return blockValue.web_results;
  if (Array.isArray(blockValue.citations)) return blockValue.citations;
  if (Array.isArray(blockValue.results)) return blockValue.results;
  return [];
}


// ---------------------------------------------------------------------------
// Normalization: turn each entry into user prompt + assistant answer rows
// ---------------------------------------------------------------------------

function normalizeEntry(entry, threadUuid, turnIndex) {
  const entryUuid = firstString(entry, [
    'uuid', 'backend_uuid', 'id', 'entry_uuid'
  ]) || `${threadUuid}:${turnIndex}`;

  const promptText = firstString(entry, ['query_str', 'query', 'prompt']);

  const blocks = readEntryBlocks(entry);

  const answerChunks = [];
  const codeChunks = [];
  const reasoningChunks = [];
  const sources = [];

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;

    const answerPayload = readBlockPayload(block, ANSWER_BLOCK_TYPES);
    if (answerPayload) {
      const txt = readBlockText(answerPayload.value, [
        'answer', 'text', 'content', 'markdown'
      ]);
      if (txt) answerChunks.push(txt);
    }

    const codePayload = readBlockPayload(block, CODE_BLOCK_TYPES);
    if (codePayload) {
      const txt = readBlockText(codePayload.value, ['code', 'content', 'text']);
      if (txt) codeChunks.push(txt);
    }

    const reasoningPayload = readBlockPayload(block, REASONING_BLOCK_TYPES);
    if (reasoningPayload) {
      const txt = readBlockText(reasoningPayload.value, [
        'content', 'text', 'plan', 'reasoning'
      ]);
      if (txt) reasoningChunks.push(txt);
    }

    const sourcePayload = readBlockPayload(block, SOURCE_BLOCK_TYPES);
    if (sourcePayload) {
      const sourceEntries = readSources(sourcePayload.value);
      for (const source of sourceEntries) {
        if (!source || typeof source !== 'object') continue;
        const url = firstString(source, ['url', 'link']);
        if (!url) continue;
        sources.push({
          entry_uuid: entryUuid,
          source_block_type: sourcePayload.typeName,
          url,
          url_clean: stripUtmParams(url),
          title: firstString(source, ['title', 'name']),
          snippet: firstString(source, ['snippet', 'summary', 'description', 'text']),
          domain: firstString(source, ['domain', 'host']),
          publication_date: toIsoUtc(source.date || source.published_at || source.timestamp || '')
        });
      }
    }
  }

  const answerText = answerChunks.join('\n\n');
  const codeText = codeChunks.join('\n\n');
  const reasoningText = reasoningChunks.join('\n\n');

  const createdAt = toIsoUtc(
    entry.created_at || entry.created_datetime
    || entry.query_datetime || entry.timestamp || ''
  );
  const updatedAt = toIsoUtc(
    entry.updated_at || entry.last_updated_datetime
    || entry.completion_datetime || ''
  );
  const modelId = firstString(entry, [
    'display_model', 'model', 'model_version', 'answer_model'
  ]);
  const status = firstString(entry, ['status', 'state']);

  return {
    entryUuid,
    turnIndex,
    promptText,
    answerText,
    codeText,
    reasoningText,
    sources,
    createdAt,
    updatedAt,
    modelId,
    status,
    sourceCount: sources.length,
    hasReasoning: reasoningChunks.length > 0,
    hasCode: codeChunks.length > 0
  };
}


function normalizeConversation(conversationData) {
  const threadUuid = firstString(conversationData, [
    'uuid', 'backend_uuid', 'thread_uuid', 'id'
  ]);
  const entries = Array.isArray(conversationData.entries) ? conversationData.entries : [];
  const normalized = entries.map((e, i) => normalizeEntry(e, threadUuid, i));
  return { threadUuid, normalized };
}


// ---------------------------------------------------------------------------
// CSV A: metadata
// ---------------------------------------------------------------------------

function extractMetadata(conversationData, normalized) {
  return {
    conversation_id: firstString(conversationData, [
      'uuid', 'backend_uuid', 'thread_uuid', 'id'
    ]),
    title: conversationData.title || '',
    created_at: toIsoUtc(conversationData.created_at),
    updated_at: toIsoUtc(conversationData.updated_at),
    num_turns: normalized.length,
    num_sources: normalized.reduce((n, e) => n + e.sourceCount, 0),
    page_count: typeof conversationData.page_count === 'number' ? conversationData.page_count : ''
  };
}

function generateMetadataCSV(metadata) {
  const headers = [
    'schema_version',
    'extractor_version',
    'donor_id',
    'donor_id_type',
    'download_time',
    'conversation_id',
    'title',
    'created_at',
    'updated_at',
    'num_turns',
    'num_sources',
    'page_count'
  ];
  const enriched = {
    schema_version: SCHEMA_VERSIONS.perplexity_metadata,
    extractor_version: EXTRACTOR_VERSION,
    ...metadata
  };
  const row = headers.map(h => escapeCSVField(enriched[h]));
  return [headers.join(','), row.join(',')].join('\r\n') + '\r\n';
}


// ---------------------------------------------------------------------------
// CSV B: messages (one user row + one assistant row per turn)
// ---------------------------------------------------------------------------

function extractMessages(conversationData, normalized) {
  const conversationId = firstString(conversationData, [
    'uuid', 'backend_uuid', 'thread_uuid', 'id'
  ]);
  const rows = [];

  for (const entry of normalized) {
    rows.push({
      conversation_id: conversationId,
      message_id: `${entry.entryUuid}:user`,
      parent_id: entry.turnIndex === 0 ? '' : `${normalized[entry.turnIndex - 1].entryUuid}:assistant`,
      entry_uuid: entry.entryUuid,
      turn_index: entry.turnIndex,
      role: 'user',
      text: entry.promptText,
      text_cleaned: cleanText(entry.promptText),
      code_text: '',
      reasoning_text: '',
      created_at: entry.createdAt,
      model_identifier: '',
      status: '',
      source_count: 0
    });

    rows.push({
      conversation_id: conversationId,
      message_id: `${entry.entryUuid}:assistant`,
      parent_id: `${entry.entryUuid}:user`,
      entry_uuid: entry.entryUuid,
      turn_index: entry.turnIndex,
      role: 'assistant',
      text: entry.answerText,
      text_cleaned: cleanText(entry.answerText),
      code_text: entry.codeText,
      reasoning_text: entry.reasoningText,
      created_at: entry.updatedAt || entry.createdAt,
      model_identifier: entry.modelId,
      status: entry.status,
      source_count: entry.sourceCount
    });
  }

  return rows;
}

function generateMessagesCSV(messages) {
  const headers = [
    'schema_version',
    'extractor_version',
    'donor_id',
    'donor_id_type',
    'download_time',
    'conversation_id',
    'message_id',
    'parent_id',
    'entry_uuid',
    'turn_index',
    'role',
    'text',
    'text_cleaned',
    'code_text',
    'reasoning_text',
    'created_at',
    'model_identifier',
    'status',
    'source_count'
  ];
  const rows = [headers.join(',')];
  for (const m of messages) {
    const enriched = {
      schema_version: SCHEMA_VERSIONS.perplexity_messages,
      extractor_version: EXTRACTOR_VERSION,
      ...m
    };
    rows.push(headers.map(h => escapeCSVField(enriched[h])).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}


// ---------------------------------------------------------------------------
// CSV C: sources
// ---------------------------------------------------------------------------

function extractSources(conversationData, normalized) {
  const conversationId = firstString(conversationData, [
    'uuid', 'backend_uuid', 'thread_uuid', 'id'
  ]);
  const rows = [];
  for (const entry of normalized) {
    entry.sources.forEach((src, idx) => {
      rows.push({
        conversation_id: conversationId,
        entry_uuid: entry.entryUuid,
        turn_index: entry.turnIndex,
        source_index: idx,
        source_block_type: src.source_block_type,
        url: src.url,
        url_clean: src.url_clean,
        title: src.title,
        snippet: src.snippet,
        domain: src.domain,
        publication_date: src.publication_date
      });
    });
  }
  return rows;
}

function generateSourcesCSV(sources) {
  const headers = [
    'schema_version',
    'extractor_version',
    'donor_id',
    'donor_id_type',
    'download_time',
    'conversation_id',
    'entry_uuid',
    'turn_index',
    'source_index',
    'source_block_type',
    'url',
    'url_clean',
    'title',
    'snippet',
    'domain',
    'publication_date'
  ];
  const rows = [headers.join(',')];
  for (const s of sources) {
    const enriched = {
      schema_version: SCHEMA_VERSIONS.perplexity_sources,
      extractor_version: EXTRACTOR_VERSION,
      ...s
    };
    rows.push(headers.map(h => escapeCSVField(enriched[h])).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}


// ---------------------------------------------------------------------------
// CSV D: canonical messages
// ---------------------------------------------------------------------------

function generateMessagesCanonicalCSV(messages, { donorId, donorIdType, downloadTime }) {
  const headers = canonicalHeaders();
  const rows = [headers.join(',')];
  const schemaVersion = SCHEMA_VERSIONS.perplexity_messages_canonical;
  for (const m of messages) {
    const row = {
      donor_id: donorId,
      platform: 'perplexity',
      conversation_id: m.conversation_id,
      message_id: m.message_id,
      parent_message_id: m.parent_id || '',
      turn_index: m.turn_index,
      role: m.role,
      text: m.text,
      text_cleaned: m.text_cleaned,
      created_at_iso: m.created_at,
      model_identifier: m.model_identifier || '',
      schema_version: schemaVersion,
      extractor_version: EXTRACTOR_VERSION,
      platform_specific_json: JSON.stringify({
        donor_id_type: donorIdType,
        download_time: downloadTime,
        entry_uuid: m.entry_uuid,
        code_text: m.code_text,
        reasoning_text: m.reasoning_text,
        status: m.status,
        source_count: m.source_count
      })
    };
    rows.push(headers.map(h => escapeCSVField(row[h])).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}


// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function extractPerplexityConversation(conversationData, { donorId = '', donorIdType = '', downloadTime = '' } = {}) {
  if (!conversationData || typeof conversationData !== 'object') {
    throw new Error('Invalid Perplexity conversation data');
  }

  const { normalized } = normalizeConversation(conversationData);

  const metadata = extractMetadata(conversationData, normalized);
  metadata.donor_id = donorId;
  metadata.donor_id_type = donorIdType;
  metadata.download_time = downloadTime;

  const messages = extractMessages(conversationData, normalized).map(m => ({
    ...m,
    donor_id: donorId,
    donor_id_type: donorIdType,
    download_time: downloadTime
  }));

  const sources = extractSources(conversationData, normalized).map(s => ({
    ...s,
    donor_id: donorId,
    donor_id_type: donorIdType,
    download_time: downloadTime
  }));

  return {
    metadata,
    messages,
    sources,
    metadataCSV: generateMetadataCSV(metadata),
    messagesCSV: generateMessagesCSV(messages),
    sourcesCSV: generateSourcesCSV(sources),
    messagesCanonicalCSV: generateMessagesCanonicalCSV(messages, { donorId, donorIdType, downloadTime })
  };
}


export {
  extractPerplexityConversation,
  normalizeConversation,
  extractMetadata,
  extractMessages,
  extractSources,
  generateMetadataCSV,
  generateMessagesCSV,
  generateSourcesCSV,
  generateMessagesCanonicalCSV
};
