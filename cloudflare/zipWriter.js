/**
 * Workers-native streaming ZIP writer using Web Streams API.
 * Produces a valid ZIP file with STORED (uncompressed) entries.
 *
 * Usage:
 *   const writer = createZipStreamWriter();
 *   await writer.writeEntry('a.txt', streamA, 100);
 *   await writer.writeEntry('b.txt', streamB, 200);
 *   const zipStream = writer.finalize(); // ReadableStream<Uint8Array>
 */

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c;
}

function crc32Compute(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dateToZipTime(date) {
  const d = date || new Date();
  const dosTime = ((d.getSeconds() >> 1) | (d.getMinutes() << 5) | (d.getHours() << 11)) & 0xFFFF;
  const dosDate = (d.getDate() | ((d.getMonth() + 1) << 5) | ((d.getFullYear() - 1980) << 9)) & 0xFFFF;
  return { dosTime, dosDate };
}

const TEXT_ENCODER = new TextEncoder();

function concatBytes(arrays) {
  const total = arrays.reduce((s, a) => s + a.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.byteLength;
  }
  return out;
}

/**
 * Creates a streaming ZIP writer.
 *
 * writeEntry() buffers the entire entry in memory (one file at a time),
 * which is acceptable for a Workers environment where individual files
 * are typically <100MB (the upload cap).
 *
 * finalize() returns a ReadableStream that yields the complete ZIP archive.
 */
export function createZipStreamWriter() {
  const entries = [];
  const usedNames = new Set();
  let currentOffset = 0;

  function uniqueName(name) {
    if (!usedNames.has(name)) {
      usedNames.add(name);
      return name;
    }
    const dotIdx = name.lastIndexOf('.');
    const base = dotIdx > 0 ? name.slice(0, dotIdx) : name;
    const ext = dotIdx > 0 ? name.slice(dotIdx) : '';
    let counter = 1;
    while (usedNames.has(`${base}_${counter}${ext}`)) counter++;
    const unique = `${base}_${counter}${ext}`;
    usedNames.add(unique);
    return unique;
  }

  /**
   * Write a file entry into the ZIP.
   * @param {string} name - path within the ZIP (e.g. "folder/file.txt")
   * @param {ReadableStream<Uint8Array>} stream - file content stream
   * @param {number} [size] - uncompressed size hint (unused for STORED, kept for API)
   * @returns {Promise<void>}
   */
  async function writeEntry(name, stream, size) {
    const safeName = uniqueName(name);
    const filenameBytes = TEXT_ENCODER.encode(safeName);
    const { dosTime, dosDate } = dateToZipTime();

    const dataChunks = [];
    let totalSize = 0;

    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalSize += bytes.length;
      dataChunks.push(bytes);
    }

    const data = dataChunks.length === 1 ? dataChunks[0] : concatBytes(dataChunks);
    const crc = crc32Compute(data);

    // Local file header: 30 bytes + filename
    const localHeaderSize = 30 + filenameBytes.length;
    const localHeader = new Uint8Array(localHeaderSize);
    const hv = new DataView(localHeader.buffer, localHeader.byteOffset, localHeader.byteLength);
    hv.setUint32(0, 0x04034b50, true);
    hv.setUint16(4, 20, true);   // version needed
    hv.setUint16(6, 0, true);    // flags
    hv.setUint16(8, 0, true);    // compression = STORED
    hv.setUint16(10, dosTime, true);
    hv.setUint16(12, dosDate, true);
    hv.setUint32(14, crc, true);
    hv.setUint32(18, totalSize, true);  // compressed
    hv.setUint32(22, totalSize, true);  // uncompressed
    hv.setUint16(26, filenameBytes.length, true);
    hv.setUint16(28, 0, true);   // extra field length
    localHeader.set(filenameBytes, 30);

    entries.push({
      filenameBytes,
      dosTime,
      dosDate,
      crc,
      compressedSize: totalSize,
      uncompressedSize: totalSize,
      offset: currentOffset,
      localHeader,
      data,
    });

    currentOffset += localHeaderSize + data.byteLength;
  }

  /**
   * Finalize the ZIP and return a ReadableStream yielding the complete archive.
   * @returns {ReadableStream<Uint8Array>}
   */
  function finalize() {
    const chunks = [];

    // Local file headers + data
    for (const entry of entries) {
      chunks.push(entry.localHeader);
      chunks.push(entry.data);
    }

    // Central directory
    const cdOffset = currentOffset;
    for (const entry of entries) {
      const cdSize = 46 + entry.filenameBytes.length;
      const cd = new Uint8Array(cdSize);
      const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);    // version made by
      cv.setUint16(6, 20, true);    // version needed
      cv.setUint16(8, 0, true);     // flags
      cv.setUint16(10, 0, true);    // compression = STORED
      cv.setUint16(12, entry.dosTime, true);
      cv.setUint16(14, entry.dosDate, true);
      cv.setUint32(16, entry.crc, true);
      cv.setUint32(20, entry.compressedSize, true);
      cv.setUint32(24, entry.uncompressedSize, true);
      cv.setUint16(28, entry.filenameBytes.length, true);
      cv.setUint16(30, 0, true);    // extra field
      cv.setUint16(32, 0, true);    // comment length
      cv.setUint16(34, 0, true);    // disk number
      cv.setUint16(36, 0, true);    // internal attrs
      cv.setUint32(38, 0, true);    // external attrs
      cv.setUint32(42, entry.offset, true);
      cd.set(entry.filenameBytes, 46);
      chunks.push(cd);
    }

    let cdTotalSize = 0;
    for (const entry of entries) {
      cdTotalSize += 46 + entry.filenameBytes.length;
    }

    // End of central directory
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer, eocd.byteOffset, eocd.byteLength);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);                       // disk number
    ev.setUint16(6, 0, true);                       // disk with CD
    ev.setUint16(8, entries.length, true);           // entries on this disk
    ev.setUint16(10, entries.length, true);          // total entries
    ev.setUint32(12, cdTotalSize, true);             // CD size
    ev.setUint32(16, cdOffset, true);                // CD offset
    ev.setUint16(20, 0, true);                       // comment length
    chunks.push(eocd);

    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      }
    });
  }

  return { writeEntry, finalize };
}
