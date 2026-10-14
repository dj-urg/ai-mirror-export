/**
 * AI Chat Exporter - Mistral (Le Chat / Vibe) Extractor Module
 *
 * Generates four CSV files from a Mistral conversation payload:
 *   CSV A: Conversation metadata     (one row per conversation)
 *   CSV B: Conversation messages     (one row per message)
 *   CSV C: Sources                   (one row per cited source)
 *   CSV D: Canonical messages        (cross-platform shape, one row per message)
 *
 * Input shape (assembled by content.js):
 *   {
 *     _captured_conversation_id: string,
 *     chat: {                         // from tRPC `chat.byId` (may be null)
 *       id, title, generatedTitle, userTitle, createdFrom, modelConfig,
 *       organizationId, projectId, pinned, visibility, productType,
 *       updatedAt, features, integrations, libraries, ...
 *     } | null,
 *     messages: [                     // from tRPC `message.all` (items array)
 *       {
 *         id, parentId, role, content, contentChunks, turn, createdAt,
 *         chatId, createdById, files, status, generationStatus, model,
 *         isAcceleratedAnswer, moderationCategory, moderationBlockedCategory,
 *         reaction, memories, followups, visibility, version, versionCount,
 *         prevVersion, nextVersion, references, quotedContent, reviewComments,
 *         workflowExecution, citedSources
 *       },
 *       ...
 *     ]
 *   }
 *
 * The API returns `messages` in newest-first order; we reverse them to turn
 * order (oldest-first) so the CSV reads top-to-bottom as the conversation
 * actually unfolded.
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
 * Pull { chat, messages, conversationId } out of the payload assembled by
 * content.js. Defensive against the chat half being missing (we still want
 * to export the messages).
 */
function unwrap(data) {
  if (!data || typeof data !== 'object') {
    return { chat: null, messages: [], conversationId: '' };
  }
  const chat = data.chat && typeof data.chat === 'object' ? data.chat : null;
  const rawMessages = Array.isArray(data.messages) ? data.messages : [];
  // Mistral's API returns newest-first; reverse to oldest-first for the CSV.
  // Secondary sort by `turn` so a batch that arrives slightly out of order
  // still ends up in conversational sequence.
  const messages = [...rawMessages].reverse();
  const conversationId =
    (typeof data._captured_conversation_id === 'string' && data._captured_conversation_id) ||
    (chat && chat.id) ||
    (messages[0] && messages[0].chatId) ||
    '';
  return { chat, messages, conversationId };
}

function normalizeRole(role) {
  if (!role) return '';
  const s = String(role).toLowerCase();
  if (s === 'user' || s === 'human') return 'user';
  if (s === 'assistant' || s === 'bot' || s === 'ai') return 'assistant';
  return s;
}

/**
 * Collect the user-visible answer text from a message. For assistant messages
 * Mistral provides a top-level `content` string that is the final rendered
 * answer (with resolved citation links). For user messages the chunks are
 * null and the content string holds the raw prompt. Prefer `content` as the
 * canonical display text and fall back to assembling non-reasoning text
 * chunks when it is missing. Reasoning chunks (`_context.type === 'reasoning'`)
 * are always excluded here; they belong in the `reasoning_text` column.
 */
function assembleDisplayText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  if (typeof msg.content === 'string' && msg.content.length > 0) return msg.content;
  const chunks = Array.isArray(msg.contentChunks) ? msg.contentChunks : null;
  if (chunks && chunks.length > 0) {
    const texts = chunks
      .filter(c => {
        if (!c || c.type !== 'text' || typeof c.text !== 'string') return false;
        const ctx = c._context && c._context.type;
        return ctx !== 'reasoning';
      })
      .map(c => c.text)
      // Dedupe adjacent identical chunks so streamed assistant replies that
      // emit the same text twice do not double the body.
      .filter((t, i, arr) => i === 0 || t !== arr[i - 1]);
    if (texts.length > 0) return texts.join('\n\n');
  }
  return '';
}

/**
 * Extract reasoning / thinking text. Mistral tags these chunks with
 * `_context.type === 'reasoning'`.
 */
function assembleReasoningText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const chunks = Array.isArray(msg.contentChunks) ? msg.contentChunks : null;
  if (!chunks || chunks.length === 0) return '';
  const parts = [];
  for (const c of chunks) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text' && c._context && c._context.type === 'reasoning' && typeof c.text === 'string') {
      parts.push(c.text);
    }
  }
  return parts.join('\n\n');
}

/**
 * Summarize the structured chunks on a message: types present, tool names
 * invoked, and chunk count. Also surfaces whether reasoning / tool_call /
 * search-result blocks were present so downstream analysts can filter.
 */
function summarizeChunks(msg) {
  const chunks = Array.isArray(msg && msg.contentChunks) ? msg.contentChunks : [];
  const types = new Set();
  const toolNames = [];
  let hasReasoning = false;
  for (const c of chunks) {
    if (!c || typeof c !== 'object') continue;
    const t = typeof c.type === 'string' ? c.type : '';
    if (t) types.add(t);
    if (t === 'tool_call' && typeof c.name === 'string' && c.name) toolNames.push(c.name);
    if (t === 'text' && c._context && c._context.type === 'reasoning') hasReasoning = true;
  }
  return {
    chunkCount: chunks.length,
    chunkTypes: Array.from(types),
    toolNames,
    hasReasoning,
    hasToolCall: types.has('tool_call'),
    hasSearchResult: types.has('afp_search_result') || types.has('search_result'),
    hasImage: types.has('image') || types.has('generated_image')
  };
}

function modelIdentifierFromChat(chat) {
  if (!chat || typeof chat !== 'object') return '';
  const mc = chat.modelConfig;
  if (!mc || typeof mc !== 'object') return '';
  return mc.model_alias || mc.model || '';
}


// ============================================================================
// CSV A: CONVERSATION METADATA
// ============================================================================

function extractConversationMetadata(data) {
  const { chat, messages, conversationId } = unwrap(data);

  let numUser = 0;
  let numAssistant = 0;
  let numWithToolCall = 0;
  let numWithReasoning = 0;
  let numWithSearch = 0;
  let numWithFiles = 0;
  let numCitedSources = 0;

  for (const m of messages) {
    const role = normalizeRole(m && m.role);
    if (role === 'user') numUser++;
    else if (role === 'assistant') numAssistant++;

    const summary = summarizeChunks(m);
    if (summary.hasToolCall) numWithToolCall++;
    if (summary.hasReasoning) numWithReasoning++;
    if (summary.hasSearchResult) numWithSearch++;
    if (Array.isArray(m && m.files) && m.files.length > 0) numWithFiles++;
    if (Array.isArray(m && m.citedSources)) numCitedSources += m.citedSources.length;
  }

  const title = (chat && (chat.userTitle || chat.generatedTitle || chat.title)) || '';
  return {
    conversation_id: conversationId,
    title,
    generated_title: (chat && chat.generatedTitle) || '',
    user_title: (chat && chat.userTitle) || '',
    product_type: (chat && chat.productType) || '',
    visibility: (chat && chat.visibility) || '',
    permission: (chat && chat.permission) || '',
    pinned: Boolean(chat && chat.pinned),
    created_at: toIsoUtc(chat && (chat.createdAt || chat.created_at)) || '',
    updated_at: toIsoUtc(chat && (chat.updatedAt || chat.updated_at)) || '',
    organization_id: (chat && chat.organizationId) || '',
    project_id: (chat && chat.projectId) || '',
    model_alias: modelIdentifierFromChat(chat),
    reasoning_effort: (chat && chat.modelConfig && chat.modelConfig.reasoning_effort) || '',
    features: Array.isArray(chat && chat.features) ? chat.features.join(',') : '',
    integrations: Array.isArray(chat && chat.integrations)
      ? chat.integrations.map(x => (typeof x === 'string' ? x : (x && x.name) || '')).filter(Boolean).join(',')
      : '',
    libraries: Array.isArray(chat && chat.libraries)
      ? chat.libraries.map(x => (typeof x === 'string' ? x : (x && x.name) || '')).filter(Boolean).join(',')
      : '',
    num_messages: messages.length,
    num_user_messages: numUser,
    num_assistant_messages: numAssistant,
    num_messages_with_tool_call: numWithToolCall,
    num_messages_with_reasoning: numWithReasoning,
    num_messages_with_search: numWithSearch,
    num_messages_with_files: numWithFiles,
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
    'generated_title',
    'user_title',
    'product_type',
    'visibility',
    'permission',
    'pinned',
    'created_at',
    'updated_at',
    'organization_id',
    'project_id',
    'model_alias',
    'reasoning_effort',
    'features',
    'integrations',
    'libraries',
    'num_messages',
    'num_user_messages',
    'num_assistant_messages',
    'num_messages_with_tool_call',
    'num_messages_with_reasoning',
    'num_messages_with_search',
    'num_messages_with_files',
    'num_cited_sources'
  ];
  const enriched = {
    schema_version: SCHEMA_VERSIONS.mistral_metadata,
    extractor_version: EXTRACTOR_VERSION,
    ...metadata
  };
  const row = headers.map(h => escapeCSVField(enriched[h]));
  return [headers.join(','), row.join(',')].join('\r\n') + '\r\n';
}


// ============================================================================
// CSV B: CONVERSATION MESSAGES (one row per message)
// ============================================================================

function extractConversationMessages(data) {
  const { chat, messages, conversationId } = unwrap(data);
  const defaultModel = modelIdentifierFromChat(chat);
  const rows = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] || {};
    const summary = summarizeChunks(m);
    const text = assembleDisplayText(m);
    const reasoning = assembleReasoningText(m);
    rows.push({
      conversation_id: conversationId,
      message_id: m.id || '',
      parent_message_id: m.parentId || '',
      turn_index: typeof m.turn === 'number' ? m.turn : i,
      role: normalizeRole(m.role),
      text,
      text_cleaned: cleanText(text),
      reasoning_text: reasoning,
      reasoning_text_cleaned: cleanText(reasoning),
      model_identifier: (typeof m.model === 'string' && m.model) ? m.model : defaultModel,
      created_at: toIsoUtc(m.createdAt) || '',
      status: m.status || '',
      generation_status: m.generationStatus || '',
      moderation_category: m.moderationCategory || '',
      moderation_blocked_category: m.moderationBlockedCategory || '',
      reaction: m.reaction || '',
      visibility: m.visibility || '',
      is_accelerated_answer: Boolean(m.isAcceleratedAnswer),
      agent_id: m.agentId || m.agentsApiAgentId || '',
      version: typeof m.version === 'number' ? m.version : '',
      version_count: typeof m.versionCount === 'number' ? m.versionCount : '',
      chunk_count: summary.chunkCount,
      chunk_types: summary.chunkTypes.join(','),
      tool_names: summary.toolNames.join(','),
      has_reasoning: summary.hasReasoning,
      has_tool_call: summary.hasToolCall,
      has_search_result: summary.hasSearchResult,
      has_files: Array.isArray(m.files) && m.files.length > 0,
      cited_source_count: Array.isArray(m.citedSources) ? m.citedSources.length : 0,
      content_chunks_json: toJsonCell(m.contentChunks),
      files_json: toJsonCell(m.files),
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
    'text',
    'text_cleaned',
    'reasoning_text',
    'reasoning_text_cleaned',
    'model_identifier',
    'created_at',
    'status',
    'generation_status',
    'moderation_category',
    'moderation_blocked_category',
    'reaction',
    'visibility',
    'is_accelerated_answer',
    'agent_id',
    'version',
    'version_count',
    'chunk_count',
    'chunk_types',
    'tool_names',
    'has_reasoning',
    'has_tool_call',
    'has_search_result',
    'has_files',
    'cited_source_count',
    'content_chunks_json',
    'files_json',
    'raw_message_json'
  ];
  const rows = [headers.join(',')];
  for (const m of messages) {
    const enriched = {
      schema_version: SCHEMA_VERSIONS.mistral_messages,
      extractor_version: EXTRACTOR_VERSION,
      ...m
    };
    rows.push(headers.map(h => escapeCSVField(enriched[h])).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}


// ============================================================================
// CSV C: SOURCES — citedSources + tool-call search results
// ============================================================================

function extractSources(data) {
  const { messages, conversationId } = unwrap(data);
  const rows = [];

  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const messageId = m.id || '';

    // Mistral surfaces citations in two places:
    //   1. `citedSources` on the message — the primary, deduped citation list.
    //   2. Inline `tool_call.publicResult.results` inside contentChunks when
    //      the model invoked a search tool. These are the raw search hits
    //      before the model picked which ones to cite.
    const cited = Array.isArray(m.citedSources) ? m.citedSources : [];
    for (let i = 0; i < cited.length; i++) {
      const s = cited[i] || {};
      const url = s.url || '';
      rows.push({
        conversation_id: conversationId,
        message_id: messageId,
        source_list: 'cited',
        source_index: i,
        source_id: s.id || '',
        type: s.type || s.source || '',
        url,
        url_clean: stripUtmParams(url),
        title: s.title || '',
        snippet: s.description || s.snippet || '',
        site_name: s.source || '',
        published_at: toIsoUtc(s.date) || '',
        tool_name: '',
        raw_json: toJsonCell(s)
      });
    }

    // Search-tool results surfaced in content chunks. These are shaped as
    //   { type: 'tool_call', name: 'news_search', publicResult: { results: [...] } }
    // where each result has { id, url, title, source, date, description }.
    const chunks = Array.isArray(m.contentChunks) ? m.contentChunks : [];
    for (const c of chunks) {
      if (!c || c.type !== 'tool_call') continue;
      const name = typeof c.name === 'string' ? c.name : '';
      const pr = c.publicResult;
      if (!pr || typeof pr !== 'object') continue;
      // publicResult can be a stringified payload (search_tool_functions) or
      // an object with a results array. We only harvest the results-array shape.
      const results = Array.isArray(pr.results) ? pr.results : null;
      if (!results) continue;
      for (let i = 0; i < results.length; i++) {
        const r = results[i] || {};
        const url = r.url || '';
        rows.push({
          conversation_id: conversationId,
          message_id: messageId,
          source_list: 'tool_call',
          source_index: i,
          source_id: r.id || '',
          type: r.type || r.source || '',
          url,
          url_clean: stripUtmParams(url),
          title: r.title || '',
          snippet: r.description || r.snippet || '',
          site_name: r.source || '',
          published_at: toIsoUtc(r.date) || '',
          tool_name: name,
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
    'source_list',
    'source_index',
    'source_id',
    'type',
    'url',
    'url_clean',
    'title',
    'snippet',
    'site_name',
    'published_at',
    'tool_name',
    'raw_json'
  ];
  const rows = [headers.join(',')];
  for (const s of sources) {
    const enriched = {
      schema_version: SCHEMA_VERSIONS.mistral_sources,
      extractor_version: EXTRACTOR_VERSION,
      platform: 'mistral',
      ...s
    };
    rows.push(headers.map(h => escapeCSVField(enriched[h])).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}


// ============================================================================
// CSV D: CANONICAL MESSAGES
// ============================================================================

function generateMessagesCanonicalCSV(data, { donorId, donorIdType, downloadTime }) {
  const headers = canonicalHeaders();
  const schemaVersion = SCHEMA_VERSIONS.mistral_messages_canonical;
  const { chat, messages, conversationId } = unwrap(data);
  const defaultModel = modelIdentifierFromChat(chat);

  const rows = [headers.join(',')];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] || {};
    const text = assembleDisplayText(m);
    const summary = summarizeChunks(m);
    const row = {
      donor_id: donorId,
      platform: 'mistral',
      conversation_id: conversationId,
      message_id: m.id || '',
      parent_message_id: m.parentId || '',
      turn_index: typeof m.turn === 'number' ? m.turn : i,
      role: normalizeRole(m.role),
      text,
      text_cleaned: cleanText(text),
      created_at_iso: toIsoUtc(m.createdAt) || '',
      model_identifier: (typeof m.model === 'string' && m.model) ? m.model : defaultModel,
      schema_version: schemaVersion,
      extractor_version: EXTRACTOR_VERSION,
      platform_specific_json: JSON.stringify({
        donor_id_type: donorIdType,
        download_time: downloadTime,
        status: m.status || '',
        generation_status: m.generationStatus || '',
        moderation_category: m.moderationCategory || '',
        reaction: m.reaction || '',
        is_accelerated_answer: Boolean(m.isAcceleratedAnswer),
        has_reasoning: summary.hasReasoning,
        has_tool_call: summary.hasToolCall,
        has_search_result: summary.hasSearchResult,
        has_files: Array.isArray(m.files) && m.files.length > 0,
        chunk_types: summary.chunkTypes,
        tool_names: summary.toolNames,
        version: typeof m.version === 'number' ? m.version : null,
        version_count: typeof m.versionCount === 'number' ? m.versionCount : null,
        product_type: (chat && chat.productType) || ''
      })
    };
    rows.push(headers.map(h => escapeCSVField(row[h])).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}


// ============================================================================
// MAIN EXPORT
// ============================================================================

function extractMistralConversation(conversationData, { donorId = '', donorIdType = '', downloadTime = '' } = {}) {
  if (!conversationData) {
    throw new Error('Invalid Mistral conversation data');
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
  extractMistralConversation,
  extractConversationMetadata,
  extractConversationMessages,
  extractSources,
  generateMetadataCSV,
  generateMessagesCSV,
  generateSourcesCSV,
  generateMessagesCanonicalCSV
};
