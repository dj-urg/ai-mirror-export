/**
 * Tests for utils/zip_read.js against hand-made archives: size caps,
 * CRC-32, the entry filter, ZIP64 / multi-disk / encryption refusals and
 * Windows-style paths. Node ESM, no fixtures on disk.
 */
import assert from 'node:assert/strict';

import { buildZip, crc32 } from '../../utils/zip.js';
import { readZip, ZipReadError } from '../../utils/zip_read.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Build an archive by hand. Each entry: {name, content, method (0|8)} plus
 * optional overrides of what the headers claim: crc, size, compSize, flags,
 * diskStart.
 */
async function makeZip(entries, eocdOverrides = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const raw = typeof e.content === 'string' ? enc.encode(e.content) : e.content;
    const method = e.method ?? 0;
    const data = method === 8 ? await deflate(raw) : raw;
    const crc = e.crc ?? crc32(raw);
    const size = e.size ?? raw.length;
    const compSize = e.compSize ?? data.length;

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true);
    lh.setUint16(6, e.flags ?? 0, true); lh.setUint16(8, method, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, compSize, true); lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true);
    locals.push(new Uint8Array(lh.buffer), name, data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint16(8, e.flags ?? 0, true); ch.setUint16(10, method, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, compSize, true); ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true); ch.setUint16(34, e.diskStart ?? 0, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, eocdOverrides.disk ?? 0, true);
  eocd.setUint16(6, eocdOverrides.cdDisk ?? 0, true);
  eocd.setUint16(8, eocdOverrides.entriesOnDisk ?? entries.length, true);
  eocd.setUint16(10, eocdOverrides.entries ?? entries.length, true);
  eocd.setUint32(12, cdSize, true); eocd.setUint32(16, eocdOverrides.cdOffset ?? offset, true);
  const parts = [...locals, ...central, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

async function refuses(zip, pattern, opts) {
  await assert.rejects(() => readZip(zip, opts), (err) => {
    assert.ok(err instanceof ZipReadError, `expected ZipReadError, got ${err}`);
    assert.match(err.message, pattern);
    return true;
  });
}

let checks = 0;
const ok = () => { checks++; };

// --- reads what the extension and common tools write --------------------------
{
  const entries = await readZip(buildZip([{ name: 'a.csv', content: 'h\r\nü\r\n' }, { name: 'dir/b.txt', content: 'b' }]));
  assert.deepEqual(entries.map(e => e.name), ['a.csv', 'dir/b.txt']);
  assert.equal(dec.decode(entries[0].bytes), 'h\r\nü\r\n');
  ok();

  const text = 'hello,'.repeat(500);
  const [deflated] = await readZip(await makeZip([{ name: 'x.csv', content: text, method: 8 }]));
  assert.equal(dec.decode(deflated.bytes), text);
  ok();

  // Bit 3 (sizes repeated after the data) is what macOS Archive Utility sets;
  // the directory still has the real values.
  const [streamed] = await readZip(await makeZip([{ name: 'x.csv', content: text, method: 8, flags: 0x0008 }]));
  assert.equal(dec.decode(streamed.bytes), text);
  ok();

  const [empty] = await readZip(await makeZip([{ name: 'empty.csv', content: '' }]));
  assert.equal(empty.bytes.length, 0);
  ok();
}

// --- folders, resource forks, Windows separators ------------------------------
{
  const zip = await makeZip([
    { name: 'export\\sub\\a.csv', content: 'a' },
    { name: 'folder/', content: '' },
    { name: '__MACOSX/._a.csv', content: 'junk' },
    { name: '__MACOSX\\._b.csv', content: 'junk' }
  ]);
  assert.deepEqual((await readZip(zip)).map(e => e.name), ['export/sub/a.csv']);
  ok();
}

// --- filter: other entries are never unpacked ---------------------------------
{
  const zip = await makeZip([
    { name: 'keep.csv', content: 'k' },
    { name: 'bomb.bin', content: 'x', method: 8, size: 0xFFFFFFF0 },   // would be refused if looked at
    { name: 'broken.bin', content: 'x', crc: 1 },
    { name: 'secret.bin', content: 'x', flags: 0x0001 },
    { name: 'odd.bin', content: 'x', method: 12 }
  ]);
  const seen = [];
  const entries = await readZip(zip, { filter: (name) => { seen.push(name); return name.endsWith('.csv'); } });
  assert.deepEqual(entries.map(e => e.name), ['keep.csv']);
  assert.equal(seen.length, 5);
  await refuses(zip, /too large/);
  ok();
}

// --- size caps ----------------------------------------------------------------
{
  // Declared size over the cap: refused before anything is unpacked.
  await refuses(await makeZip([{ name: 'big.csv', content: 'x'.repeat(2000), method: 8 }]),
    /"big\.csv" is too large to merge \(more than 0 MB when unpacked\)/, { maxEntryBytes: 1000 });
  await refuses(await makeZip([{ name: 'big.csv', content: 'x', method: 8, size: 300 * 1024 * 1024 }]),
    /"big\.csv" is too large to merge \(more than 200 MB when unpacked\)/);
  ok();

  // Several entries that fit one by one but not together.
  const three = await makeZip([1, 2, 3].map(i => ({ name: `${i}.csv`, content: 'x'.repeat(400) })));
  await refuses(three, /This ZIP is too large to merge/, { maxEntryBytes: 500, maxTotalBytes: 1000 });
  assert.equal((await readZip(three, { maxEntryBytes: 500, maxTotalBytes: 1200 })).length, 3);
  ok();

  // A header that understates the size: inflating stops at the declared size.
  const lying = await makeZip([{ name: 'bomb.csv', content: 'x'.repeat(5 * 1024 * 1024), method: 8, size: 10 }]);
  assert.ok(lying.length < 20000, 'fixture is a small archive');
  await refuses(lying, /"bomb\.csv" is damaged/);
  // ... and one that overstates it.
  await refuses(await makeZip([{ name: 'short.csv', content: 'abc', method: 8, size: 10 }]), /"short\.csv" is damaged/);
  await refuses(await makeZip([{ name: 'stored.csv', content: 'abc', size: 10 }]), /"stored\.csv" is damaged/);
  ok();
}

// --- checksums and corrupt data -----------------------------------------------
{
  await refuses(await makeZip([{ name: 'a.csv', content: 'abc', crc: 0 }]), /checksum does not match/);
  await refuses(await makeZip([{ name: 'a.csv', content: 'abc'.repeat(50), method: 8, crc: 0 }]), /checksum does not match/);

  const flipped = buildZip([{ name: 'a.csv', content: 'conversation' }]);
  flipped[30 + 'a.csv'.length] ^= 0x01;   // first data byte
  await refuses(flipped, /checksum does not match/);

  const garbage = await makeZip([{ name: 'a.csv', content: 'abcdefgh'.repeat(40), method: 8 }]);
  garbage.fill(0xFF, 30 + 'a.csv'.length, 30 + 'a.csv'.length + 4);
  await refuses(garbage, /"a\.csv" is damaged/);
  ok();
}

// --- archives this reader does not support ------------------------------------
{
  const one = [{ name: 'a.csv', content: 'abc' }];
  await refuses(await makeZip(one, { disk: 1 }), /split over several files/);
  await refuses(await makeZip(one, { cdDisk: 1 }), /split over several files/);
  await refuses(await makeZip(one, { entriesOnDisk: 0 }), /split over several files/);
  await refuses(await makeZip([{ ...one[0], diskStart: 2 }]), /split over several files/);
  await refuses(await makeZip(one, { entries: 0xFFFF, entriesOnDisk: 0xFFFF }), /ZIP64/);
  await refuses(await makeZip(one, { cdOffset: 0xFFFFFFFF }), /ZIP64/);
  await refuses(await makeZip([{ ...one[0], size: 0xFFFFFFFF, compSize: 0xFFFFFFFF }]), /ZIP64/);
  await refuses(await makeZip([{ ...one[0], flags: 0x0001 }]), /encrypted/);
  await refuses(await makeZip([{ ...one[0], method: 12 }]), /unsupported compression method \(12\)/);
  await refuses(await makeZip(one, { entries: 2, entriesOnDisk: 2 }), /directory is damaged/);
  await refuses(await makeZip(one, { cdOffset: 5 }), /directory is damaged/);
  await refuses(await makeZip([{ ...one[0], compSize: 5000, size: 5000 }]), /truncated/);
  await refuses(enc.encode('definitely not a zip file at all'), /Not a ZIP file/);
  await refuses(new Uint8Array(4), /Not a ZIP file/);
  await assert.rejects(() => readZip('nope'), TypeError);
  ok();
}

console.log(`[test_zip_read] ${checks} groups passed`);
