const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const { createOssSource } = require('../electron/features/lab-oss/index.cjs');
const manifest = require('../electron/features/lab-oss/manifest.json');
const { conformance } = require('./helpers/lab-provider-conformance.cjs');
const { requirementsHash, cacheKey, prepareEnvironment } = require('../electron/features/lab-oss/environment.cjs');
const { taskDirectory, sha256, readRow, patchPaths } = require('../electron/features/lab-oss/data.cjs');
const { locked } = require('../electron/features/lab-oss/cache.cjs');
const { fixture, conformanceProvider, GOLD, HIDDEN, BEFORE } = require('./fixtures/lab-oss/fixture.cjs');

const originalFetch = globalThis.fetch, originalRequest = https.request, originalGet = https.get;
const denyNetwork = () => { throw new Error('Network is forbidden in OSS tests.'); };
before(() => { globalThis.fetch = denyNetwork; https.request = denyNetwork; https.get = denyNetwork; });
after(() => { globalThis.fetch = originalFetch; https.request = originalRequest; https.get = originalGet; });

const selection = { source: 'oss', repos: ['fixture/unit'], tasks: [{ id: 'oss-fixture-unit-1' }] };
async function ready(t) {
  const f = await fixture(t), provider = createOssSource({ manifest: f.manifest });
  const { scope } = await provider.canonical(selection, f.ctx);
  await provider.fetch(scope, f.ctx);
  const canonical = await provider.canonical(selection, f.ctx);
  return { ...f, provider, ...canonical, task: canonical.tasks[0] };
}

test('the oss provider meets the source contract', async t => {
  const f = await fixture(t), provider = await conformanceProvider(f.manifest);
  const { info, tasks, canonical } = await conformance(provider, {
    query: { source: 'oss', repos: ['fixture/unit'], size: 1 }, selection: { source: 'oss', repos: ['fixture/unit'] },
    ctx: f.ctx, secrets: [GOLD, HIDDEN],
  });
  assert.equal(info.available, true); assert.equal(tasks.length, 1); assert.ok(canonical.scopeKey);
});

test('the shipped manifest contains twelve pinned Python tasks, metadata only, with attribution', async () => {
  const provider = createOssSource(), ctx = { signal: new AbortController().signal, t: value => value };
  const info = await provider.describe(ctx);
  assert.equal(info.metric, 'resolved'); assert.equal(info.review, true); assert.equal(info.keyStored, null);
  assert.equal(info.downloadBytes, null, 'Git transfer size is unknown, never a measured zero');
  assert.equal(manifest.tasks.length, 12); assert.equal(info.size.max, 12);
  assert.deepEqual(info.options.map(item => item.id), ['pallets/flask', 'psf/requests', 'pytest-dev/pytest']);
  assert.match(info.manifest.sha256, /^[a-f0-9]{64}$/);
  for (const entry of manifest.tasks) {
    assert.match(entry.base, /^[a-f0-9]{40}$/); assert.match(entry.row.sha256, /^[a-f0-9]{64}$/);
    assert.ok(entry.FAIL_TO_PASS.length && entry.PASS_TO_PASS.length);
    assert.match(entry.upstream, /^https:\/\/github.com\//); assert.ok(entry.license);
    assert.equal(entry.problem_statement, undefined); assert.equal(entry.patch, undefined); assert.equal(entry.test_patch, undefined);
    assert.ok(Object.values(entry.sha256).every(value => /^[a-f0-9]{64}$/.test(value)));
  }
});

test('describe and sample are manifest-only even with broken machine tools', async t => {
  const f = await fixture(t), provider = createOssSource({ manifest: f.manifest });
  const ctx = { ...f.ctx, tools: new Proxy({}, { get: denyNetwork }), credential: denyNetwork, getProjects: denyNetwork };
  assert.equal((await provider.describe(ctx)).available, true);
  const query = { source: 'oss', repos: ['fixture/unit'], size: 1 }, tasks = await provider.sample(query, ctx);
  assert.deepEqual(await provider.sample(structuredClone(query), ctx), tasks);
  assert.equal(tasks.length, 1); assert.match(tasks[0].why, /可能已被训练污染/);
  assert.deepEqual(await provider.sample({ ...query, exclude: [tasks[0].id] }, ctx), []);
  assert.equal(f.state.downloads, 0);
});

test('canonical rejects forged, path-like, duplicate and foreign-repository selections', async t => {
  const f = await fixture(t), provider = createOssSource({ manifest: f.manifest });
  for (const value of [
    { ...selection, tasks: [{ id: 'oss-forged-1' }] }, { ...selection, tasks: [{ id: '../oss-fixture-unit-1' }] },
    { ...selection, tasks: [...selection.tasks, ...selection.tasks] }, { ...selection, repos: ['foreign/repo'] },
    { ...selection, source: 'aa' }, { ...selection, tasks: [] },
  ]) await assert.rejects(provider.canonical(value, f.ctx));
  for (const size of [0, 2, NaN, '1']) await assert.rejects(provider.sample({ ...selection, size }, f.ctx));
});

test('fetch verifies data and Git identity; the second canonical hydrates only the problem statement', async t => {
  const f = await ready(t);
  assert.equal(f.task.text, f.row.problem_statement);
  const serialized = JSON.stringify(f.tasks);
  assert.ok(!serialized.includes(GOLD)); assert.ok(!serialized.includes(HIDDEN)); assert.ok(!serialized.includes('patch'));
  const brief = f.provider.brief(f.task, f.scope);
  assert.equal(brief.task, f.row.problem_statement); assert.ok(brief.rules.some(rule => rule.includes('contaminated')));
  await f.provider.fetch(f.scope, f.ctx); assert.equal(f.state.downloads, 1);
  assert.notEqual((await f.provider.sample({ ...selection, size: 1 }, f.ctx))[0].text, f.row.problem_statement);
  const rebuilt = await f.provider.canonical({ ...selection, tasks: [{ id: f.task.id, text: 'forged text', patch: GOLD }] }, f.ctx);
  assert.equal(rebuilt.tasks[0].text, f.row.problem_statement);
});

test('a corrupt download never publishes a row or reaches Git', async t => {
  const f = await fixture(t), provider = createOssSource({ manifest: f.manifest }); f.state.badDownload = true;
  const { scope } = await provider.canonical(selection, f.ctx);
  await assert.rejects(provider.fetch(scope, f.ctx), { infrastructure: true });
  assert.equal(f.state.fetches, 0);
  assert.equal(await fs.stat(path.join(taskDirectory(f.ctx, f.entry), 'row.json')).catch(() => null), null);
});

test('a changed private row or grading patch is fatal to the guard', async t => {
  const f = await ready(t), guard = await f.provider.guard(f.scope, f.ctx);
  assert.deepEqual(guard.protectedPaths, [f.ctx.cacheDirectory]); await guard.check();
  await fs.appendFile(path.join(taskDirectory(f.ctx, f.entry), 'tests.patch'), '\nchanged');
  await assert.rejects(guard.check(), { fatal: true });
});

test('prepare exposes only the base; installs are isolated and wheels are cached by requirements', async t => {
  const f = await ready(t), run = await f.run(), workspace = await f.provider.prepare(f.task, f.scope, run);
  assert.equal(await fs.readFile(path.join(workspace.cwd, 'calc.py'), 'utf8'), BEFORE);
  assert.ok(!(await fs.readFile(path.join(workspace.cwd, 'tests/test_calc.py'), 'utf8')).includes(HIDDEN));
  assert.equal((await f.git(workspace.cwd, ['rev-list', '--all'])).trim().split('\n').length, 1);
  assert.equal(await fs.stat(path.join(workspace.cwd, '.git/objects/info/alternates')).catch(() => null), null);
  assert.equal(f.state.wheelBuilds, 1); assert.equal(f.state.maximumInstalls, 1); assert.equal(f.state.calls[0].network, false);
  assert.ok(f.state.calls.filter(call => call.network).every(call => call.args[2].includes('runpy.run_module')));
  const cache = cacheKey(f.entry, run, 'cpython-312-x64'); assert.ok(cache.includes(requirementsHash(f.entry)));
  assert.equal(await fs.stat(path.join(cache, '.in-use')).catch(() => null), null);
  await f.provider.prepare(f.task, f.scope, await f.run());
  assert.equal(f.state.wheelBuilds, 1); assert.equal(f.state.installs, 2);
});

test('concurrent preparations serialize installation for the same dependency hash', async t => {
  const f = await ready(t); f.state.installDelay = 30;
  await Promise.all([f.run(), f.run()].map(async value => f.provider.prepare(f.task, f.scope, await value)));
  assert.equal(f.state.maximumInstalls, 1); assert.equal(f.state.wheelBuilds, 1);
});

test('failed installs are infrastructure failures and never publish a wheel cache', async t => {
  const f = await ready(t); f.state.failInstall = true; const run = await f.run();
  await assert.rejects(f.provider.prepare(f.task, f.scope, run), { infrastructure: true });
  assert.equal(await fs.stat(path.join(cacheKey(f.entry, run, 'cpython-312-x64'), 'wheels.json')).catch(() => null), null);
});

test('wheel checksum corruption is refused before another installation', async t => {
  const f = await ready(t), run = await f.run(); await f.provider.prepare(f.task, f.scope, run);
  await fs.writeFile(path.join(cacheKey(f.entry, run, 'cpython-312-x64'), 'wheels', 'pytest-8.3.5-py3-none-any.whl'), 'tampered');
  const installs = f.state.installs;
  await assert.rejects(f.provider.prepare(f.task, f.scope, await f.run()), { infrastructure: true });
  assert.equal(f.state.installs, installs);
});

test('reference proves F2P fail before the fix, P2P stay passing, then the complete suite passes', async t => {
  const f = await ready(t), ctx = await f.run(), reference = await f.provider.reference(f.task, f.scope, ctx);
  assert.equal(reference.total, 2); assert.deepEqual(reference.diffFiles, ['calc.py']);
  assert.ok(!JSON.stringify(reference).includes(GOLD)); assert.ok(!JSON.stringify(reference).includes(HIDDEN));
  const jobs = f.state.calls.filter(call => call.args.some(arg => arg.startsWith('--junitxml=')));
  assert.equal(jobs.length, 2); assert.ok(jobs.every(call => call.network === false));
});

test('reference rejects an already-passing baseline and an ineffective known fix', async t => {
  for (const mode of ['all-pass', 'always-fail']) {
    const f = await ready(t); f.state.mode = mode;
    await assert.rejects(f.provider.reference(f.task, f.scope, await f.run()), /reference/);
  }
});

test('grade restores hidden tests and reports resolved only when both groups pass', async t => {
  const f = await ready(t), reference = await f.provider.reference(f.task, f.scope, await f.run());
  const ctx = { ...await f.run(), reference }, workspace = await f.provider.prepare(f.task, f.scope, ctx);
  await fs.writeFile(path.join(workspace.cwd, 'tests/test_calc.py'), 'pretend everything passes');
  const failed = await f.provider.grade(f.task, f.scope, ctx);
  assert.deepEqual([failed.passed, failed.score, failed.testsPassed, failed.testsTotal], [false, 0, 1, 2]);
  await fs.writeFile(path.join(workspace.cwd, 'calc.py'), BEFORE.replace('return 0', 'return 42'));
  const passed = await f.provider.grade(f.task, f.scope, ctx);
  assert.deepEqual([passed.passed, passed.score, passed.testsPassed, passed.testsTotal], [true, 1, 2, 2]);
  assert.equal(path.dirname(passed.evidence), ctx.artifactDirectory);
  assert.ok((await fs.readFile(path.join(workspace.cwd, 'tests/test_calc.py'), 'utf8')).includes(HIDDEN));
});

test('missing, duplicate, renamed, skipped, malformed and errored evidence is never a pass', async t => {
  const f = await ready(t), reference = await f.provider.reference(f.task, f.scope, await f.run());
  const ctx = { ...await f.run(), reference }; await f.provider.prepare(f.task, f.scope, ctx);
  for (const mode of ['missing', 'duplicate', 'wrong-name', 'skipped', 'error', 'malformed', 'bad-code']) {
    f.state.mode = mode;
    await assert.rejects(f.provider.grade(f.task, f.scope, ctx), /could not be graded/, mode);
  }
  await assert.rejects(f.provider.grade(f.task, f.scope, { ...ctx, reference: null }), /validated OSS reference/);
});

test('unsafe patch paths and tampered dataset identities are rejected', async t => {
  const f = await fixture(t);
  for (const file of ['../outside.py', '.git/config', '/absolute.py', 'dir\\escape.py']) {
    assert.throws(() => patchPaths('--- a/' + file + '\n+++ b/' + file + '\n'), /path/);
  }
  assert.deepEqual(patchPaths(f.row.test_patch), ['tests/test_calc.py']);
  const data = JSON.parse(f.raw); data.rows[0].row.repo = 'foreign/repo'; const raw = Buffer.from(JSON.stringify(data));
  assert.throws(() => readRow(raw, { ...f.entry, row: { ...f.entry.row, sha256: sha256(raw), bytes: raw.length } }), /identity/);
});

test('stop is observed before network, preparation or tests', async t => {
  const f = await ready(t); f.controller.abort(new Error('owner stopped'));
  await assert.rejects(f.provider.fetch(f.scope, f.ctx), /owner stopped/);
  await assert.rejects(f.provider.prepare(f.task, f.scope, await f.run()), /owner stopped/);
  assert.equal(f.state.calls.length, 0);
});

test('an aborted lock waiter cannot let the next installer bypass an active installer', async () => {
  const running = new AbortController(), waiting = new AbortController(), events = [];
  let release; const gate = new Promise(resolve => { release = resolve; });
  const first = locked('synthetic-lock', { signal: running.signal }, async () => { events.push('first'); await gate; });
  await new Promise(resolve => setImmediate(resolve));
  const second = locked('synthetic-lock', { signal: waiting.signal }, async () => { events.push('cancelled'); });
  waiting.abort(new Error('stopped'));
  const rejected = assert.rejects(second, /stopped/);
  const third = locked('synthetic-lock', { signal: running.signal }, async () => { events.push('third'); });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(events, ['first']);
  await Promise.race([rejected, new Promise((resolve, reject) => setTimeout(() => reject(new Error('Queued cancellation blocked.')), 500))]);
  release(); await Promise.all([first, rejected, third]); assert.deepEqual(events, ['first', 'third']);
});

test('grading removes injected pytest configuration and rejects a linked test file without following it', async t => {
  const f = await ready(t), reference = await f.provider.reference(f.task, f.scope, await f.run());
  const ctx = { ...await f.run(), reference }, workspace = await f.provider.prepare(f.task, f.scope, ctx);
  await fs.writeFile(path.join(workspace.cwd, 'conftest.py'), 'raise RuntimeError("injected")');
  await f.provider.grade(f.task, f.scope, ctx);
  assert.equal(await fs.stat(path.join(workspace.cwd, 'conftest.py')).catch(() => null), null);
  const original = fs.lstat, target = path.join(workspace.cwd, 'tests/test_calc.py');
  t.mock.method(fs, 'lstat', async (...args) => args[0] === target
    ? { isFile: () => false, isSymbolicLink: () => true } : original(...args));
  await assert.rejects(f.provider.grade(f.task, f.scope, ctx), { fatal: true });
});

test('cache partition includes Python runtime and platform, while requirements determine the installation lock', async t => {
  const f = await fixture(t);
  assert.notEqual(cacheKey(f.entry, f.ctx, 'cpython-310-x64'), cacheKey(f.entry, f.ctx, 'cpython-312-x64'));
  assert.notEqual(cacheKey(f.entry, f.ctx, 'cpython-312-x64'), cacheKey(f.entry, { ...f.ctx, platform: 'other' }, 'cpython-312-x64'));
  assert.throws(() => patchPaths('diff --git a/x.py b/x.py\nnew file mode 120000\n--- /dev/null\n+++ b/x.py\n'), /Unsupported/);
});

test('packaging-generated source files belong to the prepared baseline and caches do not', async t => {
  const f = await ready(t);
  f.state.afterInstall = async cwd => {
    await fs.writeFile(path.join(cwd, 'version.py'), '__version__ = "synthetic"\n');
    await fs.mkdir(path.join(cwd, '__pycache__'));
    await fs.writeFile(path.join(cwd, '__pycache__/calc.pyc'), 'synthetic bytecode');
  };
  const workspace = await f.provider.prepare(f.task, f.scope, await f.run());
  assert.ok(workspace.files.includes('version.py'));
  assert.ok(!workspace.files.some(file => file.includes('__pycache__')));
  assert.equal(await f.git(workspace.cwd, ['status', '--porcelain=v1']), '');
});

test('pytest editable installs receive the declared version without importing upstream Git tags', async t => {
  const f = await fixture(t), ctx = await f.run();
  await prepareEnvironment({ ...f.entry, repo: 'pytest-dev/pytest', version: '7.2',
    requirements: { ...f.entry.requirements, installEditable: true } }, f.repo, ctx);
  const pip = f.state.calls.filter(call => call.args[2]?.includes('runpy.run_module'));
  assert.equal(pip.length, 3); assert.ok(pip.every(call => call.args[5] === '7.2'));
  assert.ok(pip[0].args[2].includes('SETUPTOOLS_SCM_PRETEND_VERSION'));
});

test('a machine snapshot failure is infrastructure, not a reference task rejection', async t => {
  const f = await ready(t);
  f.ctx.tools.snapshot = async () => { throw new Error('synthetic extraction failure'); };
  await assert.rejects(f.provider.prepare(f.task, f.scope, await f.run()), { infrastructure: true });
});
