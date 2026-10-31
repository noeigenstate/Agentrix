const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { readJsonl, readJsonlSync, FILE_LIMIT, LINE_LIMIT } = require('../electron/features/dashboard/jsonl.cjs');

test('async and sync bounded JSONL readers share short-read, EOF, filtering and torn-write behavior', async t => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-jsonl-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'records.jsonl');
  const rows = Array.from({ length: 5 }, (_, at) => ({ at, v: 1, text: `记录 ${at}` }));
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row) + '\n').join('') + '{bad}\n' +
    JSON.stringify({ at: 9, v: 2 }) + '\n' + JSON.stringify({ at: 10, v: 1, text: 'x'.repeat(LINE_LIMIT) }) + '\n' + JSON.stringify({ at: 11, v: 1 }));
  const open = fs.promises.open, readSync = fs.readSync, statSync = fs.fstatSync;
  let asyncReads = 0, syncReads = 0;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args), read = handle.read.bind(handle), stat = handle.stat.bind(handle);
    handle.stat = async () => ({ size: (await stat()).size + 8 });
    handle.read = async (buffer, offset, length, position) => { asyncReads++; return read(buffer, offset, Math.min(length, 1024), position); };
    return handle;
  });
  t.mock.method(fs, 'fstatSync', fd => ({ size: statSync(fd).size + 8 }));
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    syncReads++; return readSync(fd, buffer, offset, Math.min(length, 1024), position);
  });
  const options = { since: 1, limit: 2 };
  assert.deepEqual(await readJsonl(file, options), rows.slice(-2));
  assert.deepEqual(readJsonlSync(file, options), rows.slice(-2));
  assert.ok(asyncReads > 10); assert.equal(asyncReads, syncReads);
  assert.deepEqual(await readJsonl(path.join(directory, 'missing')), []);
  assert.deepEqual(readJsonlSync(path.join(directory, 'missing')), []);
});

test('both JSONL readers bound the tail and discard its partial first line with journal options', async t => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-jsonl-tail-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'journal.jsonl');
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, 'partial\n' + JSON.stringify({ time: 20 }) + '\n', FILE_LIMIT + 5);
  } finally { fs.closeSync(fd); }
  const options = { timeKey: 'time', version: null, since: 10 };
  assert.deepEqual(await readJsonl(file, options), [{ time: 20 }]);
  assert.deepEqual(readJsonlSync(file, options), [{ time: 20 }]);
});
