/**
 * Minimal ZIP reader, the counterpart to utils/zip.js.
 *
 * Reads the archives the extension writes (STORE) and archives a student
 * re-zipped with macOS / Windows / 7-Zip (DEFLATE, inflated with the
 * built-in DecompressionStream, so no dependency and no WASM). ZIP64,
 * encryption and multi-disk archives are refused with a readable error.
 *
 * Archives come from other people, so nothing in them is trusted: only the
 * entries the caller asks for are unpacked, unpacked sizes are capped (both
 * the size the archive declares and the bytes that actually come out), and
 * every unpacked entry is checked against its CRC-32.
 *
 * Pure (no DOM, no browser.*). Works in an extension page and in Node 20+.
 */

import { crc32 } from './zip.js';

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const MB = 1024 * 1024;
export const DEFAULT_MAX_ENTRY_BYTES = 200 * MB;
export const DEFAULT_MAX_TOTAL_BYTES = 500 * MB;

export class ZipReadError extends Error {}

function findEocd(view) {
  // EOCD is 22 bytes plus an optional comment of up to 65535 bytes.
  const min = Math.max(0, view.byteLength - 22 - 0xFFFF);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) return i;
  }
  throw new ZipReadError('Not a ZIP file (no end-of-archive record found).');
}

/**
 * Inflate one entry, stopping as soon as more bytes come out than the
 * archive declared (so a small file cannot unpack into gigabytes).
 */
async function inflateRaw(raw, name, expectedSize) {
  const damaged = () => new ZipReadError(`ZIP entry "${name}" is damaged.`);
  const reader = new Blob([raw]).stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
    .getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > expectedSize) {
        await reader.cancel().catch(() => {});
        throw damaged();
      }
      chunks.push(value);
    }
  } catch (err) {
    throw err instanceof ZipReadError ? err : damaged();
  }
  if (size !== expectedSize) throw damaged();
  const out = new Uint8Array(size);
  let pos = 0;
  for (const chunk of chunks) { out.set(chunk, pos); pos += chunk.length; }
  return out;
}

/**
 * List and extract the file entries in a ZIP archive.
 * Directory entries are skipped; so are macOS resource forks (__MACOSX/).
 * Entry names always use `/` as the folder separator.
 *
 * @param {Uint8Array} bytes
 * @param {object} [opts]
 * @param {(name: string) => boolean} [opts.filter]  Only unpack entries this
 *   returns true for (default: all). Other entries are not read at all.
 * @param {number} [opts.maxEntryBytes]  Largest unpacked size of one entry.
 * @param {number} [opts.maxTotalBytes]  Largest unpacked size of all
 *   unpacked entries together.
 * @returns {Promise<Array<{name: string, bytes: Uint8Array}>>}
 */
export async function readZip(bytes, opts = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('readZip expects a Uint8Array');
  const {
    filter = null,
    maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES
  } = opts;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 22) throw new ZipReadError('Not a ZIP file (too short).');

  const eocd = findEocd(view);
  const diskNumber = view.getUint16(eocd + 4, true);
  const cdDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
    throw new ZipReadError('ZIP64 archives are not supported.');
  }
  if (diskNumber !== 0 || cdDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new ZipReadError('ZIP archives split over several files are not supported.');
  }

  const decoder = new TextDecoder('utf-8');
  const out = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < entryCount; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== SIG_CENTRAL) {
      throw new ZipReadError('ZIP directory is damaged.');
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const diskStart = view.getUint16(p + 34, true);
    const localOffset = view.getUint32(p + 42, true);
    if (p + 46 + nameLen > bytes.length) throw new ZipReadError('ZIP directory is damaged.');
    // Windows tools sometimes write `\` as the folder separator.
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/') || name.startsWith('__MACOSX/')) continue;
    if (filter && !filter(name)) continue;

    if (flags & 0x0001) throw new ZipReadError(`"${name}" is encrypted.`);
    if (compSize === 0xFFFFFFFF || size === 0xFFFFFFFF || localOffset === 0xFFFFFFFF) {
      throw new ZipReadError('ZIP64 archives are not supported.');
    }
    if (diskStart !== 0) {
      throw new ZipReadError('ZIP archives split over several files are not supported.');
    }
    if (method !== 0 && method !== 8) {
      throw new ZipReadError(`"${name}" uses an unsupported compression method (${method}).`);
    }
    if (size > maxEntryBytes) {
      throw new ZipReadError(
        `"${name}" is too large to merge (more than ${Math.floor(maxEntryBytes / MB)} MB when unpacked).`);
    }
    total += size;
    if (total > maxTotalBytes) {
      throw new ZipReadError(
        `This ZIP is too large to merge (more than ${Math.floor(maxTotalBytes / MB)} MB when unpacked).`);
    }

    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== SIG_LOCAL) {
      throw new ZipReadError(`ZIP entry "${name}" is damaged.`);
    }
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    if (start + compSize > bytes.length) throw new ZipReadError(`ZIP entry "${name}" is truncated.`);
    const raw = bytes.subarray(start, start + compSize);

    let data;
    if (method === 0) {
      if (compSize !== size) throw new ZipReadError(`ZIP entry "${name}" is damaged.`);
      data = raw.slice();
    } else {
      data = await inflateRaw(raw, name, size);
    }
    if (crc32(data) !== crc) {
      throw new ZipReadError(`ZIP entry "${name}" is damaged (its checksum does not match).`);
    }

    out.push({ name, bytes: data });
  }
  return out;
}
