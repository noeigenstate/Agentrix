const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PictureThumbnails, FILE_LIMIT } = require('../electron/features/files/picture-thumbnail.cjs');
const values = require('../electron/features/files/picture-values.json');
const image = width => { const bytes = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(width, 20); return bytes; };

test('local thumbnails are version-cached and dimensions and 25 MB limit are checked before decoding', t => {
  const prefix = path.join(os.tmpdir(), 'agentrix-thumbnail-'), root = fs.mkdtempSync(prefix), file = path.join(root, 'image.png');
  t.after(() => { assert.ok(path.resolve(root).startsWith(prefix)); fs.rmSync(root, { recursive: true, force: true }); });
  let calls = 0;
  const thumbnails = new PictureThumbnails(() => { calls++; return `data:image/png;base64,VERSION${calls}`; });
  fs.writeFileSync(file, image(8));
  assert.equal(thumbnails.file(file), 'data:image/png;base64,VERSION1');
  assert.equal(thumbnails.file(file), 'data:image/png;base64,VERSION1'); assert.equal(calls, 1);
  fs.writeFileSync(file, Buffer.concat([image(16), Buffer.alloc(1)]));
  assert.equal(thumbnails.file(file), 'data:image/png;base64,VERSION2'); assert.equal(calls, 2);
  fs.writeFileSync(file, image(20000)); assert.equal(thumbnails.file(file), values.omitted); assert.equal(calls, 2);
  fs.writeFileSync(file, 'not an image'); assert.equal(thumbnails.file(file), values.unavailable); assert.equal(calls, 2);
  fs.truncateSync(file, FILE_LIMIT + 1); assert.equal(thumbnails.file(file), values.omitted); assert.equal(calls, 2);
});

test('data thumbnails use bounded hash keys and cache bytes and entries stay bounded', () => {
  let calls = 0;
  const thumbnails = new PictureThumbnails(() => null, () => { calls++; return 'data:image/png;base64,' + 'A'.repeat(300000); });
  const first = 'data:image/png;base64,' + image(8).toString('base64');
  thumbnails.data(first); thumbnails.data(first); assert.equal(calls, 1);
  assert.ok([...thumbnails.cache.keys()].every(key => key.length < 100));
  for (let index = 0; index < 100; index++) thumbnails.data('data:image/png;base64,' + Buffer.concat([image(8), Buffer.from(String(index))]).toString('base64'));
  assert.ok(thumbnails.cache.size <= 64); assert.ok(thumbnails.bytes <= 16 * 1024 * 1024);
});

test('UNC thumbnail paths never reach stat or the image decoder', t => {
  let calls = 0;
  t.mock.method(fs, 'statSync', () => { calls++; throw new Error('network stat'); });
  const thumbnails = new PictureThumbnails(() => { calls++; });
  for (const file of ['\\\\host\\share\\x.png', '\\\\?\\UNC\\host\\share\\x.png', 'file://host/share/x.png']) assert.equal(thumbnails.file(file), values.unavailable);
  assert.equal(calls, 0);
});
