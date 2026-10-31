/**
 * AI Chat Exporter - Google Gemini Extractor Module
 *
 * Generates four CSV files from a Gemini conversation payload:
 *   CSV A: Conversation metadata     (one row per conversation)
 *   CSV B: Conversation messages     (one row per message)
 *   CSV C: Sources                   (one row per cited source/span)
 *   CSV D: Canonical messages        (cross-platform shape, one row per message)
 *
 * Input shape (assembled by content.js):
 *   {
 *     _captured_conversation_id: string,   // normalized `c_<url id>`
 *     conversation: {
 *       id, title, url, account_prefix, source_path,
 *       model, created_at, updated_at
 *     },
 *     messages: [                          // oldest-first
 *       {
 *         message_id, parent_message_id, candidate_id, parent_candidate_id,
 *         turn_index, role, text, created_at, model_identifier,
 *         citations: [
 *           {
 *             source_index, ref_index, source_id, url, title, snippet,
 *             start_index, end_index
 *           }
 *         ]
 *       }
 *     ]
 *   }
 *
 * Gemini's batchexecute history RPC returns turns newest-first. content.js
 * reverses and dedupes them before sending the payload, so this module keeps
 * the order it receives. It stays defensive about missing fields: a
 * conversation with no assistant text still exports the user prompts.
 */

import { escapeCSVField } from '../../utils/csv.js';
import {
  SCHEMA_VERSIONS,
  EXTRACTOR_VERSION,
  canonicalHeaders,
  toIsoUtc
} from '../../utils/manifest.js';
import { cleanText } from '../../utils/text_cleaner.js';
import { stripUtmParams, toJsonCell, normalizeRole } from '../../utils/extract_helpers.js';


// ============================================================================
// HELPERS
// ============================================================================

function unwrap(data) {
  if (!data || typeof data !== 'object') {
    return { conversation: null, messages: [], conversationId: '' };
  }
  const conversation = data.conversation && typeof data.conversation === 'object'
    ? data.conversation
    : null;
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const conversationId =
    (typeof data._captured_conversation_id === 'string' && data._captured_conversation_id) ||
    (conversation && conversation.id) ||
    '';
  return { conversation, messages, conversationId };
}

function citationsForMessage(message) {
  return Array.isArray(message && message.citations) ? message.citations : [];
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}


// ============================================================================
// CSV A: CONVERSATION METADATA
// ============================================================================

function extractConversationMetadata(data) {
  const { conversation, messages, conversationId } = unwrap(data);

  let numUser = 0;
  let numAssistant = 0;
  let numWithCitations = 0;
  let numCitedSources = 0;

  for (const message of messages) {
    const role = normalizeRole(message && message.role);
    if (role === 'user') numUser++;
    else if (role === 'assistant') numAssistant++;

    const citations = citationsForMessage(message);
    if (citations.length > 0) numWithCitations++;
    numCitedSources += citations.length;
  }

  const firstUser = messages.find((m) => normalizeRole(m && m.role) === 'user' && typeof m.text === 'string' && m.text);
  const derivedTitle = firstUser
    ? firstUser.text.replace(/\s+/g, ' ').trim().slice(0, 120)
    : '';

  return {
    conversation_id: conversationId,
    title: firstNonEmpty(conversation && conversation.title, derivedTitle),
    model: (conversation && conversation.model) || '',
    conversation_url: (conversation && conversation.url) || '',
    account_prefix: (conversation && conversation.account_prefix) || '',
    source_path: (conversation && conversation.source_path) || '',
    created_at: toIsoUtc(conversation && conversation.created_at) || '',
    updated_at: toIsoUtc(conversation && conversation.updated_at) || '',
    num_messages: messages.length,
    num_user_messages: numUser,
    num_assistant_messages: numAssistant,
    num_messages_with_citations: numWithCitations,
    num_cited_sources: numCitedSources
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
    'model',
    'conversation_url',
    'account_prefix',
    'source_path',
    'created_at',
    'updated_at',
    'num_messages',
    'num_user_messages',
    'num_assistant_messages',
    'num_messages_with_citations',
    'num_cited_sources'
  ];
  const enriched = {
    schema_version: SCHEMA_VERSIONS.gemini_metadata,
    extractor_version: EXTRACTOR_VERSION,
    ...metadata
  };
  const row = headers.map((header) => escapeCSVField(enriched[header]));
  return [headers.join(','), row.join(',')].join('\r\n') + '\r\n';
}


// ============================================================================
// CSV B: CONVERSATION MESSAGES (one row per message)
// ============================================================================

function extractConversationMessages(data) {
  const { messages, conversationId } = unwrap(data);
  const rows = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i] || {};
    const citations = citationsForMessage(message);
    const text = typeof message.text === 'string' ? message.text : '';
    rows.push({
      conversation_id: conversationId,
      message_id: message.message_id || `message-${i}`,
      parent_message_id: message.parent_message_id || '',
      candidate_id: message.candidate_id || '',
      parent_candidate_id: message.parent_candidate_id || '',
      turn_index: typeof message.turn_index === 'number' ? message.turn_index : i,
      role: normalizeRole(message.role),
      text,
      text_cleaned: cleanText(text),
      model_identifier: message.model_identifier || '',
      created_at: toIsoUtc(message.created_at) || '',
      cited_source_count: citations.length,
      has_citations: citations.length > 0,
      raw_message_json: toJsonCell(message)
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
    'parent_message_id',
    'candidate_id',
    'parent_candidate_id',
    'turn_index',
    'role',
    'text',
    'text_cleaned',
    'model_identifier',
    'created_at',
    'cited_source_count',
    'has_citations',
    'raw_message_json'
  ];
  const rows = [headers.join(',')];
  for (const message of messages) {
    const enriched = {
      schema_version: SCHEMA_VERSIONS.gemini_messages,
      extractor_version: EXTRACTOR_VERSION,
      ...message
    };
    rows.push(headers.map((header) => escapeCSVField(enriched[header])).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}


// ============================================================================
// CSV C: SOURCES
// ============================================================================

function extractSources(data) {
  const { messages, conversationId } = unwrap(data);
  const rows = [];

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const citations = citationsForMessage(message);
    for (let i = 0; i < citations.length; i++) {
      const citation = citations[i] || {};
      const url = typeof citation.url === 'string' ? citation.url : '';
      if (!url) continue;
      rows.push({
        conversation_id: conversationId,
        message_id: message.message_id || '',
        source_list: 'citation',
        source_index: typeof citation.source_index === 'number' ? citation.source_index : i,
        ref_index: typeof citation.ref_index === 'number' ? citation.ref_index : '',
        source_id: citation.source_id || '',
        type: 'citation',
        url,
        url_clean: stripUtmParams(url),
        title: citation.title || '',
        snippet: citation.snippet || '',
        start_index: typeof citation.start_index === 'number' ? citation.start_index : '',
        end_index: typeof citation.end_index === 'number' ? citation.end_index : '',
        raw_json: toJsonCell(citation)
      });
    }
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
    'platform',
    'conversation_id',
    'message_id',
    'source_list',
    'source_index',
    'ref_index',
    'source_id',
    'type',
    'url',
    'url_clean',
    'title',
    'snippet',
    'start_index',
    'end_index',
    'raw_json'
  ];
  const rows = [headers.join(',')];
  for (const source of sources) {
    const enriched = {
      schema_version: SCHEMA_VERSIONS.gemini_sources,
      extractor_version: EXTRACTOR_VERSION,
      platform: 'gemini',
      ...source
    };
    rows.push(headers.map((header) => escapeCSVField(enriched[header])).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}


// ============================================================================
// CSV D: CANONICAL MESSAGES
// ============================================================================

function generateMessagesCanonicalCSV(data, { donorId, donorIdType, downloadTime, scrubCell = null }) {
  const headers = canonicalHeaders();
  const schemaVersion = SCHEMA_VERSIONS.gemini_messages_canonical;
  const { conversation, messages, conversationId } = unwrap(data);
  const conversationModel = (conversation && conversation.model) || '';

  const rows = [headers.join(',')];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i] || {};
    const citations = citationsForMessage(message);
    const text = typeof message.text === 'string' ? message.text : '';
    const row = {
      donor_id: donorId,
      platform: 'gemini',
      conversation_id: conversationId,
      message_id: message.message_id || `message-${i}`,
      parent_message_id: message.parent_message_id || '',
      turn_index: typeof message.turn_index === 'number' ? message.turn_index : i,
      role: normalizeRole(message.role),
      text,
      text_cleaned: cleanText(text),
      created_at_iso: toIsoUtc(message.created_at) || '',
      model_identifier: message.model_identifier || conversationModel,
      schema_version: schemaVersion,
      extractor_version: EXTRACTOR_VERSION,
      platform_specific_json: JSON.stringify({
        donor_id_type: donorIdType,
        download_time: downloadTime,
        candidate_id: message.candidate_id || '',
        parent_candidate_id: message.parent_candidate_id || '',
        cited_source_count: citations.length,
        has_citations: citations.length > 0,
        conversation_title: (conversation && conversation.title) || ''
      })
    };
    // Optional per-cell scrubber (background.js passes one when PII scrubbing
    // is on) so the canonical file never carries text the other CSVs redact.
    rows.push(headers.map((header) => escapeCSVField(scrubCell ? scrubCell(header, row[header]) : row[header])).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}


// ============================================================================
// MAIN EXPORT
// ============================================================================

function extractGeminiConversation(conversationData, { donorId = '', donorIdType = '', downloadTime = '' } = {}) {
  if (!conversationData) {
    throw new Error('Invalid Gemini conversation data');
  }

  const metadata = extractConversationMetadata(conversationData);
  metadata.donor_id = donorId;
  metadata.donor_id_type = donorIdType;
  metadata.download_time = downloadTime;

  const messages = extractConversationMessages(conversationData);
  for (const message of messages) {
    message.donor_id = donorId;
    message.donor_id_type = donorIdType;
    message.download_time = downloadTime;
  }

  const sources = extractSources(conversationData);
  for (const source of sources) {
    source.donor_id = donorId;
    source.donor_id_type = donorIdType;
    source.download_time = downloadTime;
  }

  return {
    metadata,
    messages,
    sources,
    metadataCSV: generateMetadataCSV(metadata),
    messagesCSV: generateMessagesCSV(messages),
    sourcesCSV: generateSourcesCSV(sources),
    messagesCanonicalCSV: generateMessagesCanonicalCSV(conversationData, { donorId, donorIdType, downloadTime })
  };
}


// ============================================================================
// EXPORTS
// ============================================================================

export {
  extractGeminiConversation,
  extractConversationMetadata,
  extractConversationMessages,
  extractSources,
  generateMetadataCSV,
  generateMessagesCSV,
  generateSourcesCSV,
  generateMessagesCanonicalCSV
};
