/**
 * Row validators for data donation CSV outputs.
 *
 * Each AI platform export produces one or more CSVs with a known header set.
 * These validators run at the row level, just before CSV serialization, so
 * malformed rows (missing load-bearing columns, wrong types, bad timestamps)
 * can be flagged before the file leaves the browser.
 *
 * The module is self-contained: no DOM, no WebExtension APIs, no Node globals.
 * Safe to import from background scripts, content scripts, and Node tests.
 */

// ============================================================================
// INTERNAL HELPERS (not exported)
// ============================================================================

/**
 * Loose ISO 8601 regex. Accepts "2025-10-13T12:34:56Z", "...+02:00", "...-0200",
 * and fractional seconds. Non-matching strings fall back to Date.parse.
 */
const ISO_8601_RE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Return true if value is a plain string (including the empty string).
 */
function isString(v) {
    return typeof v === 'string';
}

/**
 * Return true if value is a finite number (rejects NaN and Infinity).
 */
function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Return true if value is a strict boolean.
 */
function isBoolean(v) {
    return typeof v === 'boolean';
}

/**
 * Return true if value is a plausible ISO 8601 timestamp string.
 * Uses a loose regex first, then falls back to Date.parse so values like
 * "2025-10-13T12:34:56" (no zone) also pass.
 */
function isIsoTimestamp(v) {
    if (!isString(v) || v === '') return false;
    if (ISO_8601_RE.test(v)) return true;
    return !Number.isNaN(Date.parse(v));
}

/**
 * Core per-column type check.
 * Returns null on success, or a short string describing the mismatch.
 * `optional` affects how empty string / null / undefined are treated for
 * iso_timestamp (empty is allowed when optional).
 */
function checkType(value, type, optional) {
    switch (type) {
        case 'any':
            return null;
        case 'string':
            return isString(value) ? null : `expected string, got ${typeOf(value)}`;
        case 'number':
            if (isFiniteNumber(value)) return null;
            return `expected finite number, got ${typeOf(value)}`;
        case 'boolean':
            return isBoolean(value) ? null : `expected boolean, got ${typeOf(value)}`;
        case 'iso_timestamp':
            if (value === '' || value === null || value === undefined) {
                return optional ? null : 'expected ISO 8601 timestamp, got empty';
            }
            return isIsoTimestamp(value)
                ? null
                : `expected ISO 8601 timestamp, got ${JSON.stringify(value)}`;
        default:
            return `unknown type "${type}" in schema`;
    }
}

/**
 * typeof-like helper that distinguishes null and NaN for clearer messages.
 */
function typeOf(v) {
    if (v === null) return 'null';
    if (typeof v === 'number' && Number.isNaN(v)) return 'NaN';
    if (typeof v === 'number' && !Number.isFinite(v)) return 'Infinity';
    return typeof v;
}

/**
 * Return true if the value is considered "missing" for required-column purposes.
 * We are lenient: null, undefined, and empty string all count as missing.
 */
function isMissing(v) {
    return v === null || v === undefined || v === '';
}

// ============================================================================
// SHARED COLUMN DEFINITIONS
// ============================================================================

// Every CSV carries these three donor-level columns.
const DONOR_COLUMNS = {
    donor_id: { type: 'string' },
    donor_id_type: { type: 'string' },
    download_time: { type: 'iso_timestamp' },
};

// Columns reserved for the upcoming schema/extractor version tags.
// Optional today, mandatory in a future release.
const VERSION_COLUMNS = {
    schema_version: { type: 'string', optional: true },
    extractor_version: { type: 'string', optional: true },
};

// ============================================================================
// SCHEMAS
// ============================================================================

/**
 * Schema registry: one entry per CSV output.
 * Keys match the filename prefixes used in background.js (chatgpt_metadata,
 * chatgpt_messages, chatgpt_sources, chatgpt_message_urls,
 * chatgpt_donor_context, claude_conversation, copilot_conversation,
 * google_ai_mode, google_ai_overview).
 */
export const SCHEMAS = {
    // --- ChatGPT ---------------------------------------------------------

    chatgpt_metadata: {
        required: ['donor_id', 'conversation_id'],
        columns: {
            ...DONOR_COLUMNS,
            conversation_id: { type: 'string' },
            title: { type: 'string', optional: true },
            create_time: { type: 'iso_timestamp', optional: true },
            update_time: { type: 'iso_timestamp', optional: true },
            default_model_slug: { type: 'string', optional: true },
            memory_scope: { type: 'string', optional: true },
            is_do_not_remember: { type: 'boolean', optional: true },
            num_messages: { type: 'number', optional: true },
            num_user_messages: { type: 'number', optional: true },
            num_assistant_messages: { type: 'number', optional: true },
            num_tool_messages: { type: 'number', optional: true },
            ...VERSION_COLUMNS,
        },
    },

    chatgpt_messages: {
        required: ['donor_id', 'conversation_id', 'message_id'],
        columns: {
            ...DONOR_COLUMNS,
            conversation_id: { type: 'string' },
            message_id: { type: 'string' },
            parent_id: { type: 'string', optional: true },
            // turn_number is a BFS depth (number) or '' for orphans — accept both.
            turn_number: { type: 'any', optional: true },
            author_role: { type: 'string', optional: true },
            tool_name: { type: 'string', optional: true },
            content_type: { type: 'string', optional: true },
            text: { type: 'string', optional: true },
            text_cleaned: { type: 'string', optional: true },
            create_time: { type: 'iso_timestamp', optional: true },
            model_slug: { type: 'string', optional: true },
            ...VERSION_COLUMNS,
        },
    },

    chatgpt_sources: {
        required: ['donor_id', 'conversation_id', 'message_id'],
        columns: {
            ...DONOR_COLUMNS,
            conversation_id: { type: 'string' },
            message_id: { type: 'string' },
            source_list: { type: 'string', optional: true },
            type: { type: 'string', optional: true },
            url: { type: 'string', optional: true },
            url_clean: { type: 'string', optional: true },
            title: { type: 'string', optional: true },
            snippet: { type: 'string', optional: true },
            // ref_turn_index / ref_index may be number or '' (missing)
            ref_turn_index: { type: 'any', optional: true },
            ref_type: { type: 'string', optional: true },
            ref_index: { type: 'any', optional: true },
            pub_date: { type: 'iso_timestamp', optional: true },
            attribution: { type: 'string', optional: true },
            ...VERSION_COLUMNS,
        },
    },

    chatgpt_message_urls: {
        required: ['donor_id', 'conversation_id', 'message_id'],
        columns: {
            ...DONOR_COLUMNS,
            conversation_id: { type: 'string' },
            message_id: { type: 'string' },
            url: { type: 'string', optional: true },
            url_clean: { type: 'string', optional: true },
            ...VERSION_COLUMNS,
        },
    },

    chatgpt_donor_context: {
        required: ['donor_id', 'conversation_id'],
        columns: {
            ...DONOR_COLUMNS,
            conversation_id: { type: 'string' },
            user_profile: { type: 'string', optional: true },
            user_instructions: { type: 'string', optional: true },
            ...VERSION_COLUMNS,
        },
    },

    // --- Claude ----------------------------------------------------------

    claude_metadata: {
        required: ['donor_id', 'conversation_id'],
        columns: {
            ...DONOR_COLUMNS,
            conversation_id: { type: 'string' },
            conversation_name: { type: 'string', optional: true },
            summary: { type: 'string', optional: true },
            created_at: { type: 'iso_timestamp', optional: true },
            updated_at: { type: 'iso_timestamp', optional: true },
            enabled_web_search: { type: 'boolean', optional: true },
            enabled_monkeys_in_a_barrel: { type: 'boolean', optional: true },
            preview_feature_uses_artifacts: { type: 'boolean', optional: true },
            settings_json: { type: 'string', optional: true },
            is_starred: { type: 'boolean', optional: true },
            is_temporary: { type: 'boolean', optional: true },
            current_leaf_message_uuid: { type: 'string', optional: true },
            num_messages: { type: 'number', optional: true },
            num_user_messages: { type: 'number', optional: true },
            num_assistant_messages: { type: 'number', optional: true },
            num_text_blocks: { type: 'number', optional: true },
            num_thinking_blocks: { type: 'number', optional: true },
            num_tool_use_blocks: { type: 'number', optional: true },
            num_tool_result_blocks: { type: 'number', optional: true },
            ...VERSION_COLUMNS,
        },
    },

    claude_messages: {
        required: ['donor_id', 'conversation_id', 'message_id'],
        columns: {
            ...DONOR_COLUMNS,
            conversation_id: { type: 'string' },
            message_id: { type: 'string' },
            parent_message_id: { type: 'string', optional: true },
            // message_index / block_index are numbers from the API, or '' when missing
            message_index: { type: 'any', optional: true },
            block_index: { type: 'any', optional: true },
            sender: { type: 'string', optional: true },
            content_type: { type: 'string', optional: true },
            text: { type: 'string', optional: true },
            text_cleaned: { type: 'string', optional: true },
            thinking_summary: { type: 'string', optional: true },
            tool_name: { type: 'string', optional: true },
            tool_input_json: { type: 'string', optional: true },
            tool_use_id: { type: 'string', optional: true },
            block_start_timestamp: { type: 'iso_timestamp', optional: true },
            block_stop_timestamp: { type: 'iso_timestamp', optional: true },
            message_created_at: { type: 'iso_timestamp', optional: true },
            message_updated_at: { type: 'iso_timestamp', optional: true },
            message_truncated: { type: 'boolean', optional: true },
            message_stop_reason: { type: 'string', optional: true },
            thinking_mode: { type: 'string', optional: true },
            on_visible_path: { type: 'boolean', optional: true },
            raw_block_json: { type: 'string', optional: true },
            ...VERSION_COLUMNS,
        },
    },

    claude_sources: {
        required: ['donor_id', 'conversation_id', 'message_id'],
        columns: {
            ...DONOR_COLUMNS,
            platform: { type: 'string', optional: true },
            conversation_id: { type: 'string' },
            message_id: { type: 'string' },
            block_index: { type: 'any', optional: true },
            source_list: { type: 'string', optional: true },
            type: { type: 'string', optional: true },
            url: { type: 'string', optional: true },
            url_clean: { type: 'string', optional: true },
            title: { type: 'string', optional: true },
            snippet: { type: 'string', optional: true },
            start_index: { type: 'any', optional: true },
            end_index: { type: 'any', optional: true },
            raw_json: { type: 'string', optional: true },
            ...VERSION_COLUMNS,
        },
    },

    claude_attachments: {
        required: ['donor_id', 'conversation_id', 'message_id'],
        columns: {
            ...DONOR_COLUMNS,
            conversation_id: { type: 'string' },
            message_id: { type: 'string' },
            source: { type: 'string', optional: true },
            file_uuid: { type: 'string', optional: true },
            file_name: { type: 'string', optional: true },
            file_type: { type: 'string', optional: true },
            file_size: { type: 'any', optional: true },
            extracted_text: { type: 'string', optional: true },
            raw_json: { type: 'string', optional: true },
            ...VERSION_COLUMNS,
        },
    },

    // --- Copilot ---------------------------------------------------------

    copilot_conversation: {
        required: ['donor_id', 'conversation_id', 'message_id'],
        columns: {
            ...DONOR_COLUMNS,
            conversation_id: { type: 'string' },
            message_id: { type: 'string' },
            role: { type: 'string', optional: true },
            text: { type: 'string', optional: true },
            text_cleaned: { type: 'string', optional: true },
            created_at: { type: 'iso_timestamp', optional: true },
            channel: { type: 'string', optional: true },
            mode: { type: 'string', optional: true },
            part_ids: { type: 'string', optional: true },
            author_type: { type: 'string', optional: true },
            ...VERSION_COLUMNS,
        },
    },

    m365_copilot_conversation: {
        required: ['donor_id', 'conversation_id'],
        columns: {
            ...DONOR_COLUMNS,
            conversation_id: { type: 'string' },
            message_id: { type: 'string', optional: true },
            request_id: { type: 'string', optional: true },
            author: { type: 'string', optional: true },
            role: { type: 'string', optional: true },
            text: { type: 'string', optional: true },
            text_cleaned: { type: 'string', optional: true },
            spoken_text: { type: 'string', optional: true },
            message_type: { type: 'string', optional: true },
            content_origin: { type: 'string', optional: true },
            turn_state: { type: 'string', optional: true },
            response_identifier: { type: 'string', optional: true },
            offense: { type: 'string', optional: true },
            input_method: { type: 'string', optional: true },
            // turn_count can be a number or '' when unknown
            turn_count: { type: 'any', optional: true },
            created_at: { type: 'iso_timestamp', optional: true },
            source_count: { type: 'number', optional: true },
            suggested_count: { type: 'number', optional: true },
            adaptive_cards_json: { type: 'string', optional: true },
            raw_json: { type: 'string', optional: true },
            ...VERSION_COLUMNS,
        },
    },

    // --- Perplexity ------------------------------------------------------

    perplexity_metadata: {
        required: ['donor_id', 'conversation_id'],
        columns: {
            ...DONOR_COLUMNS,
            conversation_id: { type: 'string' },
            title: { type: 'string', optional: true },
            created_at: { type: 'iso_timestamp', optional: true },
            updated_at: { type: 'iso_timestamp', optional: true },
            num_turns: { type: 'number', optional: true },
            num_sources: { type: 'number', optional: true },
            page_count: { type: 'any', optional: true },
            ...VERSION_COLUMNS,
        },
    },

    perplexity_messages: {
        required: ['donor_id', 'conversation_id', 'message_id'],
        columns: {
            ...DONOR_COLUMNS,
            conversation_id: { type: 'string' },
            message_id: { type: 'string' },
            parent_id: { type: 'string', optional: true },
            entry_uuid: { type: 'string', optional: true },
            turn_index: { type: 'any', optional: true },
            role: { type: 'string', optional: true },
            text: { type: 'string', optional: true },
            text_cleaned: { type: 'string', optional: true },
            code_text: { type: 'string', optional: true },
            reasoning_text: { type: 'string', optional: true },
            created_at: { type: 'iso_timestamp', optional: true },
            model_identifier: { type: 'string', optional: true },
            status: { type: 'string', optional: true },
            source_count: { type: 'number', optional: true },
            ...VERSION_COLUMNS,
        },
    },

    perplexity_sources: {
        required: ['donor_id', 'conversation_id'],
        columns: {
            ...DONOR_COLUMNS,
            conversation_id: { type: 'string' },
            entry_uuid: { type: 'string', optional: true },
            turn_index: { type: 'any', optional: true },
            source_index: { type: 'any', optional: true },
            source_block_type: { type: 'string', optional: true },
            url: { type: 'string', optional: true },
            url_clean: { type: 'string', optional: true },
            title: { type: 'string', optional: true },
            snippet: { type: 'string', optional: true },
            domain: { type: 'string', optional: true },
            publication_date: { type: 'iso_timestamp', optional: true },
            ...VERSION_COLUMNS,
        },
    },

    // --- Grok ------------------------------------------------------------

    grok_metadata: {
        required: ['donor_id', 'conversation_id'],
        columns: {
            ...DONOR_COLUMNS,
            conversation_id: { type: 'string' },
            title: { type: 'string', optional: true },
            create_time: { type: 'iso_timestamp', optional: true },
            modify_time: { type: 'iso_timestamp', optional: true },
            temporary: { type: 'boolean', optional: true },
            system_prompt_name: { type: 'string', optional: true },
            media_types: { type: 'string', optional: true },
            num_messages: { type: 'number', optional: true },
            num_user_messages: { type: 'number', optional: true },
            num_assistant_messages: { type: 'number', optional: true },
            num_messages_with_web_search: { type: 'number', optional: true },
            num_messages_with_attachments: { type: 'number', optional: true },
            num_messages_with_generated_images: { type: 'number', optional: true },
            ...VERSION_COLUMNS,
        },
    },

    grok_messages: {
        required: ['donor_id', 'conversation_id', 'message_id'],
        columns: {
            ...DONOR_COLUMNS,
            conversation_id: { type: 'string' },
            message_id: { type: 'string' },
            parent_message_id: { type: 'string', optional: true },
            turn_index: { type: 'any', optional: true },
            sender: { type: 'string', optional: true },
            role: { type: 'string', optional: true },
            text: { type: 'string', optional: true },
            text_cleaned: { type: 'string', optional: true },
            model_identifier: { type: 'string', optional: true },
            created_at: { type: 'iso_timestamp', optional: true },
            manual: { type: 'boolean', optional: true },
            partial: { type: 'boolean', optional: true },
            shared: { type: 'boolean', optional: true },
            has_web_search: { type: 'boolean', optional: true },
            has_attachments: { type: 'boolean', optional: true },
            has_generated_images: { type: 'boolean', optional: true },
            tools_used: { type: 'string', optional: true },
            xpost_ids: { type: 'string', optional: true },
            feedback_labels: { type: 'string', optional: true },
            raw_message_json: { type: 'string', optional: true },
            ...VERSION_COLUMNS,
        },
    },

    grok_sources: {
        required: ['donor_id', 'conversation_id'],
        columns: {
            ...DONOR_COLUMNS,
            platform: { type: 'string', optional: true },
            conversation_id: { type: 'string' },
            message_id: { type: 'string', optional: true },
            source_list: { type: 'string', optional: true },
            source_index: { type: 'any', optional: true },
            type: { type: 'string', optional: true },
            url: { type: 'string', optional: true },
            url_clean: { type: 'string', optional: true },
            title: { type: 'string', optional: true },
            snippet: { type: 'string', optional: true },
            site_name: { type: 'string', optional: true },
            published_at: { type: 'iso_timestamp', optional: true },
            raw_json: { type: 'string', optional: true },
            ...VERSION_COLUMNS,
        },
    },

    // --- DeepSeek --------------------------------------------------------

    deepseek_metadata: {
        required: ['donor_id', 'conversation_id'],
        columns: {
            ...DONOR_COLUMNS,
            conversation_id: { type: 'string' },
            title: { type: 'string', optional: true },
            title_type: { type: 'string', optional: true },
            model_type: { type: 'string', optional: true },
            pinned: { type: 'boolean', optional: true },
            version: { type: 'any', optional: true },
            updated_at: { type: 'iso_timestamp', optional: true },
            num_messages: { type: 'number', optional: true },
            num_user_messages: { type: 'number', optional: true },
            num_assistant_messages: { type: 'number', optional: true },
            num_messages_with_search: { type: 'number', optional: true },
            num_messages_with_thinking: { type: 'number', optional: true },
            num_messages_with_files: { type: 'number', optional: true },
            ...VERSION_COLUMNS,
        },
    },

    deepseek_messages: {
        required: ['donor_id', 'conversation_id', 'message_id'],
        columns: {
            ...DONOR_COLUMNS,
            conversation_id: { type: 'string' },
            message_id: { type: 'string' },
            parent_message_id: { type: 'string', optional: true },
            turn_index: { type: 'any', optional: true },
            role: { type: 'string', optional: true },
            sender: { type: 'string', optional: true },
            text: { type: 'string', optional: true },
            text_cleaned: { type: 'string', optional: true },
            thinking_text: { type: 'string', optional: true },
            thinking_text_cleaned: { type: 'string', optional: true },
            model: { type: 'string', optional: true },
            created_at: { type: 'iso_timestamp', optional: true },
            status: { type: 'string', optional: true },
            quasi_status: { type: 'string', optional: true },
            conversation_mode: { type: 'string', optional: true },
            search_enabled: { type: 'boolean', optional: true },
            search_triggered: { type: 'boolean', optional: true },
            thinking_enabled: { type: 'boolean', optional: true },
            ban_regenerate: { type: 'boolean', optional: true },
            has_pending_fragment: { type: 'boolean', optional: true },
            has_search_fragment: { type: 'boolean', optional: true },
            has_tool_fragment: { type: 'boolean', optional: true },
            has_file_fragment: { type: 'boolean', optional: true },
            fragment_count: { type: 'number', optional: true },
            fragment_types: { type: 'string', optional: true },
            incomplete_message: { type: 'string', optional: true },
            feedback_json: { type: 'string', optional: true },
            token_usage_json: { type: 'string', optional: true },
            raw_message_json: { type: 'string', optional: true },
            ...VERSION_COLUMNS,
        },
    },

    deepseek_sources: {
        required: ['donor_id', 'conversation_id'],
        columns: {
            ...DONOR_COLUMNS,
            platform: { type: 'string', optional: true },
            conversation_id: { type: 'string' },
            message_id: { type: 'string', optional: true },
            fragment_id: { type: 'string', optional: true },
            fragment_type: { type: 'string', optional: true },
            source_index: { type: 'any', optional: true },
            cite_index: { type: 'any', optional: true },
            url: { type: 'string', optional: true },
            url_clean: { type: 'string', optional: true },
            title: { type: 'string', optional: true },
            snippet: { type: 'string', optional: true },
            site_name: { type: 'string', optional: true },
            provider: { type: 'string', optional: true },
            published_at: { type: 'iso_timestamp', optional: true },
            raw_json: { type: 'string', optional: true },
            ...VERSION_COLUMNS,
        },
    },

    // --- Mistral ---------------------------------------------------------

    mistral_metadata: {
        required: ['donor_id', 'conversation_id'],
        columns: {
            ...DONOR_COLUMNS,
            conversation_id: { type: 'string' },
            title: { type: 'string', optional: true },
            generated_title: { type: 'string', optional: true },
            user_title: { type: 'string', optional: true },
            product_type: { type: 'string', optional: true },
            visibility: { type: 'string', optional: true },
            permission: { type: 'string', optional: true },
            pinned: { type: 'boolean', optional: true },
            created_at: { type: 'iso_timestamp', optional: true },
            updated_at: { type: 'iso_timestamp', optional: true },
            organization_id: { type: 'string', optional: true },
            project_id: { type: 'string', optional: true },
            model_alias: { type: 'string', optional: true },
            reasoning_effort: { type: 'string', optional: true },
            features: { type: 'string', optional: true },
            integrations: { type: 'string', optional: true },
            libraries: { type: 'string', optional: true },
            num_messages: { type: 'number', optional: true },
            num_user_messages: { type: 'number', optional: true },
            num_assistant_messages: { type: 'number', optional: true },
            num_messages_with_tool_call: { type: 'number', optional: true },
            num_messages_with_reasoning: { type: 'number', optional: true },
            num_messages_with_search: { type: 'number', optional: true },
            num_messages_with_files: { type: 'number', optional: true },
            num_cited_sources: { type: 'number', optional: true },
            ...VERSION_COLUMNS,
        },
    },

    mistral_messages: {
        required: ['donor_id', 'conversation_id', 'message_id'],
        columns: {
            ...DONOR_COLUMNS,
            conversation_id: { type: 'string' },
            message_id: { type: 'string' },
            parent_message_id: { type: 'string', optional: true },
            turn_index: { type: 'any', optional: true },
            role: { type: 'string', optional: true },
            text: { type: 'string', optional: true },
            text_cleaned: { type: 'string', optional: true },
            reasoning_text: { type: 'string', optional: true },
            reasoning_text_cleaned: { type: 'string', optional: true },
            model_identifier: { type: 'string', optional: true },
            created_at: { type: 'iso_timestamp', optional: true },
            status: { type: 'string', optional: true },
            generation_status: { type: 'string', optional: true },
            moderation_category: { type: 'string', optional: true },
            moderation_blocked_category: { type: 'string', optional: true },
            reaction: { type: 'string', optional: true },
            visibility: { type: 'string', optional: true },
            is_accelerated_answer: { type: 'boolean', optional: true },
            agent_id: { type: 'string', optional: true },
            version: { type: 'any', optional: true },
            version_count: { type: 'any', optional: true },
            chunk_count: { type: 'number', optional: true },
            chunk_types: { type: 'string', optional: true },
            tool_names: { type: 'string', optional: true },
            has_reasoning: { type: 'boolean', optional: true },
            has_tool_call: { type: 'boolean', optional: true },
            has_search_result: { type: 'boolean', optional: true },
            has_files: { type: 'boolean', optional: true },
            cited_source_count: { type: 'number', optional: true },
            content_chunks_json: { type: 'string', optional: true },
            files_json: { type: 'string', optional: true },
            raw_message_json: { type: 'string', optional: true },
            ...VERSION_COLUMNS,
        },
    },

    mistral_sources: {
        required: ['donor_id', 'conversation_id'],
        columns: {
            ...DONOR_COLUMNS,
            platform: { type: 'string', optional: true },
            conversation_id: { type: 'string' },
            message_id: { type: 'string', optional: true },
            source_list: { type: 'string', optional: true },
            source_index: { type: 'any', optional: true },
            source_id: { type: 'string', optional: true },
            type: { type: 'string', optional: true },
            url: { type: 'string', optional: true },
            url_clean: { type: 'string', optional: true },
            title: { type: 'string', optional: true },
            snippet: { type: 'string', optional: true },
            site_name: { type: 'string', optional: true },
            published_at: { type: 'iso_timestamp', optional: true },
            tool_name: { type: 'string', optional: true },
            raw_json: { type: 'string', optional: true },
            ...VERSION_COLUMNS,
        },
    },

    // --- Google Search ---------------------------------------------------

    google_ai_mode: {
        required: ['donor_id'],
        columns: {
            ...DONOR_COLUMNS,
            conversation_id: { type: 'string', optional: true },
            conversation_title: { type: 'string', optional: true },
            source_page_url: { type: 'string', optional: true },
            captured_at: { type: 'iso_timestamp', optional: true },
            // turn_index can be a number or '' (fallback uses array index)
            turn_index: { type: 'any', optional: true },
            role: { type: 'string', optional: true },
            text: { type: 'string', optional: true },
            text_cleaned: { type: 'string', optional: true },
            source_urls: { type: 'string', optional: true },
            source_titles: { type: 'string', optional: true },
            ...VERSION_COLUMNS,
        },
    },

    google_ai_overview: {
        required: ['donor_id'],
        columns: {
            ...DONOR_COLUMNS,
            query: { type: 'string', optional: true },
            source_page_url: { type: 'string', optional: true },
            captured_at: { type: 'iso_timestamp', optional: true },
            ai_overview_text: { type: 'string', optional: true },
            ai_overview_text_cleaned: { type: 'string', optional: true },
            source_urls: { type: 'string', optional: true },
            source_titles: { type: 'string', optional: true },
            follow_up_questions: { type: 'string', optional: true },
            follow_up_count: { type: 'number', optional: true },
            ...VERSION_COLUMNS,
        },
    },

    google_sources: {
        required: ['donor_id'],
        columns: {
            ...DONOR_COLUMNS,
            platform: { type: 'string', optional: true },
            mode: { type: 'string', optional: true },
            conversation_id: { type: 'string', optional: true },
            turn_index: { type: 'any', optional: true },
            source_page_url: { type: 'string', optional: true },
            captured_at: { type: 'iso_timestamp', optional: true },
            url: { type: 'string', optional: true },
            url_clean: { type: 'string', optional: true },
            title: { type: 'string', optional: true },
            ...VERSION_COLUMNS,
        },
    },
};

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Validate a single row against a named schema.
 * Never throws, even on null/undefined/non-object input.
 *
 * @param {unknown} row - The row object to validate.
 * @param {string} schemaName - Key into SCHEMAS.
 * @returns {{valid: boolean, errors: string[], warnings: string[]}}
 */
export function validateRow(row, schemaName) {
    const errors = [];
    const warnings = [];

    const schema = SCHEMAS[schemaName];
    if (!schema) {
        errors.push(`unknown schema "${schemaName}"`);
        return { valid: false, errors, warnings };
    }

    if (row === null || row === undefined || typeof row !== 'object' || Array.isArray(row)) {
        errors.push(`row is not an object (got ${typeOf(row)})`);
        return { valid: false, errors, warnings };
    }

    // 1. Required columns must exist and not be missing.
    for (const col of schema.required) {
        if (!(col in row) || isMissing(row[col])) {
            errors.push(`missing required column "${col}"`);
            continue;
        }
    }

    // 2. Walk every column defined in the schema and type-check it.
    for (const [col, spec] of Object.entries(schema.columns)) {
        if (!(col in row)) continue; // missing optional column is fine
        const value = row[col];
        const isRequired = schema.required.includes(col);

        // Allow empty / null for optional columns regardless of declared type
        // (except iso_timestamp, which handles emptiness itself).
        if (!isRequired && isMissing(value) && spec.type !== 'iso_timestamp') {
            continue;
        }

        const mismatch = checkType(value, spec.type, spec.optional === true || !isRequired);
        if (mismatch) {
            if (isRequired) {
                errors.push(`column "${col}": ${mismatch}`);
            } else if (spec.type === 'iso_timestamp') {
                // Bad timestamp on an optional column is a warning, not an error.
                warnings.push(`column "${col}": ${mismatch}`);
            } else {
                warnings.push(`column "${col}": ${mismatch}`);
            }
        }
    }

    // 3. Unknown columns are warnings only — schemas evolve, don't block exports.
    for (const col of Object.keys(row)) {
        if (!(col in schema.columns)) {
            warnings.push(`unknown column "${col}"`);
        }
    }

    return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validate an array of rows against a named schema, aggregating results.
 * Error and warning samples are capped at 10 each to keep logs small.
 *
 * @param {unknown[]} rows
 * @param {string} schemaName
 * @returns {{
 *   valid: boolean,
 *   totalRows: number,
 *   errorRows: number,
 *   warningRows: number,
 *   errorsSample: Array<{index: number, errors: string[]}>,
 *   warningsSample: Array<{index: number, warnings: string[]}>
 * }}
 */
export function validateRows(rows, schemaName) {
    const errorsSample = [];
    const warningsSample = [];
    let errorRows = 0;
    let warningRows = 0;

    const safeRows = Array.isArray(rows) ? rows : [];

    for (let i = 0; i < safeRows.length; i++) {
        const result = validateRow(safeRows[i], schemaName);
        if (result.errors.length > 0) {
            errorRows++;
            if (errorsSample.length < 10) {
                errorsSample.push({ index: i, errors: result.errors });
            }
        }
        if (result.warnings.length > 0) {
            warningRows++;
            if (warningsSample.length < 10) {
                warningsSample.push({ index: i, warnings: result.warnings });
            }
        }
    }

    return {
        valid: errorRows === 0,
        totalRows: safeRows.length,
        errorRows,
        warningRows,
        errorsSample,
        warningsSample,
    };
}
