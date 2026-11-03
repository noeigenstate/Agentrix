const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createOssSource } = require('../electron/features/lab-oss/index.cjs');
const manifest = require('../electron/features/lab-oss/manifest.json');
const { conformance } = require('./helpers/lab-provider-conformance.cjs');
const { requirementsHash, cacheKey, prepareEnvironment, environmentPath, pythonPath } = require('../electron/features/lab-oss/environment.cjs');
const { taskDirectory, sha256, readRow, patchPaths } = require('../electron/features/lab-oss/data.cjs');
const { locked } = require('../electron/features/lab-oss/cache.cjs');
const { caseKey } = require('../electron/features/lab-oss/pytest.cjs');
const { fixture, conformanceProvider, GOLD, HIDDEN, BEFORE } = require('./fixtures/lab-oss/fixture.cjs');

const originalFetch = globalThis.fetch, originalRequest = https.request, originalGet = https.get;
const denyNetwork = () => { throw new Error('Network is forbidden in OSS tests.'); };
before(() => { globalThis.fetch = denyNetwork; https.request = denyNetwork; https.get = denyNetwork; });
after(() => { globalThis.fetch = originalFetch; https.request = originalRequest; https.get = originalGet; });

const selection = { source: 'oss', repos: ['fixture/unit'], tasks: [{ id: 'oss-fixture-unit-1' }] };
async function ready(t, changeRow) {
  const f = await fixture(t);
  if (changeRow) {
    changeRow(f.row);
    f.entry.repo = f.row.repo;
    f.entry.url = 'https://github.com/' + f.row.repo + '.git';
    const raw = Buffer.from(JSON.stringify({ rows: [{ row_idx: 0, row: f.row, truncated_cells: [] }] }));
    f.entry.row = { ...f.entry.row, sha256: sha256(raw), bytes: raw.length };
    f.entry.sha256 = Object.fromEntries(['problem_statement', 'patch', 'test_patch'].map(key => [key, sha256(f.row[key])]));
    f.ctx.tools.download = async (url, destination) => { assert.equal(url, f.entry.row.url); await fs.writeFile(destination, raw); };
  }
  const provider = createOssSource({ manifest: f.manifest });
  const execute = f.session.execute.bind(f.session);
  // Keep the existing offline Python simulator, adapting its synthetic JUnit to real pytest phase events. Production
  // has no workspace report path; the old simulator's temporary report is consumed only in this test adapter.
  f.session.execute = async (file, args, options) => {
    if (f.state.execute || args[1] !== '-B') return execute(file, args, options);
    const target = path.join(options.cwd, '.fixture-junit.xml'), index = f.state.calls.length;
    const output = await execute(file, ['-I', '-c', args[3], '--junitxml=' + target, ...args.slice(5)], options);
    f.state.calls[index] = { file, args, ...options };
    let report;
    try { report = f.ctx.tools.junit(await fs.readFile(target, 'utf8')); }
    catch { report = { cases: [] }; }
    await fs.rm(target, { force: true });
    const ids = [...f.entry.FAIL_TO_PASS, ...f.entry.PASS_TO_PASS];
    const events = report.cases.flatMap(item => {
      const key = item.classname + '\0' + item.name;
      const id = ids.find(value => caseKey(value) === key) || 'tests/test_calc.py::' + item.name;
      return ['setup', 'call', 'teardown'].map(phase => [id, phase, phase === 'call' ? item.outcome : 'passed', false]);
    });
    const payload = { version: 1, code: output.code, events, collectionErrors: [], plugins: f.state.plugins || [] };
    return { ...output, stdout: 'AGENTRIX_OSS_EVIDENCE_' + args[4] + '=' + JSON.stringify(payload) + '\n' };
  };
  const chosen = { ...selection, repos: [f.entry.repo] };
  const { scope } = await provider.canonical(chosen, f.ctx);
  await provider.fetch(scope, f.ctx);
  const canonical = await provider.canonical(chosen, f.ctx);
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
  const jobs = f.state.calls.filter(call => call.args[1] === '-B');
  assert.equal(jobs.length, 2); assert.ok(jobs.every(call => call.network === false));
  assert.ok(jobs.every(call => call.args.includes('--confcutdir=' + path.join(ctx.workspaceRoot, 'worktree'))));
  assert.ok(jobs.every(call => !call.args.some(arg => arg.startsWith('--junitxml='))));
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
  const failed = await f.provider.grade(f.task, f.scope, ctx);
  assert.deepEqual([failed.passed, failed.score, failed.testsPassed, failed.testsTotal], [false, 0, 1, 2]);
  await fs.writeFile(path.join(workspace.cwd, 'tests/test_calc.py'), 'pretend everything passes');
  assert.equal((await f.provider.grade(f.task, f.scope, ctx)).passed, false, 'the hidden test is restored, not trusted');
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

test('grading rejects injected pytest configuration and a linked test file without following it', async t => {
  const f = await ready(t), reference = await f.provider.reference(f.task, f.scope, await f.run());
  const ctx = { ...await f.run(), reference }, workspace = await f.provider.prepare(f.task, f.scope, ctx);
  await fs.writeFile(path.join(workspace.cwd, 'conftest.py'), 'raise RuntimeError("injected")');
  await assert.rejects(f.provider.grade(f.task, f.scope, ctx), /tampered/);
  assert.match(await fs.readFile(path.join(ctx.artifactDirectory, 'tests.log'), 'utf8'), /conftest.py.*added/);
  await fs.rm(path.join(workspace.cwd, 'conftest.py'));
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

async function installedFixture(t, afterInstall) {
  const f = await ready(t);
  f.state.afterInstall = async cwd => {
    const site = path.join(path.dirname(cwd), '.oss-venv', 'Lib', 'site-packages');
    await fs.mkdir(site, { recursive: true });
    await fs.writeFile(path.join(site, 'prepared.py'), 'PREPARED = True\n');
    await afterInstall?.(site, cwd);
  };
  const reference = await f.provider.reference(f.task, f.scope, await f.run());
  const ctx = { ...await f.run(), reference }, workspace = await f.provider.prepare(f.task, f.scope, ctx);
  return { ...f, ctx, workspace, site: path.join(environmentPath(ctx), 'Lib', 'site-packages') };
}

test('a model-added pth file is a logged run error before Python can execute it', async t => {
  const f = await installedFixture(t), before = f.state.calls.length;
  await fs.writeFile(path.join(f.site, 'zz.pth'), 'import _pytest; _pytest.compromised = True\n');
  await assert.rejects(f.provider.grade(f.task, f.scope, f.ctx), /could not be graded/);
  assert.equal(f.state.calls.length, before, 'a tampered interpreter is never started');
  assert.match(await fs.readFile(path.join(f.ctx.artifactDirectory, 'tests.log'), 'utf8'), /zz.pth.*added/);
  assert.ok(path.relative(f.ctx.workspaceRoot, path.join(f.ctx.artifactDirectory, 'oss-environment.json')).startsWith('..' + path.sep));
});

test('the environment seal checks changed, removed and newly added files and directories', async t => {
  const f = await installedFixture(t), prepared = path.join(f.site, 'prepared.py');
  await fs.writeFile(prepared, 'PREPARED = False\n');
  await assert.rejects(f.provider.grade(f.task, f.scope, f.ctx), /could not be graded/);
  assert.match(await fs.readFile(path.join(f.ctx.artifactDirectory, 'tests.log'), 'utf8'), /prepared.py.*changed/);
  await fs.rm(prepared);
  await assert.rejects(f.provider.grade(f.task, f.scope, f.ctx), /could not be graded/);
  assert.match(await fs.readFile(path.join(f.ctx.artifactDirectory, 'tests.log'), 'utf8'), /prepared.py.*removed/);
  await fs.writeFile(prepared, 'PREPARED = True\n');
  await fs.mkdir(path.join(f.site, 'unsealed'));
  await assert.rejects(f.provider.grade(f.task, f.scope, f.ctx), /could not be graded/);
  assert.match(await fs.readFile(path.join(f.ctx.artifactDirectory, 'tests.log'), 'utf8'), /unsealed.*added/);
  await fs.rmdir(path.join(f.site, 'unsealed'));
  await fs.writeFile(path.join(f.workspace.cwd, 'calc.py'), BEFORE.replace('return 0', 'return 42'));
  assert.equal((await f.provider.grade(f.task, f.scope, f.ctx)).passed, true, 'ordinary source fixes remain editable');
});

const FORCE_PASS = 'import pytest\n@pytest.hookimpl(hookwrapper=True)\ndef pytest_runtest_makereport(item, call):\n' +
  '    outcome = yield\n    report = outcome.get_result()\n    report.outcome = "passed"\n    report.longrepr = None\n';

test('repository startup files and pytest options cannot change the grader', async t => {
  const f = await ready(t), reference = await f.provider.reference(f.task, f.scope, await f.run());
  const ctx = { ...await f.run(), reference }, workspace = await f.provider.prepare(f.task, f.scope, ctx);
  for (const file of ['conftest.py', 'unrelated/conftest.py', 'sitecustomize.py', 'src/usercustomize.py', 'src/zz.pth',
    'pytest.ini', '.pytest.ini', 'tox.ini', 'setup.cfg', 'pyproject.toml',
    'src/sitecustomize/__init__.py', 'src/usercustomize.cp312.pyd']) {
    const target = path.join(workspace.cwd, file);
    const payload = file === 'tox.ini' ? '[pytest]\naddopts = -p forged\n' : file === 'setup.cfg' ? '[tool:pytest]\naddopts = -p forged\n'
      : file === 'pyproject.toml' ? '[tool.pytest.ini_options]\naddopts = "-p forged"\n' : FORCE_PASS;
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, payload);
    const calls = f.state.calls.length;
    await assert.rejects(f.provider.grade(f.task, f.scope, ctx), /tampered/, file);
    assert.equal(f.state.calls.length, calls, 'the injected hook never runs: ' + file);
    assert.match(await fs.readFile(path.join(ctx.artifactDirectory, 'tests.log'), 'utf8'), /grading controls.*added/);
    await fs.rm(target);
  }
});

test('pre-placed and raced JUnit reports are errors and never result evidence', async t => {
  const f = await ready(t), reference = await f.provider.reference(f.task, f.scope, await f.run());
  const ctx = { ...await f.run(), reference }, workspace = await f.provider.prepare(f.task, f.scope, ctx);
  const report = path.join(ctx.workspaceRoot, '.oss-junit-forged.xml');
  const forged = '<testsuite>' + [...f.entry.FAIL_TO_PASS, ...f.entry.PASS_TO_PASS].map(id => {
    const [classname, name] = caseKey(id).split('\0');
    return '<testcase classname="' + classname + '" name="' + name + '"/>';
  }).join('') + '</testsuite>';
  await fs.writeFile(report, forged);
  const calls = f.state.calls.length;
  await assert.rejects(f.provider.grade(f.task, f.scope, ctx), /could not be graded/);
  assert.equal(f.state.calls.length, calls);
  assert.equal(await fs.readFile(report, 'utf8'), forged);
  await fs.rm(report);
  await fs.writeFile(path.join(workspace.cwd, 'calc.py'), BEFORE.replace('return 0', 'return 42'));
  const racing = { ...ctx, session: { ...ctx.session, async execute(...args) {
    const result = await ctx.session.execute(...args);
    await fs.writeFile(report, forged);
    return result;
  } } };
  await assert.rejects(f.provider.grade(f.task, f.scope, racing), /could not be graded/);
  assert.match(await fs.readFile(path.join(ctx.artifactDirectory, 'tests.log'), 'utf8'), /model-written OSS JUnit report/);
  await fs.rm(report);
  assert.equal((await f.provider.grade(f.task, f.scope, ctx)).passed, true);
});

test('parent pytest configuration and sourceless startup bytecode are rejected; model caches are discarded', async t => {
  const f = await ready(t), reference = await f.provider.reference(f.task, f.scope, await f.run());
  const ctx = { ...await f.run(), reference }, workspace = await f.provider.prepare(f.task, f.scope, ctx);
  await fs.writeFile(path.join(ctx.workspaceRoot, 'pytest.ini'), '[pytest]\naddopts = -p forged\n');
  await assert.rejects(f.provider.grade(f.task, f.scope, ctx), /could not be graded/);
  assert.match(await fs.readFile(path.join(ctx.artifactDirectory, 'tests.log'), 'utf8'), /outside the repository/);
  await fs.rm(path.join(ctx.workspaceRoot, 'pytest.ini'));
  await fs.writeFile(path.join(workspace.cwd, 'sitecustomize.pyc'), 'injected startup bytecode');
  await assert.rejects(f.provider.grade(f.task, f.scope, ctx), /tampered/);
  assert.match(await fs.readFile(path.join(ctx.artifactDirectory, 'tests.log'), 'utf8'), /sitecustomize.pyc.*added/);
  await fs.rm(path.join(workspace.cwd, 'sitecustomize.pyc'));
  await fs.writeFile(path.join(workspace.cwd, 'orphan.pyc'), 'injected bytecode');
  await assert.rejects(f.provider.grade(f.task, f.scope, ctx), /could not be graded/);
  assert.match(await fs.readFile(path.join(ctx.artifactDirectory, 'tests.log'), 'utf8'), /sourceless Python bytecode/);
  await fs.rm(path.join(workspace.cwd, 'orphan.pyc'));
  await fs.mkdir(path.join(workspace.cwd, '__pycache__'));
  const cached = path.join(workspace.cwd, '__pycache__', 'calc.cpython-312.pyc');
  await fs.writeFile(cached, 'injected cached code');
  await fs.writeFile(path.join(workspace.cwd, 'calc.py'), BEFORE.replace('return 0', 'return 42'));
  assert.equal((await f.provider.grade(f.task, f.scope, ctx)).passed, true);
  assert.equal(await fs.stat(cached).catch(() => null), null);
});

test('a pinned reference change to a grading control is accepted without allowing a different injected hook', async t => {
  const f = await ready(t, row => {
    row.patch += '\ndiff --git a/conftest.py b/conftest.py\nnew file mode 100644\n--- /dev/null\n+++ b/conftest.py\n' +
      '@@ -0,0 +1 @@\n+REFERENCE_CONTROL = True\n';
  });
  const reference = await f.provider.reference(f.task, f.scope, await f.run());
  assert.deepEqual(reference.controls.map(record => record.file), ['conftest.py']);
  const ctx = { ...await f.run(), reference }, workspace = await f.provider.prepare(f.task, f.scope, ctx);
  await ctx.tools.git(workspace.cwd, ['apply', path.join(taskDirectory(ctx, f.entry), 'fix.patch')]);
  assert.equal((await f.provider.grade(f.task, f.scope, ctx)).passed, true);
  assert.equal(await fs.readFile(path.join(workspace.cwd, 'conftest.py'), 'utf8'), 'REFERENCE_CONTROL = True\n');
  await fs.writeFile(path.join(workspace.cwd, 'conftest.py'), FORCE_PASS);
  await assert.rejects(f.provider.grade(f.task, f.scope, ctx), /tampered/);
});

test('alternative pytest source fixes and new regression tests are not restricted to reference files', async t => {
  const f = await ready(t, row => { row.repo = 'pytest-dev/pytest'; });
  f.state.plugins = ['src/_pytest/runner.py'];
  f.state.afterInstall = async cwd => {
    await fs.mkdir(path.join(cwd, 'src', '_pytest'), { recursive: true });
    await fs.writeFile(path.join(cwd, 'src', '_pytest', 'runner.py'), 'BASELINE_RUNNER = True\n');
    await fs.mkdir(path.join(cwd, 'src', 'flask'), { recursive: true });
    await fs.writeFile(path.join(cwd, 'src', 'flask', 'testing.py'), 'BASELINE_SOURCE = True\n');
  };
  const reference = await f.provider.reference(f.task, f.scope, await f.run());
  assert.deepEqual(reference.diffFiles, ['calc.py']);
  const ctx = { ...await f.run(), reference }, workspace = await f.provider.prepare(f.task, f.scope, ctx);
  await fs.writeFile(path.join(workspace.cwd, 'src', '_pytest', 'runner.py'), 'ALTERNATIVE_SUBJECT_FIX = True\n');
  await fs.writeFile(path.join(workspace.cwd, 'src', '_pytest', 'new_helper.py'), 'NEW_SUBJECT_HELPER = True\n');
  await fs.writeFile(path.join(workspace.cwd, 'src', 'flask', 'testing.py'), 'ALTERNATIVE_SOURCE_FIX = True\n');
  await fs.writeFile(path.join(workspace.cwd, 'tests', 'test_regression.py'), 'def test_new_regression(): assert False\n');
  await fs.writeFile(path.join(workspace.cwd, 'tests', '__init__.py'), 'raise RuntimeError("model test helper")\n');
  await fs.writeFile(path.join(workspace.cwd, 'calc.py'), BEFORE.replace('return 0', 'return 42'));
  assert.equal((await f.provider.grade(f.task, f.scope, ctx)).passed, true);
  for (const file of ['tests/test_regression.py', 'tests/__init__.py']) assert.equal(await fs.stat(path.join(workspace.cwd, file)).catch(() => null), null);
  assert.match(await fs.readFile(path.join(workspace.cwd, 'src/_pytest/runner.py'), 'utf8'), /ALTERNATIVE/);
  assert.match(await fs.readFile(path.join(workspace.cwd, 'src/_pytest/new_helper.py'), 'utf8'), /NEW_SUBJECT_HELPER/);
  f.state.plugins.push('src/_pytest/new_helper.py');
  assert.equal((await f.provider.grade(f.task, f.scope, ctx)).passed, true, 'a new subject plugin module is source too');
});

test('unsealed environment caches are removed before verification while sealed bytecode stays immutable', async t => {
  const f = await installedFixture(t, async site => {
    await fs.mkdir(path.join(site, '__pycache__'));
    await fs.writeFile(path.join(site, '__pycache__', 'prepared.cpython-312.pyc'), 'sealed bytecode');
  });
  const cached = path.join(f.site, '__pycache__', 'plugin.cpython-312-pytest-8.3.5.pyc');
  const pytestCache = path.join(environmentPath(f.ctx), '.pytest_cache');
  await fs.writeFile(cached, 'model-generated assertion rewrite cache');
  await fs.mkdir(path.join(pytestCache, 'v', 'cache'), { recursive: true });
  await fs.writeFile(path.join(pytestCache, 'v', 'cache', 'nodeids'), '[]');
  await fs.writeFile(path.join(f.workspace.cwd, 'calc.py'), BEFORE.replace('return 0', 'return 42'));
  assert.equal((await f.provider.grade(f.task, f.scope, f.ctx)).passed, true);
  assert.equal(await fs.stat(cached).catch(() => null), null);
  assert.equal(await fs.stat(pytestCache).catch(() => null), null);
  const sealed = path.join(f.site, '__pycache__', 'prepared.cpython-312.pyc');
  await fs.writeFile(sealed, 'changed sealed bytecode');
  await assert.rejects(f.provider.grade(f.task, f.scope, f.ctx), /could not be graded/);
  await fs.rm(sealed);
  await assert.rejects(f.provider.grade(f.task, f.scope, f.ctx), /could not be graded/);
  await fs.writeFile(sealed, 'sealed bytecode');
  for (const name of ['injected.py', 'zz.pth', 'injected.pyd']) {
    const file = path.join(f.site, '__pycache__', name);
    await fs.writeFile(file, 'not derived bytecode');
    await assert.rejects(f.provider.grade(f.task, f.scope, f.ctx), /could not be graded/);
    assert.equal(await fs.readFile(file, 'utf8'), 'not derived bytecode');
    await fs.rm(file);
  }
  assert.equal((await f.provider.grade(f.task, f.scope, f.ctx)).passed, true);
});

test('non-pytest configuration edits are allowed while pytest sections remain pinned', async t => {
  const f = await ready(t);
  f.state.afterInstall = async cwd => {
    await fs.writeFile(path.join(cwd, 'pyproject.toml'), '[project]\nversion = "1"\n[tool.pytest.ini_options]\naddopts = ""\n');
    await fs.writeFile(path.join(cwd, 'setup.cfg'), '[metadata]\nversion = 1\n[tool:pytest]\naddopts =\n');
    await fs.writeFile(path.join(cwd, 'tox.ini'), '[testenv]\ndeps = pytest\n[pytest]\naddopts =\n');
  };
  const reference = await f.provider.reference(f.task, f.scope, await f.run());
  const ctx = { ...await f.run(), reference }, workspace = await f.provider.prepare(f.task, f.scope, ctx);
  await fs.writeFile(path.join(workspace.cwd, 'calc.py'), BEFORE.replace('return 0', 'return 42'));
  for (const file of ['pyproject.toml', 'setup.cfg', 'tox.ini']) {
    const target = path.join(workspace.cwd, file), original = await fs.readFile(target, 'utf8');
    const edited = original.replace('version = "1"', 'version = "2"').replace('version = 1', 'version = 2').replace('deps = pytest', 'deps = pytest, coverage');
    await fs.writeFile(target, edited);
    assert.equal((await f.provider.grade(f.task, f.scope, ctx)).passed, true, file);
    assert.equal(await fs.readFile(target, 'utf8'), edited);
    await fs.writeFile(target, edited.replace('addopts =', 'addopts = -p forged'));
    await assert.rejects(f.provider.grade(f.task, f.scope, ctx), /tampered/, file);
    await fs.writeFile(target, edited);
  }
  await fs.writeFile(path.join(workspace.cwd, 'pyproject.toml'), '[project]\nversion = "2"\n[tool."pyte\\u0073t".ini_options]\naddopts = "-p forged"\n');
  await assert.rejects(f.provider.grade(f.task, f.scope, ctx), /tampered/);
});

test('reference-discovered plugins and their package initializers are pinned even with arbitrary module names', async t => {
  const f = await ready(t), file = 'custom_plugins/helper.py';
  f.state.plugins = [file];
  f.state.afterInstall = async cwd => {
    await fs.mkdir(path.join(cwd, 'custom_plugins'), { recursive: true });
    await fs.writeFile(path.join(cwd, file), 'PREPARED_PLUGIN = True\n');
  };
  const reference = await f.provider.reference(f.task, f.scope, await f.run());
  assert.deepEqual(reference.plugins, [file]);
  const ctx = { ...await f.run(), reference }, workspace = await f.provider.prepare(f.task, f.scope, ctx);
  await fs.writeFile(path.join(workspace.cwd, file), FORCE_PASS);
  await assert.rejects(f.provider.grade(f.task, f.scope, ctx), /tampered/);
  await fs.writeFile(path.join(workspace.cwd, file), 'PREPARED_PLUGIN = True\n');
  await fs.writeFile(path.join(workspace.cwd, 'custom_plugins', '__init__.py'), FORCE_PASS);
  await assert.rejects(f.provider.grade(f.task, f.scope, ctx), /tampered/);
  await fs.rm(path.join(workspace.cwd, 'custom_plugins', '__init__.py'));
  f.state.plugins.push('different_plugin.py');
  await fs.writeFile(path.join(workspace.cwd, 'calc.py'), BEFORE.replace('return 0', 'return 42'));
  await assert.rejects(f.provider.grade(f.task, f.scope, ctx), /could not be graded/);
  assert.match(await fs.readFile(path.join(ctx.artifactDirectory, 'tests.log'), 'utf8'), /plugin was not present/);
});

// Optional real-Python coverage stays offline: the caller supplies a local wheel directory. The normal suite never
// installs packages from the network or the owner's Python environment. Preparation still verifies and copies the
// production wheel cache, creates each real venv and seals it before any model edit.
test('real pytest proves reference and source fixes, and rejects pth, conftest and report tampering', {
  skip: process.env.AGENTRIX_OSS_TEST_WHEELS ? false : 'Set AGENTRIX_OSS_TEST_WHEELS to an offline pytest wheel directory.',
}, async t => {
  const f = await ready(t), execute = promisify(execFile), basePython = process.env.AGENTRIX_OSS_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const run = async (file, args, options = {}) => {
    try {
      const result = await execute(file, args, { cwd: options.cwd, timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      if (!Number.isInteger(error.code)) throw error;
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };
  const runtime = await run(basePython, ['-I', '-c', 'import sys, platform; print(sys.implementation.name + "-" + str(sys.version_info.major) + str(sys.version_info.minor) + "-" + platform.machine())']);
  assert.equal(runtime.code, 0);
  const directory = cacheKey(f.entry, f.ctx, runtime.stdout.trim()), records = [];
  await fs.mkdir(path.join(directory, 'wheels'), { recursive: true });
  for (const name of await fs.readdir(process.env.AGENTRIX_OSS_TEST_WHEELS)) {
    assert.match(name, /^[a-zA-Z0-9][a-zA-Z0-9_.+-]*\.whl$/);
    const bytes = await fs.readFile(path.join(process.env.AGENTRIX_OSS_TEST_WHEELS, name));
    await fs.writeFile(path.join(directory, 'wheels', name), bytes);
    records.push({ name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  await fs.writeFile(path.join(directory, 'wheels.json'), JSON.stringify(records));
  f.state.execute = async (file, args, options) => {
    const result = await run(file === 'python' || file === 'python3' ? basePython : file, args, options);
    if (options.log) await fs.writeFile(options.log, result.stdout + result.stderr);
    if (args[2]?.includes('runpy.run_module') && args[6] === 'install') {
      const site = await run(file, ['-I', '-c', 'import sysconfig; print(sysconfig.get_path("purelib"))']);
      assert.equal(site.code, 0);
      // Synthetic calc.py is a single-file project. This preparation-owned path entry has the same role as the
      // curated repositories' editable installs, and is covered by the complete environment seal.
      await fs.writeFile(path.join(site.stdout.trim(), 'fixture-source.pth'), options.cwd + '\n');
      const plugin = path.join(site.stdout.trim(), 'oss_fixture_plugin.py');
      await fs.writeFile(plugin, 'def pytest_configure(config):\n    assert True\n');
      const metadata = path.join(site.stdout.trim(), 'oss_fixture_plugin-1.0.dist-info');
      await fs.mkdir(metadata, { recursive: true });
      await fs.writeFile(path.join(metadata, 'METADATA'), 'Metadata-Version: 2.1\nName: oss-fixture-plugin\nVersion: 1.0\n');
      await fs.writeFile(path.join(metadata, 'entry_points.txt'), '[pytest11]\noss_fixture_plugin = oss_fixture_plugin\n');
      await fs.writeFile(path.join(metadata, 'RECORD'), 'oss_fixture_plugin.py,,\n');
    }
    return result;
  };
  const reference = await f.provider.reference(f.task, f.scope, await f.run());
  assert.equal(reference.total, 2, 'the real baseline fails F2P and the reference fix passes both groups');
  const ctx = { ...await f.run(), reference, testTimeoutMs: 30000 }, workspace = await f.provider.prepare(f.task, f.scope, ctx);
  assert.equal((await f.provider.grade(f.task, f.scope, ctx)).passed, false, 'the real unmodified source still fails');
  await fs.writeFile(path.join(workspace.cwd, 'calc.py'), BEFORE.replace('return 0', 'return 42'));
  const site = await run(pythonPath(ctx), ['-I', '-B', '-c', 'import sysconfig; print(sysconfig.get_path("purelib"))']);
  const ordinaryEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PYTEST_|PYTHONDONTWRITEBYTECODE$|PYTHONPYCACHEPREFIX$)/i.test(key)));
  const ordinary = await execute(pythonPath(ctx), ['-m', 'pytest', '--', ...f.entry.FAIL_TO_PASS, ...f.entry.PASS_TO_PASS], {
    cwd: workspace.cwd, env: ordinaryEnvironment, timeout: 30000, windowsHide: true,
  });
  assert.match(ordinary.stdout, /2 passed/);
  const rewriteCache = (await fs.readdir(path.join(site.stdout.trim(), '__pycache__'))).find(name => /^oss_fixture_plugin.*-pytest-.*\.pyc$/.test(name));
  assert.ok(rewriteCache, 'an ordinary model-side pytest run autoloaded and assertion-rewrote the entry-point plugin');
  await fs.writeFile(path.join(workspace.cwd, 'tests', 'test_model_regression.py'), 'def test_model_regression():\n    assert False\n');
  assert.equal((await f.provider.grade(f.task, f.scope, ctx)).passed, true, 'a legitimate alternative to the reference patch passes');
  assert.equal(await fs.stat(path.join(site.stdout.trim(), '__pycache__', rewriteCache)).catch(() => null), null);
  assert.equal(await fs.stat(path.join(workspace.cwd, 'tests', 'test_model_regression.py')).catch(() => null), null);
  await fs.writeFile(path.join(workspace.cwd, 'value_impl.py'), 'def corrected_value():\n    return 42\n');
  await fs.writeFile(path.join(workspace.cwd, 'calc.py'), 'from value_impl import corrected_value as value\n\ndef stable():\n    return 7\n');
  assert.equal((await f.provider.grade(f.task, f.scope, ctx)).passed, true, 'a fix in an added helper module is valid too');
  const unsafePytest = () => run(pythonPath(ctx), ['-I', '-B', '-c',
    'import os, sys, pytest; os.environ["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"; raise SystemExit(pytest.main(sys.argv[1:]))',
    '--rootdir=' + workspace.cwd, '--confcutdir=' + workspace.cwd, '-o', 'addopts=', '--',
    ...f.entry.FAIL_TO_PASS, ...f.entry.PASS_TO_PASS], { cwd: workspace.cwd });
  const pth = path.join(site.stdout.trim(), 'zz.pth'), marker = path.join(f.root, 'tamper-ran');
  await fs.writeFile(path.join(workspace.cwd, 'calc.py'), BEFORE);
  const payload = 'import pathlib, _pytest.runner; _pytest.runner.pytest_runtest_call = lambda item: None; pathlib.Path(' +
    JSON.stringify(marker) + ').write_text("executed")\n';
  await fs.writeFile(pth, payload);
  const calls = f.state.calls.length;
  await assert.rejects(f.provider.grade(f.task, f.scope, ctx), /could not be graded/);
  assert.equal(f.state.calls.length, calls);
  assert.equal(await fs.stat(marker).catch(() => null), null, 'the pth startup code was never executed');
  assert.match(await fs.readFile(path.join(ctx.artifactDirectory, 'tests.log'), 'utf8'), /zz.pth.*added/);
  assert.equal((await unsafePytest()).code, 0, 'without the integrity check the pth forges a real pytest pass');
  assert.equal(await fs.readFile(marker, 'utf8'), 'executed');
  await fs.rm(marker);
  await fs.rm(pth);
  await fs.writeFile(path.join(workspace.cwd, 'conftest.py'), FORCE_PASS);
  await assert.rejects(f.provider.grade(f.task, f.scope, ctx), /tampered/);
  assert.equal((await unsafePytest()).code, 0, 'without the integrity check the conftest hook also forges a real pass');
  await fs.rm(path.join(workspace.cwd, 'conftest.py'));
  const forged = path.join(ctx.workspaceRoot, '.oss-junit-preplaced.xml');
  await fs.writeFile(forged, '<testsuite tests="2" failures="0"/>');
  await assert.rejects(f.provider.grade(f.task, f.scope, ctx), /could not be graded/);
  await fs.rm(forged);
  await fs.writeFile(path.join(workspace.cwd, 'calc.py'), BEFORE.replace('return 0', 'return 42'));
  assert.equal((await f.provider.grade(f.task, f.scope, ctx)).passed, true);
});
