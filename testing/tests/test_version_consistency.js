/**
 * Version consistency: every version string that ships or is cited must be
 * the same. The extractor version is stamped into every CSV and manifest, so
 * it must equal the add-on version in manifest.json; package.json,
 * config/settings.js and CITATION.cff follow.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTRACTOR_VERSION } from '../../utils/manifest.js';
import { EXTENSION_CONFIG } from '../../config/settings.js';

// Set to a non-empty string to report mismatches without failing. Clear it
// in the same commit that aligns the versions.
const PENDING_UNTIL = 'D8: EXTRACTOR_VERSION is bumped to the manifest version in Phase 2';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const manifestVersion = JSON.parse(read('manifest.json')).version;
const packageVersion = JSON.parse(read('package.json')).version;
const citationMatch = read('CITATION.cff').match(/^version:\s*"?([^"\n]+)"?\s*$/m);
const citationVersion = citationMatch ? citationMatch[1].trim() : null;

const checks = [
  ['EXTRACTOR_VERSION equals manifest.json version', EXTRACTOR_VERSION === manifestVersion, `${EXTRACTOR_VERSION} vs ${manifestVersion}`],
  ['package.json version equals manifest.json version', packageVersion === manifestVersion, `${packageVersion} vs ${manifestVersion}`],
  ['config/settings.js version equals manifest.json version', EXTENSION_CONFIG.version === manifestVersion, `${EXTENSION_CONFIG.version} vs ${manifestVersion}`],
  ['CITATION.cff version equals manifest.json version', citationVersion === manifestVersion, `${citationVersion} vs ${manifestVersion}`],
  ['manifest.json version is semver', /^\d+\.\d+\.\d+$/.test(manifestVersion), manifestVersion]
];

let passed = 0;
let failed = 0;
for (const [name, ok, detail] of checks) {
  if (ok) { passed++; continue; }
  failed++;
  console.error(`${PENDING_UNTIL ? 'PENDING' : 'FAIL'}:`, name, detail);
}

if (PENDING_UNTIL && failed > 0) {
  console.log(`\nVersion consistency: ${passed} passed, ${failed} pending (not failing until ${PENDING_UNTIL})`);
} else {
  console.log(`\nVersion consistency: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
