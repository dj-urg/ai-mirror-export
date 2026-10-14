/**
 * PII sweep: with scrubbing on, nothing planted may survive anywhere in the ZIP.
 *
 * For every platform fixture, an email, a phone number, an IPv4 address and an
 * API-key-like token are appended to every prose field (string values that
 * contain whitespace, plus known title/text keys). The payload is exported
 * through the real background.js with `pii_scrub_enabled: true`, and the test
 * asserts that none of the planted values appears in any ZIP entry: not in any
 * CSV column (including raw-JSON columns and the canonical file), not in the
 * manifest, and not in any file name. It also checks that every `*_json`
 * column still parses as JSON after scrubbing, and that the manifest's
 * redaction counters are consistent.
 *
 * Planted values are built at runtime so no secret-looking literal lives in
 * the repository.
 */
import { runExport, loadFixture, utf8, PLATFORM_SCENARIOS } from './helpers/bg_harness.js';
import { parseCsv } from './helpers/csv_parse.js';

// Set to a non-empty string to report leaks without failing. Clear it in the
// same commit that makes scrubbing cover every text-bearing column (D10).
const PENDING_UNTIL = '';

export const PLANTED = Object.freeze({
  EMAIL: 'pii.sweep.donor@example.test',
  PHONE: '555-123-9876',
  IP: '203.0.113.77',
  TOKEN: 'sk-' + 'Zq9x'.repeat(10)
});
// Words between the values keep the phone pattern from running into the IP
// (the scrubber's phone regex allows digit groups separated by spaces/dots).
const PLANT_SUFFIX = ` email ${PLANTED.EMAIL} phone ${PLANTED.PHONE} ip ${PLANTED.IP} key ${PLANTED.TOKEN}`;

// Keys whose string values are prose even when they contain no whitespace.
// (`name` is deliberately absent: it is a tool name on tool_use blocks; a
// conversation name contains whitespace and is planted by the general rule.)
const TEXT_KEYS = new Set([
  'text', 'content', 'answer', 'title', 'snippet', 'query', 'query_str', 'summary',
  'message', 'spokenText', 'description', 'user_profile', 'user_instructions',
  'about_user_message', 'about_model_message', 'ai_overview_text', 'conversation_title',
  'searchQuery', 'thinking', 'reasoning', 'code', 'extracted_text', 'extracted_content', 'file_name', 'cited_text'
]);
// Keys that look like text but are structural; never plant there.
const SKIP_KEYS = new Set(['url', 'seeMoreUrl', 'source_page_url', 'domain', 'imageLink']);

export function plantPii(value, key = '') {
  if (Array.isArray(value)) return value.map(v => plantPii(v, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = plantPii(v, k);
    return out;
  }
  if (typeof value === 'string') {
    if (SKIP_KEYS.has(key)) return value;
    if (/\s/.test(value) || TEXT_KEYS.has(key)) return value + PLANT_SUFFIX;
  }
  return value;
}

let passed = 0;
let failed = 0;
const label = PENDING_UNTIL ? 'PENDING' : 'FAIL';
function assert(name, cond, detail = '') {
  if (cond) { passed++; } else { failed++; console.error(`${label}:`, name, detail); }
}

function findPlanted(text) {
  return Object.entries(PLANTED).filter(([, v]) => text.includes(v)).map(([k]) => k);
}

for (const s of PLATFORM_SCENARIOS) {
  const payload = plantPii(loadFixture(s.fixture));
  let result;
  try {
    result = await runExport({
      messageType: s.messageType, payload, senderUrl: s.senderUrl,
      settings: { pii_scrub_enabled: true }
    });
  } catch (err) {
    assert(`${s.id}: export completes`, false, err.message);
    continue;
  }
  assert(`${s.id}: a ZIP was downloaded`, result.filename !== null, JSON.stringify(result.broadcasts));
  if (!result.filename) continue;

  assert(`${s.id}: zip file name carries no planted value`, findPlanted(result.filename).length === 0, result.filename);

  let manifest = null;
  for (const [name, bytes] of result.entries) {
    const text = utf8(bytes);
    const leaks = findPlanted(name);
    assert(`${s.id}: entry name ${name} carries no planted value`, leaks.length === 0, leaks.join(','));
    if (name.endsWith('.json')) {
      manifest = JSON.parse(text);
      const l = findPlanted(text);
      assert(`${s.id}: manifest carries no planted value`, l.length === 0, l.join(','));
      continue;
    }
    const { headers, rows } = parseCsv(text);
    for (const h of headers) {
      const colText = rows.map(r => r[h]).join('\n');
      const l = findPlanted(colText);
      assert(`${s.id}: ${name} column ${h} carries no planted value`, l.length === 0, l.join(','));
      if (h.endsWith('_json')) {
        for (const r of rows) {
          if (!r[h]) continue;
          let ok = true;
          try { JSON.parse(r[h]); } catch { ok = false; }
          assert(`${s.id}: ${name} column ${h} is valid JSON after scrubbing`, ok, r[h].slice(0, 120));
          if (!ok) break;
        }
      }
    }
  }

  // The real-data validation (2026-10-14) found planted values surviving in
  // a Claude export with an uploaded file and citations. Make sure those
  // files are actually produced and scrubbed here, not merely absent.
  if (s.id === 'claude_rich') {
    const names = [...result.entries.keys()];
    const att = names.find(n => n.startsWith('claude_attachments_'));
    const src = names.find(n => n.startsWith('claude_sources_'));
    assert('claude_rich: attachments CSV present', Boolean(att), names.join(','));
    assert('claude_rich: sources CSV present', Boolean(src), names.join(','));
    if (att) {
      const rows = parseCsv(utf8(result.entries.get(att))).rows;
      assert('claude_rich: extracted_text was scrubbed', rows.some(r => r.extracted_text.includes('<REDACTED:EMAIL>')));
      assert('claude_rich: attachment raw_json was scrubbed', rows.some(r => r.raw_json.includes('<REDACTED:EMAIL>')));
    }
    if (src) {
      const rows = parseCsv(utf8(result.entries.get(src))).rows;
      assert('claude_rich: citation title was scrubbed', rows.some(r => r.title.includes('<REDACTED:EMAIL>')));
      assert('claude_rich: citation snippet was scrubbed', rows.some(r => r.snippet.includes('<REDACTED:EMAIL>')));
    }
    const msgs = names.find(n => n.startsWith('claude_messages_1'));
    const rows = parseCsv(utf8(result.entries.get(msgs))).rows;
    assert('claude_rich: tool_input_json was scrubbed', rows.some(r => r.tool_input_json.includes('<REDACTED:EMAIL>')));
    assert('claude_rich: thinking text was scrubbed', rows.some(r => r.content_type === 'thinking' && r.text.includes('<REDACTED:EMAIL>')));
  }

  if (manifest) {
    const t = manifest.telemetry || {};
    assert(`${s.id}: manifest says scrubbing was on`, t.pii_scrub_enabled === true);
    const byType = t.pii_redactions_by_type || {};
    const sum = Object.values(byType).reduce((a, b) => a + b, 0);
    assert(`${s.id}: pii_redactions_total equals the sum of by_type`, t.pii_redactions_total === sum,
      `${t.pii_redactions_total} vs ${sum} ${JSON.stringify(byType)}`);
    for (const type of ['EMAIL', 'PHONE', 'IP', 'TOKEN']) {
      assert(`${s.id}: by_type counts at least one ${type}`, (byType[type] || 0) >= 1, JSON.stringify(byType));
    }
  }
}

if (PENDING_UNTIL && failed > 0) {
  console.log(`\nPII sweep: ${passed} passed, ${failed} pending (not failing until ${PENDING_UNTIL})`);
} else {
  console.log(`\nPII sweep: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
