const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function preload() {
  const calls = []; let bridge;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), {
    require: name => {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (name, api) => { assert.equal(name, 'agentrix'); bridge = api; } },
        ipcRenderer: { invoke: (channel, ...args) => new Promise((resolve, reject) => { calls.push({ channel, args, resolve, reject }); }) },
      };
    },
  });
  return { bridge, calls };
}

const listing = { ok: true, value: { path: '', entries: [], total: 0, nextOffset: null } };

test('directory reads share pending IPC across callers and defaults, then refresh after success', async () => {
  const { bridge, calls } = preload();
  const reads = [bridge.listDirectory('project'), bridge.listDirectory('project', ''),
    bridge.listDirectory('project', '', 0), bridge.listDirectory('project', undefined, undefined)];
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, 'project:directory');
  assert.deepEqual(calls[0].args, ['project', '', 0]);
  calls[0].resolve(listing);
  assert.deepEqual(await Promise.all(reads), reads.map(() => listing));

  const refresh = bridge.listDirectory('project');
  assert.equal(calls.length, 2);
  calls[1].resolve(listing);
  assert.deepEqual(await refresh, listing);
});

test('different project, path and offset keys can read concurrently', async () => {
  const { bridge, calls } = preload();
  const keys = [['project', '', 0], ['other-project', '', 0], ['project', 'src', 0], ['project', '', 100]];
  const reads = keys.map(args => bridge.listDirectory(...args));
  assert.equal(calls.length, keys.length);
  assert.deepEqual(calls.map(call => call.args), keys);
  const results = keys.map(([, relativePath], index) => ({
    ok: true, value: { path: relativePath, entries: [{ name: `file-${index}`, path: `file-${index}`, kind: 'file' }], total: 1, nextOffset: null },
  }));
  for (let index = calls.length - 1; index >= 0; index--) calls[index].resolve(results[index]);
  assert.deepEqual(await Promise.all(reads), results);
});

test('an ok:false result is shared only while pending and allows retry', async () => {
  const { bridge, calls } = preload();
  const reads = [bridge.listDirectory('project'), bridge.listDirectory('project')];
  assert.equal(calls.length, 1);
  const failure = { ok: false, error: 'Directory unavailable' };
  calls[0].resolve(failure);
  assert.deepEqual(await Promise.all(reads), [failure, failure]);

  const retry = bridge.listDirectory('project');
  assert.equal(calls.length, 2);
  calls[1].resolve(listing);
  assert.deepEqual(await retry, listing);
});

test('a rejected directory read rejects every caller and allows retry', async () => {
  const { bridge, calls } = preload();
  const reads = [bridge.listDirectory('project'), bridge.listDirectory('project')];
  assert.equal(calls.length, 1);
  const error = new Error('IPC failed');
  const rejections = reads.map(read => assert.rejects(read, error));
  calls[0].reject(error);
  await Promise.all(rejections);

  const retry = bridge.listDirectory('project');
  assert.equal(calls.length, 2);
  calls[1].resolve(listing);
  assert.deepEqual(await retry, listing);
});
