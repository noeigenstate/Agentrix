const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { VoiceManager, MODELS, RUNTIMES, RUNTIME_VERSION, downloadRuntime, extractTarball } = require('../electron/voice.cjs');

function tarball(entries) {
  const chunks = [];
  for (const { name, bytes = Buffer.alloc(0), type = '0', mode = 0o644, link = '', prefix = '' } of entries) {
    const header = Buffer.alloc(512);
    const octal = (value, offset, length) => header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
    header.write(name, 0, 100); octal(mode, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
    octal(bytes.length, 124, 12); octal(0, 136, 12); header.fill(32, 148, 156);
    header.write(type, 156, 1); header.write(link, 157, 100); header.write('ustar\0', 257, 6); header.write('00', 263, 2); header.write(prefix, 345, 155);
    octal(header.reduce((sum, byte) => sum + byte, 0), 148, 8);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

async function temporary(t) {
  const prefix = path.join(os.tmpdir(), 'agentrix-voice-runtime-'), folder = await fs.mkdtemp(prefix);
  t.after(async () => { assert.ok(path.resolve(folder).startsWith(prefix)); await fs.rm(folder, { recursive: true, force: true }); });
  return folder;
}

function fixture() {
  const name = 'sherpa-onnx-fixture';
  const files = {
    'package.json': Buffer.from(JSON.stringify({ name, version: RUNTIME_VERSION })),
    'sherpa-onnx.node': Buffer.from('native addon fixture'),
    'libonnxruntime.so': Buffer.from('onnx runtime fixture'),
    'libsherpa-onnx-c-api.so': Buffer.from('c api fixture'),
    'libsherpa-onnx-cxx-api.so': Buffer.from('cxx api fixture'),
  };
  const bytes = tarball([...Object.entries(files).map(([name, bytes]) => ({ name: `package/${name}`, bytes, mode: 0o755 })),
    { name: 'package/index.js', bytes: Buffer.from('not needed') }, { name: 'package/README.md', bytes: Buffer.from('not needed') }]);
  return { bytes, files, runtime: { name, files: Object.keys(files), size: bytes.length, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    urls: ['https://registry.npmjs.org', 'https://registry.npmmirror.com'].map(host => `${host}/${name}/-/${name}-${RUNTIME_VERSION}.tgz`) } };
}

function modelFixture(t) {
  const id = 'runtime-fixture', bytes = Buffer.alloc(700, 'm');
  MODELS[id] = { label: 'Runtime fixture', directory: id, files: [{ name: 'model.onnx', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), urls: ['https://example.invalid/model.onnx'] }], config: file => ({ fixture: file('model.onnx') }) };
  t.after(() => { delete MODELS[id]; });
  return { id, bytes };
}

test('runtime version and SHA-512 pins match the installed sherpa lockfile on both npm hosts', () => {
  const lock = require('../package-lock.json');
  assert.equal(RUNTIME_VERSION, lock.packages['node_modules/sherpa-onnx-node'].version);
  assert.deepEqual(Object.keys(RUNTIMES).sort(), ['darwin-arm64', 'linux-arm64', 'linux-x64', 'win-x64']);
  for (const runtime of Object.values(RUNTIMES)) {
    const pin = lock.packages[`node_modules/${runtime.name}`];
    assert.equal(pin.version, RUNTIME_VERSION); assert.equal(runtime.integrity, pin.integrity);
    assert.match(runtime.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/); assert.ok(runtime.size > 0);
    assert.equal(runtime.urls[0], pin.resolved);
    assert.equal(runtime.urls[1], pin.resolved.replace('registry.npmjs.org', 'registry.npmmirror.com'));
  }
});

test('ustar extraction strips package/, creates nested directories and preserves file bytes and modes', async t => {
  const folder = await temporary(t), archive = path.join(folder, 'fixture.tgz'), output = path.join(folder, 'extracted');
  await fs.writeFile(archive, tarball([
    { name: 'package/', type: '5', mode: 0o755 }, { name: 'package/nested/', type: '5', mode: 0o755 },
    { name: 'package/sherpa-onnx.node', bytes: Buffer.from('addon'), mode: 0o755 },
    { name: 'libonnxruntime.so.1', prefix: 'package/nested/deeper', bytes: Buffer.from('shared library'), mode: 0o755 },
    { name: 'package/package.json', bytes: Buffer.from('{}') },
  ]));
  await extractTarball(archive, output);
  assert.equal(await fs.readFile(path.join(output, 'sherpa-onnx.node'), 'utf8'), 'addon');
  assert.equal(await fs.readFile(path.join(output, 'nested/deeper/libonnxruntime.so.1'), 'utf8'), 'shared library');
  assert.equal(await fs.readFile(path.join(output, 'package.json'), 'utf8'), '{}');
  await assert.rejects(fs.stat(path.join(output, 'package')), { code: 'ENOENT' });
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(output, 'sherpa-onnx.node'))).mode & 0o777, 0o755);
});

test('ustar extraction preserves relative library symlinks', async t => {
  const folder = await temporary(t), archive = path.join(folder, 'fixture.tgz'), output = path.join(folder, 'extracted');
  try { await fs.symlink('probe-target', path.join(folder, 'probe')); }
  catch (error) { if (error.code !== 'EPERM') throw error; t.skip('Windows symlink creation requires privileges'); return; }
  await fs.writeFile(archive, tarball([
    { name: 'package/libonnxruntime.so', type: '2', link: 'libonnxruntime.so.1' },
    { name: 'package/libonnxruntime.so.1', bytes: Buffer.from('library'), mode: 0o755 },
  ]));
  await extractTarball(archive, output);
  assert.equal(await fs.readlink(path.join(output, 'libonnxruntime.so')), 'libonnxruntime.so.1');
  assert.equal(await fs.readFile(path.join(output, 'libonnxruntime.so'), 'utf8'), 'library');
});

test('ustar extraction rejects absolute paths, parent traversal and escaping symlinks', async t => {
  const folder = await temporary(t), archive = path.join(folder, 'fixture.tgz'), output = path.join(folder, 'extracted');
  await fs.mkdir(output);
  for (const name of ['/absolute.node', '../escape.node', 'package/../escape.node', 'package/nested/../../escape.node', 'C:/absolute.node', 'package/C:/absolute.node', 'package\\..\\escape.node']) {
    await fs.writeFile(archive, tarball([{ name, bytes: Buffer.from('escape') }]));
    await assert.rejects(extractTarball(archive, output), /不安全路径/, name);
  }
  for (const link of ['../escape.so', '/absolute.so', 'C:\\absolute.so']) {
    await fs.writeFile(archive, tarball([{ name: 'package/libevil.so', type: '2', link }]));
    await assert.rejects(extractTarball(archive, output), /不安全路径/, link);
  }
  assert.deepEqual(await fs.readdir(output), []);
  await assert.rejects(fs.stat(path.join(folder, 'escape.node')), { code: 'ENOENT' });
});

test('runtime integrity mismatch installs nothing and deletes corrupt partial bytes', async t => {
  const folder = await temporary(t), { runtime, bytes } = fixture(), output = path.join(folder, `${runtime.name}-${RUNTIME_VERSION}`);
  const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 1] ^= 1;
  const calls = [];
  await assert.rejects(downloadRuntime(runtime, output, async url => { calls.push(url); return new Response(corrupt); }, new AbortController().signal, () => {}), /校验失败/);
  assert.deepEqual(calls, runtime.urls); assert.deepEqual(await fs.readdir(folder), []);
});

test('runtime installation keeps the addon, libraries and package metadata after complete extraction', async t => {
  const folder = await temporary(t), { runtime, bytes, files } = fixture(), output = path.join(folder, `${runtime.name}-${RUNTIME_VERSION}`);
  const progress = [];
  await downloadRuntime(runtime, output, async (_url, { signal }) => {
    assert.equal(signal.aborted, false);
    await assert.rejects(fs.stat(output), { code: 'ENOENT' });
    return new Response(bytes);
  }, new AbortController().signal, count => progress.push(count));
  assert.deepEqual((await fs.readdir(output)).sort(), Object.keys(files).sort());
  for (const [name, content] of Object.entries(files)) assert.deepEqual(await fs.readFile(path.join(output, name)), content);
  assert.equal(progress.at(-1), bytes.length); assert.deepEqual(await fs.readdir(folder), [path.basename(output)]);
  await downloadRuntime(runtime, output, () => assert.fail('a complete runtime is reused'), new AbortController().signal, () => {});
});

test('an incomplete runtime archive never replaces an installed directory', async t => {
  const folder = await temporary(t), { runtime, files } = fixture(), output = path.join(folder, `${runtime.name}-${RUNTIME_VERSION}`);
  const bytes = tarball([{ name: 'package/package.json', bytes: files['package.json'] }]);
  const incomplete = { ...runtime, size: bytes.length, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
  await fs.mkdir(output); await fs.writeFile(path.join(output, 'previous'), 'previous incomplete install');
  await assert.rejects(downloadRuntime(incomplete, output, async () => new Response(bytes), new AbortController().signal, () => {}), /文件不完整/);
  assert.deepEqual(await fs.readdir(output), ['previous']);
  assert.ok(!(await fs.readdir(folder)).some(name => name.includes('.tmp-')));
});

test('runtime fallback uses the npm mirror and resumes the same verified tarball', async t => {
  const folder = await temporary(t), { runtime, bytes } = fixture(), output = path.join(folder, `${runtime.name}-${RUNTIME_VERSION}`);
  await fs.writeFile(output + '.tgz.partial', bytes.subarray(0, 20));
  const calls = [];
  await downloadRuntime(runtime, output, async (url, { headers }) => {
    calls.push([url, headers.Range]);
    if (url === runtime.urls[0]) throw new TypeError('fetch failed');
    return new Response(bytes.subarray(20), { status: 206, headers: { 'Content-Range': `bytes 20-${bytes.length - 1}/${bytes.length}` } });
  }, new AbortController().signal, () => {});
  assert.deepEqual(calls, runtime.urls.map(url => [url, 'bytes=20-']));
  assert.ok((await fs.stat(path.join(output, 'sherpa-onnx.node'))).size > 0);
});

test('aborting an engine download preserves partial bytes for the next attempt', async t => {
  const folder = await temporary(t), { runtime, bytes } = fixture(), output = path.join(folder, `${runtime.name}-${RUNTIME_VERSION}`);
  const controller = new AbortController();
  await assert.rejects(downloadRuntime(runtime, output, async (_url, { signal }) => new Response(new ReadableStream({
    start(stream) { stream.enqueue(bytes.subarray(0, 20)); signal.addEventListener('abort', () => stream.error(new Error('aborted')), { once: true }); },
  })), controller.signal, count => { assert.equal(count, 20); controller.abort(); }), /aborted/);
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(output + '.tgz.partial'), bytes.subarray(0, 20));
  await downloadRuntime(runtime, output, async (_url, { headers }) => {
    assert.equal(headers.Range, 'bytes=20-');
    return new Response(bytes.subarray(20), { status: 206, headers: { 'Content-Range': `bytes 20-${bytes.length - 1}/${bytes.length}` } });
  }, new AbortController().signal, () => {});
  assert.ok((await fs.stat(path.join(output, 'sherpa-onnx.node'))).size > 0);
});

test('readiness requires both runtime and model, and prepare downloads only the missing parts', async t => {
  const folder = await temporary(t), engine = fixture(), model = modelFixture(t);
  for (const [hasEngine, hasModel] of [[false, false], [false, true], [true, false], [true, true]]) {
    const directory = path.join(folder, `${hasEngine}-${hasModel}`), calls = [];
    const voice = new VoiceManager({ directory, model: model.id, runtime: engine.runtime, fetcher: async url => {
      calls.push(url); return new Response(url.endsWith('.tgz') ? engine.bytes : model.bytes);
    } });
    t.after(() => voice.close());
    if (hasEngine) await downloadRuntime(engine.runtime, voice.runtimeDirectory, async () => new Response(engine.bytes), new AbortController().signal, () => {});
    if (hasModel) { await fs.mkdir(path.dirname(voice.file(model.id, 'model.onnx')), { recursive: true }); await fs.writeFile(voice.file(model.id, 'model.onnx'), model.bytes); }
    assert.equal((await voice.getState()).ready, hasEngine && hasModel);
    assert.equal(voice.engineDirectory, voice.runtimeDirectory);
    assert.equal(voice.runtimeReady, hasEngine);
    assert.deepEqual(calls, []);
    assert.equal((await voice.prepare()).ready, true);
    assert.equal(voice.engineDirectory, voice.runtimeDirectory);
    assert.equal(voice.runtimeReady, true);
    assert.deepEqual(calls, [...(hasEngine ? [] : [engine.runtime.urls[0]]), ...(hasModel ? [] : [MODELS[model.id].files[0].urls[0]])]);
    const restarted = new VoiceManager({ directory, model: model.id, runtime: engine.runtime });
    t.after(() => restarted.close());
    assert.equal((await restarted.getState()).ready, true);
  }
});

test('a development checkout reuses its platform package without downloading a runtime', async t => {
  const runtime = RUNTIMES[`${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`];
  if (!runtime) { t.skip('no pinned runtime for this platform'); return; }
  let installed;
  try { installed = path.dirname(require.resolve(`${runtime.name}/sherpa-onnx.node`)); }
  catch { t.skip('no development platform package installed'); return; }
  const directory = await temporary(t), model = modelFixture(t);
  const voice = new VoiceManager({ directory, model: model.id, fetcher: () => assert.fail('the engine and model already exist') });
  t.after(() => voice.close());
  await fs.mkdir(path.dirname(voice.file(model.id, 'model.onnx')), { recursive: true }); await fs.writeFile(voice.file(model.id, 'model.onnx'), model.bytes);
  assert.equal((await voice.getState()).ready, true); assert.equal((await voice.prepare()).ready, true);
  assert.equal(voice.engineDirectory, installed); assert.equal(voice.runtimeReady, true);
  await assert.rejects(fs.stat(voice.runtimeDirectory), { code: 'ENOENT' });
});

test('a missing shared library prevents readiness even with an addon and complete model', async t => {
  const directory = await temporary(t), engine = fixture(), model = modelFixture(t);
  const voice = new VoiceManager({ directory, model: model.id, runtime: engine.runtime });
  t.after(() => voice.close());
  await downloadRuntime(engine.runtime, voice.runtimeDirectory, async () => new Response(engine.bytes), new AbortController().signal, () => {});
  await fs.unlink(path.join(voice.runtimeDirectory, 'libonnxruntime.so'));
  await fs.mkdir(path.dirname(voice.file(model.id, 'model.onnx')), { recursive: true }); await fs.writeFile(voice.file(model.id, 'model.onnx'), model.bytes);
  assert.equal((await voice.getState()).ready, false);
  assert.equal(voice.engineDirectory, voice.runtimeDirectory); assert.equal(voice.runtimeReady, false);
});

test('download totals and percent include engine bytes before the model is fetched', async t => {
  const directory = await temporary(t), engine = fixture(), model = modelFixture(t), states = [], calls = [];
  let release, reached;
  const holdModel = new Promise(resolve => { release = resolve; }), requestedModel = new Promise(resolve => { reached = resolve; });
  const voice = new VoiceManager({ directory, model: model.id, runtime: engine.runtime, changed: state => states.push(state), fetcher: async url => {
    calls.push(url);
    if (url.endsWith('.tgz')) return new Response(new ReadableStream({
      start(stream) { const half = Math.floor(engine.bytes.length / 2); stream.enqueue(engine.bytes.subarray(0, half)); stream.enqueue(engine.bytes.subarray(half)); stream.close(); },
    }));
    reached(); await holdModel; return new Response(model.bytes);
  } });
  t.after(() => { release(); voice.close(); });
  const preparing = voice.prepare();
  await requestedModel;
  const during = await voice.getState(), total = engine.bytes.length + model.bytes.length;
  assert.deepEqual(calls, [engine.runtime.urls[0], MODELS[model.id].files[0].urls[0]]);
  assert.equal(during.ready, false); assert.equal(during.phase, 'downloading'); assert.equal(during.downloadBytes, total);
  assert.equal(during.percent, Math.floor(engine.bytes.length / total * 100));
  assert.equal(during.models.find(item => item.id === model.id).downloadBytes, total);
  assert.ok((await fs.stat(path.join(voice.runtimeDirectory, 'sherpa-onnx.node'))).size > 0);
  release(); assert.equal((await preparing).percent, 100);
  assert.ok(states.some(state => state.phase === 'downloading' && state.percent === during.percent));
  assert.ok(states.some(state => state.phase === 'downloading' && state.percent === Math.floor(Math.floor(engine.bytes.length / 2) / total * 100)));
});

test('runtime failures use the model error path and retry successfully', async t => {
  const directory = await temporary(t), engine = fixture(), model = modelFixture(t);
  let corrupt = true;
  const voice = new VoiceManager({ directory, model: model.id, runtime: engine.runtime, fetcher: async url => new Response(url.endsWith('.tgz') ? (corrupt ? Buffer.alloc(engine.bytes.length) : engine.bytes) : model.bytes) });
  t.after(() => voice.close());
  await assert.rejects(voice.prepare(), /校验失败/);
  const state = await voice.getState();
  assert.equal(state.phase, 'error'); assert.equal(state.ready, false); assert.match(state.error, /校验失败/);
  await assert.rejects(fs.stat(voice.runtimeDirectory), { code: 'ENOENT' });
  corrupt = false; assert.equal((await voice.prepare()).ready, true);
});

test('an unsupported platform reports unavailable without fetching or starting a worker', async t => {
  const directory = await temporary(t);
  const voice = new VoiceManager({ directory, runtime: null, fetcher: () => assert.fail('unsupported runtimes are never downloaded') });
  t.after(() => voice.close());
  const state = await voice.getState();
  assert.equal(state.phase, 'error'); assert.equal(state.ready, false); assert.match(state.error, /不支持当前平台/);
  await assert.rejects(voice.prepare(), /不支持当前平台/); await voice.warm(); assert.equal(voice.worker, undefined);
});

test('the worker seeds sherpa with the engine directory chosen by the main process', async () => {
  const { loadSherpa } = require('../electron/voice-worker.cjs');
  for (const runtimeDirectory of [path.resolve('node_modules/sherpa-onnx-linux-x64'), path.resolve('voice/runtime/sherpa-onnx-linux-x64-1.13.8')]) {
    const bridge = path.resolve('node_modules/sherpa-onnx-node/addon.js'), addon = path.join(runtimeDirectory, 'sherpa-onnx.node');
    const native = {}, calls = [];
    const load = name => {
      if (name === addon) { calls.push(name); return native; }
      if (name === 'sherpa-onnx-node') { assert.equal(load.cache[bridge].exports, native); assert.equal(load.cache[bridge].loaded, true); return {}; }
      assert.fail(`unexpected require ${name}`);
    };
    load.cache = {};
    load.resolve = name => {
      assert.equal(name, 'sherpa-onnx-node/addon.js');
      return bridge;
    };
    loadSherpa(load, runtimeDirectory);
    assert.deepEqual(calls, [addon]);
  }
});
