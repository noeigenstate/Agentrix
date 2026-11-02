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
const { runTask, validateReference } = require('../electron/features/lab/runner.cjs');
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
    referenceRunner: options => options.provider.reference(options.task, options.scope, { ...options.context, reference: null }),
    runner: async () => passed(), ...options });
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
  const root = await temporary(t), id = 'c'.repeat(64), calls = [];
  const host = tools.createTools({ command: async (file, args, options) => {
    calls.push({ file, args, options });
    return { code: args[0] === 'exec' ? 1 : 0, stdout: args[0] === 'create' ? id : '', stderr: '' };
  } });
  const config = { image: 'example/task', digest: 'sha256:' + 'd'.repeat(64), workdir: '/workspace', network: 'none' };
  assert.equal(await host.docker.create(config), id);
  const create = calls.find(call => call.args[0] === 'create');
  assert.ok(create.args.includes(config.image + '@' + config.digest));
  assert.ok(!create.args.some(arg => /mount|volume|privileged|docker.sock/.test(arg)));
  assert.equal(create.args[create.args.indexOf('--network') + 1], 'none');
  assert.equal((await host.docker.exec(id, ['sh', '-c', 'exit 1'], { stdin: 'fixture' })).code, 1);
  await fs.writeFile(path.join(root, 'test.sh'), 'fixture');
  await host.docker.copyTo(id, path.join(root, 'test.sh'), '/tests/test.sh');
  await assert.rejects(host.docker.exec(id, ['true'], { timeoutMs: 0 }));
  await assert.rejects(host.docker.copyTo(id, path.join(root, 'test.sh'), '/../escape'));
  await host.docker.remove(id); await assert.rejects(host.docker.exec(id, ['true']));
  const unavailable = tools.createTools({ command: async () => { throw new Error('missing Docker'); } });
  assert.equal((await unavailable.docker.probe()).available, false);
  await assert.rejects(unavailable.docker.create(config), error => error.infrastructure === true);
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

test('the history provider conforms and restores its real Node tests over an isolated Git snapshot', async t => {
  const root = await temporary(t), projectPath = path.join(root, 'project'), cache = path.join(root, 'cache');
  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true }); await fs.mkdir(path.join(projectPath, 'tests'));
  await fs.mkdir(cache); await fs.mkdir(path.join(root, 'home'));
  const env = { ...cleanEnvironment(), HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), GIT_ALLOW_PROTOCOL: 'file' };
  const git = async (...args) => (await promisify(execFile)('git', ['-c', 'user.name=Lab fixture', '-c', 'user.email=lab@example.invalid',
    ...args], { cwd: projectPath, env, windowsHide: true })).stdout.trim();
  await git('init'); await fs.writeFile(path.join(projectPath, 'src/value.cjs'), 'module.exports = 0;\n');
  const testFile = expected => "const {test}=require('node:test'); const assert=require('node:assert/strict');\n" +
    "test('value',()=>assert.equal(require('../src/value.cjs')," + expected + "));\n";
  await fs.writeFile(path.join(projectPath, 'tests/value.test.cjs'), testFile(0));
  await git('add', '.'); await git('commit', '-m', 'Starting fixture');
  await fs.writeFile(path.join(projectPath, 'src/value.cjs'), 'module.exports = 1;\n');
  await fs.writeFile(path.join(projectPath, 'tests/value.test.cjs'), testFile(1));
  await git('add', '.'); await git('commit', '-m', 'Fix fixture calculation');
  const provider = createHistorySource(), project = { id: 'fixture', name: 'Fixture', path: projectPath };
  const ctx = { tools, getProjects: () => [project], t: text => text, signal: new AbortController().signal,
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
  const id = 'e'.repeat(64), calls = [];
  const host = tools.createTools({ command: async (_file, args) => {
    calls.push(args);
    if (args[0] === 'exec') throw new Error('timeout');
    return { code: 0, stdout: args[0] === 'create' ? id : '', stderr: '' };
  } });
  await host.docker.create({ image: 'fixture/task', digest: 'sha256:' + 'f'.repeat(64), workdir: '/app', network: 'none' });
  await assert.rejects(host.docker.exec(id, ['sleep', '999']), error => error.infrastructure === true);
  assert.deepEqual(calls.at(-1), ['rm', '--force', id]);
  const removedCalls = calls.length; await host.docker.remove(id); assert.equal(calls.length, removedCalls);
  const recovered = tools.createTools({ command: async (_file, args) => {
    calls.push(args); return { code: 0, stdout: args[0] === 'inspect' ? 'true' : '', stderr: '' };
  } });
  await recovered.docker.remove(id); assert.equal(calls.at(-2)[0], 'inspect'); assert.equal(calls.at(-1)[0], 'rm');
  const foreign = tools.createTools({ command: async () => ({ code: 0, stdout: 'false', stderr: '' }) });
  await assert.rejects(foreign.docker.remove(id), /无效/);
});

test('startup reaps a persisted run container before returning experiments without needing a live session', async t => {
  const root = await temporary(t), store = new LabStore(root), id = randomUUID(), runId = randomUUID(), removed = [];
  await store.save({ id, createdAt: 1, source: 'history', state: 'done', tasks: [], runs: [{ id: runId, state: 'error' }] });
  const directory = path.join(store.folder(id), 'runs', runId); await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'container.json'), JSON.stringify({ id: 'a'.repeat(64) }));
  const engine = new LabEngine({ userData: root, providers: [], sourceTools: { ...tools, docker: { async remove(id) { removed.push(id); } } } });
  await engine.ready; engine.close();
  assert.deepEqual(removed, ['a'.repeat(64)]);
  assert.equal(await fs.stat(path.join(directory, 'container.json')).catch(() => null), null);
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
