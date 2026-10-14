/**
 * Main Background Script - Platform Router
 *
 * Routes conversation data to platform-specific handlers
 * and manages CSV generation and downloads
 */

import {
  extractChatGPTConversation,
  generateMetadataCSV as generateChatGPTMetadataCSV,
  generateMessagesCSV,
  generateMessagesCanonicalCSV,
  generateSearchResultsCSV as generateChatGPTSourcesCSV,
  generateMessageUrlsCSV as generateChatGPTMessageUrlsCSV,
  generateDonorContextCSV
} from './platforms/chatgpt/extractor.js';
import {
  extractClaudeConversation,
  generateMetadataCSV as generateClaudeMetadataCSV,
  generateMessagesCSV as generateClaudeMessagesCSV,
  generateSourcesCSV as generateClaudeSourcesCSV,
  generateAttachmentsCSV as generateClaudeAttachmentsCSV,
  generateMessagesCanonicalCSV as generateClaudeMessagesCanonicalCSV
} from './platforms/claude/extractor.js';
import {
  extractPerplexityConversation,
  generateMetadataCSV as generatePerplexityMetadataCSV,
  generateMessagesCSV as generatePerplexityMessagesCSV,
  generateSourcesCSV as generatePerplexitySourcesCSV,
  generateMessagesCanonicalCSV as generatePerplexityMessagesCanonicalCSV
} from './platforms/perplexity/extractor.js';
import {
  extractGrokConversation,
  generateMetadataCSV as generateGrokMetadataCSV,
  generateMessagesCSV as generateGrokMessagesCSV,
  generateSourcesCSV as generateGrokSourcesCSV,
  generateMessagesCanonicalCSV as generateGrokMessagesCanonicalCSV
} from './platforms/grok/extractor.js';
import {
  extractDeepSeekConversation,
  generateMetadataCSV as generateDeepSeekMetadataCSV,
  generateMessagesCSV as generateDeepSeekMessagesCSV,
  generateSourcesCSV as generateDeepSeekSourcesCSV,
  generateMessagesCanonicalCSV as generateDeepSeekMessagesCanonicalCSV
} from './platforms/deepseek/extractor.js';
import {
  extractMistralConversation,
  generateMetadataCSV as generateMistralMetadataCSV,
  generateMessagesCSV as generateMistralMessagesCSV,
  generateSourcesCSV as generateMistralSourcesCSV,
  generateMessagesCanonicalCSV as generateMistralMessagesCanonicalCSV
} from './platforms/mistral/extractor.js';
import { EXTENSION_CONFIG, getPlatformByUrl } from './config/settings.js';
import { sanitizeErrorMessage } from './shared/errors.js';
import { escapeCSVField, generateCSV } from './utils/csv.js';
import {
  SCHEMA_VERSIONS,
  EXTRACTOR_VERSION,
  canonicalHeaders,
  toIsoUtc,
  sha256Hex,
  hmacDonorId,
  buildManifest,
  countRows
} from './utils/manifest.js';
import {
  scrubCell,
  scrubRowDeep,
  PII_RULESET_VERSION,
  PII_SCRUB_OPTION_KEYS
} from './utils/pii.js';
import { cleanText } from './utils/text_cleaner.js';
import { validateRows } from './utils/validators.js';
import { buildZip } from './utils/zip.js';
import { stripUtmParams, normalizeRole } from './utils/extract_helpers.js';

// UTF-8 BOM prepended to every CSV inside the ZIP so Excel opens them with the
// right encoding.
const UTF8_BOM = '﻿';

// In production, suppress all console output to avoid leaking operational
// details and internal state to the browser console.
const IS_PRODUCTION = true;
const _console = IS_PRODUCTION ? { log: () => {}, warn: () => {}, error: () => {} } : console;

// Sanitize a conversation/query identifier for use inside a filename. Keeps
// enough context to be useful at a glance while staying well within POSIX
// filename limits.
function sanitizeIdForFilename(id) {
  const s = typeof id === 'string' ? id.replace(/[^A-Za-z0-9_-]/g, '') : '';
  return s.substring(0, 40) || 'unknown';
}

// Turn an ISO 8601 timestamp into a filename-safe UTC slug. Example:
// '2026-10-13T11:58:12.345Z' → '2026-10-13T11-58-12Z'.
function timestampSlug(iso) {
  if (typeof iso !== 'string' || !iso) return '';
  return iso.replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
}

// Resolve the best conversation identifier available on a payload. Order
// matches the per-platform shapes: ChatGPT uses `conversation_id`, Claude uses
// `uuid`, Copilot uses `conversationId`, Google uses `query`.
function resolveConversationId(conversationData) {
  if (!conversationData || typeof conversationData !== 'object') return null;
  // Grok's conversation payload is just `{ responses: [...] }` with no
  // conversation id in the body — the id is stamped on from the request URL by
  // inject.js/content.js as `_captured_conversation_id`. Also honor the nested
  // `conversation.conversationId` shape for forward-compat with other platforms.
  const stamped = typeof conversationData._captured_conversation_id === 'string'
    ? conversationData._captured_conversation_id
    : null;
  const grokNested = conversationData.conversation
    && typeof conversationData.conversation === 'object'
    ? conversationData.conversation.conversationId
    : null;
  // DeepSeek wraps the conversation metadata under `data.biz_data.chat_session`.
  const deepseekBiz = conversationData.data && conversationData.data.biz_data
    ? conversationData.data.biz_data
    : (conversationData.biz_data || null);
  const deepseekSession = deepseekBiz && typeof deepseekBiz.chat_session === 'object'
    ? deepseekBiz.chat_session.id
    : null;
  // Mistral payloads carry `_captured_conversation_id` (stamped by content.js);
  // the `chat.id` on the metadata half is also accepted as a fallback.
  const mistralChat = conversationData.chat && typeof conversationData.chat === 'object'
    ? conversationData.chat.id
    : null;
  return stamped
    || grokNested
    || deepseekSession
    || mistralChat
    || conversationData.conversation_id
    || conversationData.uuid
    || conversationData.id
    || conversationData.conversationId
    || conversationData.query
    // Google AI Mode payloads from before 3.0.0 carried only a title.
    || conversationData.conversation_title
    || null;
}


/**
 * Normalize per-category scrub options from storage. Unknown keys are dropped
 * and every advertised key is coerced to boolean, so the options object
 * always has the same shape regardless of what was stored. The manifest
 * writes it only when scrubbing is on (`{}` when off; see manifestExtras).
 * Defaults: every advertised key is `false`; there is no popup toggle.
 */
function normalizeScrubOptions(stored) {
  const out = {};
  const src = (stored && typeof stored === 'object') ? stored : {};
  for (const key of PII_SCRUB_OPTION_KEYS) {
    out[key] = Boolean(src[key]);
  }
  return out;
}

/**
 * Load per-donor privacy settings. Non-fatal if storage is unavailable.
 * `study_salt` is the HMAC key for donor_id pseudonymisation; empty means use raw UUID.
 */
async function loadPrivacySettings() {
  try {
    const s = await browser.storage.local.get([
      'pii_scrub_enabled',
      'pii_scrub_options',
      'include_donor_context',
      'study_salt',
      'consent_version',
      'consent_given_at'
    ]);
    return {
      piiScrubEnabled: Boolean(s.pii_scrub_enabled),
      piiScrubOptions: normalizeScrubOptions(s.pii_scrub_options),
      includeDonorContext: s.include_donor_context !== false, // default: true
      studySalt: typeof s.study_salt === 'string' ? s.study_salt : '',
      // Consent record written by the popup's first-run gate. null when the
      // install predates 3.0.0 (consent was given before versions existed).
      consentVersion: typeof s.consent_version === 'string' ? s.consent_version : null,
      consentGivenAt: typeof s.consent_given_at === 'string' ? s.consent_given_at : null
    };
  } catch {
    return {
      piiScrubEnabled: false,
      piiScrubOptions: normalizeScrubOptions(null),
      includeDonorContext: true,
      studySalt: '',
      consentVersion: null,
      consentGivenAt: null
    };
  }
}


/**
 * Copilot Platform Handler
 */
const CopilotHandler = {
  extractTextFromContent(content) {
    if (!content || !Array.isArray(content)) return '';
    return content
      .filter(part => part && part.type === 'text')
      .map(part => part.text || '')
      .join('\n\n');
  },

  flattenConversationData(convJson) {
    if (!convJson || !Array.isArray(convJson.results)) {
      _console.warn('[Copilot] Invalid conversation data: missing results');
      return [];
    }
    const results = convJson.results;
    const conversationId = convJson.conversationId || '';
    const rows = [];
    for (const result of results) {
      try {
        const text = this.extractTextFromContent(result.content);
        const authorType = result.author?.type || '';
        const role = authorType === 'human' ? 'user' :
          authorType === 'ai' ? 'assistant' :
            authorType;
        const partIds = result.content
          ?.filter(part => part && part.type === 'text')
          .map(part => part.partId || '')
          .join(',') || '';
        rows.push({
          conversation_id: conversationId,
          message_id: result.id || '',
          role,
          text,
          text_cleaned: cleanText(text),
          created_at: toIsoUtc(result.createdAt) || result.createdAt || '',
          channel: result.channel || '',
          mode: result.mode || '',
          part_ids: partIds,
          author_type: authorType
        });
      } catch (error) {
        _console.error('[Copilot] Error processing result:', error);
      }
    }
    return rows;
  }
};

/**
 * Microsoft 365 Copilot (BizChat) Handler
 *
 * Input payload is the structure assembled by platforms/m365_copilot/inject.js:
 *   { conversationId, results: [m365_message...], metadata: {...} }
 * where each m365_message is a Sydney/BizChat chat frame with fields like
 * `author`, `text`, `messageType`, `requestId`, optional `sourceAttributions`
 * and `suggestedResponses`.
 */
const M365CopilotHandler = {

  flattenConversationData(convJson) {
    if (!convJson || !Array.isArray(convJson.results)) {
      _console.warn('[M365Copilot] Invalid conversation data: missing results');
      return [];
    }
    const conversationId = convJson.conversationId || '';
    const rows = [];
    for (const msg of convJson.results) {
      if (!msg || typeof msg !== 'object') continue;
      try {
        const author = typeof msg.author === 'string' ? msg.author : '';
        const sourceAttr = Array.isArray(msg.sourceAttributions) ? msg.sourceAttributions : [];
        const suggested = Array.isArray(msg.suggestedResponses) ? msg.suggestedResponses : [];
        const adaptive = Array.isArray(msg.adaptiveCards) ? msg.adaptiveCards : [];
        const createdAt = msg.createdAt || msg.timestamp || '';
        const m365Text = typeof msg.text === 'string' ? msg.text : '';
        rows.push({
          conversation_id: conversationId,
          message_id: typeof msg.messageId === 'string' ? msg.messageId : '',
          request_id: typeof msg.requestId === 'string' ? msg.requestId : '',
          author,
          role: normalizeRole(author),
          text: m365Text,
          text_cleaned: cleanText(m365Text),
          spoken_text: typeof msg.spokenText === 'string' ? msg.spokenText : '',
          message_type: typeof msg.messageType === 'string' ? msg.messageType : '',
          content_origin: typeof msg.contentOrigin === 'string' ? msg.contentOrigin : '',
          turn_state: typeof msg.turnState === 'string' ? msg.turnState : '',
          response_identifier: typeof msg.responseIdentifier === 'string' ? msg.responseIdentifier : '',
          offense: typeof msg.offense === 'string' ? msg.offense : '',
          input_method: typeof msg.inputMethod === 'string' ? msg.inputMethod : '',
          turn_count: typeof msg.turnCount === 'number' ? msg.turnCount : '',
          created_at: toIsoUtc(createdAt) || (typeof createdAt === 'string' ? createdAt : ''),
          source_count: sourceAttr.length,
          suggested_count: suggested.length,
          adaptive_cards_json: adaptive.length > 0
            ? (() => { try { return JSON.stringify(adaptive); } catch { return ''; } })()
            : '',
          raw_json: (() => { try { return JSON.stringify(msg); } catch { return ''; } })()
        });
      } catch (error) {
        _console.error('[M365Copilot] Error processing message:', error);
      }
    }
    return rows;
  },

  /**
   * One row per sourceAttribution across all messages. Mirrors chatgpt_sources
   * / claude_sources shape so researchers can concat across platforms.
   */
  flattenSources(convJson) {
    if (!convJson || !Array.isArray(convJson.results)) return [];
    const rows = [];
    const conversationId = convJson.conversationId || '';
    for (const msg of convJson.results) {
      const attrs = Array.isArray(msg?.sourceAttributions) ? msg.sourceAttributions : [];
      for (let i = 0; i < attrs.length; i++) {
        const a = attrs[i] || {};
        const url = a.seeMoreUrl || a.url || '';
        rows.push({
          conversation_id: conversationId,
          request_id: typeof msg.requestId === 'string' ? msg.requestId : '',
          message_type: typeof msg.messageType === 'string' ? msg.messageType : '',
          source_index: i,
          provider_name: a.providerDisplayName || '',
          title: a.title || a.name || '',
          snippet: a.snippet || a.description || '',
          url,
          url_clean: stripUtmParams(url),
          search_query: a.searchQuery || '',
          image_link: a.imageLink || '',
          raw_json: (() => { try { return JSON.stringify(a); } catch { return ''; } })()
        });
      }
    }
    return rows;
  }
};

function generateM365CopilotSourcesCSV(rows) {
  const headers = [
    'schema_version',
    'extractor_version',
    'donor_id',
    'donor_id_type',
    'download_time',
    'platform',
    'conversation_id',
    'request_id',
    'message_type',
    'source_index',
    'provider_name',
    'title',
    'snippet',
    'url',
    'url_clean',
    'search_query',
    'image_link',
    'raw_json'
  ];
  const out = [headers.join(',')];
  for (const r of rows) {
    const enriched = {
      schema_version: SCHEMA_VERSIONS.m365_copilot_sources,
      extractor_version: EXTRACTOR_VERSION,
      platform: 'm365_copilot',
      ...r
    };
    out.push(headers.map(h => escapeCSVField(enriched[h])).join(','));
  }
  return out.join('\r\n') + '\r\n';
}

/**
 * Google Search AI Overview Handler
 */
const GoogleSearchHandler = {
  flattenConversationData(data) {
    if (!data || typeof data !== 'object') {
      _console.warn('[GoogleSearch] Invalid data: not an object');
      return [];
    }
    if (data.mode === 'ai_mode') {
      if (!Array.isArray(data.turns) || data.turns.length === 0) return [];
      const aiModeConversationId = data.conversation_id || data.conversation_title || '';
      return data.turns.map((turn, i) => {
        const sources = Array.isArray(turn.sources) ? turn.sources : [];
        const turnText = turn.text || '';
        return {
          conversation_id: aiModeConversationId,
          conversation_title: data.conversation_title || '',
          source_page_url: data.source_page_url || '',
          captured_at: turn.captured_at || data.captured_at || '',
          turn_index: typeof turn.index === 'number' ? turn.index : i,
          role: turn.role || '',
          text: turnText,
          text_cleaned: cleanText(turnText),
          source_urls: sources.map(s => s && s.url ? s.url : '').filter(Boolean).join(', '),
          source_titles: sources.map(s => s && s.title ? s.title : '').filter(Boolean).join(', ')
        };
      });
    }
    if (typeof data.ai_overview_text !== 'string') return [];
    const sources = Array.isArray(data.sources) ? data.sources : [];
    const followUps = Array.isArray(data.follow_up_questions) ? data.follow_up_questions : [];
    return [{
      query: data.query || '',
      source_page_url: data.source_page_url || '',
      captured_at: data.captured_at || '',
      ai_overview_text: data.ai_overview_text,
      ai_overview_text_cleaned: cleanText(data.ai_overview_text),
      source_urls: sources.map(s => s && s.url ? s.url : '').filter(Boolean).join(', '),
      source_titles: sources.map(s => s && s.title ? s.title : '').filter(Boolean).join(', '),
      follow_up_questions: followUps.join(', '),
      follow_up_count: followUps.length
    }];
  },

  /**
   * One row per source URL (across turns in ai_mode, or across data.sources
   * in ai_overview). Mirrors the per-source grain used by chatgpt_sources
   * and claude_sources so analysts can concat across platforms.
   */
  flattenSources(data) {
    if (!data || typeof data !== 'object') return [];
    const rows = [];
    if (data.mode === 'ai_mode') {
      const turns = Array.isArray(data.turns) ? data.turns : [];
      const aiModeConversationId = data.conversation_id || data.conversation_title || '';
      turns.forEach((turn, i) => {
        const srcs = Array.isArray(turn.sources) ? turn.sources : [];
        for (const s of srcs) {
          if (!s || !s.url) continue;
          rows.push({
            mode: 'ai_mode',
            conversation_id: aiModeConversationId,
            turn_index: typeof turn.index === 'number' ? turn.index : i,
            source_page_url: data.source_page_url || '',
            captured_at: turn.captured_at || data.captured_at || '',
            url: s.url,
            url_clean: stripUtmParams(s.url),
            title: s.title || ''
          });
        }
      });
      return rows;
    }
    const srcs = Array.isArray(data.sources) ? data.sources : [];
    for (const s of srcs) {
      if (!s || !s.url) continue;
      rows.push({
        mode: 'ai_overview',
        conversation_id: data.query || '',
        turn_index: '',
        source_page_url: data.source_page_url || '',
        captured_at: data.captured_at || '',
        url: s.url,
        url_clean: stripUtmParams(s.url),
        title: s.title || ''
      });
    }
    return rows;
  }
};

/**
 * Generate google_sources.csv from the per-source rows above. Schema matches
 * claude_sources/chatgpt_sources enough that researchers can union all three.
 */
function generateGoogleSourcesCSV(rows) {
  const headers = [
    'schema_version',
    'extractor_version',
    'donor_id',
    'donor_id_type',
    'download_time',
    'platform',
    'mode',
    'conversation_id',
    'turn_index',
    'source_page_url',
    'captured_at',
    'url',
    'url_clean',
    'title'
  ];
  const out = [headers.join(',')];
  for (const r of rows) {
    const enriched = {
      schema_version: SCHEMA_VERSIONS.google_sources,
      extractor_version: EXTRACTOR_VERSION,
      platform: 'google_search',
      ...r
    };
    out.push(headers.map(h => escapeCSVField(enriched[h])).join(','));
  }
  return out.join('\r\n') + '\r\n';
}


/**
 * Validate a payload before extraction. Every failure carries a stable
 * `code` the popup maps to plain copy (the `error` string is for logs):
 *   NOT_OBJECT, TOO_LARGE, UNSERIALIZABLE, MISSING_FIELDS, BAD_SHAPE, EMPTY.
 */
function validateConversationData(data, platform) {
  if (!data || typeof data !== 'object') {
    return { isValid: false, code: 'NOT_OBJECT', error: 'Data is not an object' };
  }
  const MAX_PAYLOAD_SIZE = 50 * 1024 * 1024;
  try {
    const jsonSize = JSON.stringify(data).length;
    if (jsonSize > MAX_PAYLOAD_SIZE) {
      return {
        isValid: false,
        code: 'TOO_LARGE',
        error: `Payload too large: ${(jsonSize / 1024 / 1024).toFixed(2)}MB (max: 50MB)`
      };
    }
  } catch (error) {
    return { isValid: false, code: 'UNSERIALIZABLE', error: 'Failed to serialize data: ' + error.message };
  }
  switch (platform) {
    case 'chatgpt':
      if (!data.mapping && !data.conversation_id) {
        return { isValid: false, code: 'MISSING_FIELDS', error: 'ChatGPT data missing required fields (mapping or conversation_id)' };
      }
      if ('mapping' in data && (data.mapping === null || typeof data.mapping !== 'object' || Array.isArray(data.mapping))) {
        return { isValid: false, code: 'BAD_SHAPE', error: 'ChatGPT mapping is not a plain object' };
      }
      break;
    case 'claude':
      if (!Array.isArray(data.chat_messages)) {
        return { isValid: false, code: 'MISSING_FIELDS', error: 'Claude data missing required chat_messages array' };
      }
      if (data.chat_messages.length === 0) {
        return { isValid: false, code: 'EMPTY', error: 'Claude chat_messages array is empty' };
      }
      break;
    case 'copilot':
      if (!Array.isArray(data.results)) {
        return { isValid: false, code: 'MISSING_FIELDS', error: 'Copilot data missing required results array' };
      }
      if (data.results.length === 0) {
        return { isValid: false, code: 'EMPTY', error: 'Copilot results array is empty' };
      }
      break;
    case 'm365_copilot':
      if (!Array.isArray(data.results)) {
        return { isValid: false, code: 'MISSING_FIELDS', error: 'M365 Copilot data missing required results array' };
      }
      if (data.results.length === 0) {
        return { isValid: false, code: 'EMPTY', error: 'M365 Copilot results array is empty' };
      }
      break;
    case 'google_search':
      if (data.mode === 'ai_mode') {
        if (!Array.isArray(data.turns) || data.turns.length === 0) {
          return { isValid: false, code: 'EMPTY', error: 'Google AI Mode data missing turns' };
        }
      } else if (typeof data.ai_overview_text !== 'string' || data.ai_overview_text.length < 10) {
        return { isValid: false, code: 'EMPTY', error: 'Google Search data missing ai_overview_text' };
      }
      break;
    case 'perplexity':
      if (!Array.isArray(data.entries)) {
        return { isValid: false, code: 'MISSING_FIELDS', error: 'Perplexity data missing entries array' };
      }
      if (data.entries.length === 0) {
        return { isValid: false, code: 'EMPTY', error: 'Perplexity entries array is empty' };
      }
      break;
    case 'grok': {
      // Grok responses may wrap messages under `responses`, `conversation.responses`,
      // or `messages` depending on the endpoint. Any one of them is acceptable.
      const nestedResponses = data.conversation && Array.isArray(data.conversation.responses)
        ? data.conversation.responses
        : null;
      const flatResponses = Array.isArray(data.responses) ? data.responses : null;
      const flatMessages = Array.isArray(data.messages) ? data.messages : null;
      const messages = flatResponses || nestedResponses || flatMessages;
      if (!messages) {
        return { isValid: false, code: 'MISSING_FIELDS', error: 'Grok data missing responses/messages array' };
      }
      if (messages.length === 0) {
        return { isValid: false, code: 'EMPTY', error: 'Grok messages array is empty' };
      }
      break;
    }
    case 'deepseek': {
      // DeepSeek wraps the payload under `data.biz_data`. Accept either the
      // wrapped shape or an unwrapped `chat_messages` for forward-compat.
      const biz = data.data && data.data.biz_data
        ? data.data.biz_data
        : (data.biz_data || null);
      const chatMessages =
        (biz && Array.isArray(biz.chat_messages) ? biz.chat_messages : null) ||
        (Array.isArray(data.chat_messages) ? data.chat_messages : null);
      if (!chatMessages) {
        return { isValid: false, code: 'MISSING_FIELDS', error: 'DeepSeek data missing chat_messages array' };
      }
      if (chatMessages.length === 0) {
        return { isValid: false, code: 'EMPTY', error: 'DeepSeek chat_messages array is empty' };
      }
      break;
    }
    case 'mistral':
      if (!Array.isArray(data.messages)) {
        return { isValid: false, code: 'MISSING_FIELDS', error: 'Mistral data missing required messages array' };
      }
      if (data.messages.length === 0) {
        return { isValid: false, code: 'EMPTY', error: 'Mistral messages array is empty' };
      }
      break;
    default:
      _console.warn(`[${platform}] Unknown platform, skipping detailed validation`);
      break;
  }
  return { isValid: true, error: null };
}

const DONOR_ID_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;

async function getOrCreateDonorId() {
  try {
    const stored = await browser.storage.local.get(['donor_id', 'donor_id_created']);
    const { donor_id, donor_id_created } = stored;
    if (donor_id && donor_id_created) {
      const age = Date.now() - new Date(donor_id_created).getTime();
      if (age < DONOR_ID_EXPIRY_MS) return { id: donor_id, type: 'persistent' };
    }
    const id = crypto.randomUUID();
    await browser.storage.local.set({ donor_id: id, donor_id_created: new Date().toISOString() });
    return { id, type: 'persistent' };
  } catch {
    return { id: crypto.randomUUID(), type: 'session' };
  }
}

/**
 * Build the cross-platform canonical messages CSV for Claude/Copilot/Google.
 * ChatGPT builds its own canonical CSV inside the extractor.
 */
function buildCanonicalCSV(rows, mapping, { donorId, donorIdType, downloadTime, platform, schemaName }) {
  const headers = canonicalHeaders();
  const schemaVersion = SCHEMA_VERSIONS[schemaName] || 'unknown';
  const out = [headers.join(',')];
  for (const row of rows) {
    const extras = {};
    for (const key in row) {
      if (!mapping.consumed.has(key)) extras[key] = row[key];
    }
    const canonical = {
      donor_id: donorId,
      platform,
      conversation_id: mapping.conversation_id(row),
      message_id: mapping.message_id(row),
      parent_message_id: mapping.parent_message_id(row),
      turn_index: mapping.turn_index(row),
      role: mapping.role(row),
      text: mapping.text(row),
      text_cleaned: mapping.text_cleaned
        ? mapping.text_cleaned(row)
        : cleanText(mapping.text(row)),
      created_at_iso: mapping.created_at_iso(row),
      model_identifier: mapping.model_identifier(row),
      schema_version: schemaVersion,
      extractor_version: EXTRACTOR_VERSION,
      platform_specific_json: JSON.stringify({ donor_id_type: donorIdType, download_time: downloadTime, ...extras })
    };
    out.push(headers.map(h => escapeCSVField(canonical[h])).join(','));
  }
  return out.join('\r\n') + '\r\n';
}

const CANONICAL_MAPPINGS = {
  copilot: {
    consumed: new Set(['conversation_id', 'message_id', 'role', 'text', 'text_cleaned', 'created_at', 'mode']),
    conversation_id: r => r.conversation_id,
    message_id: r => r.message_id,
    parent_message_id: () => '',
    turn_index: () => '',
    role: r => r.role,
    text: r => r.text,
    text_cleaned: r => r.text_cleaned,
    created_at_iso: r => r.created_at,
    model_identifier: r => r.mode || ''
  },
  m365_copilot: {
    consumed: new Set([
      'conversation_id', 'message_id', 'request_id', 'role', 'text', 'text_cleaned',
      'created_at', 'message_type', 'turn_count'
    ]),
    conversation_id: r => r.conversation_id,
    // Each message has its own stable messageId. For the user's prompt
    // message, Sydney reuses the requestId as the messageId so cross-platform
    // joins by message_id still work per turn.
    message_id: r => r.message_id || r.request_id,
    parent_message_id: () => '',
    turn_index: r => typeof r.turn_count === 'number' ? r.turn_count : '',
    role: r => r.role,
    text: r => r.text,
    text_cleaned: r => r.text_cleaned,
    created_at_iso: r => r.created_at,
    model_identifier: r => r.message_type || ''
  },
  google_ai_mode: {
    consumed: new Set(['conversation_id', 'turn_index', 'role', 'text', 'text_cleaned', 'captured_at']),
    conversation_id: r => r.conversation_id,
    message_id: r => `turn_${r.turn_index}`,
    parent_message_id: () => '',
    turn_index: r => r.turn_index,
    role: r => r.role,
    text: r => r.text,
    text_cleaned: r => r.text_cleaned,
    created_at_iso: r => r.captured_at,
    model_identifier: () => ''
  },
  google_ai_overview: {
    consumed: new Set(['query', 'ai_overview_text', 'ai_overview_text_cleaned', 'captured_at']),
    conversation_id: r => r.query,
    message_id: () => '0',
    parent_message_id: () => '',
    turn_index: () => 0,
    role: () => 'assistant',
    text: r => r.ai_overview_text,
    text_cleaned: r => r.ai_overview_text_cleaned,
    created_at_iso: r => r.captured_at,
    model_identifier: () => ''
  }
};

/**
 * Generate a flat CSV with schema_version + extractor_version prepended.
 */
function generateVersionedCSV(rows, schemaName) {
  if (!rows || rows.length === 0) return '';
  const schemaVersion = SCHEMA_VERSIONS[schemaName] || 'unknown';
  const baseHeaders = Object.keys(rows[0]);
  const headers = ['schema_version', 'extractor_version', ...baseHeaders];
  const enriched = rows.map(r => ({ schema_version: schemaVersion, extractor_version: EXTRACTOR_VERSION, ...r }));
  return generateCSV(enriched, headers);
}

/**
 * Translate the manifest-shaped scrub options into the shape `scrubText` reads
 * internally. Keeps `scrubText`'s existing `stripUrls` parameter name
 * (unit-tested in test_pii.js) while the public manifest vocabulary (`URL`)
 * matches the keys emitted by `countRedactions().byType`.
 */
function scrubOptionsForScrubText(options) {
  if (!options) return undefined;
  return { stripUrls: Boolean(options.URL) };
}

/**
 * Scrub PII (optional) in every cell of every row, per the column
 * classification in utils/pii.js (text, JSON, URL, structural). Returns
 * per-type counts alongside the total so callers can surface a
 * `pii_redactions_by_type` map in the export manifest.
 */
function scrubRowsIfEnabled(rows, enabled, options, platform) {
  if (!enabled) {
    return { rows, redactionCount: 0, redactionsByType: {} };
  }
  const scrubOptions = scrubOptionsForScrubText(options);
  let total = 0;
  const byType = {};
  const scrubbed = rows.map(row => {
    const r = scrubRowDeep(row, scrubOptions, platform);
    total += r.counts.total;
    for (const [type, n] of Object.entries(r.counts.byType)) {
      byType[type] = (byType[type] || 0) + n;
    }
    return r.row;
  });
  return { rows: scrubbed, redactionCount: total, redactionsByType: byType };
}

/**
 * Per-cell scrubber handed to the extractors' canonical-CSV generators (the
 * ones that build canonical rows from the raw payload rather than from the
 * already-scrubbed message rows). Counts go straight into `stats`.
 * Returns null when scrubbing is off, so the generators run untouched.
 */
function makeCellScrubber(enabled, options, platform, stats) {
  if (!enabled) return null;
  const scrubOptions = scrubOptionsForScrubText(options);
  return (column, value) => {
    const r = scrubCell(column, value, scrubOptions, platform);
    mergeScrubCounts(stats, { redactionCount: r.counts.total, redactionsByType: r.counts.byType });
    return r.value;
  };
}

/**
 * Fold the return value of `scrubIfEnabled` into a running `{ total, byType }`
 * accumulator. Lets the per-platform code stay one line per CSV instead of
 * repeating a four-line merge at every call site.
 */
function mergeScrubCounts(stats, result) {
  if (!result) return;
  stats.total += result.redactionCount || 0;
  if (result.redactionsByType) {
    for (const [type, n] of Object.entries(result.redactionsByType)) {
      stats.byType[type] = (stats.byType[type] || 0) + n;
    }
  }
}

/**
 * Run validators against each CSV we're about to download; return a summary
 * safe to embed in the manifest.
 */
function summarizeValidation(perSchema) {
  const summary = {};
  for (const [schemaName, result] of Object.entries(perSchema)) {
    summary[schemaName] = {
      valid: result.valid,
      total_rows: result.totalRows,
      error_rows: result.errorRows,
      warning_rows: result.warningRows,
      errors_sample: result.errorsSample.slice(0, 5),
      warnings_sample: result.warningsSample.slice(0, 5)
    };
  }
  return summary;
}

/**
 * Push a CSV entry into the per-export file list.
 * `stem` is the schema-level name (e.g. `claude_metadata`); the actual
 * inner filename gets the export slug (short conversation id + download
 * timestamp) appended so each CSV is traceable back to its originating ZIP
 * even when extracted and moved around in isolation. Scripts can still glob
 * by schema with a trailing wildcard: `**​/claude_metadata_*.csv`.
 */
function pushCsv(list, stem, schemaName, content, slug) {
  const innerName = slug ? `${stem}_${slug}.csv` : `${stem}.csv`;
  list.push({ innerName, schemaName, content });
}

/**
 * Main entrypoint: generate the CSV bundle for one conversation and trigger
 * a single ZIP download containing every CSV + the provenance manifest.
 */
async function handleConversationData(message) {
  const platform = message.platform || 'unknown';
  const conversationData = message.payload;
  // Optional id the content script derived from the page URL; used for
  // naming only when the payload itself yields none.
  const hintedConversationId = (typeof message.conversationId === 'string'
    && /^[A-Za-z0-9._:-]{1,128}$/.test(message.conversationId))
    ? message.conversationId
    : null;

  if (!conversationData) {
    _console.error(`[${platform}] No conversation data in message`);
    return;
  }

  const validation = validateConversationData(conversationData, platform);
  if (!validation.isValid) {
    _console.error(`[${platform}] Invalid conversation data:`, validation.error);
    // Branch on the structured `code` set by validateConversationData, not
    // on the human-readable error string — the latter can drift (and did,
    // before the independent review flagged it). docs/ux-audit.md §3.1 B2.
    broadcastExportResult({
      platform,
      outcome: validation.code === 'EMPTY' ? 'empty_export' : 'invalid_data',
      code: validation.code || 'BAD_SHAPE',
      // `reason` is diagnostic text for the popup's log, never shown to the user.
      reason: validation.error || 'Validation failed'
    });
    return;
  }

  try {
    const { id: donorIdRaw, type: donorIdType } = await getOrCreateDonorId();
    const {
      piiScrubEnabled, piiScrubOptions, includeDonorContext, studySalt, consentVersion, consentGivenAt
    } = await loadPrivacySettings();
    const donorId = await hmacDonorId(donorIdRaw, studySalt);
    const donorIdHashed = studySalt ? donorId : await sha256Hex(donorIdRaw);
    const downloadTime = new Date().toISOString();

    const csvFiles = []; // { innerName, schemaName, content, rowCount }
    const perSchemaValidation = {};
    const piiStats = { total: 0, byType: {} };
    const cellScrubber = makeCellScrubber(piiScrubEnabled, piiScrubOptions, platform, piiStats);

    // Build a filename slug that pins every file in this export (CSVs and
    // manifest) to its conversation + download time. If the ZIP is unpacked
    // and the CSVs move around, each file still carries enough provenance in
    // its name to be matched back to the manifest / archive. On Google the
    // id is the search query (free text), so it is scrubbed like any other
    // text cell when scrubbing is on; elsewhere it is an opaque id.
    const rawConversationId = resolveConversationId(conversationData) || hintedConversationId;
    const conversationIdForNaming = (cellScrubber && typeof rawConversationId === 'string')
      ? cellScrubber('conversation_id', rawConversationId)
      : rawConversationId;
    const idShort = sanitizeIdForFilename(conversationIdForNaming || '');
    const slug = `${idShort}_${timestampSlug(downloadTime)}`;
    let apiFormat = null;
    let orphanCount = 0;
    let extractionTelemetry = null;

    if (platform === 'chatgpt') {
      const result = extractChatGPTConversation(conversationData, { donorId, donorIdType, downloadTime });
      apiFormat = result.apiFormat;
      orphanCount = result.orphanCount;

      const scrubChatGPTMeta = scrubRowsIfEnabled([result.metadata], piiScrubEnabled, piiScrubOptions, platform);
      mergeScrubCounts(piiStats, scrubChatGPTMeta);
      const scrubChatGPTMsgs = scrubRowsIfEnabled(result.messages, piiScrubEnabled, piiScrubOptions, platform);
      const msgRows = scrubChatGPTMsgs.rows;
      mergeScrubCounts(piiStats, scrubChatGPTMsgs);

      // With scrubbing on, every CSV is regenerated from the scrubbed rows;
      // off, the extractor's own output is used untouched.
      pushCsv(csvFiles, 'chatgpt_metadata', 'chatgpt_metadata',
        piiScrubEnabled ? generateChatGPTMetadataCSV(scrubChatGPTMeta.rows[0]) : result.metadataCSV, slug);
      pushCsv(csvFiles, 'chatgpt_messages', 'chatgpt_messages',
        piiScrubEnabled ? generateMessagesCSV(msgRows) : result.messagesCSV, slug);
      pushCsv(csvFiles, 'chatgpt_messages_canonical', 'chatgpt_messages_canonical',
        piiScrubEnabled
          ? generateMessagesCanonicalCSV(msgRows, { donorId, donorIdType, downloadTime })
          : result.messagesCanonicalCSV, slug);

      if (result.searchResults && result.searchResults.length > 0) {
        const scrubSources = scrubRowsIfEnabled(result.searchResults, piiScrubEnabled, piiScrubOptions, platform);
        mergeScrubCounts(piiStats, scrubSources);
        pushCsv(csvFiles, 'chatgpt_sources', 'chatgpt_sources',
          piiScrubEnabled ? generateChatGPTSourcesCSV(scrubSources.rows) : result.sourcesCSV, slug);
      }
      if (result.messageUrls && result.messageUrls.length > 0) {
        const scrubUrls = scrubRowsIfEnabled(result.messageUrls, piiScrubEnabled, piiScrubOptions, platform);
        mergeScrubCounts(piiStats, scrubUrls);
        pushCsv(csvFiles, 'chatgpt_message_urls', 'chatgpt_message_urls',
          piiScrubEnabled ? generateChatGPTMessageUrlsCSV(scrubUrls.rows) : result.messageUrlsCSV, slug);
      }
      if (includeDonorContext && result.donorContext &&
          (result.donorContext.user_profile || result.donorContext.user_instructions)) {
        if (piiScrubEnabled) {
          const scrubDonor = scrubRowsIfEnabled([result.donorContext], piiScrubEnabled, piiScrubOptions, platform);
          mergeScrubCounts(piiStats, scrubDonor);
          const dc = scrubDonor.rows[0] || result.donorContext;
          pushCsv(csvFiles, 'chatgpt_donor_context', 'chatgpt_donor_context', generateDonorContextCSV(dc), slug);
        } else {
          pushCsv(csvFiles, 'chatgpt_donor_context', 'chatgpt_donor_context', result.donorContextCSV, slug);
        }
      }

      const msgRowsForValidation = msgRows.map(m => ({
        donor_id: m.donor_id,
        donor_id_type: m.donor_id_type,
        download_time: m.download_time,
        conversation_id: m.conversation_id,
        message_id: m.node_id,
        parent_id: m.parent_id,
        turn_number: m.turn_number,
        author_role: m.author_role,
        tool_name: m.tool_name,
        content_type: m.content_type,
        text: m.text,
        create_time: m.create_time,
        model_slug: m.model_slug,
        on_visible_path: m.on_visible_path
      }));
      perSchemaValidation.chatgpt_messages = validateRows(msgRowsForValidation, 'chatgpt_messages');

    } else if (platform === 'claude') {
      const result = extractClaudeConversation(conversationData, { donorId, donorIdType, downloadTime });

      // Optional PII scrub per CSV. Each schema has its own target columns.
      const scrubMetadata = scrubRowsIfEnabled([result.metadata], piiScrubEnabled, piiScrubOptions, platform);
      mergeScrubCounts(piiStats, scrubMetadata);
      const scrubMessages = scrubRowsIfEnabled(result.messages, piiScrubEnabled, piiScrubOptions, platform);
      mergeScrubCounts(piiStats, scrubMessages);
      const scrubSources = scrubRowsIfEnabled(result.sources, piiScrubEnabled, piiScrubOptions, platform);
      mergeScrubCounts(piiStats, scrubSources);
      const scrubAttachments = scrubRowsIfEnabled(result.attachments, piiScrubEnabled, piiScrubOptions, platform);
      mergeScrubCounts(piiStats, scrubAttachments);

      pushCsv(csvFiles, 'claude_metadata', 'claude_metadata',
        generateClaudeMetadataCSV(scrubMetadata.rows[0] || result.metadata), slug);
      pushCsv(csvFiles, 'claude_messages', 'claude_messages',
        generateClaudeMessagesCSV(scrubMessages.rows), slug);
      if (scrubSources.rows.length > 0) {
        pushCsv(csvFiles, 'claude_sources', 'claude_sources',
          generateClaudeSourcesCSV(scrubSources.rows), slug);
      }
      if (scrubAttachments.rows.length > 0) {
        pushCsv(csvFiles, 'claude_attachments', 'claude_attachments',
          generateClaudeAttachmentsCSV(scrubAttachments.rows), slug);
      }
      pushCsv(csvFiles, 'claude_messages_canonical', 'claude_messages_canonical',
        cellScrubber
          ? generateClaudeMessagesCanonicalCSV(conversationData, { donorId, donorIdType, downloadTime, scrubCell: cellScrubber })
          : result.messagesCanonicalCSV, slug);

      perSchemaValidation.claude_messages = validateRows(scrubMessages.rows, 'claude_messages');

    } else if (platform === 'perplexity') {
      const result = extractPerplexityConversation(conversationData, { donorId, donorIdType, downloadTime });

      const scrubMetadata = scrubRowsIfEnabled([result.metadata], piiScrubEnabled, piiScrubOptions, platform);
      mergeScrubCounts(piiStats, scrubMetadata);
      const scrubMessages = scrubRowsIfEnabled(result.messages, piiScrubEnabled, piiScrubOptions, platform);
      mergeScrubCounts(piiStats, scrubMessages);
      const scrubSources = scrubRowsIfEnabled(result.sources, piiScrubEnabled, piiScrubOptions, platform);
      mergeScrubCounts(piiStats, scrubSources);

      pushCsv(csvFiles, 'perplexity_metadata', 'perplexity_metadata',
        generatePerplexityMetadataCSV(scrubMetadata.rows[0] || result.metadata), slug);
      pushCsv(csvFiles, 'perplexity_messages', 'perplexity_messages',
        generatePerplexityMessagesCSV(scrubMessages.rows), slug);
      if (scrubSources.rows.length > 0) {
        pushCsv(csvFiles, 'perplexity_sources', 'perplexity_sources',
          generatePerplexitySourcesCSV(scrubSources.rows), slug);
      }
      pushCsv(csvFiles, 'perplexity_messages_canonical', 'perplexity_messages_canonical',
        piiScrubEnabled
          ? generatePerplexityMessagesCanonicalCSV(scrubMessages.rows, { donorId, donorIdType, downloadTime })
          : result.messagesCanonicalCSV, slug);

      perSchemaValidation.perplexity_messages = validateRows(scrubMessages.rows, 'perplexity_messages');

    } else if (platform === 'grok') {
      const result = extractGrokConversation(conversationData, { donorId, donorIdType, downloadTime });

      const scrubMetadata = scrubRowsIfEnabled([result.metadata], piiScrubEnabled, piiScrubOptions, platform);
      mergeScrubCounts(piiStats, scrubMetadata);
      const scrubMessages = scrubRowsIfEnabled(result.messages, piiScrubEnabled, piiScrubOptions, platform);
      mergeScrubCounts(piiStats, scrubMessages);
      const scrubSources = scrubRowsIfEnabled(result.sources, piiScrubEnabled, piiScrubOptions, platform);
      mergeScrubCounts(piiStats, scrubSources);

      pushCsv(csvFiles, 'grok_metadata', 'grok_metadata',
        generateGrokMetadataCSV(scrubMetadata.rows[0] || result.metadata), slug);
      pushCsv(csvFiles, 'grok_messages', 'grok_messages',
        generateGrokMessagesCSV(scrubMessages.rows), slug);
      if (scrubSources.rows.length > 0) {
        pushCsv(csvFiles, 'grok_sources', 'grok_sources',
          generateGrokSourcesCSV(scrubSources.rows), slug);
      }
      pushCsv(csvFiles, 'grok_messages_canonical', 'grok_messages_canonical',
        cellScrubber
          ? generateGrokMessagesCanonicalCSV(conversationData, { donorId, donorIdType, downloadTime, scrubCell: cellScrubber })
          : result.messagesCanonicalCSV, slug);

      perSchemaValidation.grok_messages = validateRows(scrubMessages.rows, 'grok_messages');

    } else if (platform === 'deepseek') {
      const result = extractDeepSeekConversation(conversationData, { donorId, donorIdType, downloadTime });

      const scrubMetadata = scrubRowsIfEnabled([result.metadata], piiScrubEnabled, piiScrubOptions, platform);
      mergeScrubCounts(piiStats, scrubMetadata);
      const scrubMessages = scrubRowsIfEnabled(result.messages, piiScrubEnabled, piiScrubOptions, platform);
      mergeScrubCounts(piiStats, scrubMessages);
      const scrubSources = scrubRowsIfEnabled(result.sources, piiScrubEnabled, piiScrubOptions, platform);
      mergeScrubCounts(piiStats, scrubSources);

      pushCsv(csvFiles, 'deepseek_metadata', 'deepseek_metadata',
        generateDeepSeekMetadataCSV(scrubMetadata.rows[0] || result.metadata), slug);
      pushCsv(csvFiles, 'deepseek_messages', 'deepseek_messages',
        generateDeepSeekMessagesCSV(scrubMessages.rows), slug);
      if (scrubSources.rows.length > 0) {
        pushCsv(csvFiles, 'deepseek_sources', 'deepseek_sources',
          generateDeepSeekSourcesCSV(scrubSources.rows), slug);
      }
      pushCsv(csvFiles, 'deepseek_messages_canonical', 'deepseek_messages_canonical',
        cellScrubber
          ? generateDeepSeekMessagesCanonicalCSV(conversationData, { donorId, donorIdType, downloadTime, scrubCell: cellScrubber })
          : result.messagesCanonicalCSV, slug);

      perSchemaValidation.deepseek_messages = validateRows(scrubMessages.rows, 'deepseek_messages');

    } else if (platform === 'mistral') {
      const result = extractMistralConversation(conversationData, { donorId, donorIdType, downloadTime });

      const scrubMetadata = scrubRowsIfEnabled([result.metadata], piiScrubEnabled, piiScrubOptions, platform);
      mergeScrubCounts(piiStats, scrubMetadata);
      const scrubMessages = scrubRowsIfEnabled(result.messages, piiScrubEnabled, piiScrubOptions, platform);
      mergeScrubCounts(piiStats, scrubMessages);
      const scrubSources = scrubRowsIfEnabled(result.sources, piiScrubEnabled, piiScrubOptions, platform);
      mergeScrubCounts(piiStats, scrubSources);

      pushCsv(csvFiles, 'mistral_metadata', 'mistral_metadata',
        generateMistralMetadataCSV(scrubMetadata.rows[0] || result.metadata), slug);
      pushCsv(csvFiles, 'mistral_messages', 'mistral_messages',
        generateMistralMessagesCSV(scrubMessages.rows), slug);
      if (scrubSources.rows.length > 0) {
        pushCsv(csvFiles, 'mistral_sources', 'mistral_sources',
          generateMistralSourcesCSV(scrubSources.rows), slug);
      }
      pushCsv(csvFiles, 'mistral_messages_canonical', 'mistral_messages_canonical',
        cellScrubber
          ? generateMistralMessagesCanonicalCSV(conversationData, { donorId, donorIdType, downloadTime, scrubCell: cellScrubber })
          : result.messagesCanonicalCSV, slug);

      perSchemaValidation.mistral_messages = validateRows(scrubMessages.rows, 'mistral_messages');

    } else if (platform === 'copilot' || platform === 'm365_copilot' || platform === 'google_search') {
      const handler =
        platform === 'copilot' ? CopilotHandler :
        platform === 'm365_copilot' ? M365CopilotHandler :
        GoogleSearchHandler;
      const rawRows = handler.flattenConversationData(conversationData).map(row => ({
        donor_id: donorId,
        donor_id_type: donorIdType,
        download_time: downloadTime,
        ...row
      }));

      let canonicalKey, flatSchemaName, innerPrefix, canonicalInner;
      if (platform === 'copilot') {
        canonicalKey = 'copilot';
        flatSchemaName = 'copilot_conversation';
        innerPrefix = 'copilot_conversation';
        canonicalInner = 'copilot_messages_canonical';
      } else if (platform === 'm365_copilot') {
        canonicalKey = 'm365_copilot';
        flatSchemaName = 'm365_copilot_conversation';
        innerPrefix = 'm365_copilot_conversation';
        canonicalInner = 'm365_copilot_messages_canonical';
      } else {
        const isAIMode = conversationData.mode === 'ai_mode';
        canonicalKey = isAIMode ? 'google_ai_mode' : 'google_ai_overview';
        flatSchemaName = isAIMode ? 'google_ai_mode' : 'google_ai_overview';
        innerPrefix = flatSchemaName;
        canonicalInner = isAIMode ? 'google_ai_mode_canonical' : 'google_ai_overview_canonical';
        extractionTelemetry = conversationData.extraction_telemetry || null;
      }

      if (rawRows.length === 0) {
        // Every message failed to flatten (or the payload had none). Do not
        // ship an empty CSV; tell the popup instead.
        broadcastExportResult({
          platform,
          outcome: 'empty_export',
          reason: 'No messages could be extracted from this conversation'
        });
        return;
      }

      const scrubFlat = scrubRowsIfEnabled(rawRows, piiScrubEnabled, piiScrubOptions, platform);
      const scrubbedRows = scrubFlat.rows;
      mergeScrubCounts(piiStats, scrubFlat);

      pushCsv(csvFiles, innerPrefix, flatSchemaName, generateVersionedCSV(scrubbedRows, flatSchemaName), slug);

      const canonicalSchemaName = {
        copilot: 'copilot_messages_canonical',
        m365_copilot: 'm365_copilot_messages_canonical',
        google_ai_mode: 'google_ai_mode_canonical',
        google_ai_overview: 'google_ai_overview_canonical'
      }[canonicalKey];
      pushCsv(csvFiles, canonicalInner, canonicalSchemaName,
        buildCanonicalCSV(scrubbedRows, CANONICAL_MAPPINGS[canonicalKey], {
          donorId, donorIdType, downloadTime,
          platform: canonicalKey,
          schemaName: canonicalSchemaName
        }), slug);

      // Dedicated sources CSV for Google (parity with chatgpt_sources /
      // claude_sources). Only emit when there's actually at least one source.
      if (platform === 'google_search') {
        const sourceRows = GoogleSearchHandler.flattenSources(conversationData).map(r => ({
          donor_id: donorId,
          donor_id_type: donorIdType,
          download_time: downloadTime,
          ...r
        }));
        if (sourceRows.length > 0) {
          const scrubbedSources = scrubRowsIfEnabled(sourceRows, piiScrubEnabled, piiScrubOptions, platform);
          mergeScrubCounts(piiStats, scrubbedSources);
          pushCsv(csvFiles, 'google_sources', 'google_sources', generateGoogleSourcesCSV(scrubbedSources.rows), slug);
        }
      }

      if (platform === 'm365_copilot') {
        const sourceRows = M365CopilotHandler.flattenSources(conversationData).map(r => ({
          donor_id: donorId,
          donor_id_type: donorIdType,
          download_time: downloadTime,
          ...r
        }));
        if (sourceRows.length > 0) {
          const scrubbedSources = scrubRowsIfEnabled(sourceRows, piiScrubEnabled, piiScrubOptions, platform);
          mergeScrubCounts(piiStats, scrubbedSources);
          pushCsv(csvFiles, 'm365_copilot_sources', 'm365_copilot_sources',
            generateM365CopilotSourcesCSV(scrubbedSources.rows), slug);
        }
      }

      perSchemaValidation[flatSchemaName] = validateRows(scrubbedRows, flatSchemaName);

    } else {
      _console.error(`[${platform}] No handler found for platform`);
      return;
    }

    if (csvFiles.length === 0 || csvFiles.every(f => !f.content)) {
      _console.warn(`[${platform}] No data extracted from conversation`);
      broadcastExportResult({
        platform,
        outcome: 'empty_export',
        reason: 'No data could be extracted from this conversation'
      });
      return;
    }

    for (const f of csvFiles) f.rowCount = countRows(f.content);

    const conversationIdForManifest = conversationIdForNaming;

    // Build manifest using inner filenames (the archive paths) so the manifest
    // describes exactly what's in the zip the user downloads.
    const manifestExtras = {
      pii_scrub_enabled: piiScrubEnabled,
      pii_scrub_options: piiScrubEnabled ? piiScrubOptions : {},
      pii_ruleset_version: PII_RULESET_VERSION,
      pii_redactions_total: piiStats.total,
      pii_redactions_by_type: piiStats.byType,
      include_donor_context: includeDonorContext,
      consent_version: consentVersion,
      consent_given_at: consentGivenAt,
      orphaned_nodes: orphanCount,
      validation: summarizeValidation(perSchemaValidation),
      ...(extractionTelemetry ? { extraction_telemetry: extractionTelemetry } : {})
    };
    const manifestJson = await buildManifest({
      platform,
      conversationId: conversationIdForManifest,
      donorIdHashed,
      donorIdType,
      downloadTime,
      apiFormat,
      files: csvFiles.map(f => ({
        filename: f.innerName,
        content: f.content,
        schemaName: f.schemaName,
        rowCount: f.rowCount
      })),
      extras: manifestExtras
    });

    // Compose the ZIP. CSVs get a UTF-8 BOM so Excel renders them correctly
    // when a researcher opens the file straight from the archive. The manifest
    // name mirrors the CSV naming so it is also traceable back to the ZIP in
    // isolation.
    const manifestName = `${platform}_manifest_${slug}.json`;
    const zipEntries = [
      ...csvFiles.map(f => ({ name: f.innerName, content: UTF8_BOM + f.content })),
      { name: manifestName, content: manifestJson }
    ];
    const zipBytes = buildZip(zipEntries);
    const zipBlob = new Blob([zipBytes], { type: 'application/zip' });
    const url = URL.createObjectURL(zipBlob);

    const zipFilename = `${platform}_${slug}.zip`;

    browser.downloads.download({ url, filename: zipFilename, saveAs: false })
      .then((downloadId) => {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        // downloadId lets the popup's review step call downloads.show().
        broadcastExportResult({
          platform,
          outcome: 'success',
          filename: zipFilename,
          downloadId: typeof downloadId === 'number' ? downloadId : null
        });
      })
      .catch(error => {
        _console.error(`[${platform}] Download failed:`, error);
        URL.revokeObjectURL(url);
        broadcastExportResult({
          platform,
          outcome: 'download_failed',
          reason: sanitizeErrorMessage(error && (error.message || String(error))) || 'Download failed',
          filename: zipFilename
        });
      });
  } catch (error) {
    _console.error(`[${platform}] Error processing conversation data:`, error);
    broadcastExportResult({
      platform,
      outcome: 'processing_failed',
      reason: sanitizeErrorMessage(error && (error.message || String(error))) || 'Processing failed'
    });
    // Re-throw so the message-listener's .catch() sets the toolbar '!' badge.
    throw error;
  }
}

/**
 * Fire a one-way runtime message any open popup / dev harness can listen
 * for. Returns no value; caller doesn't await. Safe to call even when no
 * listeners are attached — the promise rejection is intentionally
 * swallowed so a missing popup doesn't look like a background error.
 */
function broadcastExportResult(detail) {
  try {
    browser.runtime.sendMessage({ type: 'EXPORT_RESULT', detail }).catch(() => {});
  } catch (_) { /* no listener attached; expected when popup is closed */ }
}

const MESSAGE_TYPE_TO_PLATFORM = {
  CHATGPT_CONVERSATION_DATA: 'chatgpt',
  CLAUDE_CONVERSATION_DATA: 'claude',
  COPILOT_CONVERSATION_DATA: 'copilot',
  M365_COPILOT_CONVERSATION_DATA: 'm365_copilot',
  PERPLEXITY_CONVERSATION_DATA: 'perplexity',
  GROK_CONVERSATION_DATA: 'grok',
  DEEPSEEK_CONVERSATION_DATA: 'deepseek',
  MISTRAL_CONVERSATION_DATA: 'mistral',
  GOOGLE_SEARCH_AI_OVERVIEW_DATA: 'google_search'
};

// Content-script-authored messages that aren't conversation-data payloads.
// These go through the same sender validation but take a separate branch.
const AUTH_MESSAGE_TYPES = new Set(['AUTH_FAILED', 'AUTH_RECOVERED']);

// Per-tab auth-failure state. Keyed by tabId, value: {platform, where, since}.
// Set by AUTH_FAILED, cleared by AUTH_RECOVERED, tabs.onUpdated (url change
// or status 'loading'), and tabs.onRemoved. The popup reads this on open
// via GET_AUTH_STATE so a user who dismissed the previous popup still sees
// the sign-in message on the next open — not just while a popup happens
// to be live when the 401 fires.
const authFailureByTab = new Map();

function senderHostnameMatchesPlatform(hostname, platformId) {
  const platform = EXTENSION_CONFIG.platforms[platformId];
  if (!platform || !platform.enabled) return false;
  const domains = platform.domains || [];
  return domains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!sender || sender.id !== browser.runtime.id) {
    _console.warn('[Background] Message from unauthorized sender:', sender?.id);
    return false;
  }
  if (!message || typeof message.type !== 'string') {
    _console.warn('[Background] Invalid message structure');
    return false;
  }

  // Popup-authored read: "does this tab currently have a stored auth
  // failure?" Popup uses this on open so it can show the sign-in message
  // without needing to wait for a fresh 401 round-trip.
  if (message.type === 'GET_AUTH_STATE') {
    // Only the popup asks this, and the popup has no sender.tab. A content
    // script always has one and must not be able to read another tab's
    // auth state, so reject anything that arrives from a tab.
    if (sender.tab) {
      _console.warn('[Background] GET_AUTH_STATE from a tab rejected');
      return false;
    }
    const tabId = typeof message.tabId === 'number' ? message.tabId : null;
    const state = (tabId != null) ? authFailureByTab.get(tabId) : null;
    return Promise.resolve(state
      ? { authFailed: true, platform: state.platform, where: state.where, since: state.since }
      : { authFailed: false });
  }

  // Content-script-authored auth signal. Validated identically to the
  // conversation-data path: must be top frame of a tab whose URL hostname
  // matches the claimed platform (so e.g. a chat.deepseek.com content
  // script can't impersonate claude).
  if (AUTH_MESSAGE_TYPES.has(message.type)) {
    const platformId = message.platform;
    if (!platformId) {
      _console.warn('[Background] Auth message missing platform');
      return false;
    }
    if (!sender.tab || typeof sender.tab.url !== 'string') {
      _console.warn('[Background] Auth message without tab origin');
      return false;
    }
    if (sender.frameId !== 0) {
      _console.warn('[Background] Auth message from subframe rejected');
      return false;
    }
    let authSenderUrl;
    try { authSenderUrl = new URL(sender.tab.url); } catch { return false; }
    if (authSenderUrl.protocol !== 'https:') return false;
    if (!senderHostnameMatchesPlatform(authSenderUrl.hostname, platformId)) {
      _console.warn('[Background] Auth message platform/host mismatch');
      return false;
    }
    const tabId = sender.tab.id;
    if (message.type === 'AUTH_FAILED') {
      authFailureByTab.set(tabId, {
        platform: platformId,
        where: (message.detail && typeof message.detail.where === 'string') ? message.detail.where : null,
        since: Date.now()
      });
      broadcastExportResult({ platform: platformId, outcome: 'auth_failed' });
    } else { // AUTH_RECOVERED
      authFailureByTab.delete(tabId);
      broadcastExportResult({ platform: platformId, outcome: 'auth_recovered' });
    }
    return false;
  }

  const expectedPlatform = MESSAGE_TYPE_TO_PLATFORM[message.type];
  if (!expectedPlatform) {
    return false;
  }

  if (!sender.tab || typeof sender.tab.url !== 'string') {
    _console.warn('[Background] Privileged message without tab origin');
    return false;
  }

  if (sender.frameId !== 0) {
    _console.warn('[Background] Privileged message from subframe rejected');
    return false;
  }

  let senderUrl;
  try {
    senderUrl = new URL(sender.tab.url);
  } catch {
    _console.warn('[Background] Invalid URL in sender tab');
    return false;
  }

  if (senderUrl.protocol !== 'https:') {
    _console.warn('[Background] Non-https sender rejected');
    return false;
  }

  if (!senderHostnameMatchesPlatform(senderUrl.hostname, expectedPlatform)) {
    _console.warn('[Background] Message type does not match sender origin');
    return false;
  }

  const tabId = sender.tab.id;
  handleConversationData({ platform: expectedPlatform, payload: message.payload, conversationId: message.conversationId })
    .then((result) => {
      // Clear any stale "!" badge from a previous failed export on this tab.
      if (typeof tabId === 'number') clearExportFailureBadge(tabId);
      return result;
    })
    .catch((err) => {
      _console.error(`[${expectedPlatform}] Conversation handling failed:`, err);
      if (typeof tabId === 'number') setExportFailureBadge(tabId);
    });
  return false;
});

_console.log('AI Chat Exporter: Main background script loaded at ' + new Date().toISOString());

self.addEventListener('unhandledrejection', event => {
  _console.error('[Background] Unhandled rejection:', event.reason);
});

// ---------------------------------------------------------------------------
// Programmatic content script registration for Perplexity.
//
// The manifest `content_scripts` entries for Perplexity do not reliably take
// effect in some Firefox builds, even though structurally identical entries
// work for every other platform. Registering the same scripts via
// `browser.scripting.registerContentScripts` at background startup bypasses
// whatever is going wrong at manifest-parse time.
//
// This is additive: if the manifest entries also fire, Firefox dedupes
// matching script IDs so we never double-inject.
// ---------------------------------------------------------------------------

(async function ensurePerplexityContentScripts() {
  const scripting = typeof browser !== 'undefined' ? browser.scripting : null;
  if (!scripting || typeof scripting.registerContentScripts !== 'function') {
    _console.warn('[Background] browser.scripting unavailable; relying on manifest content_scripts');
    return;
  }

  const scripts = [
    {
      id: 'perplexity-main-world',
      matches: ['https://www.perplexity.ai/*'],
      js: ['shared/message-security.js', 'platforms/perplexity/inject.js'],
      runAt: 'document_start',
      world: 'MAIN',
      persistAcrossSessions: true
    },
    {
      id: 'perplexity-isolated-world',
      matches: ['https://www.perplexity.ai/*'],
      js: ['shared/message-security.js', 'platforms/perplexity/content.js'],
      runAt: 'document_start',
      world: 'ISOLATED',
      persistAcrossSessions: true
    }
  ];

  try {
    const existing = await scripting.getRegisteredContentScripts({
      ids: scripts.map(s => s.id)
    });
    const existingIds = new Set(existing.map(s => s.id));
    if (existingIds.size > 0) {
      await scripting.unregisterContentScripts({ ids: Array.from(existingIds) });
    }
    await scripting.registerContentScripts(scripts);
    _console.log('[Background] Perplexity content scripts registered via scripting API');
  } catch (err) {
    _console.error('[Background] Failed to register Perplexity content scripts:', err);
  }

  // Belt-and-suspenders: also hook navigation and inject on each page load.
  // If both the manifest entries AND the registerContentScripts path have
  // somehow been ignored, this at least gets the scripts into the page the
  // moment Firefox tells us it's committed to a navigation.
  try {
    browser.tabs.onUpdated.addListener(async (tabId, info, tab) => {
      try {
        if (!tab || typeof tab.url !== 'string') return;
        if (!tab.url.startsWith('https://www.perplexity.ai/')) return;
        if (info.status !== 'loading') return;
        _console.log('[Background] perplexity tab loading, injecting via executeScript', { tabId });
        await scripting.executeScript({
          target: { tabId },
          files: ['shared/message-security.js', 'platforms/perplexity/inject.js'],
          world: 'MAIN',
          injectImmediately: true
        });
        await scripting.executeScript({
          target: { tabId },
          files: ['shared/message-security.js', 'platforms/perplexity/content.js'],
          world: 'ISOLATED',
          injectImmediately: true
        });
        _console.log('[Background] perplexity executeScript succeeded for tab', tabId);
      } catch (err) {
        _console.error('[Background] perplexity executeScript failed:', err && (err.message || err));
      }
    });
    _console.log('[Background] perplexity tab-navigation injector installed');
  } catch (err) {
    _console.error('[Background] could not install tab-navigation injector:', err);
  }
})();

// ---------------------------------------------------------------------------
// Toolbar icon state
//
// Reflect per-tab platform support in the toolbar icon + title. Color icon
// when the active tab is on one of EXTENSION_CONFIG.platforms' domains;
// greyed-out icon otherwise. setTitle always carries a text explanation so
// the state is never communicated by color alone (WCAG 1.4.1 — use of
// color), and the title is what macOS VoiceOver / NVDA / Jaws read out
// when the toolbar button receives focus.
//
// No `tabs` permission: Firefox only exposes `tab.url` / `info.url` for
// tabs whose URL is covered by host_permissions, which is exactly the set
// of supported sites. An undefined URL therefore means "not a supported
// page" and gets the grey icon. The listeners below re-evaluate on every
// status change as well as on URL changes, so a tab that navigates from a
// supported site to an unsupported one (where no URL is delivered) still
// turns grey.
//
// Badges are reserved for conditions that need user attention: a '!'
// appears when the most recent export on the tab failed. The badge
// clears on the next successful export or navigation.
// ---------------------------------------------------------------------------

const ICON_PATHS_COLOR = {
  16:  'icons/icon-16.png',
  32:  'icons/icon-32.png',
  48:  'icons/icon-48.png',
  96:  'icons/icon-96.png',
  128: 'icons/icon-128.png'
};
const ICON_PATHS_GREY = {
  16:  'icons/icon-16-grey.png',
  32:  'icons/icon-32-grey.png',
  48:  'icons/icon-48-grey.png',
  96:  'icons/icon-96-grey.png',
  128: 'icons/icon-128-grey.png'
};

// Display names come from config/settings.js so this list can never drift
// from the popup's.
const SUPPORTED_NAMES = Object.values(EXTENSION_CONFIG.platforms)
  .filter(p => p.enabled)
  .map(p => p.name);
const UNSUPPORTED_TITLE =
  'AI Chat Exporter — this page is not supported. Supported sites: ' +
  SUPPORTED_NAMES.slice(0, -1).join(', ') + ', and ' + SUPPORTED_NAMES[SUPPORTED_NAMES.length - 1] + '.';

async function applyIconStateForTab(tabId, url) {
  const action = typeof browser !== 'undefined' ? browser.action : null;
  if (!action) return;
  const platform = (typeof url === 'string') ? getPlatformByUrl(url) : null;
  try {
    if (platform) {
      await action.setIcon({ tabId, path: ICON_PATHS_COLOR });
      await action.setTitle({
        tabId,
        title: `AI Chat Exporter — ready to export this ${platform.name} conversation.`
      });
    } else {
      await action.setIcon({ tabId, path: ICON_PATHS_GREY });
      await action.setTitle({ tabId, title: UNSUPPORTED_TITLE });
    }
  } catch (_) {
    // Per-tab setIcon can throw on about:/moz-extension: tabs. Not a
    // user-facing problem; silently fall back to the default icon.
  }
}

async function setExportFailureBadge(tabId) {
  const action = typeof browser !== 'undefined' ? browser.action : null;
  if (!action) return;
  try {
    await action.setBadgeText({ tabId, text: '!' });
    if (typeof action.setBadgeBackgroundColor === 'function') {
      // Firefox-friendly: provide an rgba array, not a hex string.
      await action.setBadgeBackgroundColor({ tabId, color: [215, 0, 34, 255] });
    }
  } catch (_) { /* ignore */ }
}

async function clearExportFailureBadge(tabId) {
  const action = typeof browser !== 'undefined' ? browser.action : null;
  if (!action) return;
  try { await action.setBadgeText({ tabId, text: '' }); } catch (_) { /* ignore */ }
}

try {
  // URL or load-status change → re-evaluate the icon + clear per-tab auth
  // state. `tab.url` is undefined for pages outside host_permissions, which
  // applyIconStateForTab treats as unsupported.
  browser.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (!info) return;
    const urlChanged = typeof info.url === 'string';
    if (urlChanged || info.status === 'loading' || info.status === 'complete') {
      applyIconStateForTab(tabId, urlChanged ? info.url : (tab && tab.url));
    }
    if (urlChanged) {
      // The user navigated; previous auth-failed state no longer applies
      // on this tab (they may have signed in, moved to a different site,
      // etc.). Dropping the entry lets the next 401 on this tab re-notify.
      authFailureByTab.delete(tabId);
    }
    // Clear stale "!" when the tab finishes loading a new page.
    if (info.status === 'complete') {
      clearExportFailureBadge(tabId);
    }
    // A tab that is actively loading has fresh cookies; the previous
    // 401 may now resolve to 200. Clear so popup opened mid-reload
    // doesn't flash a stale sign-in message.
    if (info.status === 'loading') {
      authFailureByTab.delete(tabId);
    }
  });

  // Tab closed → drop its auth state (no lingering memory).
  if (browser.tabs.onRemoved && browser.tabs.onRemoved.addListener) {
    browser.tabs.onRemoved.addListener((tabId) => {
      authFailureByTab.delete(tabId);
    });
  }

  // Tab switch → read the new tab's URL and re-apply.
  browser.tabs.onActivated.addListener(async ({ tabId }) => {
    try {
      const tab = await browser.tabs.get(tabId);
      applyIconStateForTab(tabId, tab && tab.url);
    } catch (_) { /* ignore permission denials */ }
  });

  // On startup / install, paint every open tab's icon so there's no
  // flash of the default color icon on an unsupported site.
  (async () => {
    try {
      const tabs = await browser.tabs.query({});
      for (const tab of tabs) {
        if (typeof tab.id === 'number') applyIconStateForTab(tab.id, tab.url);
      }
    } catch (_) { /* ignore */ }
  })();
} catch (err) {
  _console.error('[Background] could not install icon-state listeners:', err);
}
