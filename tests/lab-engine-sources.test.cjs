require('./fixtures/lab-isolation.cjs');
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { randomUUID, createHash } = require('node:crypto');
mock.method(https, 'get', () => { throw new Error('Tests must never access the network'); });
mock.method(globalThis, 'fetch', () => { throw new Error('Tests must never access the network'); });
const { LabEngine } = require('../electron/features/lab/engine.cjs');
const { LabStore } = require('../electron/features/lab/store.cjs');
const { experimentInput } = require('../electron/features/lab/values.cjs');
const tools = require('../electron/features/lab/sources/tools.cjs');
const { runTask, validateReference, recoverRuns } = require('../electron/features/lab/runner.cjs');
const { createAaSource } = require('../electron/features/lab-aa/index.cjs');
const { cleanEnvironment } = require('../electron/features/lab/sandbox.cjs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHistorySource } = require('../electron/features/lab/sources/history.cjs');
const { conformance, fakeSession } = require('./helpers/lab-provider-conformance.cjs');

async function temporary(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lab-sources-')));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 }));
  return root;
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const passed = () => ({ state: 'passed', testsPassed: 1, testsTotal: 1, score: 1, costUsd: 0.1, outputTokens: 3 });

function fakeProvider(id, { size = 3, cost = 0.5, reference, guard, prepare, grade } = {}) {
  const tasks = Array.from({ length: size }, (_, index) => ({
    id: id === 'history' ? (index + 1).toString(16).padStart(40, '0') : id + '-task-' + index,
    source: id, title: id + ' ' + index, text: 'cold manifest title', kind: 'core', why: '',
  }));
  let fetched = false;
  return { id, review: 'none', tasks,
    defaults: Object.fromEntries(['orchestrated', 'opus', 'sol', 'sonnet'].map(arm => [arm, { costUsd: cost, minutes: 1 }])),
    async describe() { return { id, available: true, reason: null,
      metric: { history: 'hidden-tests', oss: 'resolved', aa: 'tests' }[id], review: false,
      size: { min: 1, max: 66, standard: 1 }, options: [], manifest: null, downloadBytes: 123,
      published: fetched ? { label: 'fixture', url: 'https://example.invalid', asOf: '2026-01-01', harness: 'fixture',
        comparable: false, note: null, values: { sol: 0.5 } } : null, keyStored: null }; },
    async sample(query) { return tasks.filter(task => !query.exclude.includes(task.id)).slice(0, query.size); },
    async canonical(selection) {
      return { scope: { id }, scopeKey: 'scope-' + id, scopeLabel: id, tasks: selection.tasks.map(item => {
        const task = tasks.find(task => task.id === item.id);
        if (!task) throw new Error('forged task');
        return { ...task, text: fetched ? 'downloaded problem text' : task.text };
      }) };
    },
    async fetch() { fetched = true; },
    guard: guard || (async () => ({ protectedPaths: [], async check() {} })),
    reference: reference || (async (_task, _scope, ctx) => { assert.equal(ctx.reference, null); return { diffFiles: [] }; }),
    prepare: prepare || (async () => { throw new Error('engine fixture must inject its runner'); }),
    grade: grade || (async () => ({ testsPassed: 1, testsTotal: 1, score: 1, passed: true, evidence: null })),
  };
}
const selection = (provider, count = 1) => ({ source: provider.id,
  ...(provider.id === 'history' ? { projectId: 'fixture' } : provider.id === 'oss' ? { repos: ['fixture'] } : { benchmark: 'terminal-bench-4' }),
  tasks: provider.tasks.slice(0, count).map(task => ({ id: task.id })) });

async function fixture(t, providers, options = {}) {
  const root = await temporary(t);
  const engine = new LabEngine({ userData: root, getProjects: () => [], providers, prices: { models: {} },
    sourceTools: { ...tools, docker: { async sweep() {}, async remove() {} } },
    referenceRunner: options => options.provider.reference(options.task, options.scope, { ...options.context, reference: null }),
    runner: async () => passed(), ...options });
  await engine.ready; await engine.cleanupTail;
  t.after(async () => { engine.close(); await engine.active?.done; await engine.startDone?.catch(() => {}); });
  return { root, engine, input: { selections: providers.map(provider => selection(provider)),
    arms: ['sol', 'sonnet'], repeats: 1, budgetUsd: 10 } };
}

test('all source references finish before models start and lanes overlap with stable per-lane order', { timeout: 10000 }, async t => {
  const providers = ['history', 'oss', 'aa'].map(id => fakeProvider(id)), barrier = deferred(), calls = [];
  let references = 0, entered = 0;
  const f = await fixture(t, providers, {
    referenceRunner: async options => { references++; return { diffFiles: [options.task.id] }; },
    runner: async options => {
      assert.equal(references, 3); assert.equal(options.task.text, 'downloaded problem text');
      calls.push([options.run.source, options.run.arm, options.run.repeat]);
      if (++entered === 3) barrier.resolve();
      await barrier.promise; return passed();
    },
  });
  await f.engine.start(f.input); await f.engine.active.done;
  const experiment = (await f.engine.list())[0];
  assert.equal(experiment.state, 'done'); assert.equal(calls.length, 6);
  assert.equal(new Set(calls.slice(0, 3).map(call => call[0])).size, 3);
  for (const provider of providers) assert.deepEqual(calls.filter(call => call[0] === provider.id).map(call => call[1]), ['sol', 'sonnet']);
  assert.equal(experiment.projectId, 'fixture'); assert.equal(experiment.sources.length, 3);
  assert.ok(experiment.runs.every(run => run.score === 1));
});

test('budget slices follow source estimates, sum to the budget and never rebalance', async t => {
  const providers = [fakeProvider('oss', { cost: 0.5 }), fakeProvider('aa', { cost: 1.5 })], ceilings = [];
  const f = await fixture(t, providers, { runner: async options => {
    ceilings.push([options.run.source, options.budgetCeiling]);
    return { ...passed(), costUsd: null, knownCostUsd: 0.1 };
  } });
  const estimate = await f.engine.estimate(f.input);
  assert.deepEqual(estimate.sources.map(source => source.share), [0.25, 0.75]);
  await f.engine.start({ ...f.input, budgetUsd: 3 }); await f.engine.active.done;
  const experiment = (await f.engine.list())[0];
  assert.deepEqual(experiment.lanes.map(lane => lane.budgetUsd), [0.75, 2.25]);
  assert.equal(experiment.lanes.reduce((n, lane) => n + lane.budgetUsd, 0), 3);
  assert.deepEqual(ceilings, [['oss', 0.75], ['aa', 2.25]]);
  assert.ok(experiment.lanes.every(lane => lane.state === 'stopped'));
  assert.equal(experiment.spentUsd, 2); assert.ok(experiment.runs.every(run => run.costUsd === null));
  assert.equal(experiment.projectId, null); assert.equal(experiment.projectName, null);
});

test('an insufficient single-source budget persists a stopped experiment without rejecting start', async t => {
  let calls = 0;
  const f = await fixture(t, [fakeProvider('oss')], { runner: async () => { calls++; return passed(); } });
  await f.engine.start({ ...f.input, budgetUsd: 0.1 }); await f.engine.active.done;
  const experiment = (await f.engine.list())[0];
  assert.equal(calls, 0); assert.equal(experiment.state, 'stopped'); assert.equal(experiment.spentUsd, 0);
  assert.equal(experiment.lanes[0].budgetUsd, 0.1); assert.match(experiment.lanes[0].error, /预算/);
});

test('two consecutive infrastructure errors stop only their lane and do not persist internal flags', async t => {
  const calls = { oss: 0, aa: 0 };
  const providers = [fakeProvider('oss'), fakeProvider('aa')];
  const f = await fixture(t, providers, { runner: async options => {
    calls[options.run.source]++;
    return options.run.source === 'oss' ? { state: 'error', infrastructure: true, modelStarted: false, error: 'fixture disk failure' } : passed();
  } });
  f.input.selections = providers.map(provider => selection(provider, 3));
  await f.engine.start(f.input); await f.engine.active.done;
  const experiment = (await f.engine.list())[0];
  assert.deepEqual(calls, { oss: 2, aa: 6 });
  assert.deepEqual(experiment.lanes.map(lane => lane.state), ['error', 'done']); assert.equal(experiment.state, 'done');
  assert.ok(experiment.runs.every(run => !('infrastructure' in run) && !('modelStarted' in run)));
});

test('a fatal run cancels every other active lane before another model can start', { timeout: 10000 }, async t => {
  const gate = deferred(); let entered = 0, cancelled = false;
  const f = await fixture(t, [fakeProvider('oss'), fakeProvider('aa')], { runner: async options => {
    if (++entered === 2) gate.resolve(); await gate.promise;
    if (options.run.source === 'oss') return { state: 'error', fatal: true, modelStarted: false, error: 'guard changed' };
    await new Promise(resolve => { options.signal.addEventListener('abort', resolve, { once: true }); if (options.signal.aborted) resolve(); });
    cancelled = true; return { state: 'stopped', modelStarted: false };
  } });
  await f.engine.start(f.input); await f.engine.active.done;
  assert.equal(entered, 2); assert.equal(cancelled, true); assert.equal((await f.engine.list())[0].state, 'error');
});

test('a rejected reference spends nothing and blacklists only its source and scope', async t => {
  let models = 0;
  const providers = [fakeProvider('oss', { reference: async () => { throw new Error('bad known answer'); } }), fakeProvider('aa')];
  const f = await fixture(t, providers, { runner: async () => { models++; return passed(); } });
  await assert.rejects(f.engine.start(f.input), /oss: .*bad known answer/s);
  const experiment = (await f.engine.list())[0];
  assert.equal(models, 0); assert.equal(experiment.spentUsd, 0); assert.ok(experiment.runs.every(run => run.state === 'stopped'));
  assert.deepEqual([...f.engine.referenceFailures.keys()], ['oss:scope-oss']);
  const tasks = await f.engine.sample({ source: 'oss', repos: ['fixture'], size: 3 });
  assert.equal(tasks.length, 2); assert.ok(tasks.every(task => task.id !== providers[0].tasks[0].id));
});

test('a fatal reference cancels other reference lanes without launching models', { timeout: 10000 }, async t => {
  const gate = deferred(); let entered = 0, cancelled = false;
  const f = await fixture(t, [fakeProvider('oss'), fakeProvider('aa')], { referenceRunner: async options => {
    if (++entered === 2) gate.resolve(); await gate.promise;
    if (options.provider.id === 'oss') throw Object.assign(new Error('fatal fixture'), { fatal: true });
    await new Promise(resolve => { options.signal.addEventListener('abort', resolve, { once: true }); if (options.signal.aborted) resolve(); });
    cancelled = true; throw new Error('reference cancelled');
  }, runner: () => assert.fail('no model before all references') });
  await assert.rejects(f.engine.start(f.input), /fatal fixture/); assert.equal(cancelled, true);
  assert.equal((await f.engine.list())[0].state, 'error');
});

test('throwing describe becomes unavailable and forged ids, duplicate sources and over 600 runs are rejected', async t => {
  const provider = fakeProvider('oss'), f = await fixture(t, [provider]);
  await assert.rejects(f.engine.start({ ...f.input, selections: [{ ...selection(provider), tasks: [{ id: 'oss-forged' }] }] }), /forged/);
  await assert.rejects(f.engine.start({ ...f.input, selections: [{ ...selection(provider), tasks: [{ id: '../escape' }] }] }), /任务/);
  assert.throws(() => experimentInput({ ...f.input, selections: [selection(provider), selection(provider)] }));
  const many = fakeProvider('aa', { size: 66 });
  assert.throws(() => experimentInput({ ...f.input, selections: [selection(many, 66)],
    arms: ['orchestrated', 'opus', 'sol', 'sonnet'], repeats: 3 }), /600/);
  provider.describe = async () => { throw new Error('private fixture detail'); };
  const info = (await f.engine.sources())[0];
  assert.equal(info.available, false); assert.doesNotMatch(info.reason, /private/);
  await assert.rejects(f.engine.start(f.input));
});

test('legacy experiments load as history lanes and preserve unknown scores and the 600-run storage limit', async t => {
  const root = await temporary(t), store = new LabStore(root), id = randomUUID();
  const old = { id, source: 'history', createdAt: 1, state: 'done', projectId: 'p', projectName: 'Old', budgetUsd: 3, spentUsd: 1,
    tasks: [{ id: 'a'.repeat(40) }], runs: [{ state: 'passed', testsPassed: 2, testsTotal: 2 }, { state: 'error', testsPassed: null, testsTotal: null }] };
  await store.save(old);
  const loaded = (await store.list())[0];
  assert.deepEqual(loaded.sources, ['history']); assert.equal(loaded.source, undefined);
  assert.equal(loaded.lanes[0].spentUsd, 1); assert.equal(loaded.tasks[0].source, 'history');
  assert.deepEqual(loaded.runs.map(run => run.score), [1, null]);
  await store.save({ ...old, runs: Array.from({ length: 600 }, () => old.runs[0]) }); assert.equal((await store.list()).length, 1);
  await store.save({ ...old, runs: Array.from({ length: 601 }, () => old.runs[0]) }); assert.equal((await store.list()).length, 0);
});

test('AA keys use encrypted storage, never enter experiments, clear correctly and fail closed without encryption', async t => {
  const key = 'synthetic-aa-fixture', storage = { isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from([...Buffer.from(value)].map(byte => byte ^ 173)),
    decryptString: value => Buffer.from([...value].map(byte => byte ^ 173)).toString() };
  const provider = fakeProvider('aa'), f = await fixture(t, [provider], { safeStorage: storage });
  assert.equal(await f.engine.aaKey(key), true); assert.equal((await f.engine.sources())[0].keyStored, true);
  assert.equal(f.engine.context('oss').credential(), null); assert.equal(f.engine.context('aa').credential(), key);
  assert.equal((await fs.readFile(path.join(f.root, 'lab/secrets/aa.key'))).includes(key), false);
  await f.engine.start(f.input); await f.engine.active.done;
  assert.equal(JSON.stringify(await f.engine.list()).includes(key), false);
  const reopened = new LabEngine({ userData: f.root, safeStorage: storage, providers: [provider] });
  await reopened.ready; assert.equal(reopened.context('aa').credential(), key); reopened.close();
  assert.equal(await f.engine.aaKey(null), false); assert.equal((await f.engine.sources())[0].keyStored, false);
  assert.equal(await fs.stat(path.join(f.root, 'lab/secrets/aa.key')).catch(() => null), null);
  storage.isEncryptionAvailable = () => false; await assert.rejects(f.engine.aaKey(key), /安全密钥存储/);
});

test('a fresh profile loads without asking the operating system for encryption availability', async t => {
  let probes = 0;
  const storage = { isEncryptionAvailable() { probes++; throw new Error('fixture locked keychain'); },
    decryptString() { assert.fail('there is no encrypted key to decrypt'); } };
  const f = await fixture(t, [fakeProvider('history')], { safeStorage: storage });
  assert.deepEqual(await f.engine.list(), []); assert.equal(probes, 0);
  const secret = path.join(f.engine.store.directory, 'secrets/aa.key');
  await fs.mkdir(path.dirname(secret), { recursive: true }); await fs.writeFile(secret, 'synthetic encrypted bytes');
  assert.equal(await f.engine.store.readAaKey(storage), null); assert.equal(probes, 1);
  assert.equal(await fs.readFile(secret, 'utf8'), 'synthetic encrypted bytes');
});

function fakeGet(responses, calls) {
  return (url, options, callback) => {
    calls.push({ url: String(url), headers: { ...options.headers } });
    const next = responses.shift(); assert.ok(next, 'unexpected network request');
    const request = new EventEmitter(); request.destroy = error => { request.emit('error', error); request.emit('close'); };
    queueMicrotask(() => {
      const reply = Readable.from([Buffer.from(next.body || '')]);
      reply.statusCode = next.status ?? 200; reply.headers = next.headers || {};
      reply.once('close', () => request.emit('close')); callback(reply);
    });
    return request;
  };
}

test('downloads verify hashes atomically, restrict every redirect and enforce size limits', async t => {
  const root = await temporary(t), target = path.join(root, 'payload'), calls = [];
  await fs.writeFile(target, 'previous');
  const hash = createHash('sha256').update('verified').digest('hex');
  const host = tools.createTools({ get: fakeGet([
    { body: 'wrong' }, { body: 'verified' }, { status: 302, headers: { location: 'https://foreign.invalid/code' } }, { body: 'too big' },
  ], calls) });
  const options = { hosts: ['allowed.invalid'], sha256: hash };
  await assert.rejects(host.download('https://allowed.invalid/code', target, options), /校验/);
  assert.equal(await fs.readFile(target, 'utf8'), 'previous');
  assert.deepEqual(await host.download('https://allowed.invalid/code', target, options), { bytes: 8 });
  await assert.rejects(host.download('https://allowed.invalid/code', target, options), /允许范围/);
  await assert.rejects(host.download('https://allowed.invalid/code', target, { ...options, maxBytes: 2 }), /大小限制/);
  await assert.rejects(host.download('http://allowed.invalid/code', target, options));
  await assert.rejects(host.download('https://user:password@allowed.invalid/code', target, options));
  assert.equal(calls.length, 4); assert.deepEqual(await fs.readdir(root), ['payload']);
});

test('pinned Git downloads keep protocol restrictions, isolated homes and disabled credentials', async t => {
  const root = await temporary(t), calls = [], commit = 'a'.repeat(40);
  const host = tools.createTools({ command: async (file, args, options) => {
    calls.push({ file, args, options });
    return { code: 0, stdout: args.includes('--is-bare-repository') ? 'true' : args.includes('--verify') ? commit : '', stderr: '' };
  } });
  await host.fetchCommit('https://github.com/fixture/repo.git', commit, path.join(root, 'repo.git'), { hosts: ['github.com'] });
  const fetch = calls.find(call => call.args.includes('fetch'));
  assert.equal(fetch.options.env.GIT_ALLOW_PROTOCOL, 'https'); assert.equal(fetch.options.env.GIT_CONFIG_NOSYSTEM, '1');
  assert.ok(fetch.args.includes('credential.helper=')); assert.ok(fetch.args.includes('http.followRedirects=false'));
  assert.ok(fetch.args.includes(commit)); assert.equal(fetch.options.env.CODEX_HOME, undefined);
  assert.notEqual(fetch.options.env.HOME, os.homedir());
  await assert.rejects(async () => host.fetchCommit('file:///fixture', commit, path.join(root, 'bad'), { hosts: ['github.com'] }));
});

test('AA score requests use header-only authentication, paginate and return sanitized per-model values', async () => {
  const key = 'synthetic-aa-key', calls = [];
  const host = tools.createTools({ now: () => '2026-01-01', get: fakeGet([
    { body: JSON.stringify({ tier: 'pro', data: [{ slug: 'gpt-6.1-sol', evaluations: { terminalbench_v4_0: 0.7 }, ignored: key }], pagination: { has_more: true } }) },
    { body: JSON.stringify({ tier: 'pro', data: [{ slug: 'unknown', evaluations: { terminalbench_v4_0: null } }] }) },
    { status: 302, headers: { location: 'https://foreign.invalid' } },
  ], calls) });
  const result = await host.aaScores({ key, benchmark: 'terminal-bench-4' });
  assert.deepEqual(result, { asOf: '2026-01-01', values: { 'gpt-6.1-sol': 0.7 } });
  assert.ok(calls.every(call => !call.url.includes(key) && call.headers['x-api-key'] === key));
  await assert.rejects(host.aaScores({ key, benchmark: 'terminal-bench-4' }), error => !error.message.includes(key));
  assert.equal(calls.length, 3); assert.equal(JSON.stringify(result).includes(key), false);
});

test('Docker uses pinned images without mounts, bounds exec, preserves task exits and removes only owned containers', async t => {
  const root = await temporary(t), id = 'c'.repeat(64), calls = [], installId = randomUUID();
  const host = tools.createTools({ installId, command: async (file, args, options) => {
    calls.push({ file, args, options });
    return { code: args[0] === 'exec' ? 1 : 0, stdout: args[0] === 'create' ? id : '', stderr: '' };
  } });
  const run = host.docker.forRun(randomUUID());
  const config = { image: 'example/task', digest: 'sha256:' + 'd'.repeat(64), workdir: '/workspace', network: 'none' };
  assert.equal(await run.create(config), id);
  const create = calls.find(call => call.args[0] === 'create');
  assert.ok(create.args.includes(config.image + '@' + config.digest));
  assert.ok(!create.args.some(arg => /mount|volume|privileged|docker.sock/.test(arg)));
  assert.equal(create.args[create.args.indexOf('--network') + 1], 'none');
  assert.ok(create.args.includes('--rm')); assert.ok(create.args.includes('--cap-drop=ALL'));
  assert.ok(create.args.includes('--security-opt=no-new-privileges:true'));
  assert.ok(create.args.includes('agentrix.lab.install=' + installId));
  assert.equal(create.options.env.DOCKER_HOST, undefined);
  assert.equal((await host.docker.exec(id, ['sh', '-c', 'exit 1'], { stdin: 'fixture' })).code, 1);
  await fs.writeFile(path.join(root, 'test.sh'), 'fixture');
  await host.docker.copyTo(id, path.join(root, 'test.sh'), '/tests/test.sh');
  await assert.rejects(host.docker.exec(id, ['true'], { timeoutMs: 0 }));
  await assert.rejects(host.docker.copyTo(id, path.join(root, 'test.sh'), '/../escape'));
  await run.remove(id); await run.close(); await assert.rejects(host.docker.exec(id, ['true']));
  const unavailable = tools.createTools({ installId, command: async () => { throw new Error('missing Docker'); } });
  assert.equal((await unavailable.docker.probe()).available, false);
  await assert.rejects(unavailable.docker.forRun(randomUUID()).create(config), error => error.infrastructure === true);
});

test('generic references and the runner use the provider context and bind the broker to its container', async t => {
  const root = await temporary(t), id = randomUUID(), controller = new AbortController(), events = [];
  const provider = fakeProvider('aa', {
    prepare: async (_task, _scope, ctx) => {
      const cwd = path.join(ctx.workspaceRoot, 'task'); await fs.mkdir(cwd);
      await fs.writeFile(path.join(cwd, 'value.py'), 'value = 0\n');
      return { ...await tools.files(cwd, { signal: ctx.signal }), container: { id: 'c'.repeat(64) } };
    },
    grade: async (_task, _scope, ctx) => {
      assert.equal(ctx.reference.proof, 'reference'); events.push('grade');
      return { testsPassed: null, testsTotal: null, score: 1, passed: true, evidence: null };
    },
  });
  const scopedTools = { ...tools, docker: {
    async exec(container, argv) { events.push(['exec', container, argv]); return { code: 0, stdout: 'container', stderr: '' }; },
    async remove(container) { events.push(['remove', container]); },
  } };
  const context = { tools: scopedTools, getProjects: () => [], credential: () => null, platform: process.platform,
    t: text => text, signal: controller.signal, cacheDirectory: path.join(root, 'cache') };
  const sessionFactory = settings => ({ ...settings, controller: new AbortController(), nodePath: process.execPath,
    privateDirectory: path.join(root, 'private'), publicHelper: '/fake-helper', control: path.join(settings.workspaceRoot, 'control'),
    async start() { await fs.mkdir(this.control, { recursive: true }); },
    async broker(handler) { this.handler = handler; events.push('broker'); },
    async root(args, options) {
      await this.handler({ argv: ['pwd'], timeoutMs: 1000 }); this.modelStarted = true;
      await fs.writeFile(args[args.indexOf('--out') + 1], 'fixture answer');
      const stdout = '[dispatch] ended fixture claude model claude-sonnet-5-5'; options.onLine(stdout);
      return { code: 0, stdout, stderr: '' };
    },
    async close() { events.push('closed'); },
  });
  provider.reference = async (_task, _scope, ctx) => {
    assert.equal(ctx.reference, null); assert.equal(ctx.session.nodePath, process.execPath);
    return { diffFiles: ['value.py'], proof: 'reference' };
  };
  const common = { provider, scope: {}, context, signal: controller.signal, sessionFactory, socketDirectory: root,
    env: { ...cleanEnvironment(), CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude') },
    task: provider.tasks[0], prices: { models: {} } };
  const reference = await validateReference(common);
  const result = await runTask({ ...common, reference, run: { id, arm: 'sonnet' }, directory: path.join(root, 'runs', id) });
  assert.equal(result.state, 'passed', JSON.stringify(result)); assert.equal(result.score, 1); assert.equal(result.testsTotal, null);
  assert.ok(events.indexOf('broker') < events.indexOf('grade'));
  assert.deepEqual(events.find(event => Array.isArray(event) && event[0] === 'exec'), ['exec', 'c'.repeat(64), ['pwd']]);
  assert.equal(events.filter(event => Array.isArray(event) && event[0] === 'remove').length, 1);
  assert.equal(await fs.stat(path.join(root, 'runs', id, 'workspaces')).catch(() => null), null);
  provider.grade = async () => ({ passed: true, score: null, testsTotal: null, testsPassed: null, evidence: null });
  const invalidId = randomUUID();
  const invalid = await runTask({ ...common, reference, run: { id: invalidId, arm: 'sonnet' }, directory: path.join(root, 'runs', invalidId) });
  assert.equal(invalid.state, 'error'); assert.match(invalid.error, /评分结果/);
});

test('the history provider conforms and restores its real Node tests over an isolated Git snapshot', { timeout: 45000 }, async t => {
  const root = await temporary(t), projectPath = path.join(root, 'project'), cache = path.join(root, 'cache');
  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true }); await fs.mkdir(path.join(projectPath, 'tests'));
  await fs.mkdir(cache); await fs.mkdir(path.join(root, 'home'));
  const env = { ...cleanEnvironment(), HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), GIT_ALLOW_PROTOCOL: 'file' };
  const git = async (...args) => (await promisify(execFile)('git', ['-c', 'user.name=Lab fixture', '-c', 'user.email=lab@example.invalid',
    ...args], { cwd: projectPath, env, windowsHide: true, timeout: 5000, signal: t.signal })).stdout.trim();
  await git('init'); await fs.writeFile(path.join(projectPath, 'src/value.cjs'), 'module.exports = 0;\n');
  const testFile = expected => "const {test}=require('node:test'); const assert=require('node:assert/strict');\n" +
    "test('value',()=>assert.equal(require('../src/value.cjs')," + expected + "));\n";
  await fs.writeFile(path.join(projectPath, 'tests/value.test.cjs'), testFile(0));
  await git('add', '.'); await git('commit', '-m', 'Starting fixture');
  await fs.writeFile(path.join(projectPath, 'src/value.cjs'), 'module.exports = 1;\n');
  await fs.writeFile(path.join(projectPath, 'tests/value.test.cjs'), testFile(1));
  await git('add', '.'); await git('commit', '-m', 'Fix fixture calculation');
  const provider = createHistorySource(), project = { id: 'fixture', name: 'Fixture', path: projectPath };
  const ctx = { tools, getProjects: () => [project], t: text => text, signal: t.signal,
    cacheDirectory: cache, platform: process.platform, credential: () => null };
  const { canonical } = await conformance(provider, { query: { source: 'history', projectId: project.id, size: 1, preferShortComplex: false },
    selection: { source: 'history', projectId: project.id }, ctx });
  const [task] = canonical.tasks, before = await git('status', '--porcelain');
  const context = async name => {
    const workspaceRoot = path.join(root, name, 'workspaces'), artifactDirectory = path.join(root, name, 'artifacts');
    await fs.mkdir(workspaceRoot, { recursive: true }); await fs.mkdir(artifactDirectory);
    const session = fakeSession();
    session.execute = function(file, args, options) {
      this.calls.push({ file, args, network: options.network ?? false });
      return require('../electron/features/lab/process.cjs').command(file, args, { ...options, env });
    };
    return { ...ctx, workspaceRoot, artifactDirectory, session, testTimeoutMs: 120000, reference: null };
  };
  const referenceCtx = await context('reference'), reference = await provider.reference(task, canonical.scope, referenceCtx);
  assert.equal(reference.total, 1); assert.deepEqual(reference.diffFiles, ['tests/value.test.cjs']);
  const runCtx = { ...await context('run'), reference }, workspace = await provider.prepare(task, canonical.scope, runCtx);
  assert.equal(await fs.readFile(path.join(workspace.cwd, 'src/value.cjs'), 'utf8'), 'module.exports = 0;\n');
  const failed = await provider.grade(task, canonical.scope, runCtx); assert.equal(failed.passed, false);
  await fs.writeFile(path.join(workspace.cwd, 'src/value.cjs'), 'module.exports = 1;\n');
  assert.equal((await provider.grade(task, canonical.scope, runCtx)).passed, true);
  assert.equal(await git('status', '--porcelain'), before);
  assert.ok(runCtx.session.calls.every(call => call.network === false));
});

test('Docker exec timeouts reap the container and recovery verifies its lab label before removal', async () => {
  const id = 'e'.repeat(64), calls = [], installId = randomUUID();
  const host = tools.createTools({ installId, command: async (_file, args) => {
    calls.push(args);
    if (args[0] === 'exec') throw new Error('timeout');
    return { code: 0, stdout: args[0] === 'create' ? id : '', stderr: '' };
  } });
  const run = host.docker.forRun(randomUUID());
  await run.create({ image: 'fixture/task', digest: 'sha256:' + 'f'.repeat(64), workdir: '/app', network: 'none' });
  await assert.rejects(host.docker.exec(id, ['sleep', '999']), error => error.infrastructure === true);
  assert.deepEqual(calls.at(-1), ['rm', '--force', id]);
  const removedCalls = calls.length; await host.docker.remove(id); assert.equal(calls.length, removedCalls);
  await run.close();
  const recovered = tools.createTools({ installId, command: async (_file, args) => {
    calls.push(args); return { code: 0, stdout: args[0] === 'inspect' ? JSON.stringify({ 'agentrix.lab.install': installId }) : '', stderr: '' };
  } });
  await recovered.docker.remove(id); assert.equal(calls.at(-2)[0], 'inspect'); assert.equal(calls.at(-1)[0], 'rm');
  const foreign = tools.createTools({ installId, command: async () => ({ code: 0, stdout: JSON.stringify({ 'agentrix.lab.install': randomUUID() }), stderr: '' }) });
  await assert.rejects(foreign.docker.remove(id), /无效/);
  await assert.rejects(foreign.docker.removeRecorded(id), /无效/);
  const legacy = tools.createTools({ installId, command: async (_file, args) => {
    calls.push(args); return { code: 0, stdout: JSON.stringify({ 'agentrix.lab': 'true' }), stderr: '' };
  } });
  await assert.rejects(legacy.docker.remove(id), /无效/);
  await legacy.docker.removeRecorded(id); assert.deepEqual(calls.at(-1), ['rm', '--force', id]);
});

test('background startup cleanup reaps a persisted run container without needing a live session', async t => {
  const root = await temporary(t), store = new LabStore(root), id = randomUUID(), runId = randomUUID(), removed = [];
  await store.save({ id, createdAt: 1, source: 'history', state: 'done', tasks: [], runs: [{ id: runId, state: 'error' }] });
  const directory = path.join(store.folder(id), 'runs', runId); await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'container.json'), JSON.stringify({ id: 'a'.repeat(64) }));
  const engine = new LabEngine({ userData: root, providers: [], sourceTools: { ...tools, docker: { async remove(id) { removed.push(id); } } } });
  await engine.ready; await engine.cleanupTail; engine.close();
  assert.deepEqual(removed, ['a'.repeat(64)]);
  assert.equal(await fs.stat(path.join(directory, 'container.json')).catch(() => null), null);
});

function fakeDaemon() {
  const daemon = { reachable: true, containers: new Map(), calls: [], removed: [], refused: new Set(), extras: [] };
  let serial = 0;
  daemon.add = labels => {
    const id = (++serial).toString(16).padStart(64, '0');
    daemon.containers.set(id, { labels, started: false }); return id;
  };
  daemon.command = async (_file, args, options) => {
    daemon.calls.push({ args, options });
    const result = (stdout = '', code = 0, stderr = '') => ({ stdout, code, stderr });
    if (!daemon.reachable) return result('', 1, 'Cannot connect to the Docker daemon');
    if (args[0] === 'info') return result('fixture-version');
    if (args[0] === 'create') {
      const labels = Object.fromEntries(args.flatMap((arg, index) => arg === '--label' ? [args[index + 1].split('=')] : []));
      const id = daemon.add(labels); await daemon.onCreate?.(id); return result(id);
    }
    if (args[0] === 'ps') {
      const install = args.at(-1).split('=').at(-1);
      return result([...daemon.containers].filter(([, value]) => value.labels['agentrix.lab.install'] === install)
        .map(([id]) => id).concat(daemon.extras).join('\n'));
    }
    const id = args.at(-1), container = daemon.containers.get(id);
    if (!container) return result('', 1, 'No such container');
    if (args[0] === 'inspect') return result(JSON.stringify(container.labels));
    if (args[0] === 'start') { container.started = true; return result(id); }
    if (args[0] === 'rm') {
      if (daemon.refused.has(id)) return result('', 1, 'fixture removal failure');
      daemon.containers.delete(id); daemon.removed.push(id); return result(id);
    }
    throw new Error('Unexpected fake Docker command: ' + args[0]);
  };
  return daemon;
}

for (const failure of ['missing binary', 'stopped daemon']) test('AA keeps its provider reason and throttles empty recovery with a ' + failure, async t => {
  const root = await temporary(t), daemon = fakeDaemon(), store = new LabStore(root);
  let clock = 1000, recoveries = 0;
  if (failure === 'stopped daemon') await store.save({ id: randomUUID(), createdAt: 1, state: 'done', sources: ['aa'],
    tasks: [], lanes: [{ source: 'aa', state: 'done' }], runs: [{ id: randomUUID(), source: 'aa', state: 'passed' }] });
  daemon.reachable = false;
  const command = failure === 'missing binary' ? async (_file, args) => {
    daemon.calls.push({ args }); throw Object.assign(new Error('fixture missing binary'), { code: 'ENOENT' });
  } : daemon.command;
  const engine = new LabEngine({ userData: root, providers: [createAaSource()], now: () => clock,
    sourceTools: { ...tools, ...tools.createTools({ command }) }, recovery: async () => { recoveries++; return []; } });
  try {
    await engine.ready; await engine.cleanupTail;
    for (let index = 0; index < 3; index++) {
      const [info] = await engine.sources();
      assert.equal(info.available, false); assert.equal(info.reason, 'Docker 不可用，请先安装并启动 Docker。');
      await engine.cleanupTail;
    }
    assert.equal(daemon.calls.filter(call => call.args[0] === 'ps').length, 1);
    assert.equal(recoveries, 1);
    clock += 30001;
    assert.equal((await engine.sources())[0].reason, 'Docker 不可用，请先安装并启动 Docker。');
    await engine.cleanupTail;
    assert.equal(daemon.calls.filter(call => call.args[0] === 'ps').length, 2); assert.equal(recoveries, 2);
  } finally { await engine.cleanupTail; engine.close(); }
});

test('an identified orphan keeps the cleanup reason even without a run record, until its later sweep succeeds', async t => {
  const root = await temporary(t), installId = await new LabStore(root).installId(), daemon = fakeDaemon();
  const orphan = daemon.add({ 'agentrix.lab.install': installId, 'agentrix.lab.run': randomUUID() });
  daemon.refused.add(orphan);
  const engine = new LabEngine({ userData: root, providers: [createAaSource()],
    sourceTools: { ...tools, ...tools.createTools({ command: daemon.command }) } });
  try {
    await engine.ready; await engine.cleanupTail;
    assert.deepEqual(await engine.list(), []);
    assert.match((await engine.sources())[0].reason, /上次实验的容器尚未清理完成/);
    daemon.reachable = false;
    assert.match((await engine.sources())[0].reason, /上次实验的容器尚未清理完成/);
    daemon.reachable = true; daemon.refused.clear();
    await engine.retryCleanup(true, true);
    assert.equal((await engine.sources())[0].available, true); assert.ok(daemon.removed.includes(orphan));
  } finally { await engine.cleanupTail; engine.close(); }
});

for (const phase of ['Docker sweep', 'lease recovery']) test('slow background ' + phase + ' permits listing, source descriptions and new history and OSS runs', { timeout: 10000 }, async t => {
  const root = await temporary(t), store = new LabStore(root), id = randomUUID(), runId = randomUUID();
  const directory = path.join(store.folder(id), 'runs', runId), lease = path.join(store.directory, 'private', runId);
  await fs.mkdir(path.join(directory, 'workspaces'), { recursive: true }); await fs.mkdir(lease, { recursive: true });
  await fs.writeFile(path.join(directory, 'container.json'), JSON.stringify({ id: 'a'.repeat(64) }));
  await fs.writeFile(path.join(lease, 'manifest.json'), JSON.stringify({ runId, directory }));
  await store.save({ id, createdAt: 1, state: 'running', sources: ['aa'], tasks: [],
    lanes: [{ source: 'aa', state: 'running' }], runs: [{ id: runId, source: 'aa', state: 'running' }] });
  if (process.platform === 'win32') t.mock.method(require('../electron/features/lab/sandbox-win32.cjs'), 'killMarked', async () => {});
  const entered = deferred(), release = deferred(), model = deferred(), modelEntered = deferred(), killed = [], fresh = [];
  const wait = async action => {
    let timer;
    try { return await Promise.race([action, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('A public lab operation waited for background cleanup.')), 2000);
    })]); } finally { clearTimeout(timer); }
  };
  const pause = async () => { entered.resolve(); await release.promise; };
  const providers = ['history', 'oss', 'aa'].map(id => fakeProvider(id));
  const engine = new LabEngine({ userData: root, providers, prices: { models: {} },
    sourceTools: { ...tools, docker: { async sweep() { if (phase === 'Docker sweep') await pause(); }, async remove() {} } },
    recovery: async (root, options) => {
      if (phase === 'lease recovery') await pause();
      return recoverRuns(root, { ...options, platform: 'linux', kill: async id => killed.push(id) });
    }, referenceRunner: async () => ({ diffFiles: [] }), runner: async options => {
      const workspace = path.join(options.directory, 'workspaces');
      const privateDirectory = path.join(store.directory, 'private', options.run.id);
      await fs.mkdir(workspace, { recursive: true }); await fs.mkdir(privateDirectory, { recursive: true });
      await fs.writeFile(path.join(workspace, 'live'), 'live');
      await fs.writeFile(path.join(privateDirectory, 'manifest.json'), JSON.stringify({ runId: options.run.id, directory: options.directory }));
      fresh.push({ id: options.run.id, workspace, privateDirectory });
      if (options.run.source === 'oss') { modelEntered.resolve(); await model.promise; }
      return passed();
    } });
  try {
    const [experiments, infos] = await wait(Promise.all([engine.list(), engine.sources()]));
    await wait(entered.promise);
    assert.equal(experiments[0].state, 'stopped');
    assert.deepEqual(infos.map(info => info.available), [true, true, false]);
    const input = provider => ({ selections: [selection(provider)], arms: ['sol', 'sonnet'], repeats: 1, budgetUsd: 10 });
    await wait(engine.start(input(providers[0]))); await wait(engine.active.done);
    await wait(engine.start(input(providers[1]))); await wait(modelEntered.promise);
    let changed = 0; engine.subscribe(() => changed++);
    release.resolve(); await wait(engine.cleanupTail);
    assert.ok(changed > 0); assert.ok(engine.active);
    assert.equal(await fs.stat(path.join(directory, 'container.json')).catch(() => null), null);
    assert.equal(await fs.stat(path.join(directory, 'workspaces')).catch(() => null), null);
    for (const run of fresh) {
      assert.notEqual(run.id, runId); assert.equal(killed.includes(run.id), false);
      assert.equal(await fs.readFile(path.join(run.workspace, 'live'), 'utf8'), 'live');
      assert.ok(await fs.stat(path.join(run.privateDirectory, 'manifest.json')));
    }
    assert.ok(killed.includes(runId));
  } finally {
    release.resolve(); model.resolve(); await engine.ready.catch(() => {}); await engine.cleanupTail;
    await engine.active?.done; engine.close();
  }
});

test('the installation label is durably published once, shared by concurrent stores and different for another installation', async t => {
  const root = await temporary(t), stores = Array.from({ length: 4 }, () => new LabStore(root));
  const ids = await Promise.all(stores.map(store => store.installId()));
  assert.equal(new Set(ids).size, 1); assert.match(ids[0], /^[a-f0-9-]{36}$/);
  assert.equal(await new LabStore(root).installId(), ids[0]);
  assert.equal(await fs.readFile(path.join(root, 'lab/install-id'), 'utf8'), ids[0]);
  assert.notEqual(await new LabStore(path.join(root, 'another')).installId(), ids[0]);
  assert.deepEqual(await fs.readdir(path.join(root, 'lab')), ['install-id']);
});

test('a failed startup Docker inspection keeps its records, stops the experiment and permits history and OSS before a later AA retry', async t => {
  const root = await temporary(t), store = new LabStore(root), installId = await store.installId(), daemon = fakeDaemon();
  const id = randomUUID(), runId = randomUUID(), container = daemon.add({ 'agentrix.lab': 'true' });
  const directory = path.join(store.folder(id), 'runs', runId), record = path.join(directory, 'container.json');
  await fs.mkdir(path.join(directory, 'workspaces'), { recursive: true });
  await fs.writeFile(record, JSON.stringify({ id: container }));
  await store.save({ id, createdAt: 1, sources: ['aa'], tasks: [], state: 'running',
    lanes: [{ source: 'aa', state: 'running' }], runs: [{ id: runId, source: 'aa', state: 'running', activeModel: 'sol' }] });
  if (process.platform === 'win32') t.mock.method(require('../electron/features/lab/sandbox-win32.cjs'), 'killMarked', async () => {});
  daemon.reachable = false;
  const providers = ['history', 'oss', 'aa'].map(id => fakeProvider(id));
  const engine = new LabEngine({ userData: root, providers, sourceTools: { ...tools, ...tools.createTools({ command: daemon.command }) },
    prices: { models: {} }, runner: async () => passed(), referenceRunner: async () => ({ diffFiles: [] }) });
  t.after(() => engine.close());
  await engine.ready; await engine.cleanupTail;
  const [stopped] = await engine.list();
  assert.equal(stopped.state, 'stopped'); assert.equal(stopped.runs[0].state, 'stopped');
  assert.equal(stopped.runs[0].activeModel, null); assert.match(stopped.runs[0].error, /清理.*Docker/);
  assert.equal((await store.list())[0].state, 'stopped');
  assert.ok(await fs.stat(record)); assert.ok(await fs.stat(path.join(directory, 'workspaces')));
  assert.equal((await store.readCleanup()).length, 1);
  assert.ok(daemon.calls.some(call => call.args[0] === 'inspect'));
  const infos = await engine.sources();
  assert.deepEqual(infos.map(info => info.available), [true, true, false]); assert.match(infos[2].reason, /启动 Docker.*重试/);
  const input = provider => ({ selections: [selection(provider)], arms: ['sol', 'sonnet'], repeats: 1, budgetUsd: 10 });
  for (const provider of providers.slice(0, 2)) {
    await engine.start(input(provider)); await engine.active.done;
    assert.equal((await engine.list())[0].state, 'done');
  }
  await assert.rejects(engine.start(input(providers[2])), /清理.*Docker/);
  assert.ok(await fs.stat(record)); assert.equal((await store.readCleanup()).length, 1);
  daemon.reachable = true;
  await engine.start(input(providers[2])); await engine.active.done;
  assert.equal(daemon.containers.has(container), false); assert.ok(daemon.removed.includes(container));
  assert.equal(await fs.stat(record).catch(() => null), null);
  assert.equal(await fs.stat(path.join(directory, 'workspaces')).catch(() => null), null);
  assert.deepEqual(await store.readCleanup(), []); assert.equal((await engine.sources())[2].available, true);
  const recovered = (await engine.list()).find(experiment => experiment.id === id);
  assert.equal(recovered.runs[0].error, null); assert.equal(recovered.lanes[0].error, null);
});

test('the labelled sweep excludes live creations and foreign installations, contains each removal failure and retries it', async t => {
  const store = new LabStore(await temporary(t)), installId = await store.installId(), daemon = fakeDaemon();
  const host = tools.createTools({ installId, command: daemon.command }), owner = randomUUID(), run = host.docker.forRun(owner);
  const barrier = deferred(), creating = deferred();
  daemon.onCreate = async id => { creating.resolve(id); await barrier.promise; };
  const creation = run.create({ image: 'fixture/task', digest: 'sha256:' + 'f'.repeat(64), workdir: '/app', network: 'none' });
  const liveId = await creating.promise;
  const stale = daemon.add({ 'agentrix.lab.install': installId, 'agentrix.lab.run': randomUUID() });
  const failed = daemon.add({ 'agentrix.lab.install': installId, 'agentrix.lab.run': randomUUID() });
  const foreign = daemon.add({ 'agentrix.lab.install': randomUUID() }), user = daemon.add({ 'agentrix.lab': 'true' });
  daemon.extras = [foreign, user]; daemon.refused.add(failed);
  await assert.rejects(host.docker.sweep(), error => error.failures.length === 1 && error.failures[0].id === failed);
  assert.deepEqual(daemon.removed, [stale]); assert.ok(daemon.containers.has(liveId));
  assert.ok(daemon.containers.has(foreign)); assert.ok(daemon.containers.has(user));
  barrier.resolve(); assert.equal(await creation, liveId);
  await assert.rejects(host.docker.remove(liveId), /正在运行/);
  await assert.rejects(host.docker.remove(foreign), /无效/);
  daemon.refused.clear(); await host.docker.sweep();
  assert.equal(daemon.containers.has(failed), false); assert.equal(daemon.containers.has(liveId), true);
  await run.close(); assert.equal(daemon.containers.has(liveId), false);
});

test('the first AA start sweeps again after a successful startup, before reference or model execution', async t => {
  const daemon = fakeDaemon(), provider = fakeProvider('aa');
  const f = await fixture(t, [provider], { sourceTools: { ...tools, ...tools.createTools({ command: daemon.command }) },
    referenceRunner: async () => { assert.equal(daemon.containers.size, 0); return { diffFiles: [] }; } });
  await f.engine.ready;
  const installId = await f.engine.store.installId();
  const orphan = daemon.add({ 'agentrix.lab.install': installId, 'agentrix.lab.run': randomUUID() });
  await f.engine.start(f.input); await f.engine.active.done;
  assert.ok(daemon.removed.includes(orphan)); assert.equal(daemon.calls.filter(call => call.args[0] === 'ps').length, 2);
});

test('failed recovery keeps the worktree retry list across a stopped experiment and the next engine launch', async t => {
  const root = await temporary(t), store = new LabStore(root), id = randomUUID(), runId = randomUUID();
  const directory = path.join(store.folder(id), 'runs', runId);
  await fs.mkdir(path.join(directory, 'workspaces'), { recursive: true });
  await store.save({ id, createdAt: 1, state: 'running', tasks: [], runs: [{ id: runId, state: 'running' }] });
  const sourceTools = { ...tools, docker: { async sweep() {}, async remove() {} } };
  const providers = ['history', 'oss', 'aa'].map(id => fakeProvider(id));
  const first = new LabEngine({ userData: root, providers, sourceTools, prices: { models: {} },
    runner: async () => passed(), referenceRunner: async () => ({ diffFiles: [] }),
    recovery: async () => { throw new Error('fixture recovery timeout'); } });
  assert.equal((await first.list())[0].state, 'stopped');
  await first.cleanupTail;
  assert.deepEqual((await first.sources()).map(info => info.available), [true, true, false]);
  for (const provider of providers.slice(0, 2)) {
    await first.start({ selections: [selection(provider)], arms: ['sol', 'sonnet'], repeats: 1, budgetUsd: 10 });
    await first.active.done; assert.equal((await first.list())[0].state, 'done');
  }
  first.close();
  assert.equal((await store.readCleanup()).length, 1); assert.ok(await fs.stat(path.join(directory, 'workspaces')));
  if (process.platform === 'win32') t.mock.method(require('../electron/features/lab/sandbox-win32.cjs'), 'killMarked', async () => {});
  const next = new LabEngine({ userData: root, providers: [], sourceTools });
  await next.ready; await next.cleanupTail; next.close();
  assert.equal((await next.list()).find(experiment => experiment.id === id).state, 'stopped'); assert.deepEqual(await store.readCleanup(), []);
  assert.equal(await fs.stat(path.join(directory, 'workspaces')).catch(() => null), null);
});

test('an unwritable cleanup journal leaves listing and history and OSS available and is retried before AA use', async t => {
  const root = await temporary(t), store = new LabStore(root), writeCleanup = store.writeCleanup.bind(store);
  let refused = true;
  t.mock.method(store, 'writeCleanup', entries => refused ? Promise.reject(new Error('fixture journal locked')) : writeCleanup(entries));
  const providers = ['history', 'oss', 'aa'].map(id => fakeProvider(id));
  const engine = new LabEngine({ userData: root, store, providers, prices: { models: {} },
    sourceTools: { ...tools, docker: { async sweep() {}, async remove() {} } },
    runner: async () => passed(), referenceRunner: async () => ({ diffFiles: [] }) });
  t.after(() => engine.close());
  assert.deepEqual(await engine.list(), []);
  assert.deepEqual((await engine.sources()).map(info => info.available), [true, true, false]);
  const input = provider => ({ selections: [selection(provider)], arms: ['sol', 'sonnet'], repeats: 1, budgetUsd: 10 });
  for (const provider of providers.slice(0, 2)) { await engine.start(input(provider)); await engine.active.done; }
  refused = false;
  await engine.start(input(providers[2])); await engine.active.done;
  assert.equal((await engine.list())[0].state, 'done'); assert.deepEqual(await store.readCleanup(), []);
  assert.equal((await engine.sources())[2].available, true);
});

test('deleting an old experiment while another run is live never enters startup process recovery', async t => {
  let recovering = 0, hold = false;
  const entered = deferred(), finish = deferred();
  const f = await fixture(t, [fakeProvider('oss')], { recovery: async () => { recovering++; return []; },
    runner: async () => { if (hold) { entered.resolve(); await finish.promise; } return passed(); } });
  await f.engine.start(f.input); await f.engine.active.done;
  const old = (await f.engine.list())[0].id;
  hold = true; await f.engine.start(f.input); const active = f.engine.active.done;
  await entered.promise;
  const before = recovering;
  try { await f.engine.remove(old); assert.equal(recovering, before); }
  finally { finish.resolve(); await active; }
  assert.equal((await f.engine.list()).length, 1);
});

test('a data directory inside any owner project is rejected before creating or changing files', async t => {
  const project = await temporary(t), userData = path.join(project, 'forbidden-data');
  const engine = new LabEngine({ userData, getProjects: () => [{ id: 'p', name: 'Fixture', path: project }], providers: [] });
  await assert.rejects(engine.ready, /原项目之外/); engine.close();
  assert.deepEqual(await fs.readdir(project), []);
});

test('removing an experiment preserves downloaded source caches', async t => {
  const f = await fixture(t, [fakeProvider('oss')]);
  await f.engine.start(f.input); await f.engine.active.done;
  const cache = path.join(f.root, 'lab/cache/oss/pip/hash'); await fs.mkdir(cache, { recursive: true });
  await fs.writeFile(path.join(cache, 'wheel'), 'fixture wheel');
  await f.engine.remove((await f.engine.list())[0].id);
  assert.equal((await f.engine.list()).length, 0); assert.equal(await fs.readFile(path.join(cache, 'wheel'), 'utf8'), 'fixture wheel');
});
