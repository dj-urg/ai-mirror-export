#!/usr/bin/env node
/**
 * Trivial test runner.
 *
 * Scans this directory for `test_*.js` files and dynamically imports each one.
 * Any uncaught error or rejected promise is treated as a test failure. Exits
 * with code 1 if any file fails or if no test files are found at all — the
 * latter guards against CI silently passing when the testing directory is
 * missing on a fresh checkout.
 */

import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
    let entries;
    try {
        entries = await readdir(__dirname);
    } catch (err) {
        console.error(`[run_all] Failed to read test directory: ${err.message}`);
        process.exit(1);
    }

    const testFiles = entries
        .filter(name => name.startsWith('test_') && name.endsWith('.js'))
        .sort();

    if (testFiles.length === 0) {
        console.error('[run_all] No test files found (expected test_*.js). ' +
            'Did a fresh checkout omit testing/tests/? CI should fail here.');
        process.exit(1);
    }

    let failures = 0;
    for (const file of testFiles) {
        const absPath = join(__dirname, file);
        const url = pathToFileURL(absPath).href;
        process.stdout.write(`[run_all] ${file} ... `);
        try {
            await import(url);
            console.log('ok');
        } catch (err) {
            failures++;
            console.log('FAIL');
            console.error(err && err.stack ? err.stack : err);
        }
    }

    const total = testFiles.length;
    const passed = total - failures;
    console.log(`[run_all] ${passed}/${total} passed, ${failures} failed`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('[run_all] Unexpected error:', err);
    process.exit(1);
});
