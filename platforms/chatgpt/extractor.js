/**
 * AI Chat Exporter - ChatGPT Extractor Module
 *
 * Generates five CSV files from a ChatGPT conversation JSON:
 *   CSV A: Conversation metadata        (one row per conversation)
 *   CSV B: Conversation messages        (one row per message/node)
 *   CSV C: Sources                      (one row per source: search results + citations)
 *   CSV D: Message URLs                 (one row per URL from safe_urls)
 *   CSV E: Donor context                (user profile and model instructions)
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
        return content.thoughts.map(thought => thought.content || '').join('\n\n');
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
 * Extract user profile from conversation (clean text only)
 */
function extractUserProfile(mapping) {
    for (const nodeId in mapping) {
        const node = mapping[nodeId];
        if (node.message?.content?.content_type === 'user_editable_context') {
            const meta = node.message.metadata?.user_context_message_data;
            if (meta?.about_user_message) return meta.about_user_message.trim();
            const profile = node.message.content.user_profile || '';
            const match = profile.match(/User profile:\s*```(.+?)```/s);
            return match ? match[1].trim() : '';
        }
    }
    return '';
}

/**
 * Extract user instructions from conversation (clean text only)
 */
function extractUserInstructions(mapping) {
    for (const nodeId in mapping) {
        const node = mapping[nodeId];
        if (node.message?.content?.content_type === 'user_editable_context') {
            const meta = node.message.metadata?.user_context_message_data;
            if (meta?.about_model_message) return meta.about_model_message.trim();
            const instructions = node.message.content.user_instructions || '';
            const match = instructions.match(/```(.+?)```/s);
            return match ? match[1].trim() : '';
        }
    }
    return '';
}

/**
 * Count messages by role
 */
function countMessagesByRole(mapping, role) {
    let count = 0;
    for (const nodeId in mapping) {
        if (mapping[nodeId].message?.author?.role === role) count++;
    }
    return count;
}

/**
 * Count all messages (excluding user_editable_context and model_editable_context)
 */
function countAllMessages(mapping) {
    let count = 0;
    for (const nodeId in mapping) {
        const node = mapping[nodeId];
        if (node.message?.content) {
            const ct = node.message.content.content_type;
            if (ct !== 'user_editable_context' && ct !== 'model_editable_context') count++;
        }
    }
    return count;
}

/**
 * Get default model slug from conversation
 */
function getDefaultModelSlug(conversationData) {
    const mapping = conversationData.mapping || {};
    for (const nodeId in mapping) {
        const node = mapping[nodeId];
        const slug = node.message?.metadata?.resolved_model_slug
            || node.message?.metadata?.model_slug
            || node.message?.metadata?.default_model_slug;
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
    const mapping = conversationData.mapping || {};

    return {
        conversation_id: conversationData.conversation_id || conversationData.id || '',
        title: conversationData.title || '',
        create_time: unixToISO(conversationData.create_time),
        update_time: unixToISO(conversationData.update_time),
        default_model_slug: conversationData.default_model_slug || getDefaultModelSlug(conversationData),
        memory_scope: conversationData.memory_scope || '',
        is_do_not_remember: Boolean(conversationData.is_do_not_remember),
        num_messages: countAllMessages(mapping),
        num_user_messages: countMessagesByRole(mapping, 'user'),
        num_assistant_messages: countMessagesByRole(mapping, 'assistant'),
        num_tool_messages: countMessagesByRole(mapping, 'tool')
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
 * Includes turn_number (BFS depth from root) and parent_id for ordering.
 * safe_urls are moved to CSV D.
 */
function extractConversationMessages(conversationData) {
    const messages = [];
    const mapping = conversationData.mapping || {};
    const conversationId = conversationData.conversation_id || conversationData.id || '';
    const nodeDepths = computeNodeDepths(mapping);

    for (const nodeId in mapping) {
        const node = mapping[nodeId];
        if (!node.message) continue;

        const message = node.message;
        const content = message.content;
        const contentType = content?.content_type || '';

        if (contentType === 'user_editable_context' || contentType === 'model_editable_context') continue;

        const authorRole = message.author?.role || '';

        messages.push({
            conversation_id: conversationId,
            node_id: message.id || nodeId,
            parent_id: node.parent || '',
            turn_number: nodeDepths.has(nodeId) ? nodeDepths.get(nodeId) : '',
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
 */
function extractSearchResults(conversationData) {
    const results = [];
    const mapping = conversationData.mapping || {};
    const conversationId = conversationData.conversation_id || conversationData.id || '';

    for (const nodeId in mapping) {
        const node = mapping[nodeId];
        if (!node.message) continue;

        const messageId = node.message.id || nodeId;

        // --- search_result_groups ---
        const groups = node.message.metadata?.search_result_groups;
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
            node.message.content?.content_references ||
            node.message.metadata?.content_references;

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
 * Normalize safe_urls from message metadata into one row per URL.
 * url_clean strips UTM parameters for deduplication.
 */
function extractMessageUrls(conversationData) {
    const urlRows = [];
    const mapping = conversationData.mapping || {};
    const conversationId = conversationData.conversation_id || conversationData.id || '';

    for (const nodeId in mapping) {
        const node = mapping[nodeId];
        if (!node.message) continue;

        const messageId = node.message.id || nodeId;
        const urls = node.message.metadata?.safe_urls;
        if (!Array.isArray(urls) || urls.length === 0) continue;

        for (const url of urls) {
            urlRows.push({
                conversation_id: conversationId,
                message_id: messageId,
                url: url,
                url_clean: stripUtmParams(url)
            });
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
    const mapping = conversationData.mapping || {};
    return {
        conversation_id: conversationData.conversation_id || conversationData.id || '',
        user_profile: extractUserProfile(mapping),
        user_instructions: extractUserInstructions(mapping)
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
 * @param {Object} conversationData - The full ChatGPT conversation JSON object
 * @param {Object} options - { donorId, donorIdType, downloadTime }
 * @returns {Object} metadataCSV, messagesCSV, sourcesCSV, messageUrlsCSV,
 *                   donorContextCSV, and the raw data arrays for each
 */
function extractChatGPTConversation(conversationData, { donorId = '', donorIdType = '', downloadTime = '' } = {}) {
    if (!conversationData || !conversationData.mapping) {
        throw new Error('Invalid ChatGPT conversation data: missing mapping');
    }

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
