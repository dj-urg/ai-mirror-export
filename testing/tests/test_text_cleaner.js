/**
 * Tests for utils/text_cleaner.js (cleanText).
 *
 * The cleaned text is what rides in `text_cleaned` across every platform's
 * messages CSV, so each stripping rule gets its own assertion. The goal:
 * remove presentation markup without touching semantic markdown.
 */

import assert from 'node:assert/strict';
import { cleanText } from '../../utils/text_cleaner.js';

let passed = 0;
let failed = 0;

function run(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}`);
    console.error(e && e.stack ? e.stack : e);
  }
}

run('returns empty string for non-string / empty input', () => {
  assert.equal(cleanText(null), '');
  assert.equal(cleanText(undefined), '');
  assert.equal(cleanText(''), '');
  assert.equal(cleanText(42), '');
  assert.equal(cleanText({}), '');
});

run('strips Grok inline render citation blocks', () => {
  const grok = 'Snapshot of events<grok:render card_id="866af7" card_type="citation_card" type="render_inline_citation"><argument name="citation_id">0</argument></grok:render>.';
  assert.equal(cleanText(grok), 'Snapshot of events.');
});

run('strips multi-tag HTML while keeping prose', () => {
  const html = 'A <strong>bold</strong> and <em>italic</em> point.';
  assert.equal(cleanText(html), 'A bold and italic point.');
});

run('keeps mathematical < and > comparisons', () => {
  const prose = 'if a < b and b > c, then...';
  assert.equal(cleanText(prose), 'if a < b and b > c, then...');
});

run('strips ChatGPT bracketed citation markers', () => {
  const chatgpt = 'The study showed results.【12†source】 Keep going.';
  assert.equal(cleanText(chatgpt), 'The study showed results. Keep going.');
});

run('preserves markdown emphasis, lists, and headings', () => {
  const md = '# Title\n\n- **bold** item\n- `code` item\n\n> quote';
  assert.equal(cleanText(md), '# Title\n\n- **bold** item\n- `code` item\n\n> quote');
});

run('removes zero-width characters', () => {
  const invisible = 'word​word‌word﻿';
  assert.equal(cleanText(invisible), 'wordwordword');
});

run('collapses runs of 3+ blank lines to a single blank line', () => {
  const spacey = 'first\n\n\n\n\nsecond';
  assert.equal(cleanText(spacey), 'first\n\nsecond');
});

run('trims trailing whitespace on each line', () => {
  const trailing = 'line one   \nline two\t\nline three';
  assert.equal(cleanText(trailing), 'line one\nline two\nline three');
});

run('handles mixed Grok + markdown + bracketed cite', () => {
  const combo = '**Headline**<grok:render card_id="x"><argument name="citation_id">1</argument></grok:render>\n\nBody text.【0†web】';
  assert.equal(cleanText(combo), '**Headline**\n\nBody text.');
});

console.log(`\nText cleaner tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
