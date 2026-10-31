const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PictureThumbnails, FILE_LIMIT } = require('../electron/features/files/picture-thumbnail.cjs');
const { createFileCards } = require('../electron/features/files/file-cards.cjs');
const values = require('../electron/picture-values.json');
const image = width => { const bytes = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(width, 20); return bytes; };
function jpeg(width, height, segments = 2) {
  const metadata = Buffer.alloc(65537); metadata[0] = 255; metadata[1] = 226; metadata.writeUInt16BE(65535, 2);
  const frame = Buffer.from([255, 192, 0, 17, 8, 0, 0, 0, 0, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0]);
  frame.writeUInt16BE(height, 5); frame.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([255, 216]), ...Array(segments).fill(metadata), frame, Buffer.from([255, 217])]);
}

test('local thumbnails are version-cached and dimensions and 25 MB limit are checked before decoding', t => {
  const prefix = path.join(os.tmpdir(), 'agentrix-thumbnail-'), root = fs.mkdtempSync(prefix), file = path.join(root, 'image.png');
  t.after(() => { assert.ok(path.resolve(root).startsWith(prefix)); fs.rmSync(root, { recursive: true, force: true }); });
  let calls = 0;
  const thumbnails = new PictureThumbnails(() => { calls++; return `data:image/png;base64,VERSION${calls}`; });
  // Each version gets its own modification time: two quick writes can share one on a coarse or fast file system, and the
  // cache (path, size and times) cannot tell such twins apart.
  let version = 0;
  const write = content => { fs.writeFileSync(file, content); const at = new Date(Date.now() - 60000 + ++version * 1000); fs.utimesSync(file, at, at); };
  write(image(8));
  assert.equal(thumbnails.file(file), 'data:image/png;base64,VERSION1');
  assert.equal(thumbnails.file(file), 'data:image/png;base64,VERSION1'); assert.equal(calls, 1);
  write(Buffer.concat([image(16), Buffer.alloc(1)]));
  assert.equal(thumbnails.file(file), 'data:image/png;base64,VERSION2'); assert.equal(calls, 2);
  write(image(20000)); assert.equal(thumbnails.file(file), values.omitted); assert.equal(calls, 2);
  write('not an image'); assert.equal(thumbnails.file(file), values.unavailable); assert.equal(calls, 2);
  fs.truncateSync(file, FILE_LIMIT + 1); assert.equal(thumbnails.file(file), values.omitted); assert.equal(calls, 2);
});

test('recent equal-stat rewrites revalidate the full file and keep cache accounting bounded', t => {
  const prefix = path.join(os.tmpdir(), 'agentrix-thumbnail-race-'), root = fs.mkdtempSync(prefix), file = path.join(root, 'image.png');
  t.after(() => { assert.ok(path.resolve(root).startsWith(prefix)); fs.rmSync(root, { recursive: true, force: true }); });
  const at = new Date(), stat = fs.statSync;
  const write = byte => { fs.writeFileSync(file, Buffer.concat([image(8), Buffer.alloc(130000, byte)])); fs.utimesSync(file, at, at); };
  write(0);
  const initial = stat(file);
  let now = initial.mtimeMs + 100;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(fs, 'statSync', (name, options) => {
    const value = stat(name, options);
    return name === file ? { isFile: () => value.isFile(), size: value.size, mtimeMs: value.mtimeMs, ctimeMs: initial.ctimeMs } : value;
  });
  let calls = 0;
  const thumbnails = new PictureThumbnails(() => `data:image/png;base64,VERSION${++calls}`);
  assert.equal(thumbnails.file(file), 'data:image/png;base64,VERSION1');
  assert.equal(thumbnails.file(file), 'data:image/png;base64,VERSION1');
  assert.equal(calls, 1, 'unchanged content does not require another decode');
  for (const byte of [1, 2]) {
    write(byte);
    const current = fs.statSync(file);
    assert.deepEqual([current.size, current.mtimeMs, current.ctimeMs], [initial.size, initial.mtimeMs, initial.ctimeMs]);
    assert.equal(thumbnails.file(file), `data:image/png;base64,VERSION${byte + 1}`);
  }
  now += 60000; write(3);
  assert.equal(thumbnails.file(file), 'data:image/png;base64,VERSION4', 'an entry racy when cached remains verified');
  assert.equal(thumbnails.cache.size, 1);
  assert.equal(thumbnails.bytes, 'data:image/png;base64,VERSION4'.length);
});

test('older equal-stat thumbnails trust stat without rehashing', t => {
  const prefix = path.join(os.tmpdir(), 'agentrix-thumbnail-old-'), root = fs.mkdtempSync(prefix), file = path.join(root, 'image.png');
  t.after(() => { assert.ok(path.resolve(root).startsWith(prefix)); fs.rmSync(root, { recursive: true, force: true }); });
  const at = new Date(Date.now() - 60000), stat = fs.statSync, read = fs.readSync;
  const write = width => { fs.writeFileSync(file, image(width)); fs.utimesSync(file, at, at); };
  write(8);
  const initial = stat(file);
  t.mock.method(fs, 'statSync', (name, options) => {
    const value = stat(name, options);
    return name === file ? { isFile: () => value.isFile(), size: value.size, mtimeMs: value.mtimeMs, ctimeMs: initial.ctimeMs } : value;
  });
  let reads = 0, calls = 0;
  t.mock.method(fs, 'readSync', (...args) => { reads++; return read(...args); });
  const thumbnails = new PictureThumbnails(() => `data:image/png;base64,VERSION${++calls}`);
  assert.equal(thumbnails.file(file), 'data:image/png;base64,VERSION1');
  write(16);
  reads = 0;
  assert.equal(thumbnails.file(file), 'data:image/png;base64,VERSION1');
  assert.equal(reads, 0);
  assert.equal(calls, 1);
});

test('a recent file changed during decoding is not cached under the wrong hash', t => {
  const prefix = path.join(os.tmpdir(), 'agentrix-thumbnail-change-'), root = fs.mkdtempSync(prefix), file = path.join(root, 'image.png');
  t.after(() => { assert.ok(path.resolve(root).startsWith(prefix)); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(file, image(8));
  const now = fs.statSync(file).mtimeMs + 100;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const thumbnails = new PictureThumbnails(() => {
    if (++calls === 1) fs.writeFileSync(file, image(16));
    return `data:image/png;base64,VERSION${calls}`;
  });
  assert.equal(thumbnails.file(file), values.unavailable);
  assert.equal(thumbnails.cache.size, 0);
  assert.equal(thumbnails.file(file), 'data:image/png;base64,VERSION2');
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
  for (const file of ['\\\\host\\share\\x.png', '\\\\?\\UNC\\host\\share\\x.png', '\\\\.\\host\\x.png', 'file://host/share/x.png']) assert.equal(thumbnails.file(file), values.unavailable);
  assert.equal(calls, 0);
});

test('JPEG thumbnails find SOF after 64 KiB with bounded segment reads, including file cards', async t => {
  const prefix = path.join(os.tmpdir(), 'agentrix-jpeg-'), root = fs.mkdtempSync(prefix), file = path.join(root, 'phone.jpg');
  t.after(() => { assert.ok(path.resolve(root).startsWith(prefix)); fs.rmSync(root, { recursive: true, force: true }); });
  const reads = [], read = fs.readSync;
  t.mock.method(fs, 'readSync', (...args) => { reads.push({ length: args[3], position: args[4] }); return read(...args); });
  let decodes = 0;
  const shrink = () => { decodes++; return 'data:image/jpeg;base64,THUMBNAIL'; }, thumbnails = new PictureThumbnails(shrink);
  fs.writeFileSync(file, jpeg(1200, 800));
  const old = new Date(Date.now() - 60000); fs.utimesSync(file, old, old);
  assert.equal(thumbnails.file(file), 'data:image/jpeg;base64,THUMBNAIL');
  assert.equal(thumbnails.file(file), 'data:image/jpeg;base64,THUMBNAIL'); assert.equal(decodes, 1);
  assert.ok(reads.some(value => value.position > 64 * 1024), 'SOF is read past the initial header');
  assert.ok(reads.every(value => value.length <= 64 * 1024));
  assert.ok(reads.reduce((sum, value) => sum + value.length, 0) < 66 * 1024, 'metadata payloads are skipped');
  const card = createFileCards({ previews: {}, capture: async () => null, shrink });
  assert.equal((await card({ id: 'p', path: root }, file)).picture, 'data:image/jpeg;base64,THUMBNAIL'); assert.equal(decodes, 2);
  fs.writeFileSync(file, jpeg(8000, 8000)); assert.equal(thumbnails.file(file), values.omitted); assert.equal(decodes, 2);
  reads.length = 0;
  fs.writeFileSync(file, jpeg(1200, 800, 65)); assert.equal(thumbnails.file(file), values.unavailable); assert.equal(decodes, 2);
  assert.ok(reads.every(value => value.position + value.length <= 4 * 1024 * 1024));
  assert.ok(reads.reduce((sum, value) => sum + value.length, 0) < 66 * 1024, 'the scan cap does not read megabytes of metadata');
});

test('only an explicit project root permits thumbnails on its own UNC share', { skip: process.platform !== 'win32' }, t => {
  const root = '\\\\preview.invalid\\share\\app', file = path.join(root, 'image.png');
  let stats = 0;
  t.mock.method(fs, 'statSync', () => { stats++; return { isFile: () => true, size: 24, mtimeMs: 1, ctimeMs: 1 }; });
  t.mock.method(fs, 'openSync', () => 1);
  t.mock.method(fs, 'readSync', (_fd, buffer, offset, length, position) => image(8).copy(buffer, offset, position, position + length));
  t.mock.method(fs, 'closeSync', () => {});
  const thumbnails = new PictureThumbnails(() => 'data:image/png;base64,SHARE');
  assert.equal(thumbnails.file(file), values.unavailable); assert.equal(stats, 0);
  assert.equal(thumbnails.file(file, { projectRoot: root }), 'data:image/png;base64,SHARE'); assert.equal(stats, 1);
  assert.equal(thumbnails.file('\\\\elsewhere.invalid\\share\\image.png', { projectRoot: root }), values.unavailable); assert.equal(stats, 1);
});
