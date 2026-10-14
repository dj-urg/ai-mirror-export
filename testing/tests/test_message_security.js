/**
 * shared/message-security.js is a classic script that attaches
 * window.MessageSecurity. Load it in a vm sandbox with a fake window that
 * exposes Node's WebCrypto, then exercise sign / verify / replay.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'message-security.js'), 'utf8');

const window = { crypto: globalThis.crypto, TextEncoder, Uint8Array, Uint32Array };
const context = vm.createContext({ window, JSON, Array, Date, Promise, Object, Error, TypeError });
vm.runInContext(source, context, { filename: 'message-security.js' });
const MessageSecurity = window.MessageSecurity;

let passed = 0;
let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; } else { failed++; console.error('FAIL:', name, detail); }
}

assert('MessageSecurity attached to window', MessageSecurity && typeof MessageSecurity.createSignedMessage === 'function');

const secret = 'a'.repeat(64);
const payload = { hello: 'world' };
const signed = await MessageSecurity.createSignedMessage(payload, 'TEST_TYPE', 'test-source', 'test', secret);
assert('signed message carries signature/timestamp/nonce',
  typeof signed.signature === 'string' && typeof signed.timestamp === 'number' && typeof signed.nonce === 'string');

const ok = await MessageSecurity.verifySignedMessage(signed, 'TEST_TYPE', 'test-source', secret);
assert('first verification succeeds', ok.isValid === true, ok.error);

const replay = await MessageSecurity.verifySignedMessage(signed, 'TEST_TYPE', 'test-source', secret);
assert('replaying the same message is rejected', replay.isValid === false && /nonce/i.test(replay.error || ''), JSON.stringify(replay));

const tampered = { ...signed, payload: { hello: 'tampered' } };
const bad = await MessageSecurity.verifySignedMessage(tampered, 'TEST_TYPE', 'test-source', secret);
assert('tampered payload fails signature', bad.isValid === false && bad.error === 'Invalid signature', JSON.stringify(bad));

const wrongSecret = await MessageSecurity.verifySignedMessage(
  await MessageSecurity.createSignedMessage(payload, 'TEST_TYPE', 'test-source', 'test', secret),
  'TEST_TYPE', 'test-source', 'b'.repeat(64));
assert('wrong secret fails signature', wrongSecret.isValid === false);

const stale = await MessageSecurity.createSignedMessage(payload, 'TEST_TYPE', 'test-source', 'test', secret);
stale.timestamp -= 60000;
const staleSigned = await MessageSecurity.createSignedMessage(payload, 'TEST_TYPE', 'test-source', 'test', secret);
// Re-sign with an old timestamp by building the message by hand.
const { signature: _s, ...staleData } = staleSigned;
staleData.timestamp -= 60000;
const staleSig = await MessageSecurity.signMessage(JSON.stringify(staleData), secret);
const staleResult = await MessageSecurity.verifySignedMessage({ ...staleData, signature: staleSig }, 'TEST_TYPE', 'test-source', secret);
assert('message older than the window is rejected', staleResult.isValid === false && /timestamp/i.test(staleResult.error || ''), JSON.stringify(staleResult));

const second = await MessageSecurity.createSignedMessage(payload, 'TEST_TYPE', 'test-source', 'test', secret);
assert('distinct messages have distinct nonces', second.nonce !== signed.nonce);
const secondOk = await MessageSecurity.verifySignedMessage(second, 'TEST_TYPE', 'test-source', secret);
assert('a fresh message after a replay still verifies', secondOk.isValid === true, secondOk.error);

console.log(`\nMessage security tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
