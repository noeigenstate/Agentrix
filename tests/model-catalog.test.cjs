const { createCliChecks, createModelProbes } = require('../electron/features/agents/usage-host.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ModelCatalog, modelRow, trackModelRuntime } = require('../electron/features/routing/model-catalog.cjs');
const { rankByName } = require('../electron/features/routing/seat-rules.mjs');
const seats = require('../electron/features/routing/model-seats.cjs');
const { probeCodex, probeClaude } = require('../electron/features/routing/model-probe.cjs');
const { createRpc } = require('../electron/features/codex-app-server/index.cjs');
const { workerModelKey } = require('../electron/features/cli-adapters/workers.cjs');
const agyOptions = require('./fixtures/agy-acp/model-options.json');
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
  assert.equal(modelRow({ model: 'agy:gemini-4-neon' }).model, 'gemini-4-neon');
});

test('old agy cache hides orchestration modes immediately and preserves other providers', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-old-catalog-'));
  t.after(() => fs.promises.rm(dataDir, { recursive: true, force: true }));
  const at = 1000, file = path.join(dataDir, 'seat-models.json');
  const raw = JSON.stringify({ version: 1,
    agy: { at, rows: agyOptions.map(({ value, name }) => ({
      model: value === 'gemini-pro-orchestrator' ? 'agy:' + value : workerModelKey(value, 'agy'),
      label: name, lastSeen: at,
    })) },
    claude: { at, rows: [{ model: 'claude-opus-5-5', efforts: ['max'], fast: true }] },
    codex: { at, rows: [{ model: 'gpt-6.2-sol', efforts: ['high'], fast: false }] },
  });
  fs.writeFileSync(file, raw);
  const catalog = new ModelCatalog({ dataDir, now: () => at });
  assert.deepEqual(catalog.rows().filter(row => row.family === 'agy').map(row => row.model), [
    'gemini-4-neon', 'gemini-4-carbon', 'gemini-4-argon', 'gemini-4-hydrogen', 'gemini-3.8-flash',
    'agy:claude-opus-5-5', 'agy:claude-sonnet-5-5', 'agy:gpt-oss-120b-medium',
  ]);
  assert.deepEqual(catalog.rows().filter(row => row.family !== 'agy').map(({ model, efforts, fast }) => ({ model, efforts, fast })), [
    { model: 'claude-opus-5-5', efforts: ['max'], fast: true }, { model: 'gpt-6.2-sol', efforts: ['high'], fast: false },
  ]);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});

test('catalog refresh throttles, persists, retains missing rows for 30 days and deduplicates probes', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-catalog-'));
  t.after(() => fs.promises.rm(dataDir, { recursive: true, force: true }));
  let now = 1000, codex = 0, claude = 0, changed = 0;
  const catalog = new ModelCatalog({ dataDir, now: () => now, changed: () => changed++, probes: {
    codex: async () => { codex++; return [{ model: 'gpt-6.2-sol' }]; }, claude: async () => { claude++; return [{ model: 'claude-opus-5-5' }]; } } });
  await Promise.all([catalog.refresh('startup'), catalog.refresh('startup')]);
  assert.equal(codex, 1); assert.equal(claude, 0);
  assert.deepEqual(catalog.timestamps(), { claude: null, agy: null, codex: now });
  await catalog.refresh('dialog'); assert.equal(claude, 1); assert.equal(codex, 1);
  now += 3600001; await catalog.refresh('dialog'); assert.equal(codex, 2); assert.equal(claude, 1);
  await catalog.refresh('manual'); assert.equal(codex, 3); assert.equal(claude, 2);
  catalog.accept('codex', [{ model: 'gpt-6.3-sol' }]);
  assert.equal(catalog.rows().find(row => row.model === 'gpt-6.2-sol').listed, false);
  const stored = JSON.parse(fs.readFileSync(catalog.file, 'utf8'));
  assert.equal(stored.version, 1);
  assert.deepEqual(stored.claude.rows.map(row => row.family), ['claude']);
  assert.deepEqual(stored.codex.rows.map(row => row.family), ['codex', 'codex']);
  const restored = new ModelCatalog({ dataDir, now: () => now });
  assert.deepEqual(restored.timestamps(), catalog.timestamps());
  assert.equal(restored.rows().find(row => row.model === 'gpt-6.2-sol').source, 'cached');
  now += 30 * 86400000 + 1;
  assert.equal(restored.rows().some(row => row.model === 'gpt-6.2-sol'), false);
  assert.ok(changed >= 3);
});

test('foreground model refreshes finish while agy is pending and authentication failures cool down', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-background-'));
  t.after(() => fs.promises.rm(dataDir, { recursive: true, force: true }));
  const agy = deferred(), changes = [];
  let now = 1, attempts = 0;
  const catalog = new ModelCatalog({ dataDir, now: () => now, changed: () => changes.push(catalog.errors()), probes: {
    agy: () => ++attempts === 1 ? agy.promise : [{ model: 'gemini-3.8-flash' }],
    claude: () => [{ model: 'claude-opus-5-5' }], codex: () => [{ model: 'gpt-6.2-sol' }],
  } });
  await catalog.refresh('dialog', { waitForBackground: false });
  assert.equal(attempts, 1);
  assert.deepEqual(catalog.rows().map(row => row.family), ['claude', 'codex']);
  const failure = catalog.refresh('dialog');
  agy.reject(Object.assign(new Error('private provider error'), { catalogCode: 'auth_required' }));
  await failure;
  assert.deepEqual(changes.at(-1), { agy: 'auth_required' });
  now += 59_999;
  await catalog.refresh('dialog');
  assert.equal(attempts, 1);
  now++;
  await catalog.refresh('dialog');
  assert.equal(attempts, 2);
  assert.deepEqual(changes.at(-1), {});
  assert.deepEqual(catalog.rows().filter(row => row.family === 'agy').map(row => row.model), ['gemini-3.8-flash']);
});

test('newest numeric Sol defaults do not rewrite choices; rendering degrades unsupported settings visibly', () => {
  const models = seats.catalog({ codex: true, claude: true }, [
    { model: 'gpt-6.2-sol', efforts: ['medium'], defaultEffort: 'medium', fast: false },
    { model: 'gpt-6.10-sol', efforts: ['high'], fast: true }, { model: 'gpt-7.0-sol', listed: false },
    { model: 'claude-opus-5-5', fast: true }]);
  assert.equal(seats.defaultsFor({ codex: true }, models).developer.model, 'gpt-6.10-sol');
  const raw = { developer: { model: 'gpt-6.2-sol', effort: 'ultra', fast: true } };
  assert.deepEqual(seats.cleanStoredSeats(raw, ['developer']), raw);
  assert.equal(seats.seatIssues(raw, models).length, 2);
  assert.deepEqual(seats.resolveSeat(raw.developer, null, { codex: true }, models), { model: 'gpt-6.2-sol', effort: 'medium', fast: false });
  assert.equal(raw.developer.fast, true);
  const { renderRoutingGuide } = require('../electron/features/routing/guide-render.cjs');
  const text = '<!-- agentrix:team -->\n| developer | Developer | Implementation | Code | Opus | Agent |\n<!-- /agentrix:team -->';
  const roles = [{ id: 'orchestrator' }, { id: 'developer' }], installed = { claude: true };
  const render = (model, fast = false) => renderRoutingGuide(text, { roles, map: { developer: { model, effort: 'high', fast } }, leadAgent: 'claude', installed, catalog: models });
  assert.match(render('claude-opus-5-5', true), /\| claude-opus-5-5 · high · fast \| start_role seat developer;/);
  assert.match(render('claude-opus-5-5'), /Agent call, model "opus", effort "high"/);
  assert.match(render('claude-opus-5-4'), /\| claude-opus-5-4 · high \| start_role seat developer/);
});

test('the shared seat rank rule matches the model rank fixture', () => {
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/seat-ranks.json'), 'utf8'));
  assert.ok(cases.length >= 10);
  for (const { model, rank } of cases) assert.equal(rankByName(model), rank, model);
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
  const rows = await probeCodex({ rpcFactory: createRpc, stop: child => child.kill(), workerEnvironment: env => env || {}, executable: async () => 'injected-only', spawn: (_file, args) => {
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
  assert.deepEqual(options.settingSources, []); assert.equal(options.persistSession, false);
});

test('unchanged catalog rows persist freshness across restart without publishing again', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-quiet-')); t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let now = 100, published = 0;
  const catalog = new ModelCatalog({ dataDir, now: () => now, changed: () => published++ });
  const rows = [{ model: 'gpt-6.2-sol' }]; catalog.accept('codex', rows);
  const bytes = fs.readFileSync(catalog.file, 'utf8'); now++;
  catalog.accept('codex', rows); assert.equal(published, 1); assert.equal(catalog.timestamps().codex, now);
  assert.notEqual(fs.readFileSync(catalog.file, 'utf8'), bytes);
  const restored = new ModelCatalog({ dataDir, now: () => now });
  assert.equal(restored.timestamps().codex, now); assert.equal(restored.rows()[0].lastSeen, now);
});

test('main uses a neutral probe folder and still lists keyed models after SDK startup fails', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neutral-probe-')); t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let listed = 0, cwd;
  const { adapters } = require('../electron/features/cli-adapters/registry.cjs');
  const directory = path.join(dataDir, 'model-probe');
  const modelProbes = createModelProbes({ path, fs, adapters, app: { getPath: () => dataDir },
    seatModelRuntimes: { claude: new Set() }, agents: { getState: () => ({ claude: { installed: true } }) },
    claudeRuntime: { credentials: { read: () => 'synthetic-injected' } }, createSdkLoader: () => () => {},
    resolveClaudeExecutable: async () => 'injected', claudeLocator: {}, process: { env: {} }, apiEnvironment: env => env,
    probeClaude: async input => { cwd = input.options.cwd; throw Error('sdk-failure'); },
    listModels: async () => { listed++; return { models: ['claude-new'] }; }, netRequest: () => () => {}, electronNet: {} });
  assert.ok(fs.statSync(directory).isDirectory()); assert.deepEqual(fs.readdirSync(directory), []);
  const rows = await modelProbes.claude();
  assert.equal(cwd, directory); assert.equal(listed, 1); assert.equal(rows[0].model, 'claude-new');
});

test('main skips an absent agy and delegates the installed catalog probe', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-probe-'));
  t.after(() => fs.promises.rm(dataDir, { recursive: true, force: true }));
  const { adapterOf } = require('../electron/features/cli-adapters/registry.cjs');
  let installed = false, calls = 0;
  const probes = createModelProbes({ path, fs, app: { getPath: () => dataDir }, seatModelRuntimes: {},
    agents: { getState: () => ({ agy: { installed } }) }, adapters: () => [{
      manifest: adapterOf('agy').manifest,
      modelProbe(_host, directory, available) {
        calls++; assert.equal(available(), true); assert.equal(path.basename(directory), 'model-probe');
        return [{ model: 'gemini-3.8-flash' }];
      },
    }] });
  assert.equal(await probes.agy(), null); assert.equal(calls, 0);
  installed = true;
  assert.deepEqual(await probes.agy(), [{ model: 'gemini-3.8-flash' }]); assert.equal(calls, 1);
});

test('main publishes a manual install result when its version check changes the displayed state', async () => {
  const { adapters } = require('../electron/features/cli-adapters/registry.cjs');
  let state = null, calls = 0, changes = 0;
  const installer = { peek: () => state, refresh() {
    calls++; state = { installed: true, version: '1.5.18', fileShown: path.resolve('agy.exe') };
  } };
  const { checkManualInstalls } = createCliChecks({ adapters, process: { env: {} },
    agents: { installers: new Map([['agy', installer]]), changed: () => changes++ } });
  await Promise.all([checkManualInstalls(), checkManualInstalls()]);
  assert.equal(calls, 1); assert.equal(changes, 1);
  await checkManualInstalls();
  assert.equal(calls, 2); assert.equal(changes, 1);
});

test('Codex probe starts a process group with a scrubbed environment and awaits the injected tree stop', async () => {
  const { workerEnvironment } = require('../electron/features/codex-app-server/index.cjs');
  const stopping = deferred(), stopped = deferred(); let completed = false;
  const child = { stdin: { destroy() {} }, stdout: { destroy() {} }, stderr: { destroy() {} } };
  const run = probeCodex({ executable: async () => 'injected', env: { PATH: 'synthetic', AGENTRIX_BOOTSTRAP: 'private' }, workerEnvironment,
    spawn: (_file, _args, options) => { assert.equal(options.detached, process.platform !== 'win32'); assert.equal(options.env.AGENTRIX_BOOTSTRAP, undefined); return child; },
    rpcFactory: () => ({ request: async method => method === 'model/list' ? { data: [] } : {}, notify() {}, close() {} }),
    stop: value => { assert.equal(value, child); stopping.resolve(); return stopped.promise; } }).then(value => { completed = true; return value; });
  await stopping.promise; assert.equal(completed, false); stopped.resolve(); await run; assert.equal(completed, true);
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
  child.pid = 12345; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => killed++;
  child.stdin = new Writable({ write(_chunk, _encoding, done) { initialized.resolve(); done(); } });
  const run = probeCodex({ rpcFactory: createRpc, stop: child => child.kill(), workerEnvironment: env => env || {}, executable: async () => 'injected', spawn: () => child, timers });
  await initialized.promise; timers.expire(); await assert.rejects(run, /model_probe_timeout/);
  assert.equal(killed, 1); assert.equal(timers.active, false);
  assert.ok([child.stdin, child.stdout, child.stderr].every(pipe => pipe.destroyed));
  const late = deferred(), lateTimers = deadline(); let spawned = false;
  const unresolved = probeCodex({ rpcFactory: createRpc, stop: child => child.kill(), workerEnvironment: env => env || {}, executable: () => late.promise, spawn: () => { spawned = true; }, timers: lateTimers });
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

test('an asynchronous spawn failure without a pid preserves its error and skips tree stop', async () => {
  const child = new EventEmitter(); let stopped = false;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(_chunk, _encoding, done) {
    done(); queueMicrotask(() => child.emit('error', Object.assign(new Error('missing injected executable'), { code: 'ENOENT' })));
  } });
  await assert.rejects(probeCodex({ executable: async () => 'missing', spawn: () => child,
    rpcFactory: createRpc, workerEnvironment: env => env || {}, stop: async () => { stopped = true; throw Error('process_stop_timeout'); } }),
  error => error.code === 'ENOENT');
  assert.equal(stopped, false);
});
