const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { brotliCompressSync, gzipSync } = require('node:zlib');
const { readPak, trimPak, trimElectronPak } = require('../scripts/trim-electron-pak.cjs');
const manifest = require('../scripts/electron-pak-trim.json');

const sha256 = data => createHash('sha256').update(data).digest('hex');
// Physical ids 10/20/30/40/50; aliases 11/12 -> 10, 21/22 -> 20, 31 -> 30, 41 -> 40.
const input = Buffer.from('0500000002000000050006000a004800000014004e0000001e005200000028005800000032005c00000000005c0000000b0000000c00000015000100160001001f0002002900030073686172656400ff0d0a72656d6f76656c617374', 'hex');
const output = Buffer.from('0500000002000000030002000b002c00000014003200000028003600000000003a000000160001002900020073686172656400ff0d0a6c617374', 'hex');
const expected = { inputSha256: sha256(input), outputSha256: sha256(output), groups: { 'intro-sounds': [10, 12], devtools: [21, 30, 31], tracing: [50] } };

async function temporary(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-pak-'));
  t.after(async () => {
    assert.equal(path.dirname(folder), path.resolve(os.tmpdir()));
    assert.ok(path.basename(folder).startsWith('agentrix-pak-'));
    await fs.rm(folder, { recursive: true, force: true });
  });
  return folder;
}

async function loadScript(name, overrides) {
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '../scripts', name), 'utf8'), {
    module, exports: module.exports, Buffer, process, console: { log() {} },
    require: name => overrides[name] || require(name),
  });
  return module.exports;
}

test('rewriting removes exactly the pinned ids, promotes surviving aliases and preserves all retained bytes', () => {
  const result = trimPak(input, expected);
  assert.deepEqual(result, output);
  assert.deepEqual(trimPak(input, expected), result);
  const before = readPak(input), after = readPak(result);
  assert.equal(after.encoding, before.encoding);
  assert.deepEqual([...after.resources.keys()].sort((a, b) => a - b), [11, 20, 22, 40, 41]);
  for (const [id, bytes] of after.resources) assert.deepEqual(bytes, before.resources.get(id));
  for (const id of Object.values(expected.groups).flat()) assert.equal(after.resources.has(id), false);
  assert.equal(result.readUInt16LE(10), 2);
});

for (const [name, pin, error] of [
  ['unknown input hash', { ...expected, inputSha256: '0'.repeat(64) }, /Unknown Electron resources.pak SHA-256:.*--regenerate/],
  ['output hash mismatch', { ...expected, outputSha256: '0'.repeat(64) }, /PAK output SHA-256 mismatch/],
]) {
  test(`${name} fails before writing`, async t => {
    const file = path.join(await temporary(t), 'resources.pak');
    await fs.writeFile(file, input);
    await assert.rejects(trimElectronPak(file, 'win32-x64', { electronVersion: 'fixture', platforms: { 'win32-x64': pin } }), error);
    assert.deepEqual(await fs.readFile(file), input);
  });
}

test('a verified file rewrite matches the expected output hash and unsupported platforms fail', async t => {
  const file = path.join(await temporary(t), 'resources.pak');
  await fs.writeFile(file, input);
  const result = await trimElectronPak(file, 'win32-x64', { platforms: { 'win32-x64': expected } });
  assert.deepEqual(result, { removedBytes: input.length - output.length, outputSha256: sha256(output) });
  assert.deepEqual(await fs.readFile(file), output);
  await assert.rejects(trimElectronPak(file, 'win32-arm64'), /Unsupported Electron 44\.3\.0 PAK platform: win32-arm64.*--regenerate/);
  assert.deepEqual(await fs.readFile(file), output);
});

test('missing, duplicate and unknown trim groups fail closed', () => {
  for (const groups of [
    { ...expected.groups, tracing: [] },
    { ...expected.groups, tracing: [999] },
    { ...expected.groups, tracing: [10] },
    { ...expected.groups, surprise: [11] },
  ]) assert.throws(() => trimPak(input, { ...expected, groups }), /Missing|Unexpected/);
});

test('invalid PAK headers, offsets and alias targets are rejected', () => {
  const version = Buffer.from(input); version.writeUInt32LE(4, 0);
  const offset = Buffer.from(input); offset.writeUInt32LE(input.length + 1, 20);
  const alias = Buffer.from(input); alias.writeUInt16LE(5, 50);
  const sentinel = Buffer.from(input); sentinel.writeUInt32LE(input.length - 1, 44);
  for (const data of [Buffer.alloc(4), input.subarray(0, 30), version, offset, alias, sentinel]) assert.throws(() => readPak(data), /PAK/);
});

for (const [platform, arch, key, relative] of [
  ['win32', 1, 'win32-x64', 'resources.pak'],
  ['darwin', 3, 'darwin-arm64', 'Named App.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/resources.pak'],
  ['linux', 1, 'linux-x64', 'resources.pak'],
  ['linux', 3, 'linux-arm64', 'resources.pak'],
]) {
  test(`afterPack trims and copies the dispatch runtime for ${key} before platform cleanup`, async () => {
    const calls = [], removed = [], created = [], written = [];
    const runtime = { 'transcript-tail.cjs': 'tail source\n', 'features/agents/token-rate.cjs': 'rate source\n' };
    const hook = await loadScript('after-pack.cjs', {
      'node:fs/promises': { rm: async file => removed.push(file), readdir: async () => ['keep.sh', 'drop.ps1', 'drop.cmd', 'drop.exe', 'drop.cs'],
        mkdir: async folder => created.push(folder), writeFile: async (...args) => written.push(args) },
      './trim-electron-pak.cjs': { trimElectronPak: async (...args) => { calls.push(args); return { removedBytes: 1 }; } },
      '../integration/dispatch.cjs': { runtimeFiles: () => runtime },
    });
    const appOutDir = path.resolve('fixture-output');
    await hook.default({ electronPlatformName: platform, arch, appOutDir, packager: { appInfo: { productFilename: 'Named App' } } });
    assert.deepEqual(calls, [[path.join(appOutDir, relative), key]]);
    const resources = path.join(appOutDir, platform === 'darwin' ? 'Named App.app/Contents/Resources' : 'resources');
    assert.deepEqual(written, Object.entries(runtime).map(([name, source]) => [path.join(resources, 'integration/electron', name), source]));
    assert.deepEqual(created, written.map(([file]) => path.dirname(file)));
    assert.equal(removed.some(file => file.endsWith('keep.sh')), false);
    assert.equal(removed.some(file => file.endsWith('dxcompiler.dll')), platform === 'win32');
    assert.equal(removed.some(file => file.endsWith('drop.ps1')), platform !== 'win32');
  });
}

test('afterPack propagates trimming failures', async () => {
  const hook = await loadScript('after-pack.cjs', {
    'node:fs/promises': { rm: async () => {} },
    './trim-electron-pak.cjs': { trimElectronPak: async () => { throw new Error('unrecognized pak'); } },
  });
  await assert.rejects(hook.default({ electronPlatformName: 'win32', arch: 1, appOutDir: 'fixture-output' }), /unrecognized pak/);
});

test('the Electron 44.3.0 manifest pins all four platforms and exactly the approved groups', () => {
  assert.equal(manifest.electronVersion, '44.3.0');
  assert.deepEqual(Object.keys(manifest.platforms), ['win32-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']);
  assert.equal(new Set(manifest.introSoundSha256).size, 6);
  for (const pin of Object.values(manifest.platforms)) {
    assert.match(pin.inputSha256, /^[a-f0-9]{64}$/);
    assert.match(pin.outputSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(pin.inputSha256, pin.outputSha256);
    assert.deepEqual(Object.keys(pin.groups), ['intro-sounds', 'devtools', 'tracing']);
    assert.deepEqual(Object.values(pin.groups).map(ids => ids.length), [6, 893, 2]);
    const ids = Object.values(pin.groups).flat();
    assert.equal(new Set(ids).size, ids.length);
    for (const group of Object.values(pin.groups)) assert.deepEqual(group, [...group].sort((a, b) => a - b));
  }
});

test('regeneration discovers shifted ids by content and retains neighboring resources', async () => {
  const sounds = Array.from({ length: 6 }, (_, index) => Buffer.from(`fLaCintro-${index}`));
  const trimmer = await loadScript('trim-electron-pak.cjs', {
    './electron-pak-trim.json': { introSoundSha256: sounds.map(sha256) },
  });
  const brotli = text => {
    const header = Buffer.alloc(8); header.writeUInt16LE(0x9b1e); header.writeUIntLE(Buffer.byteLength(text), 2, 6);
    return Buffer.concat([header, brotliCompressSync(Buffer.from(text))]);
  };
  const entries = [
    ...sounds.map((sound, index) => [100 + index, sound]),
    [200, Buffer.from('fLaCretained HRTF')],
    [300, Buffer.from('neighbor')],
    [301, gzipSync('<title>chrome://tracing</title><script src="tracing.js"></script>')],
    [302, gzipSync("tr.exportTo('tr.b', function(){}); // chrome://tracing")],
    [500, brotli('{"domains":[{"domain":"Runtime"}]}')],
    [501, brotli('<title>DevTools</title>')],
    [502, brotli('Lighthouse v1 https://github.com/GoogleChrome/lighthouse')],
  ];
  const table = Buffer.alloc(12 + (entries.length + 1) * 6);
  table.writeUInt32LE(5); table.writeUInt16LE(entries.length, 8);
  let offset = table.length;
  entries.forEach(([id, value], index) => {
    table.writeUInt16LE(id, 12 + index * 6); table.writeUInt32LE(offset, 14 + index * 6); offset += value.length;
  });
  table.writeUInt32LE(offset, 14 + entries.length * 6);
  const data = Buffer.concat([table, ...entries.map(([, value]) => value)]);
  const entry = trimmer.regenerateEntry(data);
  assert.deepEqual(JSON.parse(JSON.stringify(entry.groups)), { 'intro-sounds': [100, 101, 102, 103, 104, 105], devtools: [500, 501, 502], tracing: [301, 302] });
  const kept = readPak(trimmer.trimPak(data, entry)).resources;
  assert.deepEqual([...kept.keys()], [200, 300]);
  assert.deepEqual(kept.get(200), entries[6][1]);
  assert.deepEqual(kept.get(300), entries[7][1]);
  assert.throws(() => trimmer.regenerateEntry(input), /Could not uniquely identify/);
});
