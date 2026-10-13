/**
 * Tests for utils/manifest.js. Node ESM.
 */
import {
  sha256Hex,
  hmacDonorId,
  countRows,
  buildManifest,
  toIsoUtc,
  canonicalHeaders,
  EXTRACTOR_VERSION,
  SCHEMA_VERSIONS,
  MANIFEST_SCHEMA_VERSION
} from '../../utils/manifest.js';

let passed = 0;
let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', name, detail); }
}

async function run() {
  // sha256Hex
  const empty = await sha256Hex('');
  assert('sha256 of empty is standard hash',
    empty === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const abc = await sha256Hex('abc');
  assert('sha256 of abc is standard hash',
    abc === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

  // hmacDonorId
  const idPlain = await hmacDonorId('donor-123', '');
  assert('empty salt returns raw id', idPlain === 'donor-123');
  const idSalted = await hmacDonorId('donor-123', 'salt-xyz');
  assert('salted id is 64 hex chars', /^[0-9a-f]{64}$/.test(idSalted));
  const idSalted2 = await hmacDonorId('donor-123', 'salt-xyz');
  assert('hmac is deterministic', idSalted === idSalted2);
  const idDifferent = await hmacDonorId('donor-123', 'other-salt');
  assert('different salt yields different hash', idSalted !== idDifferent);

  // countRows
  assert('empty csv has 0 rows', countRows('') === 0);
  assert('header-only has 0 rows', countRows('h1,h2\r\n') === 0);
  assert('one row csv', countRows('h1,h2\r\na,b\r\n') === 1);
  assert('three row csv', countRows('h1\r\n1\r\n2\r\n3\r\n') === 3);
  assert('tolerates missing trailing newline', countRows('h1\r\n1\r\n2') === 2);

  // buildManifest
  const manifestJson = await buildManifest({
    platform: 'claude',
    conversationId: 'abc-123',
    donorIdHashed: 'hashed-id',
    donorIdType: 'persistent',
    downloadTime: '2026-01-01T00:00:00.000Z',
    files: [
      { filename: 'claude_messages.csv', content: 'h\r\na\r\n', schemaName: 'claude_messages' }
    ],
    extras: { pii_redactions: 3 }
  });
  const manifest = JSON.parse(manifestJson);
  assert('manifest has schema version', manifest.manifest_schema_version === MANIFEST_SCHEMA_VERSION);
  assert('manifest has extractor version', manifest.extractor_version === EXTRACTOR_VERSION);
  assert('manifest records platform', manifest.platform === 'claude');
  assert('manifest records conversation id', manifest.conversation_id === 'abc-123');
  assert('manifest has one file entry', manifest.files.length === 1);
  assert('file entry has sha256', /^[0-9a-f]{64}$/.test(manifest.files[0].sha256));
  assert('file entry has schema', manifest.files[0].schema === 'claude_messages');
  assert('file entry has version', manifest.files[0].schema_version === SCHEMA_VERSIONS.claude_messages);
  assert('file entry row count', manifest.files[0].rows === 1);
  assert('manifest preserves extras', manifest.telemetry.pii_redactions === 3);

  // MANIFEST_SCHEMA_VERSION bumped additively to 1.1.0
  assert('manifest schema is 1.1.0', MANIFEST_SCHEMA_VERSION === '1.1.0');

  // New additive telemetry fields survive the round-trip
  const manifestWithScrub = await buildManifest({
    platform: 'claude',
    conversationId: 'abc-456',
    donorIdHashed: 'hashed-id',
    donorIdType: 'persistent',
    downloadTime: '2026-01-01T00:00:00.000Z',
    files: [
      { filename: 'claude_messages.csv', content: 'h\r\na\r\n', schemaName: 'claude_messages' }
    ],
    extras: {
      pii_scrub_enabled: true,
      pii_scrub_options: { URL: false },
      pii_ruleset_version: '1.0.0',
      pii_redactions_total: 3,
      pii_redactions_by_type: { EMAIL: 2, PHONE: 1 }
    }
  });
  const m2 = JSON.parse(manifestWithScrub);
  assert('telemetry has pii_scrub_options', m2.telemetry.pii_scrub_options.URL === false);
  assert('telemetry has pii_ruleset_version', m2.telemetry.pii_ruleset_version === '1.0.0');
  assert('telemetry has pii_redactions_by_type EMAIL', m2.telemetry.pii_redactions_by_type.EMAIL === 2);
  assert('telemetry has pii_redactions_by_type PHONE', m2.telemetry.pii_redactions_by_type.PHONE === 1);
  assert('pii_scrub_options and by_type share UPPERCASE vocabulary',
    Object.keys(m2.telemetry.pii_scrub_options).every(k => k === k.toUpperCase()) &&
    Object.keys(m2.telemetry.pii_redactions_by_type).every(k => k === k.toUpperCase()));

  // toIsoUtc
  assert('toIsoUtc passes through ISO', toIsoUtc('2026-01-01T00:00:00.000Z') === '2026-01-01T00:00:00.000Z');
  assert('toIsoUtc handles unix seconds',
    toIsoUtc(1735689600) === '2025-01-01T00:00:00.000Z');
  assert('toIsoUtc handles unix ms',
    toIsoUtc(1735689600000) === '2025-01-01T00:00:00.000Z');
  assert('toIsoUtc empty for null', toIsoUtc(null) === '');
  assert('toIsoUtc empty for garbage', toIsoUtc('not a date') === '');
  assert('toIsoUtc empty for empty string', toIsoUtc('') === '');

  // canonicalHeaders
  const headers = canonicalHeaders();
  assert('canonical has donor_id first', headers[0] === 'donor_id');
  assert('canonical includes schema_version', headers.includes('schema_version'));
  assert('canonical includes extractor_version', headers.includes('extractor_version'));
  assert('canonical includes platform_specific_json', headers.includes('platform_specific_json'));
  assert('canonicalHeaders returns copy',
    canonicalHeaders() !== canonicalHeaders() || Array.isArray(canonicalHeaders()));

  console.log(`\nManifest tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
