const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { createAaSource } = require('../electron/features/lab-aa/index.cjs');
const { reward } = require('../electron/features/lab-aa/container.cjs');
const { installWrappers } = require('../electron/features/lab-aa/wrappers.cjs');
const { conformance, fakeSession } = require('./helpers/lab-provider-conformance.cjs');
const baseTools = require('../electron/features/lab/sources/tools.cjs');
const { LabStore } = require('../electron/features/lab/store.cjs');
const fixtureData = require('./fixtures/lab-aa/task.json');
const catalog = require('../electron/features/lab-aa/manifest.json');
const digest = value => createHash('sha256').update(value).digest('hex');
const query = size => ({ source: 'aa', benchmark: 'terminal-bench-4', size });
const selection = tasks => ({ source: 'aa', benchmark: 'terminal-bench-4', tasks: tasks.map(task => ({ id: task.id })) });
const secrets = ['ORACLE_FIXTURE_SENTINEL', 'VERIFIER_FIXTURE_SENTINEL'];

beforeEach(t => {
  const unavailable = () => { throw new Error('External network is forbidden in provider tests.'); };
  t.mock.method(global, 'fetch', unavailable);
  t.mock.method(require('node:https'), 'request', unavailable);
  t.mock.method(require('node:https'), 'get', unavailable);
});

function manifest() {
  const make = item => ({
    id: 'aa-' + item, item, category: 'fixture',
    environment: { image: 'fixture/agent', digest: 'sha256:' + 'a'.repeat(64), workdir: '/app' },
    verifier: { image: 'fixture/verifier', digest: 'sha256:' + 'b'.repeat(64), workdir: '/app' },
    verifierTimeoutSec: 120, artifacts: ['/app/output.txt'], collect: [],
    files: Object.entries(fixtureData.files).map(([file, text]) => ({
      path: file, sha256: digest(text), bytes: Buffer.byteLength(text), executable: file.endsWith('.sh'),
    })),
  });
  return {
    version: 'fixture-1', benchmark: 'terminal-bench-4', upstreamVersion: '4.0.0', upstreamCount: 4,
    source: { revision: '1'.repeat(40), imagesSha256: '2'.repeat(64), repository: 'https://github.com/harbor-framework/terminal-bench', license: 'Apache-2.0' },
    tasks: [make('first'), make('second')],
    excluded: [{ item: 'needs-gpu', reasons: ['gpu'] }, { item: 'needs-services', reasons: ['multi-service'] }],
  };
}

function fakeDocker(options = {}) {
  const containers = new Map(), calls = [];
  const result = (code = 0, stdout = '', stderr = '') => ({ code, stdout, stderr });
  const present = (container, file) => container.files.has(file) || [...container.files.keys()].some(key => key.startsWith(file + '/'));
  return {
    containers, calls,
    async probe() { return { available: !options.unavailable, reason: options.unavailable ? 'fixture Docker unavailable' : null }; },
    async create(config) {
      calls.push(['create', config]);
      if (options.createError) throw Object.assign(new Error('fixture daemon failure'), { infrastructure: true });
      const id = (containers.size + 1).toString(16).padStart(64, '0');
      const files = new Map();
      if (config.image === 'fixture/verifier') files.set('/app/verifier-bootstrap.txt', Buffer.from('keep verifier data'));
      containers.set(id, { config, files, stages: new Map(), removed: false });
      return id;
    },
    async exec(id, argv, settings) {
      calls.push(['exec', id, argv, settings]);
      const container = containers.get(id);
      if (container.removed) throw Object.assign(new Error('fixture container removed'), { infrastructure: true });
      if (argv[0] === 'test') return result(present(container, argv[2]) ? 0 : 1);
      if (argv[2] === 'test -e "$1" || test -L "$1"') return result(present(container, argv[4]) ? 0 : 1);
      if (argv[2]?.includes('tar -C')) {
        container.stages.set(argv[5], { source: argv[4], excludes: argv.slice(6) }); return result();
      }
      if (argv[0] === 'rm') {
        for (const file of argv.slice(2)) for (const key of container.files.keys()) {
          if (key === file || key.startsWith(file + '/')) container.files.delete(key);
        }
      }
      if (argv[1] === '/solution/solve.sh') {
        if (options.oracleError) return result(1, '', 'fixture oracle failure');
        container.files.set('/app/output.txt', Buffer.from(fixtureData.expected));
      }
      if (argv[1] === '/tests/test.sh') {
        if (options.abort) options.abort();
        const score = container.files.get('/app/output.txt')?.toString() === fixtureData.expected ? '1' : '0';
        if (!options.omitReward) container.files.set('/logs/verifier/reward.' + (options.json ? 'json' : 'txt'),
          Buffer.from(options.reward ?? (options.json ? JSON.stringify({ reward: Number(score) }) : score)));
        return result(options.verifierCode || 0, 'fixture verifier output');
      }
      return result();
    },
    async copyTo(id, host, destination) {
      calls.push(['copyTo', id, host, destination]);
      const container = containers.get(id);
      const walk = async (file, target) => {
        if ((await fs.lstat(file)).isDirectory()) {
          for (const name of await fs.readdir(file)) await walk(path.join(file, name), target + '/' + name);
        } else container.files.set(target, await fs.readFile(file));
      };
      const isDirectory = (await fs.lstat(host)).isDirectory();
      const target = isDirectory && path.posix.basename(destination) !== path.basename(host)
        ? path.posix.join(destination, path.basename(host)) : destination;
      await walk(host, target);
    },
    async copyFrom(id, source, host) {
      calls.push(['copyFrom', id, source, host]);
      const container = containers.get(id), stage = container.stages.get(source);
      source = stage?.source || source;
      await fs.mkdir(path.dirname(host), { recursive: true });
      if (container.files.has(source)) await fs.writeFile(host, container.files.get(source));
      else {
        await fs.mkdir(host, { recursive: true });
        for (const [key, data] of container.files) if (key.startsWith(source + '/')) {
          const relative = key.slice(source.length + 1);
          const excluded = (stage?.excludes || []).some(option => {
            const pattern = option.slice('--exclude='.length).replace(/^\.\//, '');
            return relative.split('/').some(part => pattern === '*.pyc' ? part.endsWith('.pyc') : part === pattern);
          });
          if (excluded) continue;
          const target = path.join(host, relative);
          await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, data);
        }
      }
    },
    async remove(id) { calls.push(['remove', id]); containers.get(id).removed = true; },
  };
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lab-aa-fixture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const docker = fakeDocker(options), downloads = [], sourceManifest = manifest();
  options.modifyManifest?.(sourceManifest);
  const tools = {
    ...baseTools, docker,
    async download(url, target, settings) {
      downloads.push({ url, settings });
      const file = url.split('/tasks/')[1].split('/').slice(1).join('/');
      await fs.writeFile(target, options.badDownload ? 'corrupt' : fixtureData.files[file]);
    },
    async aaScores() { return { asOf: Date.UTC(2026, 10, 2), values: { 'claude-opus-5-5': 0.5, 'gpt-6-1-sol': 0.4, unknown: 1 } }; },
  };
  const controller = new AbortController();
  const ctx = { signal: controller.signal, t: (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, name) => values[name]),
    cacheDirectory: path.join(root, 'cache'), tools, getProjects: () => [], platform: process.platform, credential: () => options.key || null };
  const runCtx = { ...ctx, workspaceRoot: path.join(root, 'workspaces'), artifactDirectory: path.join(root, 'artifacts'),
    session: fakeSession(), testTimeoutMs: 120000, reference: null };
  await fs.mkdir(runCtx.workspaceRoot); await fs.mkdir(runCtx.artifactDirectory);
  const provider = createAaSource({ manifest: sourceManifest });
  const sampled = await provider.sample(query(1), ctx), canonical = await provider.canonical(selection(sampled), ctx);
  const fetch = async () => { await provider.fetch(canonical.scope, ctx); return canonical.tasks[0]; };
  return { root, ctx, runCtx, provider, canonical, docker, downloads, tools, sourceManifest, controller, fetch };
}

test('the aa provider meets the source contract', async t => {
  const f = await fixture(t);
  const { info, tasks } = await conformance(f.provider, {
    query: query(2), selection: { source: 'aa', benchmark: 'terminal-bench-4' }, secrets, ctx: { tools: f.tools },
  });
  assert.equal(info.available, true); assert.equal(tasks.length, 2);
  assert.ok(f.docker.calls.filter(call => call[0] === 'create').every(call => call[1].network === 'none'));
});

test('the pinned CPU catalog accounts for all 66 tasks and excludes all 11 multi-service and 3 GPU tasks', async () => {
  assert.equal(catalog.tasks.length, 52); assert.equal(catalog.excluded.length, 14);
  assert.equal(catalog.excluded.filter(task => task.reasons.includes('multi-service')).length, 11);
  assert.equal(catalog.excluded.filter(task => task.reasons.includes('gpu')).length, 3);
  assert.equal(new Set([...catalog.tasks, ...catalog.excluded].map(task => task.item)).size, 66);
  const provider = createAaSource();
  const tasks = await provider.sample(query(52), { t: text => text });
  assert.equal(tasks.length, 52);
  for (const task of catalog.excluded) await assert.rejects(provider.canonical(selection([{ id: 'aa-' + task.item }]), {}));
  assert.equal(catalog.source.revision, '452bf305c6daa62fc59061d22133a7cbc7c1572e');
  assert.equal(catalog.source.imagesSha256, '35930574da44fe4e90f6741562a9596cdbf02d2b64d639b6c2b7ab2582a4b0e6');
});

test('describe and sample use no downloads; missing Docker says why', async t => {
  const f = await fixture(t, { unavailable: true });
  const info = await f.provider.describe(f.ctx);
  assert.equal(info.available, false); assert.equal(info.reason, 'fixture Docker unavailable');
  assert.equal(info.options[0].tasks, 2); assert.equal(info.published, null);
  assert.equal(f.downloads.length, 0);
  assert.deepEqual(await f.provider.sample(query(1), f.ctx), await f.provider.sample(query(1), f.ctx));
  assert.equal((await f.provider.sample({ ...query(2), exclude: [f.canonical.tasks[0].id] }, f.ctx)).length, 1);
});

test('canonical rejects duplicate, forged, excluded and path-like ids, and never accepts renderer task text', async t => {
  const f = await fixture(t), good = f.canonical.tasks[0];
  for (const ids of [[good, good], [{ id: 'aa-unknown' }], [{ id: '../aa-first' }], [{ id: 'aa-needs-gpu' }]]) {
    await assert.rejects(f.provider.canonical(selection(ids), f.ctx));
  }
  const rebuilt = await f.provider.canonical({ ...selection([good]), tasks: [{ id: good.id, text: 'forged text' }] }, f.ctx);
  assert.notEqual(rebuilt.tasks[0].text, 'forged text');
  await assert.rejects(f.provider.fetch({ ids: [good.id] }, f.ctx));
});

test('fetch hydrates canonical text, validates pins, and reuses verified cache entries', async t => {
  const f = await fixture(t); await f.fetch();
  const rebuilt = await f.provider.canonical(selection(f.canonical.tasks), f.ctx);
  assert.equal(rebuilt.tasks[0].text, fixtureData.files['instruction.md']);
  assert.ok(f.downloads.every(call => call.url.includes('/' + f.sourceManifest.source.revision + '/') &&
    call.settings.hosts[0] === 'raw.githubusercontent.com' && /^[a-f0-9]{64}$/.test(call.settings.sha256)));
  const before = f.downloads.length; await f.fetch(); assert.equal(f.downloads.length, before);
  assert.ok(f.provider.brief(rebuilt.tasks[0], rebuilt.scope).rules.some(rule => rule.includes('tb <command>')));
});

test('a failed download hash is infrastructure and leaves no partial task file', async t => {
  const f = await fixture(t, { badDownload: true });
  await assert.rejects(f.fetch(), error => error.infrastructure === true);
  const files = await fs.readdir(f.ctx.cacheDirectory, { recursive: true });
  assert.ok(!files.some(file => file.endsWith('.download') || file.endsWith('instruction.md')));
});

test('guard rejects changed reference data as a fatal isolation breach', async t => {
  const f = await fixture(t); await f.fetch();
  const guard = await f.provider.guard(f.canonical.scope, f.ctx);
  await guard.check(); assert.deepEqual(guard.protectedPaths, [f.ctx.cacheDirectory]);
  const files = await fs.readdir(f.ctx.cacheDirectory, { recursive: true });
  const instruction = files.find(file => file.endsWith('instruction.md'));
  await fs.writeFile(path.join(f.ctx.cacheDirectory, instruction), 'changed');
  await assert.rejects(guard.check(), error => error.fatal === true);
});

test('reference proves the oracle with the real verifier path and always removes its containers', async t => {
  const f = await fixture(t), task = await f.fetch();
  const reference = await f.provider.reference(task, f.canonical.scope, f.runCtx);
  assert.deepEqual(reference.diffFiles, []); assert.equal(reference.score, 1);
  assert.equal(f.docker.containers.size, 2);
  assert.ok([...f.docker.containers.values()].every(container => container.removed));
  const copied = f.docker.calls.filter(call => call[0] === 'copyTo');
  assert.ok(copied.some(call => call[3] === '/solution'));
  assert.ok(copied.some(call => call[3] === '/tests/test.sh'));
});

async function labelledDocker(f) {
  const store = new LabStore(f.root), installId = await store.installId(), labels = new Map();
  const state = { refuseRemoval: false, calls: [] };
  const command = async (_file, args) => {
    state.calls.push(args);
    const result = (stdout = '', code = 0, stderr = '') => ({ stdout, code, stderr });
    if (args[0] === 'create') {
      assert.equal(await fs.readFile(path.join(store.directory, 'install-id'), 'utf8'), installId);
      const [image, digest] = args.find(value => value.includes('@sha256:')).split('@');
      const id = await f.docker.create({ image, digest, network: args[args.indexOf('--network') + 1], workdir: args[args.indexOf('--workdir') + 1] });
      labels.set(id, Object.fromEntries(args.flatMap((value, index) => value === '--label' ? [args[index + 1].split('=')] : [])));
      return result(id);
    }
    if (args[0] === 'ps') return result([...labels].filter(([id, value]) => !f.docker.containers.get(id).removed &&
      value['agentrix.lab.install'] === args.at(-1).split('=').at(-1)).map(([id]) => id).join('\n'));
    const id = args.at(-1);
    if (!f.docker.containers.has(id) || f.docker.containers.get(id).removed) return result('', 1, 'No such container');
    if (args[0] === 'start') { f.docker.containers.get(id).started = true; return result(id); }
    if (args[0] === 'inspect') return result(JSON.stringify(labels.get(id)));
    if (args[0] === 'rm') {
      if (state.refuseRemoval) return result('', 1, 'fixture interrupted cleanup');
      await f.docker.remove(id); return result(id);
    }
    throw new Error('Unexpected fake Docker operation');
  };
  const host = baseTools.createTools({ command }), docker = host.docker.forInstall(installId), run = docker.forRun(randomUUID());
  f.tools.docker = { ...f.docker, create: run.create, remove: run.remove };
  return { state, installId, labels, run, restart: () => host.docker.forInstall(installId) };
}

test('an agent container started before the runner writes its record is found by the next installation sweep', async t => {
  const f = await fixture(t), task = await f.fetch(), labelled = await labelledDocker(f);
  const workspace = await f.provider.prepare(task, f.canonical.scope, f.runCtx);
  assert.equal(f.docker.containers.get(workspace.container.id).started, true);
  assert.equal(await fs.stat(path.join(f.root, 'container.json')).catch(() => null), null);
  assert.equal(labelled.labels.get(workspace.container.id)['agentrix.lab.install'], labelled.installId);
  await labelled.restart().sweep();
  assert.equal(f.docker.containers.get(workspace.container.id).removed, true);
  await labelled.run.close();
});

test('reference and verifier containers left by an interrupted cleanup are swept after a simulated restart', async t => {
  const f = await fixture(t), task = await f.fetch(), labelled = await labelledDocker(f);
  labelled.state.refuseRemoval = true;
  await assert.rejects(f.provider.reference(task, f.canonical.scope, f.runCtx), /Docker 操作失败/);
  assert.equal(f.docker.containers.size, 2);
  assert.deepEqual([...f.docker.containers.values()].map(container => container.config.image).sort(), ['fixture/agent', 'fixture/verifier']);
  for (const [id, container] of f.docker.containers) {
    assert.equal(container.started, true); assert.equal(container.removed, false);
    assert.equal(labelled.labels.get(id)['agentrix.lab.install'], labelled.installId);
    assert.ok(labelled.labels.get(id)['agentrix.lab.run']);
  }
  labelled.state.refuseRemoval = false;
  await labelled.restart().sweep();
  assert.ok([...f.docker.containers.values()].every(container => container.removed));
  await labelled.run.close();
});

test('a failed oracle rejects reference validation and cleans up before any model run', async t => {
  const f = await fixture(t, { oracleError: true }), task = await f.fetch();
  await assert.rejects(f.provider.reference(task, f.canonical.scope, f.runCtx));
  assert.ok([...f.docker.containers.values()].every(container => container.removed));
  assert.equal(f.docker.containers.size, 1);
  assert.match(await fs.readFile(path.join(f.runCtx.artifactDirectory, 'tests.log'), 'utf8'), /fixture oracle failure/);
});

test('prepare exposes only broker clients; grading transfers output into a separate verifier with no host mounts', async t => {
  const f = await fixture(t), task = await f.fetch();
  const workspace = await f.provider.prepare(task, f.canonical.scope, f.runCtx);
  const agent = f.docker.containers.get(workspace.container.id);
  assert.equal(f.docker.calls.filter(call => call[0] === 'copyTo').length, 0);
  assert.ok(workspace.files.includes('bin/tb') && workspace.files.includes('bin/tb.cmd'));
  assert.ok(!workspace.files.some(file => file.includes('solution') || file.includes('tests')));
  agent.files.set('/app/output.txt', Buffer.from(fixtureData.expected));
  const grade = await f.provider.grade(task, f.canonical.scope, f.runCtx);
  assert.equal(grade.score, 1); assert.equal(grade.passed, true);
  assert.equal(grade.testsPassed, null); assert.equal(grade.testsTotal, null);
  assert.match(await fs.readFile(grade.evidence, 'utf8'), /fixture verifier output/);
  assert.equal(agent.removed, false); // The engine owns the returned agent container's lifecycle.
  assert.ok([...f.docker.containers.values()].filter(container => container !== agent).every(container => container.removed));
  assert.ok(f.docker.calls.filter(call => call[0] === 'create').every(call => call[1].network === 'none' && !('mount' in call[1])));
});

test('missing submissions are graded as failed, with unknown test counts preserved', async t => {
  const f = await fixture(t), task = await f.fetch();
  await f.provider.prepare(task, f.canonical.scope, f.runCtx);
  assert.deepEqual(await f.provider.grade(task, f.canonical.scope, f.runCtx).then(({ passed, score, testsTotal }) => ({ passed, score, testsTotal })),
    { passed: false, score: 0, testsTotal: null });
});

test('directory artifacts keep their original path, preserve verifier files, and honor upstream exclusions', async t => {
  const f = await fixture(t, { modifyManifest: value => {
    for (const task of value.tasks) task.artifacts = [{ source: '/app/', exclude: ['.cache', '*.pyc'] }];
  } });
  const task = await f.fetch(), workspace = await f.provider.prepare(task, f.canonical.scope, f.runCtx);
  const agent = f.docker.containers.get(workspace.container.id);
  agent.files.set('/app/output.txt', Buffer.from(fixtureData.expected));
  agent.files.set('/app/.cache/ignore.txt', Buffer.from('excluded dependency'));
  agent.files.set('/app/generated.pyc', Buffer.from('excluded bytecode'));
  const grade = await f.provider.grade(task, f.canonical.scope, f.runCtx);
  assert.equal(grade.score, 1);
  const verifier = [...f.docker.containers.values()].find(container => container.config.image === 'fixture/verifier');
  assert.equal(verifier.files.get('/app/verifier-bootstrap.txt').toString(), 'keep verifier data');
  assert.ok(!verifier.files.has('/app/.cache/ignore.txt') && !verifier.files.has('/app/generated.pyc'));
  assert.ok(!verifier.files.has('/app/app/output.txt'));
});

test('Docker infrastructure failures remain infrastructure failures', async t => {
  const f = await fixture(t, { createError: true }), task = await f.fetch();
  await assert.rejects(f.provider.reference(task, f.canonical.scope, f.runCtx), error => error.infrastructure === true);
});

test('unavailable optional credentials do not disable local Docker tasks', async t => {
  const f = await fixture(t);
  const ctx = { ...f.ctx, credential: () => { throw new Error('fixture key store unavailable'); } };
  await f.provider.fetch(f.canonical.scope, ctx);
  const info = await f.provider.describe(ctx);
  assert.equal(info.available, true); assert.equal(info.published, null);
});

for (const [name, options] of [
  ['missing reward', { omitReward: true }], ['malformed reward', { reward: 'NaN' }],
  ['out-of-range reward', { reward: '2' }], ['verifier failure despite reward', { verifierCode: 1, reward: '1' }],
  ['malformed JSON', { json: true, reward: '{invalid' }],
]) test(name + ' is an error and the verifier is still removed', async t => {
  const f = await fixture(t, options), task = await f.fetch();
  await f.provider.prepare(task, f.canonical.scope, f.runCtx);
  await assert.rejects(f.provider.grade(task, f.canonical.scope, f.runCtx));
  assert.ok([...f.docker.containers.values()].filter(container => container.config.image === 'fixture/verifier').every(container => container.removed));
});

test('valid JSON rewards preserve a task pass', async t => {
  const f = await fixture(t, { json: true }), task = await f.fetch();
  const workspace = await f.provider.prepare(task, f.canonical.scope, f.runCtx);
  f.docker.containers.get(workspace.container.id).files.set('/app/output.txt', Buffer.from(fixtureData.expected));
  assert.equal((await f.provider.grade(task, f.canonical.scope, f.runCtx)).score, 1);
});

test('an upstream verifier that exits 1 with reward 0 reports a completed task failure', async t => {
  const f = await fixture(t, { verifierCode: 1 }), task = await f.fetch();
  await f.provider.prepare(task, f.canonical.scope, f.runCtx);
  const grade = await f.provider.grade(task, f.canonical.scope, f.runCtx);
  assert.equal(grade.passed, false); assert.equal(grade.score, 0);
});

test('cancellation removes the private verifier and prevents a pass', async t => {
  let controller;
  const f = await fixture(t, { abort: () => controller.abort() }), task = await f.fetch(); controller = f.controller;
  await f.provider.prepare(task, f.canonical.scope, f.runCtx);
  await assert.rejects(f.provider.grade(task, f.canonical.scope, f.runCtx));
  assert.ok([...f.docker.containers.values()].filter(container => container.config.image === 'fixture/verifier').every(container => container.removed));
});

test('AA references refresh only in fetch, map exact identities, never compare the subset or expose a key', async t => {
  const f = await fixture(t, { key: 'synthetic-fixture-key' });
  assert.equal((await f.provider.describe(f.ctx)).published, null);
  await f.fetch();
  const info = await f.provider.describe(f.ctx);
  assert.deepEqual(info.published.values, { opus: 0.5, sol: 0.4 });
  assert.equal(info.published.comparable, false);
  assert.equal(info.published.asOf, '2026-11-02T00:00:00.000Z');
  assert.ok(!JSON.stringify(info).includes('synthetic-fixture-key'));
  assert.ok(!(await fs.readFile(path.join(f.ctx.cacheDirectory, 'aa-scores.json'), 'utf8')).includes('synthetic-fixture-key'));
  assert.equal((await f.provider.describe({ ...f.ctx, credential: () => null })).published, null);
});

test('AA API failure never blocks local tasks or leaks error text', async t => {
  const f = await fixture(t, { key: 'synthetic-fixture-key' });
  f.tools.aaScores = async () => { throw new Error('synthetic-fixture-key'); };
  await f.fetch();
  assert.equal((await f.provider.describe(f.ctx)).published, null);
});

test('reward parsing never treats absent, partial, boolean or nonfinite evidence as a pass', () => {
  for (const text of ['', '1 garbage', '-1', '0.5', 'Infinity']) assert.throws(() => reward(text, false));
  for (const text of ['{}', '{"reward":true}', '{"reward":null}', '{"reward":0.5}']) assert.throws(() => reward(text, true));
});

test('tb forwards exact argv and stdin through the capability broker and preserves stdout, stderr and exit code', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lab-aa-broker-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await installWrappers(root, process.execPath);
  const address = process.platform === 'win32' ? '\\\\.\\pipe\\lab-aa-' + randomUUID() : path.join(root, 'broker.sock');
  let request;
  const server = net.createServer(socket => {
    socket.setEncoding('utf8'); let text = '';
    socket.on('data', chunk => {
      text += chunk;
      if (text.includes('\n')) {
        request = JSON.parse(text);
        socket.end(JSON.stringify({ code: 7, stdout: 'fixture stdout', stderr: 'fixture stderr' }) + '\n');
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const invoke = (file, args, options = {}) => new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env: { ...process.env, HOME: root, USERPROFILE: root, AGENTRIX_LAB_BROKER: JSON.stringify({ address, capability: 'synthetic-capability' }) },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...options,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end('fixture stdin\n');
  });
  const output = await invoke(process.execPath, [path.join(root, 'bin/tb.cjs'), 'printf', 'a b', '"quoted"']);
  assert.deepEqual(request.argv, ['printf', 'a b', '"quoted"']);
  assert.equal(request.stdin, 'fixture stdin\n'); assert.equal(request.capability, 'synthetic-capability');
  assert.deepEqual(output, { code: 7, stdout: 'fixture stdout', stderr: 'fixture stderr' });
  const wrapped = process.platform === 'win32'
    ? await invoke(path.join(process.env.SystemRoot, 'System32/cmd.exe'),
      ['/d', '/s', '/c', '""' + path.join(root, 'bin/tb.cmd') + '" printf "a b" plain"'], { windowsVerbatimArguments: true })
    : await invoke('/bin/sh', [path.join(root, 'bin/tb'), 'printf', 'a b', 'plain']);
  assert.deepEqual(request.argv, ['printf', 'a b', 'plain']);
  assert.deepEqual(wrapped, output);
});
