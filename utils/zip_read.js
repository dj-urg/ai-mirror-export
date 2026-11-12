/**
 * Minimal ZIP reader, the counterpart to utils/zip.js.
 *
 * Reads the archives the extension writes (STORE) and archives a student
 * re-zipped with macOS / Windows / 7-Zip (DEFLATE, inflated with the
 * built-in DecompressionStream, so no dependency and no WASM). ZIP64,
 * encryption and multi-disk archives are refused with a readable error.
 *
 * Pure (no DOM, no browser.*). Works in an extension page and in Node 20+.
 */

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export class ZipReadError extends Error {}

function findEocd(view) {
  // EOCD is 22 bytes plus an optional comment of up to 65535 bytes.
  const min = Math.max(0, view.byteLength - 22 - 0xFFFF);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) return i;
  }
  throw new ZipReadError('Not a ZIP file (no end-of-archive record found).');
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * List and extract every file entry in a ZIP archive.
 * Directory entries are skipped; so are macOS resource forks (__MACOSX/).
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<Array<{name: string, bytes: Uint8Array}>>}
 */
export async function readZip(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('readZip expects a Uint8Array');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 22) throw new ZipReadError('Not a ZIP file (too short).');

  const eocd = findEocd(view);
  const entryCount = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xFFFF || cdOffset === 0xFFFFFFFF) {
    throw new ZipReadError('ZIP64 archives are not supported.');
  }

  const decoder = new TextDecoder('utf-8');
  const out = [];
  let p = cdOffset;
  for (let n = 0; n < entryCount; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== SIG_CENTRAL) {
      throw new ZipReadError('ZIP directory is damaged.');
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/') || name.startsWith('__MACOSX/')) continue;
    if (flags & 0x0001) throw new ZipReadError(`"${name}" is encrypted.`);

    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== SIG_LOCAL) {
      throw new ZipReadError(`ZIP entry "${name}" is damaged.`);
    }
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    if (start + compSize > bytes.length) throw new ZipReadError(`ZIP entry "${name}" is truncated.`);
    const raw = bytes.subarray(start, start + compSize);

    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = await inflateRaw(raw);
    else throw new ZipReadError(`"${name}" uses an unsupported compression method (${method}).`);

    out.push({ name, bytes: data });
  }
  return out;
}
