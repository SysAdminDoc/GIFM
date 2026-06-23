import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, buildStoreZip } from './zip.js';

test('crc32 matches the standard IEEE test vector', () => {
  // CRC-32 of "123456789" is 0xCBF43926.
  assert.equal(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('buildStoreZip writes a valid local header and end-of-central-directory record', () => {
  const entries = [
    { name: 'one.gif', data: Buffer.from('first', 'utf8') },
    { name: 'two.gif', data: Buffer.from('second', 'utf8') }
  ];
  const zip = buildStoreZip(entries);

  // First local file header signature.
  assert.equal(zip.readUInt32LE(0), 0x04034b50);

  // End-of-central-directory signature and entry counts live in the last 22 bytes.
  const eocd = zip.subarray(zip.length - 22);
  assert.equal(eocd.readUInt32LE(0), 0x06054b50);
  assert.equal(eocd.readUInt16LE(8), 2); // entries on this disk
  assert.equal(eocd.readUInt16LE(10), 2); // total entries
});
