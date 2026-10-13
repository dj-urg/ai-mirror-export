/**
 * Tests for utils/validators.js
 *
 * Run with: node testing/tests/test_validators.js
 *
 * This repo's package.json declares "type": "module", so this file is an ES
 * module. It imports validators.js directly.
 */

import { SCHEMAS, validateRow, validateRows } from '../../utils/validators.js';

// ---------------------------------------------------------------------------
// Minimal test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
    if (condition) {
        passed++;
    } else {
        failed++;
        failures.push(message);
        console.error('  FAIL:', message);
    }
}

function assertEqual(actual, expected, message) {
    const ok = actual === expected;
    if (!ok) {
        failed++;
        failures.push(`${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        console.error('  FAIL:', message, '— expected', expected, 'got', actual);
    } else {
        passed++;
    }
}

function section(name) {
    console.log(`\n--- ${name} ---`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function run() {
    section('SCHEMAS export shape');
    const expectedSchemas = [
        'chatgpt_metadata',
        'chatgpt_messages',
        'chatgpt_sources',
        'chatgpt_message_urls',
        'chatgpt_donor_context',
        'claude_metadata',
        'claude_messages',
        'claude_sources',
        'claude_attachments',
        'copilot_conversation',
        'google_ai_mode',
        'google_ai_overview',
        'google_sources',
    ];
    for (const name of expectedSchemas) {
        assert(name in SCHEMAS, `SCHEMAS.${name} is defined`);
        assert(Array.isArray(SCHEMAS[name]?.required), `SCHEMAS.${name}.required is an array`);
        assert(
            SCHEMAS[name]?.columns && typeof SCHEMAS[name].columns === 'object',
            `SCHEMAS.${name}.columns is an object`,
        );
        assert(
            'schema_version' in (SCHEMAS[name]?.columns || {}),
            `SCHEMAS.${name} includes schema_version column`,
        );
        assert(
            'extractor_version' in (SCHEMAS[name]?.columns || {}),
            `SCHEMAS.${name} includes extractor_version column`,
        );
    }

    // ---------------------------------------------------------------------
    section('Valid row passes (chatgpt_messages)');
    {
        const row = {
            donor_id: 'abc-123',
            donor_id_type: 'persistent',
            download_time: '2025-10-13T12:34:56.789Z',
            conversation_id: 'conv-1',
            message_id: 'msg-1',
            parent_id: 'msg-0',
            turn_number: 2,
            author_role: 'user',
            tool_name: '',
            content_type: 'text',
            text: 'hello',
            create_time: '2025-10-13T12:34:56Z',
            model_slug: 'gpt-5',
        };
        const result = validateRow(row, 'chatgpt_messages');
        assertEqual(result.valid, true, 'valid chatgpt_messages row is valid');
        assertEqual(result.errors.length, 0, 'valid row has no errors');
        assertEqual(result.warnings.length, 0, 'valid row has no warnings');
    }

    // ---------------------------------------------------------------------
    section('Missing required column fails');
    {
        const row = {
            donor_id: 'abc-123',
            donor_id_type: 'persistent',
            download_time: '2025-10-13T12:34:56Z',
            // conversation_id missing
            message_id: 'msg-1',
        };
        const result = validateRow(row, 'chatgpt_messages');
        assertEqual(result.valid, false, 'row missing required column is invalid');
        assert(
            result.errors.some(e => e.includes('conversation_id')),
            'error mentions missing conversation_id',
        );
    }
    {
        // Empty string counts as missing for required columns.
        const row = {
            donor_id: '',
            donor_id_type: 'persistent',
            download_time: '2025-10-13T12:34:56Z',
            conversation_id: 'conv-1',
            message_id: 'msg-1',
        };
        const result = validateRow(row, 'chatgpt_messages');
        assertEqual(result.valid, false, 'empty-string required column is invalid');
        assert(
            result.errors.some(e => e.includes('donor_id')),
            'error mentions missing donor_id',
        );
    }

    // ---------------------------------------------------------------------
    section('Wrong type on required column -> error');
    {
        const row = {
            donor_id: 'abc',
            donor_id_type: 'persistent',
            download_time: '2025-10-13T12:34:56Z',
            conversation_id: 12345, // should be string
            message_id: 'msg-1',
        };
        const result = validateRow(row, 'chatgpt_messages');
        assertEqual(result.valid, false, 'wrong-type required column is invalid');
        assert(
            result.errors.some(e => e.includes('conversation_id') && e.includes('string')),
            'error names column and expected type',
        );
    }

    section('Wrong type on optional column -> warning');
    {
        const row = {
            donor_id: 'abc',
            donor_id_type: 'persistent',
            download_time: '2025-10-13T12:34:56Z',
            conversation_id: 'conv-1',
            message_id: 'msg-1',
            text: 42, // should be string, but optional
        };
        const result = validateRow(row, 'chatgpt_messages');
        assertEqual(result.valid, true, 'wrong-type optional column still valid');
        assert(
            result.warnings.some(w => w.includes('text')),
            'warning names the text column',
        );
    }

    section('Unknown column -> warning');
    {
        const row = {
            donor_id: 'abc',
            donor_id_type: 'persistent',
            download_time: '2025-10-13T12:34:56Z',
            conversation_id: 'conv-1',
            message_id: 'msg-1',
            mystery_field: 'what is this',
        };
        const result = validateRow(row, 'chatgpt_messages');
        assertEqual(result.valid, true, 'unknown column does not break validity');
        assert(
            result.warnings.some(w => w.includes('mystery_field')),
            'warning names the unknown column',
        );
    }

    // ---------------------------------------------------------------------
    section('iso_timestamp acceptance');
    {
        const good = [
            '2025-10-13T12:34:56Z',
            '2025-10-13T12:34:56.789Z',
            '2025-10-13T12:34:56+02:00',
            '2025-10-13T12:34:56-0200',
            '2025-10-13T12:34:56', // Date.parse-able fallback
        ];
        for (const ts of good) {
            const row = {
                donor_id: 'abc',
                donor_id_type: 'persistent',
                download_time: ts,
                conversation_id: 'conv-1',
                message_id: 'msg-1',
            };
            const result = validateRow(row, 'chatgpt_messages');
            assertEqual(result.valid, true, `accepts ISO timestamp: ${ts}`);
        }
    }
    {
        // Garbage timestamp in a (non-required) timestamp column -> warning,
        // per spec: "iso_timestamp that doesn't parse" is a warning. The row
        // itself stays valid because download_time is not in the required list.
        const row = {
            donor_id: 'abc',
            donor_id_type: 'persistent',
            download_time: 'not-a-timestamp-at-all',
            conversation_id: 'conv-1',
            message_id: 'msg-1',
        };
        const result = validateRow(row, 'chatgpt_messages');
        assertEqual(result.valid, true, 'garbage ISO timestamp on optional column -> warning only');
        assert(
            result.warnings.some(w => w.includes('download_time')),
            'warning names the bad timestamp column',
        );
    }
    {
        // Garbage timestamp in an optional column -> warning.
        const row = {
            donor_id: 'abc',
            donor_id_type: 'persistent',
            download_time: '2025-10-13T12:34:56Z',
            conversation_id: 'conv-1',
            message_id: 'msg-1',
            create_time: 'definitely-not-a-date',
        };
        const result = validateRow(row, 'chatgpt_messages');
        assertEqual(result.valid, true, 'garbage optional timestamp is still valid');
        assert(
            result.warnings.some(w => w.includes('create_time')),
            'warning names the bad optional timestamp',
        );
    }

    // ---------------------------------------------------------------------
    section('Defensive: non-object input does not throw');
    const nastyInputs = [null, undefined, 42, 'hello', [], true];
    for (const bad of nastyInputs) {
        let threw = false;
        let result;
        try {
            result = validateRow(bad, 'chatgpt_messages');
        } catch (e) {
            threw = true;
        }
        assert(!threw, `validateRow(${JSON.stringify(bad)}) did not throw`);
        assertEqual(result?.valid, false, `validateRow(${JSON.stringify(bad)}) is invalid`);
        assert(Array.isArray(result?.errors), 'errors is an array');
    }

    // Unknown schema name is handled gracefully.
    {
        const result = validateRow({}, 'not_a_real_schema');
        assertEqual(result.valid, false, 'unknown schema name -> invalid');
        assert(result.errors.length > 0, 'unknown schema name produces errors');
    }

    // ---------------------------------------------------------------------
    section('validateRows aggregation');
    {
        const rows = [
            // 0: valid
            {
                donor_id: 'd',
                donor_id_type: 'persistent',
                download_time: '2025-10-13T12:34:56Z',
                conversation_id: 'c',
                message_id: 'm1',
            },
            // 1: missing required
            {
                donor_id: 'd',
                donor_id_type: 'persistent',
                download_time: '2025-10-13T12:34:56Z',
                conversation_id: '',
                message_id: 'm2',
            },
            // 2: unknown column (warning only)
            {
                donor_id: 'd',
                donor_id_type: 'persistent',
                download_time: '2025-10-13T12:34:56Z',
                conversation_id: 'c',
                message_id: 'm3',
                weird_extra: 1,
            },
            // 3: wrong type on required (error)
            {
                donor_id: 'd',
                donor_id_type: 'persistent',
                download_time: '2025-10-13T12:34:56Z',
                conversation_id: 123,
                message_id: 'm4',
            },
        ];
        const result = validateRows(rows, 'chatgpt_messages');
        assertEqual(result.totalRows, 4, 'totalRows counted correctly');
        assertEqual(result.errorRows, 2, 'errorRows counted correctly');
        assertEqual(result.warningRows, 1, 'warningRows counted correctly');
        assertEqual(result.valid, false, 'aggregate valid is false when any row errored');
        assert(result.errorsSample.length <= 10, 'errorsSample capped at 10');
        assert(result.warningsSample.length <= 10, 'warningsSample capped at 10');
        assertEqual(result.errorsSample[0].index, 1, 'first error sample points at row 1');
    }

    // Non-array input to validateRows should not crash.
    {
        const result = validateRows(null, 'chatgpt_messages');
        assertEqual(result.totalRows, 0, 'null rows -> totalRows 0');
        assertEqual(result.valid, true, 'null rows -> valid (nothing to invalidate)');
    }

    // Sample cap check — build 15 bad rows.
    {
        const bad = Array.from({ length: 15 }, () => ({}));
        const result = validateRows(bad, 'chatgpt_messages');
        assertEqual(result.errorRows, 15, 'all 15 rows errored');
        assertEqual(result.errorsSample.length, 10, 'errorsSample capped at exactly 10');
    }

    // ---------------------------------------------------------------------
    section('Per-schema smoke tests');
    const smoke = {
        chatgpt_metadata: {
            donor_id: 'd', donor_id_type: 'persistent',
            download_time: '2025-10-13T12:34:56Z',
            conversation_id: 'c', title: 'hi',
            is_do_not_remember: false, num_messages: 3,
        },
        chatgpt_sources: {
            donor_id: 'd', donor_id_type: 'persistent',
            download_time: '2025-10-13T12:34:56Z',
            conversation_id: 'c', message_id: 'm', source_list: 'search_result',
        },
        chatgpt_message_urls: {
            donor_id: 'd', donor_id_type: 'persistent',
            download_time: '2025-10-13T12:34:56Z',
            conversation_id: 'c', message_id: 'm', url: 'https://x.test',
        },
        chatgpt_donor_context: {
            donor_id: 'd', donor_id_type: 'persistent',
            download_time: '2025-10-13T12:34:56Z',
            conversation_id: 'c', user_profile: '', user_instructions: '',
        },
        claude_metadata: {
            donor_id: 'd', donor_id_type: 'persistent',
            download_time: '2025-10-13T12:34:56Z',
            conversation_id: 'c', conversation_name: 'Test',
            enabled_web_search: false, is_starred: false, is_temporary: false,
            num_messages: 2,
        },
        claude_messages: {
            donor_id: 'd', donor_id_type: 'persistent',
            download_time: '2025-10-13T12:34:56Z',
            conversation_id: 'c', message_id: 'm', sender: 'human',
            content_type: 'text', text: 'hello', message_truncated: false,
        },
        claude_sources: {
            donor_id: 'd', donor_id_type: 'persistent',
            download_time: '2025-10-13T12:34:56Z',
            conversation_id: 'c', message_id: 'm', url: 'https://x.test',
        },
        claude_attachments: {
            donor_id: 'd', donor_id_type: 'persistent',
            download_time: '2025-10-13T12:34:56Z',
            conversation_id: 'c', message_id: 'm', source: 'attachments',
        },
        copilot_conversation: {
            donor_id: 'd', donor_id_type: 'persistent',
            download_time: '2025-10-13T12:34:56Z',
            conversation_id: 'c', message_id: 'm', role: 'user',
        },
        google_ai_mode: {
            donor_id: 'd', donor_id_type: 'persistent',
            download_time: '2025-10-13T12:34:56Z',
            conversation_title: 't', turn_index: 0, role: 'user', text: 'q',
        },
        google_ai_overview: {
            donor_id: 'd', donor_id_type: 'persistent',
            download_time: '2025-10-13T12:34:56Z',
            query: 'q', ai_overview_text: 'answer', follow_up_count: 2,
        },
        google_sources: {
            donor_id: 'd', donor_id_type: 'persistent',
            download_time: '2025-10-13T12:34:56Z',
            url: 'https://example.test', title: 'Example',
        },
    };
    for (const [name, row] of Object.entries(smoke)) {
        const result = validateRow(row, name);
        assertEqual(result.valid, true, `smoke row for ${name} is valid`);
        if (!result.valid) console.error('   errors:', result.errors);
    }

    // ---------------------------------------------------------------------
    console.log('\n============================================================');
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    console.log('============================================================');
    if (failed > 0) {
        console.error('\nFailures:');
        for (const f of failures) console.error(' -', f);
        process.exit(1);
    }
}

run().catch(err => {
    console.error('Test runner crashed:', err);
    process.exit(2);
});
