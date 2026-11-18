const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ModelCatalog, modelRow, rankOf, trackModelRuntime } = require('../electron/features/skills/model-catalog.cjs');
const seats = require('../electron/features/skills/model-seats.cjs');
const { probeCodex, probeClaude } = require('../electron/features/skills/model-probe.cjs');
const { createRpc } = require('../electron/features/codex-app-server/index.cjs');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function deadline() {
  let callback, active;
  return {
    setTimeout(fn, ms) { assert.equal(ms, 10000); callback = fn; active = true; return fn; },
    clearTimeout(id) { assert.equal(id, callback); active = false; },
    expire() { assert.equal(active, true); callback(); },
    get active() { return active; },
  };
}

test('catalog keeps provider efforts, defaults, fast metadata and sanitized labels', () => {
  const row = modelRow({ model: 'gpt-6.2-sol', displayName: 'x'.repeat(90), supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }],
    defaultReasoningEffort: 'ultra', serviceTiers: [{ id: 'priority' }], isDefault: true });
  assert.deepEqual(row.efforts, ['ultra']); assert.equal(row.defaultEffort, 'ultra'); assert.equal(row.fast, true);
  assert.equal(row.label.length, 80); assert.equal(row.isDefault, true);
  assert.equal(modelRow({ model: '-unsafe' }), null);
  assert.equal(modelRow({ value: 'default', resolvedModel: 'claude-opus-5-5' }), null);
  assert.equal(modelRow({ value: 'opus', resolvedModel: 'claude-opus-5-5', supportsFastMode: true }).alias, 'opus');
});

test('catalog refresh throttles, persists, retains missing rows for 30 days and deduplicates probes', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-catalog-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let now = 1000, codex = 0, claude = 0, changed = 0;
  const catalog = new ModelCatalog({ dataDir, now: () => now, changed: () => changed++, probes: {
    codex: async () => { codex++; return [{ model: 'gpt-6.2-sol' }]; }, claude: async () => { claude++; return [{ model: 'claude-opus-5-5' }]; } } });
  await Promise.all([catalog.refresh('startup'), catalog.refresh('startup')]);
  assert.equal(codex, 1); assert.equal(claude, 0);
  await catalog.refresh('dialog'); assert.equal(claude, 1); assert.equal(codex, 1);
  now += 3600001; await catalog.refresh('dialog'); assert.equal(codex, 2); assert.equal(claude, 1);
  await catalog.refresh('manual'); assert.equal(codex, 3); assert.equal(claude, 2);
  catalog.accept('codex', [{ model: 'gpt-6.3-sol' }]);
  assert.equal(catalog.rows().find(row => row.model === 'gpt-6.2-sol').listed, false);
  const restored = new ModelCatalog({ dataDir, now: () => now });
  assert.equal(restored.rows().find(row => row.model === 'gpt-6.2-sol').source, 'cached');
  now += 30 * 86400000 + 1;
  assert.equal(restored.rows().some(row => row.model === 'gpt-6.2-sol'), false);
  assert.ok(changed >= 5);
});

test('newest numeric Sol defaults do not rewrite choices; rendering degrades unsupported settings visibly', () => {
  const models = seats.catalog({ codex: true, claude: true }, [
    { model: 'gpt-6.2-sol', efforts: ['medium'], defaultEffort: 'medium', fast: false },
    { model: 'gpt-6.10-sol', efforts: ['high'], fast: true }, { model: 'gpt-7.0-sol', listed: false },
    { model: 'claude-opus-5-5', fast: true }]);
  assert.equal(seats.defaultsFor({ codex: true }, models).core.model, 'gpt-6.10-sol');
  const raw = { core: { model: 'gpt-6.2-sol', effort: 'ultra', fast: true } };
  assert.deepEqual(seats.cleanStoredSeats(raw, ['core']), raw);
  assert.equal(seats.seatIssues(raw, models).length, 2);
  assert.match(seats.renderSeats(raw, 'codex', 'helper', { codex: true }, models), /Adjusted effort ultra to medium.*Adjusted fast on to off/);
  assert.equal(raw.core.fast, true);
  const block = seats.renderSeats({ execution: { model: 'claude-opus-5-5', effort: 'high', fast: true } }, 'claude', 'helper', { claude: true }, models);
  assert.match(block, /claude --model claude-opus-5-5 --effort high --fast.*--detach; then.*wait/);
  assert.doesNotMatch(block, /Agent call/);
});

test('rank rule matches every entry in the required shared UI fixture', () => {
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/seat-ranks.json'), 'utf8'));
  assert.ok(cases.length >= 10);
  for (const row of cases) assert.equal(rankOf(row.model), row.rank, row.model);
});

test('one-shot Codex probe pages without creating a thread and closes its injected process', async () => {
  const child = new EventEmitter(), methods = [];
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); let killed = false;
  child.kill = () => { killed = true; };
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const request = JSON.parse(chunk); methods.push(request.method);
    if (request.id) {
      const result = request.method === 'initialize' ? {} : request.params.cursor ? { data: [{ model: 'gpt-6.3-sol' }] }
        : { data: [{ model: 'gpt-6.2-sol' }], nextCursor: 'next' };
      queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n'));
    }
    done();
  } });
  const rows = await probeCodex({ rpcFactory: createRpc, executable: async () => 'injected-only', spawn: (_file, args) => {
    assert.deepEqual(args, ['app-server', '--listen', 'stdio://']); return child;
  } });
  assert.equal(rows.length, 2); assert.equal(killed, true);
  assert.deepEqual(methods, ['initialize', 'initialized', 'model/list', 'model/list']);
});

test('one-shot Claude probe never yields a prompt and always interrupts', async () => {
  let interrupted = false, closed = false, options;
  const rows = await probeClaude({ loadSdk: async () => ({ query: input => {
    options = input.options; assert.ok(input.prompt[Symbol.asyncIterator]);
    return { supportedModels: async () => [{ value: 'opus' }], interrupt: () => { interrupted = true; }, close: () => { closed = true; } };
  } }) });
  assert.equal(rows.length, 1); assert.equal(interrupted, true); assert.equal(closed, true); assert.equal(options.abortController.signal.aborted, true);
});

test('model refreshes run at the exact startup and dialog boundaries; manual refresh is never age-throttled', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-throttle-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const origin = 1000, cases = [
    { family: 'codex', reason: 'startup', age: 6 * 3600000 },
    { family: 'codex', reason: 'dialog', age: 3600000 },
    { family: 'claude', reason: 'dialog', age: 24 * 3600000 },
  ];
  for (const { family, reason, age } of cases) {
    let now = origin, calls = 0;
    const model = family === 'codex' ? 'gpt-6.2-sol' : 'claude-opus-5-5';
    const catalog = new ModelCatalog({ dataDir, now: () => now, probes: { [family]: async () => { calls++; return [{ model }]; } } });
    catalog.accept(family, [{ model }]);
    now = origin + age - 1; await catalog.refresh(reason); assert.equal(calls, 0, `${family}/${reason} before boundary`);
    now++; await catalog.refresh(reason); assert.equal(calls, 1, `${family}/${reason} at boundary`);
    await catalog.refresh(reason); assert.equal(calls, 1, 'a successful refresh resets the age');
    await catalog.refresh('manual'); await catalog.refresh('manual'); assert.equal(calls, 3, 'manual works even at the same clock value');
  }
});

test('SSH model reads and late reads from a closed local runtime cannot overwrite the local catalog', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-sources-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const catalog = new ModelCatalog({ dataDir }), runtimes = new Set();
  const localRows = [{ value: 'gpt-6.2-sol', efforts: ['high'], fast: true }];
  const remoteRows = [{ value: 'gpt-99.0-sol', efforts: ['low'], fast: false }];
  const local = trackModelRuntime({ models: async () => localRows, close: async () => {} },
    { runtimes, observe: rows => catalog.accept('codex', rows) });
  await local.models(); const before = fs.readFileSync(catalog.file, 'utf8');
  const remote = trackModelRuntime({ models: async () => remoteRows, close: async () => {} },
    { local: false, runtimes, observe: rows => catalog.accept('codex', rows) });
  assert.deepEqual(await remote.models(), remoteRows); assert.equal(runtimes.has(remote), false);
  assert.equal(fs.readFileSync(catalog.file, 'utf8'), before);
  const pending = deferred(), reading = deferred();
  const closing = trackModelRuntime({ models: () => { reading.resolve(); return pending.promise; }, close: async () => {} },
    { runtimes, observe: rows => catalog.accept('codex', rows) });
  const read = closing.models(); await reading.promise; await closing.close(); pending.resolve(remoteRows); await read;
  assert.equal(runtimes.has(closing), false); assert.equal(fs.readFileSync(catalog.file, 'utf8'), before);
  await local.close(); assert.equal(runtimes.size, 0);
});

test('merged Claude model rows preserve resolved ids, aliases, efforts and fast through live observation', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-claude-source-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const catalog = new ModelCatalog({ dataDir }), runtimes = new Set();
  const runtime = trackModelRuntime({ models: async () => [{ value: 'claude-opus-6-0', alias: 'opus', displayName: 'New Opus',
    description: 'Provider metadata', efforts: ['adaptive', 'max'], fast: true }], close: async () => {} },
  { runtimes, observe: rows => catalog.accept('claude', rows) });
  await runtime.models();
  const palette = seats.catalog({ claude: true }, catalog.rows());
  for (const model of ['opus', 'claude-opus-6-0']) {
    const row = palette.find(row => row.model === model); assert.equal(row.fast, true); assert.deepEqual(row.efforts, ['adaptive', 'max']);
  }
  await runtime.close();
});

test('Codex deadline cleans a stalled handshake and late executable resolution never spawns', async () => {
  const timers = deadline(), child = new EventEmitter(), initialized = deferred(); let killed = 0;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => killed++;
  child.stdin = new Writable({ write(_chunk, _encoding, done) { initialized.resolve(); done(); } });
  const run = probeCodex({ rpcFactory: createRpc, executable: async () => 'injected', spawn: () => child, timers });
  await initialized.promise; timers.expire(); await assert.rejects(run, /model_probe_timeout/);
  assert.equal(killed, 1); assert.equal(timers.active, false);
  assert.ok([child.stdin, child.stdout, child.stderr].every(pipe => pipe.destroyed));
  const late = deferred(), lateTimers = deadline(); let spawned = false;
  const unresolved = probeCodex({ rpcFactory: createRpc, executable: () => late.promise, spawn: () => { spawned = true; }, timers: lateTimers });
  lateTimers.expire(); await assert.rejects(unresolved, /model_probe_timeout/);
  late.resolve('too-late'); await late.promise; assert.equal(spawned, false);
});

test('Claude deadline closes the prompt and query; late SDK resolution never starts a query', async () => {
  const timers = deadline(), supported = deferred(), reading = deferred(); let interrupted = 0, closed = 0, next, signal;
  const run = probeClaude({ timers, loadSdk: async () => ({ query: ({ prompt, options }) => {
    signal = options.abortController.signal; next = prompt[Symbol.asyncIterator]().next();
    return { supportedModels: () => { reading.resolve(); return supported.promise; }, interrupt: () => { interrupted++; }, close: () => { closed++; } };
  } }) });
  await reading.promise; timers.expire(); await assert.rejects(run, /model_probe_timeout/);
  assert.deepEqual(await next, { value: undefined, done: true });
  assert.equal(interrupted, 1); assert.equal(closed, 1); assert.equal(signal.aborted, true); assert.equal(timers.active, false);
  supported.resolve([{ value: 'opus' }]); await supported.promise;
  const late = deferred(), lateTimers = deadline(); let started = false;
  const unresolved = probeClaude({ timers: lateTimers, loadSdk: () => late.promise });
  lateTimers.expire(); await assert.rejects(unresolved, /model_probe_timeout/);
  late.resolve({ query: () => { started = true; } }); await late.promise; assert.equal(started, false);
});

test('a failed model-only Claude read still interrupts and closes the query', async () => {
  let interrupted = 0, closed = 0;
  await assert.rejects(probeClaude({ loadSdk: async () => ({ query: () => ({ supportedModels: async () => { throw new Error('injected-failure'); },
    interrupt: () => { interrupted++; }, close: () => { closed++; } }) }) }), /injected-failure/);
  assert.equal(interrupted, 1); assert.equal(closed, 1);
});
