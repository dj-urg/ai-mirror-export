/**
 * AI Chat Exporter - ChatGPT Extractor Module
 *
 * Generates five CSV files from a ChatGPT conversation JSON:
 *   CSV A: Conversation metadata        (one row per conversation)
 *   CSV B: Conversation messages        (one row per message/node)
 *   CSV C: Sources                      (one row per source: search results + citations)
 *   CSV D: Message URLs                 (one row per URL from safe_urls)
 *   CSV E: Donor context                (user profile and model instructions)
 *
 * Supports two ChatGPT API formats:
 *   Old format: { mapping: { nodeId: { id, message, parent, children } }, ... }
 *   New format: { messages: [ { id, author, content, metadata } ], safe_urls, ... }
 */
import { escapeCSVField } from '../../utils/csv.js';


// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Safely get nested property from object
 */
function safeGet(obj, path, defaultValue = '') {
    try {
        return path.split('.').reduce((acc, part) => acc?.[part], obj) ?? defaultValue;
    } catch {
        return defaultValue;
    }
}

/**
 * Convert a Unix timestamp (seconds, possibly fractional) to an ISO 8601 string.
 * Returns '' for null, undefined, 0, or any falsy value.
 */
function unixToISO(ts) {
    if (!ts) return '';
    return new Date(ts * 1000).toISOString();
}

/**
 * Strip UTM tracking parameters from a URL.
 * Falls back to the original string if parsing fails.
 */
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

/**
 * BFS from the root node (parent === null) to compute tree depth for every
 * reachable node. Returns a Map of nodeId -> depth (0-based).
 * Nodes not reachable from root (orphans in branched/deleted threads) are absent
 * from the Map and will receive turn_number = '' in CSV B.
 */
function computeNodeDepths(mapping) {
    const depths = new Map();
    let rootId = null;
    for (const nodeId in mapping) {
        if (!mapping[nodeId].parent) {
            rootId = nodeId;
            break;
        }
    }
    if (!rootId) return depths;

    const queue = [[rootId, 0]];
    while (queue.length > 0) {
        const [nodeId, depth] = queue.shift();
        depths.set(nodeId, depth);
        for (const childId of (mapping[nodeId].children || [])) {
            queue.push([childId, depth + 1]);
        }
    }
    return depths;
}

/**
 * Normalize a conversation into a unified flat array of node objects,
 * regardless of whether the data uses the old mapping format or the new
 * messages array format.
 *
 * Each returned object has the shape:
 *   { nodeId: string, message: object, parent: string|null, depth: number|'' }
 *
 * Old mapping format: BFS from root to compute depth; parent from node.parent.
 * New messages array: array index used as depth; parent from message.metadata.parent_id.
 */
function normalizeMessages(conversationData) {
    // Old format: mapping object keyed by node ID
    if (conversationData.mapping && typeof conversationData.mapping === 'object') {
        const mapping = conversationData.mapping;
        const nodeDepths = computeNodeDepths(mapping);
        const nodes = [];
        for (const nodeId in mapping) {
            const node = mapping[nodeId];
            nodes.push({
                nodeId,
                message: node.message || null,
                parent: node.parent || null,
                depth: nodeDepths.has(nodeId) ? nodeDepths.get(nodeId) : ''
            });
        }
        return nodes;
    }

    // New format: flat messages array in chronological order
    if (Array.isArray(conversationData.messages)) {
        return conversationData.messages.map((message, index) => ({
            nodeId: message.id || String(index),
            message,
            parent: message.metadata?.parent_id || null,
            depth: index
        }));
    }

    return [];
}

/**
 * Extract text content from message content object
 */
function extractTextFromContent(content) {
    if (!content) return '';

    const contentType = content.content_type;

    if (contentType === 'text' && Array.isArray(content.parts)) {
        return content.parts.join('\n');
    }
    if (contentType === 'multimodal_text' && Array.isArray(content.parts)) {
        return content.parts
            .filter(part => typeof part === 'string' || part.content_type === 'text')
            .map(part => typeof part === 'string' ? part : part.text || '')
            .join('\n');
    }
    if (contentType === 'thoughts' && Array.isArray(content.thoughts)) {
        // Use summary (non-empty label) with fallback to content
        return content.thoughts.map(thought => thought.summary || thought.content || '').join('\n\n');
    }
    if (contentType === 'reasoning_recap') {
        // New format: content.content is a plain string; old format used content.parts
        if (typeof content.content === 'string') return content.content;
        if (Array.isArray(content.parts)) return content.parts.join('\n');
    }
    if (contentType === 'execution_output') return content.text || '';
    if (contentType === 'code') return content.text || '';
    if (contentType === 'user_editable_context') return '';
    if (contentType === 'model_editable_context') return '';

    return '';
}

/**
 * Check if message content contains images
 */
function hasImages(content) {
    if (!content || content.content_type !== 'multimodal_text') return false;
    if (!Array.isArray(content.parts)) return false;
    return content.parts.some(
        part => part && typeof part === 'object' && part.content_type === 'image_asset_pointer'
    );
}

/**
 * Extract image IDs from multimodal content
 */
function extractImageIds(content) {
    if (!content || content.content_type !== 'multimodal_text') return '';
    if (!Array.isArray(content.parts)) return '';
    return content.parts
        .filter(part => part?.content_type === 'image_asset_pointer')
        .map(part => part.asset_pointer || '')
        .filter(Boolean)
        .join(',');
}

/**
 * Extract user profile from normalized nodes array (clean text only)
 */
function extractUserProfile(nodes) {
    for (const { message } of nodes) {
        if (message?.content?.content_type === 'user_editable_context') {
            const meta = message.metadata?.user_context_message_data;
            if (meta?.about_user_message) return meta.about_user_message.trim();
            const profile = message.content.user_profile || '';
            const match = profile.match(/User profile:\s*```(.+?)```/s);
            return match ? match[1].trim() : '';
        }
    }
    return '';
}

/**
 * Extract user instructions from normalized nodes array (clean text only)
 */
function extractUserInstructions(nodes) {
    for (const { message } of nodes) {
        if (message?.content?.content_type === 'user_editable_context') {
            const meta = message.metadata?.user_context_message_data;
            if (meta?.about_model_message) return meta.about_model_message.trim();
            const instructions = message.content.user_instructions || '';
            const match = instructions.match(/```(.+?)```/s);
            return match ? match[1].trim() : '';
        }
    }
    return '';
}

/**
 * Count messages by role from normalized nodes array
 */
function countMessagesByRole(nodes, role) {
    let count = 0;
    for (const { message } of nodes) {
        if (message?.author?.role === role) count++;
    }
    return count;
}

/**
 * Count all messages (excluding user_editable_context and model_editable_context)
 * from normalized nodes array
 */
function countAllMessages(nodes) {
    let count = 0;
    for (const { message } of nodes) {
        if (message?.content) {
            const ct = message.content.content_type;
            if (ct !== 'user_editable_context' && ct !== 'model_editable_context') count++;
        }
    }
    return count;
}

/**
 * Get default model slug from conversation data and normalized nodes array
 */
function getDefaultModelSlug(conversationData, nodes) {
    for (const { message } of nodes) {
        const slug = message?.metadata?.resolved_model_slug
            || message?.metadata?.model_slug
            || message?.metadata?.default_model_slug;
        if (slug) return slug;
    }
    return '';
}


// ============================================================================
// CSV A: CONVERSATION METADATA
// ============================================================================

/**
 * Extract conversation metadata for CSV A.
 * user_profile and user_instructions are moved to CSV E (donor context).
 */
function extractConversationMetadata(conversationData) {
    const nodes = normalizeMessages(conversationData);

    return {
        conversation_id: conversationData.conversation_id || conversationData.id || '',
        title: conversationData.title || '',
        create_time: unixToISO(conversationData.create_time),
        update_time: unixToISO(conversationData.update_time),
        default_model_slug: conversationData.default_model_slug || getDefaultModelSlug(conversationData, nodes),
        memory_scope: conversationData.memory_scope || '',
        is_do_not_remember: Boolean(conversationData.is_do_not_remember),
        num_messages: countAllMessages(nodes),
        num_user_messages: countMessagesByRole(nodes, 'user'),
        num_assistant_messages: countMessagesByRole(nodes, 'assistant'),
        num_tool_messages: countMessagesByRole(nodes, 'tool')
    };
}

/**
 * Generate CSV A: Conversation Metadata
 */
function generateMetadataCSV(metadata) {
    const headers = [
        'donor_id',
        'donor_id_type',
        'download_time',
        'conversation_id',
        'title',
        'create_time',
        'update_time',
        'default_model_slug',
        'memory_scope',
        'is_do_not_remember',
        'num_messages',
        'num_user_messages',
        'num_assistant_messages',
        'num_tool_messages'
    ];

    const row = headers.map(h => escapeCSVField(metadata[h]));
    return [headers.join(','), row.join(',')].join('\n');
}


// ============================================================================
// CSV B: CONVERSATION MESSAGES
// ============================================================================

/**
 * Extract all messages from conversation for CSV B.
 * Includes turn_number (BFS depth from root / array index) and parent_id.
 * safe_urls are moved to CSV D.
 */
function extractConversationMessages(conversationData) {
    const messages = [];
    const nodes = normalizeMessages(conversationData);
    const conversationId = conversationData.conversation_id || conversationData.id || '';

    for (const { nodeId, message, parent, depth } of nodes) {
        if (!message) continue;

        const content = message.content;
        const contentType = content?.content_type || '';

        if (contentType === 'user_editable_context' || contentType === 'model_editable_context') continue;

        const authorRole = message.author?.role || '';

        messages.push({
            conversation_id: conversationId,
            node_id: message.id || nodeId,
            parent_id: parent || '',
            turn_number: depth,
            author_role: authorRole,
            content_type: contentType,
            text: extractTextFromContent(content),
            has_image: hasImages(content),
            image_ids: extractImageIds(content),
            create_time: unixToISO(message.create_time),
            status: message.status || '',
            end_turn: message.end_turn !== null && message.end_turn !== undefined
                ? Boolean(message.end_turn) : '',
            is_visually_hidden: Boolean(message.metadata?.is_visually_hidden_from_conversation),
            model_slug: message.metadata?.resolved_model_slug || message.metadata?.model_slug || '',
            tool_name: authorRole === 'tool' ? (message.author?.name || '') : ''
        });
    }

    return messages;
}

/**
 * Generate CSV B: Conversation Messages
 */
function generateMessagesCSV(messages) {
    const headers = [
        'donor_id',
        'donor_id_type',
        'download_time',
        'conversation_id',
        'message_id',
        'parent_id',
        'turn_number',
        'author_role',
        'tool_name',
        'content_type',
        'text',
        'create_time',
        'model_slug'
    ];

    const rows = [headers.join(',')];

    for (const msg of messages) {
        const row = {
            donor_id: msg.donor_id,
            donor_id_type: msg.donor_id_type,
            download_time: msg.download_time,
            conversation_id: msg.conversation_id,
            message_id: msg.node_id,
            parent_id: msg.parent_id,
            turn_number: msg.turn_number,
            author_role: msg.author_role,
            tool_name: msg.tool_name,
            content_type: msg.content_type,
            text: msg.text,
            create_time: msg.create_time,
            model_slug: msg.model_slug
        };
        rows.push(headers.map(h => escapeCSVField(row[h])).join(','));
    }

    return rows.join('\n');
}


// ============================================================================
// CSV C: SOURCES
// ============================================================================

/**
 * Flatten all source entries from a conversation into a single list.
 *
 * Two source_list values, each taken directly from the JSON structure:
 *   search_result    — entry.type value in search_result_groups entries
 *   grouped_webpages — ref.type value in content_references
 *
 * url_clean strips UTM tracking parameters for deduplication and analysis.
 *
 * Works with both old (mapping) and new (messages array) formats:
 * - search_result_groups and content_references are in message.metadata in both formats
 */
function extractSearchResults(conversationData) {
    const results = [];
    const nodes = normalizeMessages(conversationData);
    const conversationId = conversationData.conversation_id || conversationData.id || '';

    for (const { nodeId, message } of nodes) {
        if (!message) continue;

        const messageId = message.id || nodeId;

        // --- search_result_groups ---
        const groups = message.metadata?.search_result_groups;
        if (Array.isArray(groups)) {
            for (const group of groups) {
                if (!Array.isArray(group.entries)) continue;
                for (const entry of group.entries) {
                    results.push({
                        conversation_id: conversationId,
                        message_id: messageId,
                        source_list: 'search_result',
                        type: entry.type || '',
                        url: entry.url || '',
                        url_clean: stripUtmParams(entry.url),
                        title: entry.title || '',
                        snippet: entry.snippet || '',
                        ref_turn_index: entry.ref_id?.turn_index ?? '',
                        ref_type: entry.ref_id?.ref_type || '',
                        ref_index: entry.ref_id?.ref_index ?? '',
                        pub_date: unixToISO(entry.pub_date),
                        attribution: entry.attribution || ''
                    });
                }
            }
        }

        // --- content_references (grouped_webpages) ---
        // Can appear in either the content object or metadata depending on message type
        const contentRefs =
            message.content?.content_references ||
            message.metadata?.content_references;

        if (Array.isArray(contentRefs)) {
            for (const ref of contentRefs) {
                if (ref.type !== 'grouped_webpages') continue;

                // Inner array is called "items" in grouped_webpages
                const items = ref.items || ref.entries || ref.webpages || ref.results || [];
                if (!Array.isArray(items)) continue;

                for (const item of items) {
                    // grouped_webpages use a refs[] array; search_result entries use a ref_id object
                    const refId = item.ref_id || item.refs?.[0] || {};

                    results.push({
                        conversation_id: conversationId,
                        message_id: messageId,
                        source_list: 'grouped_webpages',
                        type: '',
                        url: item.url || '',
                        url_clean: stripUtmParams(item.url),
                        title: item.title || '',
                        snippet: item.snippet || '',
                        ref_turn_index: refId.turn_index ?? '',
                        ref_type: refId.ref_type || '',
                        ref_index: refId.ref_index ?? '',
                        pub_date: unixToISO(item.pub_date),
                        attribution: item.attribution || ''
                    });

                }
            }
        }
    }

    return results;
}

/**
 * Generate CSV C: Sources
 */
function generateSearchResultsCSV(searchResults) {
    const headers = [
        'donor_id',
        'donor_id_type',
        'download_time',
        'conversation_id',
        'message_id',
        'source_list',
        'type',
        'url',
        'url_clean',
        'title',
        'snippet',
        'ref_turn_index',
        'ref_type',
        'ref_index',
        'pub_date',
        'attribution'
    ];

    const rows = [headers.join(',')];
    for (const entry of searchResults) {
        rows.push(headers.map(h => escapeCSVField(entry[h])).join(','));
    }
    return rows.join('\n');
}


// ============================================================================
// CSV D: MESSAGE URLs
// ============================================================================

/**
 * Normalize safe_urls from a conversation into one row per URL.
 * url_clean strips UTM parameters and is used for deduplication, so the same
 * article URL with and without ?utm_source=chatgpt.com produces only one row.
 *
 * URL sources (checked in priority order per message):
 *   1. message.metadata.content_references[].safe_urls  (new format, per message)
 *   2. message.metadata.safe_urls                        (old format, per message)
 *
 * Image CDN URLs (images.openai.com) are excluded — they are article thumbnails,
 * not links shared in the conversation.
 */
function extractMessageUrls(conversationData) {
    const urlRows = [];
    const seen = new Set();
    const nodes = normalizeMessages(conversationData);
    const conversationId = conversationData.conversation_id || conversationData.id || '';

    function isImageUrl(url) {
        return url.includes('images.openai.com') ||
            /\.(jpg|jpeg|png|gif|webp|svg|ico)(\?|$)/i.test(url);
    }

    function addUrl(messageId, url) {
        if (!url || isImageUrl(url)) return;
        const clean = stripUtmParams(url);
        const key = `${messageId}\x00${clean}`;
        if (seen.has(key)) return;
        seen.add(key);
        urlRows.push({
            conversation_id: conversationId,
            message_id: messageId,
            url,
            url_clean: clean
        });
    }

    for (const { nodeId, message } of nodes) {
        if (!message) continue;

        const messageId = message.id || nodeId;

        // 1. New format: safe_urls inside content_references entries
        const contentRefs = message.metadata?.content_references;
        if (Array.isArray(contentRefs)) {
            for (const ref of contentRefs) {
                if (Array.isArray(ref.safe_urls)) {
                    for (const url of ref.safe_urls) {
                        addUrl(messageId, url);
                    }
                }
            }
        }

        // 2. Old format: safe_urls directly on message metadata
        const metaSafeUrls = message.metadata?.safe_urls;
        if (Array.isArray(metaSafeUrls)) {
            for (const url of metaSafeUrls) {
                addUrl(messageId, url);
            }
        }
    }

    return urlRows;
}

/**
 * Generate CSV D: Message URLs
 */
function generateMessageUrlsCSV(urlRows) {
    const headers = [
        'donor_id',
        'donor_id_type',
        'download_time',
        'conversation_id',
        'message_id',
        'url',
        'url_clean'
    ];

    const rows = [headers.join(',')];
    for (const entry of urlRows) {
        rows.push(headers.map(h => escapeCSVField(entry[h])).join(','));
    }
    return rows.join('\n');
}


// ============================================================================
// CSV E: DONOR CONTEXT
// ============================================================================

/**
 * Extract user profile and model instructions for CSV E.
 * Separated from conversation metadata to avoid repeating PII across every
 * conversation row and to make the donor-level scope explicit.
 */
function extractDonorContext(conversationData) {
    const nodes = normalizeMessages(conversationData);
    return {
        conversation_id: conversationData.conversation_id || conversationData.id || '',
        user_profile: extractUserProfile(nodes),
        user_instructions: extractUserInstructions(nodes)
    };
}

/**
 * Generate CSV E: Donor Context
 */
function generateDonorContextCSV(donorContext) {
    const headers = [
        'donor_id',
        'donor_id_type',
        'download_time',
        'conversation_id',
        'user_profile',
        'user_instructions'
    ];

    const row = headers.map(h => escapeCSVField(donorContext[h]));
    return [headers.join(','), row.join(',')].join('\n');
}


// ============================================================================
// MAIN EXPORT FUNCTION
// ============================================================================

/**
 * Process a ChatGPT conversation JSON and generate all CSV files.
 * Supports both the old mapping-based format and the new messages-array format.
 * @param {Object} conversationData - The full ChatGPT conversation JSON object
 * @param {Object} options - { donorId, donorIdType, downloadTime }
 * @returns {Object} metadataCSV, messagesCSV, sourcesCSV, messageUrlsCSV,
 *                   donorContextCSV, and the raw data arrays for each
 */
function extractChatGPTConversation(conversationData, { donorId = '', donorIdType = '', downloadTime = '' } = {}) {
    if (!conversationData) {
        throw new Error('Invalid ChatGPT conversation data');
    }

    // Both mapping (old API) and messages (new API) are optional;
    // normalizeMessages() returns [] for unknown formats and CSVs will be empty rows.

    const metadata = extractConversationMetadata(conversationData);
    metadata.donor_id = donorId;
    metadata.donor_id_type = donorIdType;
    metadata.download_time = downloadTime;

    const messages = extractConversationMessages(conversationData);
    messages.forEach(msg => {
        msg.donor_id = donorId;
        msg.donor_id_type = donorIdType;
        msg.download_time = downloadTime;
    });

    const searchResults = extractSearchResults(conversationData);
    searchResults.forEach(entry => {
        entry.donor_id = donorId;
        entry.donor_id_type = donorIdType;
        entry.download_time = downloadTime;
    });

    const messageUrls = extractMessageUrls(conversationData);
    messageUrls.forEach(entry => {
        entry.donor_id = donorId;
        entry.donor_id_type = donorIdType;
        entry.download_time = downloadTime;
    });

    const donorContext = extractDonorContext(conversationData);
    donorContext.donor_id = donorId;
    donorContext.donor_id_type = donorIdType;
    donorContext.download_time = downloadTime;

    return {
        metadataCSV: generateMetadataCSV(metadata),
        messagesCSV: generateMessagesCSV(messages),
        sourcesCSV: generateSearchResultsCSV(searchResults),
        messageUrlsCSV: generateMessageUrlsCSV(messageUrls),
        donorContextCSV: generateDonorContextCSV(donorContext),
        metadata,
        messages,
        searchResults,
        messageUrls,
        donorContext
    };
}


// ============================================================================
// EXPORTS
// ============================================================================

export {
    extractChatGPTConversation,
    extractConversationMetadata,
    extractConversationMessages,
    extractSearchResults,
    extractMessageUrls,
    extractDonorContext,
    generateMetadataCSV,
    generateMessagesCSV,
    generateSearchResultsCSV,
    generateMessageUrlsCSV,
    generateDonorContextCSV
};
