/**
 * AI Chat Exporter - DeepSeek Extractor Module
 *
 * Generates four CSV files from a DeepSeek conversation JSON:
 *   CSV A: Conversation metadata     (one row per conversation)
 *   CSV B: Conversation messages     (one row per message)
 *   CSV C: Sources                   (one row per web-search result)
 *   CSV D: Canonical messages        (cross-platform shape)
 *
 * DeepSeek's REST API wraps the conversation payload under
 *   { data: { biz_code, biz_data: { chat_session, chat_messages, ... } } }
 *
 * Each message carries a `fragments` array. The user turn surfaces as a
 * REQUEST fragment with the question in `content`; the assistant turn can
 * carry multiple fragments: RESPONSE/TEMPLATE_RESPONSE (final answer),
 * THINK (chain-of-thought), SEARCH / TOOL_SEARCH (web search results),
 * TOOL_OPEN / TOOL_FIND, READ_LINK, FILE, TIP. The full message object is
 * preserved in `raw_message_json` so new fragment types don't get silently
 * dropped.
 */

import { escapeCSVField } from '../../utils/csv.js';
import {
  SCHEMA_VERSIONS,
  EXTRACTOR_VERSION,
  canonicalHeaders,
  toIsoUtc
} from '../../utils/manifest.js';
import { cleanText } from '../../utils/text_cleaner.js';


// ============================================================================
// HELPERS
// ============================================================================

const RESPONSE_TYPES = new Set(['RESPONSE', 'TEMPLATE_RESPONSE']);
const SEARCH_FRAG_TYPES = new Set(['SEARCH', 'TOOL_SEARCH']);
const TOOL_FRAG_TYPES = new Set(['TOOL_SEARCH', 'TOOL_OPEN', 'TOOL_FIND']);
const FILE_FRAG_TYPES = new Set(['FILE']);

function stripUtmParams(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']
      .forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch {
    return url;
  }
}

function toJsonCell(value) {
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * Unwrap the response shape into { conv, messages, conversationId }, where
 * `conv` is the chat_session object (nullable), `messages` is the flat list
 * of message objects, and `conversationId` is the UUID stamped by the content
 * script from the request URL (DeepSeek's biz_data may omit it on cache-delta
 * replies).
 */
function unwrap(data) {
  if (!data || typeof data !== 'object') {
    return { conv: null, messages: [], conversationId: '' };
  }

  const stampedId = typeof data._captured_conversation_id === 'string'
    ? data._captured_conversation_id
    : '';

  const biz = data.data && data.data.biz_data
    ? data.data.biz_data
    : (data.biz_data || data);

  const conv = (biz && typeof biz.chat_session === 'object') ? biz.chat_session : null;
  const messages = Array.isArray(biz && biz.chat_messages) ? biz.chat_messages : [];
  const conversationId = stampedId || (conv && conv.id) || '';

  return { conv, messages, conversationId };
}

/**
 * Normalize DeepSeek's role vocabulary to the canonical shape used across
 * platforms. DeepSeek sends uppercase roles (`USER`, `ASSISTANT`).
 */
function normalizeRole(role) {
  if (!role) return '';
  const r = String(role).toLowerCase();
  if (r === 'user' || r === 'human') return 'user';
  if (r === 'assistant' || r === 'bot' || r === 'ai') return 'assistant';
  if (r === 'system') return 'system';
  return r;
}

// DeepSeek message ids / parent ids / fragment ids are integers in the API
// payload. Stringify everywhere so the CSV and validators (which expect
// strings) stay consistent.
function messageId(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const id = msg.message_id;
  if (id === null || id === undefined) return '';
  return String(id);
}

function parentId(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const id = msg.parent_id;
  if (id === null || id === undefined) return '';
  return String(id);
}

function stringifyId(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

/**
 * Pull the final-answer text off a DeepSeek message. For user turns the text
 * lives in a REQUEST fragment; for assistant turns it is the concatenated
 * content of RESPONSE / TEMPLATE_RESPONSE fragments. THINK fragments are
 * returned separately (see thinkingText).
 */
function messageText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const role = normalizeRole(msg.role);
  const fragments = Array.isArray(msg.fragments) ? msg.fragments : [];

  if (role === 'user') {
    const req = fragments.find(f => f && f.type === 'REQUEST');
    if (req && typeof req.content === 'string') return req.content;
    // Fallback: concatenate all string `content` fields in order.
    return fragments
      .map(f => (f && typeof f.content === 'string') ? f.content : '')
      .filter(Boolean)
      .join('\n');
  }

  const parts = fragments
    .filter(f => f && RESPONSE_TYPES.has(f.type) && typeof f.content === 'string')
    .map(f => f.content);
  if (parts.length) return parts.join('\n');

  // No main response — fall back to any first-fragment content.
  const first = fragments.find(f => f && typeof f.content === 'string' && f.content);
  return first ? first.content : '';
}

function thinkingText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const fragments = Array.isArray(msg.fragments) ? msg.fragments : [];
  const parts = fragments
    .filter(f => f && f.type === 'THINK' && typeof f.content === 'string')
    .map(f => f.content);
  return parts.join('\n');
}

function createdAt(msg) {
  if (!msg || typeof msg !== 'object') return '';
  return toIsoUtc(msg.inserted_at) || '';
}

function sessionUpdatedAt(conv) {
  if (!conv || typeof conv !== 'object') return '';
  // The web UI multiplies updated_at by 1000, so the raw value is in seconds.
  return toIsoUtc(conv.updated_at) || '';
}

function countFragmentsOfTypes(msg, typeSet) {
  if (!msg || typeof msg !== 'object') return 0;
  const fragments = Array.isArray(msg.fragments) ? msg.fragments : [];
  return fragments.filter(f => f && typeSet.has(f.type)).length;
}

function collectSearchFragments(msg) {
  if (!msg || typeof msg !== 'object') return [];
  const fragments = Array.isArray(msg.fragments) ? msg.fragments : [];
  return fragments.filter(f => f && SEARCH_FRAG_TYPES.has(f.type));
}


// ============================================================================
// CSV A: CONVERSATION METADATA
// ============================================================================

function extractConversationMetadata(conversationData) {
  const { conv, messages, conversationId } = unwrap(conversationData);

  let numUser = 0;
  let numAssistant = 0;
  let numWithSearch = 0;
  let numWithThinking = 0;
  let numWithFiles = 0;

  for (const m of messages) {
    const role = normalizeRole(m?.role);
    if (role === 'user') numUser++;
    else if (role === 'assistant') numAssistant++;

    if (m?.search_enabled === true || collectSearchFragments(m).length > 0) numWithSearch++;
    if (m?.thinking_enabled === true || countFragmentsOfTypes(m, new Set(['THINK'])) > 0) numWithThinking++;
    if (countFragmentsOfTypes(m, FILE_FRAG_TYPES) > 0) numWithFiles++;
  }

  return {
    conversation_id: conversationId,
    title: (conv && conv.title) || '',
    title_type: (conv && conv.title_type) || '',
    model_type: (conv && conv.model_type) || '',
    pinned: Boolean(conv && conv.pinned),
    version: (conv && typeof conv.version === 'number') ? conv.version : '',
    updated_at: sessionUpdatedAt(conv),
    num_messages: messages.length,
    num_user_messages: numUser,
    num_assistant_messages: numAssistant,
    num_messages_with_search: numWithSearch,
    num_messages_with_thinking: numWithThinking,
    num_messages_with_files: numWithFiles
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
    'title_type',
    'model_type',
    'pinned',
    'version',
    'updated_at',
    'num_messages',
    'num_user_messages',
    'num_assistant_messages',
    'num_messages_with_search',
    'num_messages_with_thinking',
    'num_messages_with_files'
  ];
  const enriched = {
    schema_version: SCHEMA_VERSIONS.deepseek_metadata,
    extractor_version: EXTRACTOR_VERSION,
    ...metadata
  };
  const row = headers.map(h => escapeCSVField(enriched[h]));
  return [headers.join(','), row.join(',')].join('\r\n') + '\r\n';
}


// ============================================================================
// CSV B: CONVERSATION MESSAGES
// ============================================================================

function extractConversationMessages(conversationData) {
  const { messages, conversationId } = unwrap(conversationData);

  const rows = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] || {};
    const rawText = messageText(m);
    const think = thinkingText(m);
    const fragments = Array.isArray(m.fragments) ? m.fragments : [];
    const fragmentTypes = fragments
      .map(f => (f && typeof f.type === 'string') ? f.type : '')
      .filter(Boolean);

    rows.push({
      conversation_id: conversationId,
      message_id: messageId(m),
      parent_message_id: parentId(m),
      turn_index: i,
      role: normalizeRole(m.role),
      sender: m.role || '',
      text: rawText,
      text_cleaned: cleanText(rawText),
      thinking_text: think,
      thinking_text_cleaned: think ? cleanText(think) : '',
      model: m.model || '',
      created_at: createdAt(m),
      status: m.status || '',
      quasi_status: m.quasi_status || '',
      conversation_mode: m.conversation_mode || '',
      search_enabled: m.search_enabled === true,
      search_triggered: m.search_triggered === true,
      thinking_enabled: m.thinking_enabled === true,
      ban_regenerate: m.ban_regenerate === true,
      has_pending_fragment: m.has_pending_fragment === true,
      has_search_fragment: collectSearchFragments(m).length > 0,
      has_tool_fragment: countFragmentsOfTypes(m, TOOL_FRAG_TYPES) > 0,
      has_file_fragment: countFragmentsOfTypes(m, FILE_FRAG_TYPES) > 0,
      fragment_count: fragments.length,
      fragment_types: fragmentTypes.join(','),
      incomplete_message: m.incomplete_message ? String(m.incomplete_message) : '',
      feedback_json: toJsonCell(m.feedback),
      token_usage_json: toJsonCell(m.accumulated_token_usage),
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
    'role',
    'sender',
    'text',
    'text_cleaned',
    'thinking_text',
    'thinking_text_cleaned',
    'model',
    'created_at',
    'status',
    'quasi_status',
    'conversation_mode',
    'search_enabled',
    'search_triggered',
    'thinking_enabled',
    'ban_regenerate',
    'has_pending_fragment',
    'has_search_fragment',
    'has_tool_fragment',
    'has_file_fragment',
    'fragment_count',
    'fragment_types',
    'incomplete_message',
    'feedback_json',
    'token_usage_json',
    'raw_message_json'
  ];
  const rows = [headers.join(',')];
  for (const m of messages) {
    const enriched = {
      schema_version: SCHEMA_VERSIONS.deepseek_messages,
      extractor_version: EXTRACTOR_VERSION,
      ...m
    };
    rows.push(headers.map(h => escapeCSVField(enriched[h])).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}


// ============================================================================
// CSV C: SOURCES — web search results surfaced by SEARCH / TOOL_SEARCH fragments
// ============================================================================

function extractSources(conversationData) {
  const { messages, conversationId } = unwrap(conversationData);
  const rows = [];

  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const msgId = messageId(m);
    const fragments = Array.isArray(m.fragments) ? m.fragments : [];

    for (let fi = 0; fi < fragments.length; fi++) {
      const frag = fragments[fi];
      if (!frag || !SEARCH_FRAG_TYPES.has(frag.type)) continue;

      // DeepSeek carries results under either `search_results` (TOOL_SEARCH)
      // or `references` (SEARCH); accept both to be forward-compatible.
      const results =
        (Array.isArray(frag.search_results) && frag.search_results) ||
        (Array.isArray(frag.results) && frag.results) ||
        (Array.isArray(frag.references) && frag.references) ||
        [];

      for (let i = 0; i < results.length; i++) {
        const r = results[i] || {};
        const url = r.url || r.link || '';
        rows.push({
          conversation_id: conversationId,
          message_id: msgId,
          fragment_id: stringifyId(frag.id),
          fragment_type: frag.type || '',
          source_index: i,
          cite_index: typeof r.cite_index === 'number' ? r.cite_index : '',
          url,
          url_clean: stripUtmParams(url),
          title: r.title || '',
          snippet: r.snippet || r.description || '',
          site_name: r.site_name || r.siteName || r.domain || '',
          provider: r.provider || '',
          published_at: toIsoUtc(r.published_at || r.publishedAt) || '',
          raw_json: toJsonCell(r)
        });
      }
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
    'fragment_id',
    'fragment_type',
    'source_index',
    'cite_index',
    'url',
    'url_clean',
    'title',
    'snippet',
    'site_name',
    'provider',
    'published_at',
    'raw_json'
  ];
  const rows = [headers.join(',')];
  for (const s of sources) {
    const enriched = {
      schema_version: SCHEMA_VERSIONS.deepseek_sources,
      extractor_version: EXTRACTOR_VERSION,
      platform: 'deepseek',
      ...s
    };
    rows.push(headers.map(h => escapeCSVField(enriched[h])).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}


// ============================================================================
// CSV D: CANONICAL MESSAGES
// ============================================================================

function generateMessagesCanonicalCSV(conversationData, { donorId, donorIdType, downloadTime }) {
  const headers = canonicalHeaders();
  const schemaVersion = SCHEMA_VERSIONS.deepseek_messages_canonical;
  const { messages, conversationId } = unwrap(conversationData);

  const rows = [headers.join(',')];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] || {};
    const rawText = messageText(m);
    const think = thinkingText(m);
    const row = {
      donor_id: donorId,
      platform: 'deepseek',
      conversation_id: conversationId,
      message_id: messageId(m),
      parent_message_id: parentId(m),
      turn_index: i,
      role: normalizeRole(m.role),
      text: rawText,
      text_cleaned: cleanText(rawText),
      created_at_iso: createdAt(m),
      model_identifier: m.model || '',
      schema_version: schemaVersion,
      extractor_version: EXTRACTOR_VERSION,
      platform_specific_json: JSON.stringify({
        donor_id_type: donorIdType,
        download_time: downloadTime,
        sender: m.role || '',
        thinking_text: think,
        status: m.status || '',
        conversation_mode: m.conversation_mode || '',
        search_enabled: m.search_enabled === true,
        search_triggered: m.search_triggered === true,
        thinking_enabled: m.thinking_enabled === true,
        has_search_fragment: collectSearchFragments(m).length > 0,
        has_tool_fragment: countFragmentsOfTypes(m, TOOL_FRAG_TYPES) > 0,
        has_file_fragment: countFragmentsOfTypes(m, FILE_FRAG_TYPES) > 0
      })
    };
    rows.push(headers.map(h => escapeCSVField(row[h])).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}


// ============================================================================
// MAIN EXPORT
// ============================================================================

function extractDeepSeekConversation(conversationData, { donorId = '', donorIdType = '', downloadTime = '' } = {}) {
  if (!conversationData) {
    throw new Error('Invalid DeepSeek conversation data');
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
  extractDeepSeekConversation,
  extractConversationMetadata,
  extractConversationMessages,
  extractSources,
  generateMetadataCSV,
  generateMessagesCSV,
  generateSourcesCSV,
  generateMessagesCanonicalCSV
};
