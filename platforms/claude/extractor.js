/**
 * AI Chat Exporter - Claude Extractor Module
 *
 * Generates five CSV files from a Claude conversation JSON:
 *   CSV A: Conversation metadata     (one row per conversation)
 *   CSV B: Conversation messages     (one row per content block within a message)
 *   CSV C: Sources                   (one row per citation across all blocks)
 *   CSV D: Attachments               (one row per attachment/file/sync_source)
 *   CSV E: Canonical messages        (one row per message, cross-platform shape)
 *
 * Design notes:
 * - Messages are emitted at content-block grain, so a single assistant message
 *   with [thinking, tool_use, text] becomes three rows. This preserves
 *   per-block timestamps and lets non-text blocks (thinking, tool_use,
 *   tool_result) travel to the CSV without being silently dropped.
 * - The canonical CSV stays at message grain for cross-platform concat with
 *   ChatGPT, concatenating text from every block in the message.
 * - Any block fields the extractor doesn't name explicitly land in
 *   `raw_block_json` so new Claude content types don't silently disappear.
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
 * Extract the text payload from a single content block based on its type.
 * Non-text block types return '' so their row still exists in the CSV but the
 * text column stays empty; downstream analysts filter by content_type instead.
 */
function extractBlockText(block) {
  if (!block || typeof block !== 'object') return '';
  const type = block.type;

  if (type === 'text') {
    return typeof block.text === 'string' ? block.text : '';
  }

  if (type === 'thinking') {
    // Claude's extended-thinking payload lives on `thinking`; some variants
    // also use `text`. Prefer thinking, fall back to text.
    if (typeof block.thinking === 'string') return block.thinking;
    if (typeof block.text === 'string') return block.text;
    return '';
  }

  if (type === 'tool_use') {
    // tool_use carries structured input, not display text. Keep text empty;
    // tool_name / tool_input_json columns surface the structured payload.
    return '';
  }

  if (type === 'tool_result') {
    // tool_result.content can be a string, or an array of content blocks.
    const content = block.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map(sub => (sub && sub.type === 'text' && typeof sub.text === 'string') ? sub.text : '')
        .filter(Boolean)
        .join('\n\n');
    }
    return '';
  }

  // Defensive fallback: any future block type with a `.text` string gets its
  // text surfaced; otherwise '' and the raw_block_json column preserves the
  // original payload.
  if (typeof block.text === 'string') return block.text;
  return '';
}

/**
 * Claude's web API sends extended thinking as `thinking: ""` with
 * `thinking_hidden: true` and a `summaries[]` list; the full reasoning text
 * is not exposed, only these summaries (verified on real captures,
 * 2026-10-14). Join them so they land in their own column.
 */
function thinkingSummary(block) {
  if (!block || block.type !== 'thinking') return '';
  const parts = Array.isArray(block.summaries)
    ? block.summaries.map(s => (s && typeof s.summary === 'string') ? s.summary : '').filter(Boolean)
    : [];
  if (parts.length === 0 && typeof block.summary === 'string') parts.push(block.summary);
  return parts.join('\n\n');
}

/**
 * The set of message uuids on the conversation's visible path: the chain
 * from `current_leaf_message_uuid` up through `parent_message_uuid`. Claude
 * exports every branch (edited prompts and regenerated answers); this lets
 * researchers filter to what the user last saw. Returns null when the
 * payload carries no leaf, in which case every message counts as visible.
 */
function visiblePathSet(conversationData) {
  const messages = Array.isArray(conversationData.chat_messages) ? conversationData.chat_messages : [];
  const leaf = conversationData.current_leaf_message_uuid;
  const byId = new Map();
  for (const m of messages) if (m && typeof m.uuid === 'string') byId.set(m.uuid, m);
  if (typeof leaf !== 'string' || !byId.has(leaf)) return null;
  const path = new Set();
  let cur = byId.get(leaf);
  let guard = 0;
  while (cur && !path.has(cur.uuid) && guard++ < 100000) {
    path.add(cur.uuid);
    cur = typeof cur.parent_message_uuid === 'string' ? byId.get(cur.parent_message_uuid) : null;
  }
  return path;
}

function isOnVisiblePath(pathSet, uuid) {
  return pathSet === null ? true : pathSet.has(uuid);
}

/**
 * Collect per-content-block rows from one Claude message.
 */
function flattenMessageBlocks(msg) {
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  if (blocks.length === 0) {
    // Preserve messages that have no content blocks (edge case) as a single
    // empty-text row so they still appear in the CSV.
    return [{
      block_index: 0,
      content_type: '',
      text: typeof msg.text === 'string' ? msg.text : '',
      thinking_summary: '',
      tool_name: '',
      tool_input_json: '',
      tool_use_id: '',
      block_start_timestamp: '',
      block_stop_timestamp: '',
      raw_block_json: ''
    }];
  }

  return blocks.map((block, idx) => {
    const contentType = block && typeof block.type === 'string' ? block.type : '';
    return {
      block_index: idx,
      content_type: contentType,
      text: extractBlockText(block),
      thinking_summary: thinkingSummary(block),
      tool_name: contentType === 'tool_use' ? (block.name || '') : '',
      tool_input_json: contentType === 'tool_use' ? toJsonCell(block.input) : '',
      tool_use_id: (contentType === 'tool_use' || contentType === 'tool_result')
        ? (block.id || block.tool_use_id || '')
        : '',
      block_start_timestamp: toIsoUtc(block.start_timestamp) || '',
      block_stop_timestamp: toIsoUtc(block.stop_timestamp) || '',
      raw_block_json: toJsonCell(block)
    };
  });
}


// ============================================================================
// CSV A: CONVERSATION METADATA
// ============================================================================

function extractConversationMetadata(conversationData) {
  const messages = Array.isArray(conversationData.chat_messages) ? conversationData.chat_messages : [];

  let numUser = 0;
  let numAssistant = 0;
  let numText = 0;
  let numThinking = 0;
  let numToolUse = 0;
  let numToolResult = 0;

  for (const msg of messages) {
    if (msg?.sender === 'human') numUser++;
    else if (msg?.sender === 'assistant') numAssistant++;

    const blocks = Array.isArray(msg?.content) ? msg.content : [];
    for (const b of blocks) {
      const t = b && b.type;
      if (t === 'text') numText++;
      else if (t === 'thinking') numThinking++;
      else if (t === 'tool_use') numToolUse++;
      else if (t === 'tool_result') numToolResult++;
    }
  }

  const settings = conversationData.settings || {};

  return {
    conversation_id: conversationData.uuid || '',
    conversation_name: conversationData.name || '',
    summary: conversationData.summary || '',
    created_at: toIsoUtc(conversationData.created_at) || conversationData.created_at || '',
    updated_at: toIsoUtc(conversationData.updated_at) || conversationData.updated_at || '',
    enabled_web_search: Boolean(settings.enabled_web_search),
    enabled_monkeys_in_a_barrel: Boolean(settings.enabled_monkeys_in_a_barrel),
    preview_feature_uses_artifacts: Boolean(settings.preview_feature_uses_artifacts),
    settings_json: toJsonCell(settings),
    is_starred: Boolean(conversationData.is_starred),
    is_temporary: Boolean(conversationData.is_temporary),
    current_leaf_message_uuid: conversationData.current_leaf_message_uuid || '',
    num_messages: messages.length,
    num_user_messages: numUser,
    num_assistant_messages: numAssistant,
    num_text_blocks: numText,
    num_thinking_blocks: numThinking,
    num_tool_use_blocks: numToolUse,
    num_tool_result_blocks: numToolResult
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
    'conversation_name',
    'summary',
    'created_at',
    'updated_at',
    'enabled_web_search',
    'enabled_monkeys_in_a_barrel',
    'preview_feature_uses_artifacts',
    'settings_json',
    'is_starred',
    'is_temporary',
    'current_leaf_message_uuid',
    'num_messages',
    'num_user_messages',
    'num_assistant_messages',
    'num_text_blocks',
    'num_thinking_blocks',
    'num_tool_use_blocks',
    'num_tool_result_blocks'
  ];
  const enriched = {
    schema_version: SCHEMA_VERSIONS.claude_metadata,
    extractor_version: EXTRACTOR_VERSION,
    ...metadata
  };
  const row = headers.map(h => escapeCSVField(enriched[h]));
  return [headers.join(','), row.join(',')].join('\r\n') + '\r\n';
}


// ============================================================================
// CSV B: CONVERSATION MESSAGES (one row per content block)
// ============================================================================

function extractConversationMessages(conversationData) {
  const rows = [];
  const conversationId = conversationData.uuid || '';
  const messages = Array.isArray(conversationData.chat_messages) ? conversationData.chat_messages : [];
  const visible = visiblePathSet(conversationData);

  for (const msg of messages) {
    const blockRows = flattenMessageBlocks(msg);
    for (const b of blockRows) {
      rows.push({
        conversation_id: conversationId,
        message_id: msg.uuid || '',
        parent_message_id: msg.parent_message_uuid || '',
        message_index: typeof msg.index === 'number' ? msg.index : '',
        block_index: b.block_index,
        sender: msg.sender || '',
        content_type: b.content_type,
        text: b.text,
        text_cleaned: cleanText(b.text),
        thinking_summary: b.thinking_summary,
        tool_name: b.tool_name,
        tool_input_json: b.tool_input_json,
        tool_use_id: b.tool_use_id,
        block_start_timestamp: b.block_start_timestamp,
        block_stop_timestamp: b.block_stop_timestamp,
        message_created_at: toIsoUtc(msg.created_at) || msg.created_at || '',
        message_updated_at: toIsoUtc(msg.updated_at) || msg.updated_at || '',
        message_truncated: Boolean(msg.truncated),
        message_stop_reason: msg.stop_reason || '',
        thinking_mode: typeof msg.thinking_mode === 'string' ? msg.thinking_mode : '',
        on_visible_path: isOnVisiblePath(visible, msg.uuid),
        raw_block_json: b.raw_block_json
      });
    }
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
    'message_index',
    'block_index',
    'sender',
    'content_type',
    'text',
    'text_cleaned',
    'thinking_summary',
    'tool_name',
    'tool_input_json',
    'tool_use_id',
    'block_start_timestamp',
    'block_stop_timestamp',
    'message_created_at',
    'message_updated_at',
    'message_truncated',
    'message_stop_reason',
    'thinking_mode',
    'on_visible_path',
    'raw_block_json'
  ];
  const rows = [headers.join(',')];
  for (const m of messages) {
    const enriched = {
      schema_version: SCHEMA_VERSIONS.claude_messages,
      extractor_version: EXTRACTOR_VERSION,
      ...m
    };
    rows.push(headers.map(h => escapeCSVField(enriched[h])).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}


// ============================================================================
// CSV C: SOURCES (citations across all content blocks)
// ============================================================================

function extractSources(conversationData) {
  const rows = [];
  const conversationId = conversationData.uuid || '';
  const messages = Array.isArray(conversationData.chat_messages) ? conversationData.chat_messages : [];

  for (const msg of messages) {
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
      const block = blocks[bIdx];
      const citations = Array.isArray(block?.citations) ? block.citations : [];
      for (const cite of citations) {
        // Citation shape varies: web_search_result_location, char_location,
        // page_location, etc. Pull known fields defensively and keep raw.
        const url = cite?.url || cite?.source || '';
        rows.push({
          conversation_id: conversationId,
          message_id: msg.uuid || '',
          block_index: bIdx,
          source_list: 'citation',
          type: cite?.type || '',
          url,
          url_clean: stripUtmParams(url),
          title: cite?.title || cite?.document_title || '',
          snippet: cite?.cited_text || cite?.excerpt || '',
          start_index: cite?.start_char_index ?? cite?.start_block_index ?? cite?.start_page_number ?? '',
          end_index: cite?.end_char_index ?? cite?.end_block_index ?? cite?.end_page_number ?? '',
          raw_json: toJsonCell(cite)
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
    'block_index',
    'source_list',
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
  for (const s of sources) {
    const enriched = {
      schema_version: SCHEMA_VERSIONS.claude_sources,
      extractor_version: EXTRACTOR_VERSION,
      platform: 'claude',
      ...s
    };
    rows.push(headers.map(h => escapeCSVField(enriched[h])).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}


// ============================================================================
// CSV D: ATTACHMENTS (user uploads + synced sources)
// ============================================================================

function extractAttachments(conversationData) {
  const rows = [];
  const conversationId = conversationData.uuid || '';
  const messages = Array.isArray(conversationData.chat_messages) ? conversationData.chat_messages : [];

  const sourceFields = ['attachments', 'files', 'files_v2', 'sync_sources'];

  for (const msg of messages) {
    for (const field of sourceFields) {
      const items = Array.isArray(msg[field]) ? msg[field] : [];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        rows.push({
          conversation_id: conversationId,
          message_id: msg.uuid || '',
          source: field,
          file_uuid: item.id || item.file_uuid || item.uuid || '',
          file_name: item.file_name || item.name || item.filename || '',
          file_type: item.file_type || item.type || item.mime_type || item.media_type || '',
          file_size: typeof item.file_size === 'number'
            ? item.file_size
            : (typeof item.size === 'number' ? item.size : ''),
          extracted_text: typeof item.extracted_content === 'string'
            ? item.extracted_content
            : (typeof item.text === 'string' ? item.text : ''),
          raw_json: toJsonCell(item)
        });
      }
    }
  }
  return rows;
}

function generateAttachmentsCSV(attachments) {
  const headers = [
    'schema_version',
    'extractor_version',
    'donor_id',
    'donor_id_type',
    'download_time',
    'conversation_id',
    'message_id',
    'source',
    'file_uuid',
    'file_name',
    'file_type',
    'file_size',
    'extracted_text',
    'raw_json'
  ];
  const rows = [headers.join(',')];
  for (const a of attachments) {
    const enriched = {
      schema_version: SCHEMA_VERSIONS.claude_attachments,
      extractor_version: EXTRACTOR_VERSION,
      ...a
    };
    rows.push(headers.map(h => escapeCSVField(enriched[h])).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}


// ============================================================================
// CSV E: CANONICAL MESSAGES (one row per message, cross-platform shape)
// ============================================================================

/**
 * One row per message (not per block). `text` is the concatenation of the
 * message's `text` blocks only, in document order; thinking (and its
 * summaries) and tool results are kept apart in platform_specific_json so
 * the answer text is never silently mixed with reasoning (1.1.0; before,
 * every block's text was joined).
 */
function generateMessagesCanonicalCSV(conversationData, { donorId, donorIdType, downloadTime, scrubCell = null }) {
  const headers = canonicalHeaders();
  const schemaVersion = SCHEMA_VERSIONS.claude_messages_canonical;
  const conversationId = conversationData.uuid || '';
  const messages = Array.isArray(conversationData.chat_messages) ? conversationData.chat_messages : [];
  const visible = visiblePathSet(conversationData);

  const rows = [headers.join(',')];
  for (const msg of messages) {
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const joinText = (pred) => blocks.filter(pred).map(extractBlockText).filter(Boolean).join('\n\n');
    const text = blocks.length === 0 && typeof msg.text === 'string'
      ? msg.text
      : joinText(b => b && b.type === 'text');
    const thinkingText = joinText(b => b && b.type === 'thinking');
    const thinkingSummaries = blocks.map(thinkingSummary).filter(Boolean).join('\n\n');
    const toolResultText = joinText(b => b && b.type === 'tool_result');
    const contentTypes = blocks.map(b => (b && b.type) || '').filter(Boolean);
    const row = {
      donor_id: donorId,
      platform: 'claude',
      conversation_id: conversationId,
      message_id: msg.uuid || '',
      parent_message_id: msg.parent_message_uuid || '',
      turn_index: typeof msg.index === 'number' ? msg.index : '',
      role: normalizeRole(msg.sender),
      text,
      text_cleaned: cleanText(text),
      created_at_iso: toIsoUtc(msg.created_at) || msg.created_at || '',
      model_identifier: '',
      schema_version: schemaVersion,
      extractor_version: EXTRACTOR_VERSION,
      platform_specific_json: JSON.stringify({
        donor_id_type: donorIdType,
        download_time: downloadTime,
        sender: msg.sender || '',
        content_types: contentTypes,
        on_visible_path: isOnVisiblePath(visible, msg.uuid),
        thinking_mode: typeof msg.thinking_mode === 'string' ? msg.thinking_mode : '',
        thinking_text: thinkingText,
        thinking_summary: thinkingSummaries,
        tool_result_text: toolResultText,
        has_thinking: contentTypes.includes('thinking'),
        has_tool_use: contentTypes.includes('tool_use'),
        has_tool_result: contentTypes.includes('tool_result'),
        has_attachments: (Array.isArray(msg.attachments) && msg.attachments.length > 0)
          || (Array.isArray(msg.files) && msg.files.length > 0)
          || (Array.isArray(msg.files_v2) && msg.files_v2.length > 0),
        truncated: Boolean(msg.truncated),
        stop_reason: msg.stop_reason || '',
        updated_at: toIsoUtc(msg.updated_at) || msg.updated_at || ''
      })
    };
    // Optional per-cell scrubber (background.js passes one when PII scrubbing
    // is on) so the canonical file never carries text the other CSVs redact.
    rows.push(headers.map(h => escapeCSVField(scrubCell ? scrubCell(h, row[h]) : row[h])).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}


// ============================================================================
// MAIN EXPORT FUNCTION
// ============================================================================

/**
 * Process a Claude conversation JSON and generate all CSV files.
 * @param {Object} conversationData - The full Claude conversation JSON object
 * @param {Object} options - { donorId, donorIdType, downloadTime }
 * @returns {Object} CSV strings + raw arrays for each
 */
function extractClaudeConversation(conversationData, { donorId = '', donorIdType = '', downloadTime = '' } = {}) {
  if (!conversationData) {
    throw new Error('Invalid Claude conversation data');
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

  const attachments = extractAttachments(conversationData);
  for (const a of attachments) {
    a.donor_id = donorId;
    a.donor_id_type = donorIdType;
    a.download_time = downloadTime;
  }

  return {
    metadata,
    messages,
    sources,
    attachments,
    metadataCSV: generateMetadataCSV(metadata),
    messagesCSV: generateMessagesCSV(messages),
    sourcesCSV: generateSourcesCSV(sources),
    attachmentsCSV: generateAttachmentsCSV(attachments),
    messagesCanonicalCSV: generateMessagesCanonicalCSV(conversationData, { donorId, donorIdType, downloadTime })
  };
}


// ============================================================================
// EXPORTS
// ============================================================================

export {
  extractClaudeConversation,
  extractConversationMetadata,
  extractConversationMessages,
  extractSources,
  extractAttachments,
  generateMetadataCSV,
  generateMessagesCSV,
  generateSourcesCSV,
  generateAttachmentsCSV,
  generateMessagesCanonicalCSV
};
