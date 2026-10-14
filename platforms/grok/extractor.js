/**
 * AI Chat Exporter - Grok Extractor Module
 *
 * Generates four CSV files from a Grok conversation JSON:
 *   CSV A: Conversation metadata     (one row per conversation)
 *   CSV B: Conversation messages     (one row per message / "response")
 *   CSV C: Sources                   (one row per web-search result / citation)
 *   CSV D: Canonical messages        (cross-platform shape)
 *
 * Grok's public web app returns conversations under either:
 *   { conversation: {...}, responses: [...] }   // typical conversation GET
 *   { responses: [...] }                        // some endpoint variants
 *   { messages: [...] }                         // defensive fallback
 *
 * Field names on individual messages observed in the wild include
 * `responseId`, `sender`, `message`, `createTime`, `parentResponseId`, plus
 * optional `webSearchResults`, `xpostIds`, `toolsUsed`, `fileAttachments`, and
 * `generatedImageUrls`. We read every known field defensively and preserve the
 * full message object in `raw_json` so new fields do not get silently dropped.
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

/**
 * Unwrap the conversation shape into { conv, messages, conversationId }, where
 * `conv` is the conversation-level object (nullable), `messages` is the flat
 * list of message objects, and `conversationId` is the UUID stamped by the
 * content script from the request URL (Grok's payload omits it).
 */
function unwrap(data) {
  if (!data || typeof data !== 'object') {
    return { conv: null, messages: [], conversationId: '' };
  }

  // UUID stamped by inject.js/content.js from the request path, because Grok's
  // own payload doesn't echo the conversation id back.
  const stampedId = typeof data._captured_conversation_id === 'string'
    ? data._captured_conversation_id
    : '';

  // Grok sometimes wraps the conversation metadata under `conversation` and the
  // flat message list under `responses` at the top level.
  if (data.conversation && typeof data.conversation === 'object') {
    const inner = data.conversation;
    const messages =
      Array.isArray(data.responses) ? data.responses :
      Array.isArray(inner.responses) ? inner.responses :
      Array.isArray(data.messages) ? data.messages :
      [];
    const conversationId = stampedId || inner.conversationId || inner.id || '';
    return { conv: inner, messages, conversationId };
  }

  // No nested wrapper — Grok's typical shape is a flat `{ responses: [...] }`
  // with no conversation metadata; `conv` falls back to the top-level object so
  // optional fields (title, mediaTypes, ...) are still read if ever present.
  const messages =
    Array.isArray(data.responses) ? data.responses :
    Array.isArray(data.messages) ? data.messages :
    [];
  const conversationId = stampedId || data.conversationId || data.id || '';
  return { conv: data, messages, conversationId };
}

/**
 * Pull a message id off a Grok message object, trying every observed shape.
 */
function messageId(msg) {
  if (!msg || typeof msg !== 'object') return '';
  return msg.responseId || msg.messageId || msg.id || '';
}

function parentId(msg) {
  if (!msg || typeof msg !== 'object') return '';
  return msg.parentResponseId || msg.parentMessageId || msg.parent_id || '';
}

/**
 * Extract display text from a message. Grok's typical shape is a plain string
 * on `message`; some variants put the user turn on `query` and the assistant
 * turn on `message` or `content`.
 */
function messageText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  if (typeof msg.message === 'string' && msg.message) return msg.message;
  if (typeof msg.content === 'string' && msg.content) return msg.content;
  if (typeof msg.query === 'string' && msg.query) return msg.query;
  if (typeof msg.text === 'string' && msg.text) return msg.text;
  // Some variants carry a `parts` array similar to ChatGPT's multimodal text.
  if (Array.isArray(msg.parts)) {
    return msg.parts
      .map(p => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : '')))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function createdAt(msg) {
  if (!msg || typeof msg !== 'object') return '';
  return toIsoUtc(msg.createTime || msg.created_at || msg.timestamp) || '';
}


// ============================================================================
// CSV A: CONVERSATION METADATA
// ============================================================================

function extractConversationMetadata(conversationData) {
  const { conv, messages, conversationId } = unwrap(conversationData);

  let numUser = 0;
  let numAssistant = 0;
  let numWithWebSearch = 0;
  let numWithAttachments = 0;
  let numWithImages = 0;

  for (const m of messages) {
    const role = normalizeRole(m?.sender || m?.role);
    if (role === 'user') numUser++;
    else if (role === 'assistant') numAssistant++;

    if (Array.isArray(m?.webSearchResults) && m.webSearchResults.length > 0) numWithWebSearch++;
    if (Array.isArray(m?.fileAttachments) && m.fileAttachments.length > 0) numWithAttachments++;
    if (Array.isArray(m?.generatedImageUrls) && m.generatedImageUrls.length > 0) numWithImages++;
  }

  return {
    conversation_id: conversationId,
    title: (conv && (conv.title || conv.name)) || '',
    create_time: toIsoUtc(conv && (conv.createTime || conv.created_at)) || '',
    modify_time: toIsoUtc(conv && (conv.modifyTime || conv.updated_at)) || '',
    temporary: Boolean(conv && conv.temporary),
    system_prompt_name: (conv && (conv.systemPromptName || conv.system_prompt_name)) || '',
    media_types: Array.isArray(conv && conv.mediaTypes) ? conv.mediaTypes.join(',') : '',
    num_messages: messages.length,
    num_user_messages: numUser,
    num_assistant_messages: numAssistant,
    num_messages_with_web_search: numWithWebSearch,
    num_messages_with_attachments: numWithAttachments,
    num_messages_with_generated_images: numWithImages
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
    'create_time',
    'modify_time',
    'temporary',
    'system_prompt_name',
    'media_types',
    'num_messages',
    'num_user_messages',
    'num_assistant_messages',
    'num_messages_with_web_search',
    'num_messages_with_attachments',
    'num_messages_with_generated_images'
  ];
  const enriched = {
    schema_version: SCHEMA_VERSIONS.grok_metadata,
    extractor_version: EXTRACTOR_VERSION,
    ...metadata
  };
  const row = headers.map(h => escapeCSVField(enriched[h]));
  return [headers.join(','), row.join(',')].join('\r\n') + '\r\n';
}


// ============================================================================
// CSV B: CONVERSATION MESSAGES (one row per message / response)
// ============================================================================

function extractConversationMessages(conversationData) {
  const { messages, conversationId } = unwrap(conversationData);

  const rows = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] || {};
    const toolsUsed = Array.isArray(m.toolsUsed) ? m.toolsUsed : [];
    const rawText = messageText(m);
    rows.push({
      conversation_id: conversationId,
      message_id: messageId(m),
      parent_message_id: parentId(m),
      turn_index: i,
      sender: m.sender || m.role || '',
      role: normalizeRole(m.sender || m.role),
      text: rawText,
      text_cleaned: cleanText(rawText),
      model_identifier: m.model || m.modelName || '',
      created_at: createdAt(m),
      manual: m.manual === true,
      partial: m.partial === true,
      shared: m.shared === true,
      has_web_search: Array.isArray(m.webSearchResults) && m.webSearchResults.length > 0,
      has_attachments: Array.isArray(m.fileAttachments) && m.fileAttachments.length > 0,
      has_generated_images: Array.isArray(m.generatedImageUrls) && m.generatedImageUrls.length > 0,
      tools_used: toolsUsed.map(t => (typeof t === 'string' ? t : (t && t.name) || '')).filter(Boolean).join(','),
      xpost_ids: Array.isArray(m.xpostIds) ? m.xpostIds.join(',') : '',
      feedback_labels: Array.isArray(m.feedbackLabels) ? m.feedbackLabels.join(',') : '',
      raw_message_json: toJsonCell(m)
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
    'turn_index',
    'sender',
    'role',
    'text',
    'text_cleaned',
    'model_identifier',
    'created_at',
    'manual',
    'partial',
    'shared',
    'has_web_search',
    'has_attachments',
    'has_generated_images',
    'tools_used',
    'xpost_ids',
    'feedback_labels',
    'raw_message_json'
  ];
  const rows = [headers.join(',')];
  for (const m of messages) {
    const enriched = {
      schema_version: SCHEMA_VERSIONS.grok_messages,
      extractor_version: EXTRACTOR_VERSION,
      ...m
    };
    rows.push(headers.map(h => escapeCSVField(enriched[h])).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}


// ============================================================================
// CSV C: SOURCES — web search results and X-post citations
// ============================================================================

function extractSources(conversationData) {
  const { messages, conversationId } = unwrap(conversationData);
  const rows = [];

  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const msgId = messageId(m);

    const webResults = Array.isArray(m.webSearchResults) ? m.webSearchResults : [];
    for (let i = 0; i < webResults.length; i++) {
      const r = webResults[i] || {};
      const url = r.url || r.link || '';
      rows.push({
        conversation_id: conversationId,
        message_id: msgId,
        source_list: 'web_search',
        source_index: i,
        type: r.type || '',
        url,
        url_clean: stripUtmParams(url),
        title: r.title || '',
        snippet: r.snippet || r.description || r.preview || '',
        site_name: r.siteName || r.site_name || r.domain || '',
        published_at: toIsoUtc(r.publishedDate || r.published_at) || '',
        raw_json: toJsonCell(r)
      });
    }

    // X-post references: often just id strings, sometimes richer objects.
    const xposts = Array.isArray(m.xpostIds) ? m.xpostIds : [];
    for (let i = 0; i < xposts.length; i++) {
      const x = xposts[i];
      const id = typeof x === 'string' ? x : (x && (x.id || x.postId)) || '';
      const url = typeof x === 'string'
        ? `https://x.com/i/status/${encodeURIComponent(id)}`
        : (x && x.url) || (id ? `https://x.com/i/status/${encodeURIComponent(id)}` : '');
      rows.push({
        conversation_id: conversationId,
        message_id: msgId,
        source_list: 'xpost',
        source_index: i,
        type: 'xpost',
        url,
        url_clean: stripUtmParams(url),
        title: (x && typeof x === 'object' && (x.title || x.text)) || '',
        snippet: (x && typeof x === 'object' && (x.text || x.snippet)) || '',
        site_name: 'x.com',
        published_at: toIsoUtc(x && (x.createdAt || x.published_at)) || '',
        raw_json: toJsonCell(x)
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
    'type',
    'url',
    'url_clean',
    'title',
    'snippet',
    'site_name',
    'published_at',
    'raw_json'
  ];
  const rows = [headers.join(',')];
  for (const s of sources) {
    const enriched = {
      schema_version: SCHEMA_VERSIONS.grok_sources,
      extractor_version: EXTRACTOR_VERSION,
      platform: 'grok',
      ...s
    };
    rows.push(headers.map(h => escapeCSVField(enriched[h])).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}


// ============================================================================
// CSV D: CANONICAL MESSAGES (one row per message, cross-platform shape)
// ============================================================================

function generateMessagesCanonicalCSV(conversationData, { donorId, donorIdType, downloadTime, scrubCell = null }) {
  const headers = canonicalHeaders();
  const schemaVersion = SCHEMA_VERSIONS.grok_messages_canonical;
  const { messages, conversationId } = unwrap(conversationData);

  const rows = [headers.join(',')];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] || {};
    const rawText = messageText(m);
    const row = {
      donor_id: donorId,
      platform: 'grok',
      conversation_id: conversationId,
      message_id: messageId(m),
      parent_message_id: parentId(m),
      turn_index: i,
      role: normalizeRole(m.sender || m.role),
      text: rawText,
      text_cleaned: cleanText(rawText),
      created_at_iso: createdAt(m),
      model_identifier: m.model || m.modelName || '',
      schema_version: schemaVersion,
      extractor_version: EXTRACTOR_VERSION,
      platform_specific_json: JSON.stringify({
        donor_id_type: donorIdType,
        download_time: downloadTime,
        sender: m.sender || m.role || '',
        manual: m.manual === true,
        partial: m.partial === true,
        shared: m.shared === true,
        has_web_search: Array.isArray(m.webSearchResults) && m.webSearchResults.length > 0,
        has_attachments: Array.isArray(m.fileAttachments) && m.fileAttachments.length > 0,
        has_generated_images: Array.isArray(m.generatedImageUrls) && m.generatedImageUrls.length > 0,
        tools_used: Array.isArray(m.toolsUsed)
          ? m.toolsUsed.map(t => (typeof t === 'string' ? t : (t && t.name) || '')).filter(Boolean)
          : []
      })
    };
    // Optional per-cell scrubber (background.js passes one when PII scrubbing
    // is on) so the canonical file never carries text the other CSVs redact.
    rows.push(headers.map(h => escapeCSVField(scrubCell ? scrubCell(h, row[h]) : row[h])).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}


// ============================================================================
// MAIN EXPORT
// ============================================================================

function extractGrokConversation(conversationData, { donorId = '', donorIdType = '', downloadTime = '' } = {}) {
  if (!conversationData) {
    throw new Error('Invalid Grok conversation data');
  }

  const metadata = extractConversationMetadata(conversationData);
  metadata.donor_id = donorId;
  metadata.donor_id_type = donorIdType;
  metadata.download_time = downloadTime;

  const messages = extractConversationMessages(conversationData);
  for (const m of messages) {
    m.donor_id = donorId;
    m.donor_id_type = donorIdType;
    m.download_time = downloadTime;
  }

  const sources = extractSources(conversationData);
  for (const s of sources) {
    s.donor_id = donorId;
    s.donor_id_type = donorIdType;
    s.download_time = downloadTime;
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
  extractGrokConversation,
  extractConversationMetadata,
  extractConversationMessages,
  extractSources,
  generateMetadataCSV,
  generateMessagesCSV,
  generateSourcesCSV,
  generateMessagesCanonicalCSV
};
