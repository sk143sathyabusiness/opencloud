import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createZipStreamWriter } from '../zipWriter.js';
import { inflateRawSync } from 'node:zlib';

/**
 * Parse a ZIP buffer into its constituent parts for verification.
 */
function parseZip(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const entries = [];

  let offset = 0;
  while (offset + 4 <= buf.byteLength) {
    const sig = view.getUint32(offset, true);
    if (sig === 0x04034b50) {
      // Local file header
      const versionNeeded = view.getUint16(offset + 4, true);
      const flags = view.getUint16(offset + 6, true);
      const compression = view.getUint16(offset + 8, true);
      const crc = view.getUint32(offset + 14, true);
      const compressedSize = view.getUint32(offset + 18, true);
      const uncompressedSize = view.getUint32(offset + 22, true);
      const filenameLen = view.getUint16(offset + 26, true);
      const extraLen = view.getUint16(offset + 28, true);
      const filename = new TextDecoder().decode(buf.slice(offset + 30, offset + 30 + filenameLen));
      const dataStart = offset + 30 + filenameLen + extraLen;
      const data = buf.slice(dataStart, dataStart + compressedSize);

      entries.push({ filename, compression, crc, compressedSize, uncompressedSize, data, flags });
      offset = dataStart + compressedSize;
    } else if (sig === 0x02014b50) {
      break; // Central directory — we found all local entries
    } else {
      break;
    }
  }

  return entries;
}

function makeStream(text) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

async function collectStream(stream) {
  const chunks = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// --- Tests ---

test('single-file ZIP has PK signature and correct entry', async () => {
  const writer = createZipStreamWriter();
  const data = 'hello world';
  await writer.writeEntry('hello.txt', makeStream(data), data.length);
  const zipStream = writer.finalize();
  const buf = await collectStream(zipStream);

  // ZIP must start with PK\x03\x04
  assert.equal(buf[0], 0x50); // 'P'
  assert.equal(buf[1], 0x4B); // 'K'
  assert.equal(buf[2], 0x03);
  assert.equal(buf[3], 0x04);

  const entries = parseZip(buf);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].filename, 'hello.txt');
  assert.equal(entries[0].compression, 0); // STORED
  assert.equal(entries[0].data.toString(), 'hello world');

  // Verify CRC32
  const { crc32 } = await import('node:zlib');
  // crc32 is not in node:zlib in older versions, compute manually
  const expectedCrc = computeCRC32(new TextEncoder().encode(data));
  assert.equal(entries[0].crc, expectedCrc);
});

test('multi-file ZIP has correct entries', async () => {
  const writer = createZipStreamWriter();
  await writer.writeEntry('a.txt', makeStream('aaa'), 3);
  await writer.writeEntry('b.txt', makeStream('bbbbbb'), 6);
  await writer.writeEntry('c.txt', makeStream('c'), 1);
  const zipStream = writer.finalize();
  const buf = await collectStream(zipStream);

  const entries = parseZip(buf);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].filename, 'a.txt');
  assert.equal(entries[0].data.toString(), 'aaa');
  assert.equal(entries[1].filename, 'b.txt');
  assert.equal(entries[1].data.toString(), 'bbbbbb');
  assert.equal(entries[2].filename, 'c.txt');
  assert.equal(entries[2].data.toString(), 'c');
});

test('collision-safe naming appends _1, _2 for duplicates', async () => {
  const writer = createZipStreamWriter();
  await writer.writeEntry('doc.txt', makeStream('v1'), 2);
  await writer.writeEntry('doc.txt', makeStream('v2'), 2);
  await writer.writeEntry('doc.txt', makeStream('v3'), 2);
  const zipStream = writer.finalize();
  const buf = await collectStream(zipStream);

  const entries = parseZip(buf);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].filename, 'doc.txt');
  assert.equal(entries[1].filename, 'doc_1.txt');
  assert.equal(entries[2].filename, 'doc_2.txt');
  assert.equal(entries[0].data.toString(), 'v1');
  assert.equal(entries[1].data.toString(), 'v2');
  assert.equal(entries[2].data.toString(), 'v3');
});

test('CRC32 is correct for known data', async () => {
  const writer = createZipStreamWriter();
  const testData = 'The quick brown fox jumps over the lazy dog';
  await writer.writeEntry('test.txt', makeStream(testData), testData.length);
  const zipStream = writer.finalize();
  const buf = await collectStream(zipStream);

  const entries = parseZip(buf);
  assert.equal(entries.length, 1);

  // Compute expected CRC32 manually
  const expectedCrc = computeCRC32(new TextEncoder().encode(testData));
  assert.equal(entries[0].crc, expectedCrc);
  assert.equal(entries[0].uncompressedSize, new TextEncoder().encode(testData).length);
});

test('empty ZIP (no entries) produces valid structure', async () => {
  const writer = createZipStreamWriter();
  const zipStream = writer.finalize();
  const buf = await collectStream(zipStream);

  // Should be 22 bytes (EOCD only)
  assert.equal(buf.byteLength, 22);

  // EOCD signature
  const sig = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true);
  assert.equal(sig, 0x06054b50);
});

test('ZIP file with subdirectory paths', async () => {
  const writer = createZipStreamWriter();
  await writer.writeEntry('docs/readme.txt', makeStream('readme'), 7);
  await writer.writeEntry('src/index.js', makeStream('code'), 4);
  const zipStream = writer.finalize();
  const buf = await collectStream(zipStream);

  const entries = parseZip(buf);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].filename, 'docs/readme.txt');
  assert.equal(entries[1].filename, 'src/index.js');
});

// Helper: manual CRC32 computation matching the ZIP writer's implementation
function computeCRC32(bytes) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
