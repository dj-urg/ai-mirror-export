/**
 * config/settings.js platform domains must match manifest.json exactly:
 * every configured domain must be covered by a content_scripts match
 * pattern, and every content-script host must be covered by a configured
 * domain. Otherwise the toolbar icon / popup / sender check disagree with
 * where the content scripts run (review B-L7 / A-L3).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSION_CONFIG, getPlatformByUrl } from '../../config/settings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

let passed = 0;
let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; } else { failed++; console.error('FAIL:', name, detail); }
}

const hostOf = (pattern) => new URL(pattern.replace('*', 'x')).hostname;
const scriptHosts = new Set();
for (const cs of manifest.content_scripts) for (const m of cs.matches) scriptHosts.add(hostOf(m));
const permissionHosts = new Set(manifest.host_permissions.map(hostOf));

const configured = new Set();
for (const [id, p] of Object.entries(EXTENSION_CONFIG.platforms)) {
  for (const d of p.domains) {
    configured.add(d);
    assert(`${id}: domain ${d} has a content script`, scriptHosts.has(d), [...scriptHosts].join(','));
    assert(`${id}: domain ${d} has a host permission`, permissionHosts.has(d));
  }
}
for (const h of scriptHosts) {
  assert(`content-script host ${h} is a configured domain`, configured.has(h));
}
for (const h of permissionHosts) {
  assert(`host permission ${h} is a configured domain`, configured.has(h));
}

// Negative cases the review called out.
assert('mail.google.com is not a platform', getPlatformByUrl('https://mail.google.com/mail/') === null);
assert('docs.google.com is not a platform', getPlatformByUrl('https://docs.google.com/document/d/x') === null);
assert('www.google.com/search is google_search', getPlatformByUrl('https://www.google.com/search?q=x')?.id === 'google_search');
assert('perplexity apex is not a platform', getPlatformByUrl('https://perplexity.ai/') === null);
assert('www.perplexity.ai is perplexity', getPlatformByUrl('https://www.perplexity.ai/search/x')?.id === 'perplexity');

console.log(`\nSettings/manifest domain tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
