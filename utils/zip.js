/**
 * Minimal ZIP writer (STORE / no compression).
 *
 * Produces a valid ZIP file from an array of { name, content } entries, where
 * `content` is a string or a Uint8Array. Output is a single Uint8Array ready
 * to wrap in a Blob and hand to the downloads API.
 *
 * Deliberately store-only (compression method 0). CSVs for one conversation
 * are small, and keeping zero deflate/compression code means no dependencies,
 * no WASM, and no CSP exceptions. The archive opens with every mainstream
 * extractor (macOS Archive Utility, Windows Explorer, 7-Zip, `unzip`, Python
 * zipfile, pandas `read_csv` from a ZipFile handle, …).
 *
 * File names are stored as UTF-8 and tagged with the ZIP General Purpose Bit
 * Flag 0x0800 so non-ASCII names survive.
 *
 * Pure (no DOM, no browser globals, no Node globals). Safe for extension
 * service workers and Node tests. crypto.subtle is NOT used because ZIP
 * requires IEEE CRC-32, which is unrelated to subtle-crypto's digest set — we
 * compute it with a precomputed table.
 */

// ---------------------------------------------------------------------------
// CRC32 (IEEE 802.3 polynomial 0xEDB88320, reflected)
// ---------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}


// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

function toBytes(content) {
  if (content instanceof Uint8Array) return content;
  if (typeof content === 'string') return new TextEncoder().encode(content);
  throw new TypeError('zip entry content must be a string or Uint8Array');
}

function writeUint16LE(view, offset, value) {
  view.setUint16(offset, value & 0xFFFF, true);
}

function writeUint32LE(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

/**
 * Encode a JS Date as DOS time + date for a ZIP header.
 * DOS time: hour<<11 | minute<<5 | second/2
 * DOS date: (year-1980)<<9 | month<<5 | day
 */
function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date();
  const year = Math.max(1980, d.getUTCFullYear());
  const dosDate =
    ((year - 1980) << 9) |
    ((d.getUTCMonth() + 1) << 5) |
    d.getUTCDate();
  const dosTime =
    (d.getUTCHours() << 11) |
    (d.getUTCMinutes() << 5) |
    Math.floor(d.getUTCSeconds() / 2);
  return { dosDate: dosDate & 0xFFFF, dosTime: dosTime & 0xFFFF };
}


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a ZIP archive (STORE mode) from an array of entries.
 *
 * @param {Array<{name: string, content: string|Uint8Array, date?: Date}>} entries
 * @returns {Uint8Array} The full archive bytes.
 */
export function buildZip(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('buildZip requires a non-empty array of entries');
  }

  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = toBytes(entry.content);
    const crc = crc32(data);
    const size = data.length;
    const { dosDate, dosTime } = dosDateTime(entry.date);

    // Local file header: 30 bytes + filename + data
    const localHeader = new ArrayBuffer(30);
    const lhView = new DataView(localHeader);
    writeUint32LE(lhView, 0, 0x04034b50);   // signature
    writeUint16LE(lhView, 4, 20);           // version needed
    writeUint16LE(lhView, 6, 0x0800);       // flags (UTF-8 name)
    writeUint16LE(lhView, 8, 0);            // method: STORE
    writeUint16LE(lhView, 10, dosTime);
    writeUint16LE(lhView, 12, dosDate);
    writeUint32LE(lhView, 14, crc);
    writeUint32LE(lhView, 18, size);        // compressed size (STORE = same)
    writeUint32LE(lhView, 22, size);        // uncompressed size
    writeUint16LE(lhView, 26, nameBytes.length);
    writeUint16LE(lhView, 28, 0);           // extra length

    localParts.push(new Uint8Array(localHeader), nameBytes, data);

    // Central directory file header: 46 bytes + filename
    const centralHeader = new ArrayBuffer(46);
    const chView = new DataView(centralHeader);
    writeUint32LE(chView, 0, 0x02014b50);   // signature
    writeUint16LE(chView, 4, 20);           // version made by (2.0, DOS)
    writeUint16LE(chView, 6, 20);           // version needed
    writeUint16LE(chView, 8, 0x0800);       // flags (UTF-8 name)
    writeUint16LE(chView, 10, 0);           // method: STORE
    writeUint16LE(chView, 12, dosTime);
    writeUint16LE(chView, 14, dosDate);
    writeUint32LE(chView, 16, crc);
    writeUint32LE(chView, 20, size);
    writeUint32LE(chView, 24, size);
    writeUint16LE(chView, 28, nameBytes.length);
    writeUint16LE(chView, 30, 0);           // extra length
    writeUint16LE(chView, 32, 0);           // comment length
    writeUint16LE(chView, 34, 0);           // disk number start
    writeUint16LE(chView, 36, 0);           // internal attrs
    writeUint32LE(chView, 38, 0);           // external attrs
    writeUint32LE(chView, 42, offset);      // local header offset

    centralParts.push(new Uint8Array(centralHeader), nameBytes);

    offset += 30 + nameBytes.length + size;
  }

  // Serialize central directory
  let centralSize = 0;
  for (const p of centralParts) centralSize += p.length;

  // End of central directory record: 22 bytes.
  // Layout per APPNOTE 6.3.9 §4.3.16: signature(4) + disk#(2) + diskWithCD(2) +
  // entriesThisDisk(2) + totalEntries(2) + cdSize(4) + cdOffset(4) + commentLen(2).
  const eocd = new ArrayBuffer(22);
  const eocdView = new DataView(eocd);
  writeUint32LE(eocdView, 0, 0x06054b50);
  writeUint16LE(eocdView, 4, 0);                  // disk number
  writeUint16LE(eocdView, 6, 0);                  // disk with CD
  writeUint16LE(eocdView, 8, entries.length);     // entries on this disk
  writeUint16LE(eocdView, 10, entries.length);    // total entries
  writeUint32LE(eocdView, 12, centralSize);       // CD size
  writeUint32LE(eocdView, 16, offset);            // CD offset (= end of local parts)
  writeUint16LE(eocdView, 20, 0);                 // comment length

  // Flatten into a single Uint8Array
  const totalSize = offset + centralSize + 22;
  const out = new Uint8Array(totalSize);
  let pos = 0;
  for (const p of localParts) { out.set(p, pos); pos += p.length; }
  for (const p of centralParts) { out.set(p, pos); pos += p.length; }
  out.set(new Uint8Array(eocd), pos);
  return out;
}
