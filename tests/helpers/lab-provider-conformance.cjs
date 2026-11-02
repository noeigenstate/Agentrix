// The Virtual Lab source contract (electron/features/lab/sources/contract.cjs) as one reusable check. Each provider's
// test calls conformance(provider, fixture) inside its "meets the source contract" test.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { assertProvider, LAB_ARMS, TASK_ID } = require('../../electron/features/lab/sources/contract.cjs');
const tools = require('../../electron/features/lab/sources/tools.cjs');
const { command } = require('../../electron/features/lab/process.cjs');
const { translate } = require('../../electron/i18n.cjs');

const METRICS = ['hidden-tests', 'resolved', 'tests'];
// Field names that would carry an answer to the model or the page.
const ANSWER_FIELD = /answer|gold|patch|solution/i;
const nullable = (value, type) => value === null || typeof value === type;
const count = value => Number.isInteger(value) && value >= 0;

// Runs commands directly with the lab's process runner: no sandbox, so for tests only. calls records each request.
function fakeSession({ nodePath = process.execPath } = {}) {
  return {
    nodePath, calls: [],
    execute(file, args, { cwd, timeoutMs, log, network = false } = {}) {
      this.calls.push({ file, args, cwd, network });
      return command(file, args, { cwd, timeoutMs, log });
    },
  };
}

function assertInfo(info, provider) {
  assert.equal(info.id, provider.id);
  assert.equal(typeof info.available, 'boolean');
  if (info.available) assert.equal(info.reason, null);
  else assert.ok(typeof info.reason === 'string' && info.reason.trim(), 'an unavailable source says why');
  assert.ok(METRICS.includes(info.metric));
  assert.equal(info.review, provider.review === 'diff');
  const { min, max, standard } = info.size;
  assert.ok([min, max, standard].every(Number.isInteger) && min >= 1 && min <= standard && standard <= max);
  assert.ok(Array.isArray(info.options));
  for (const option of info.options) {
    assert.ok(typeof option.id === 'string' && typeof option.name === 'string');
    assert.ok(nullable(option.detail, 'string') && nullable(option.license, 'string'));
    assert.ok(option.tasks === null || count(option.tasks));
  }
  assert.ok(info.manifest === null || typeof info.manifest.version === 'string' && /^[a-f0-9]{64}$/.test(info.manifest.sha256));
  if (info.published !== null) {
    const { label, url, asOf, harness, comparable, note, values } = info.published;
    assert.ok([label, asOf, harness].every(value => typeof value === 'string') && /^https:\/\//.test(url));
    assert.ok(typeof comparable === 'boolean' && nullable(note, 'string'));
    assert.ok(Object.entries(values).every(([arm, value]) => LAB_ARMS.includes(arm) && Number.isFinite(value)));
  }
  assert.ok(info.downloadBytes === null || count(info.downloadBytes));
  assert.ok(nullable(info.keyStored, 'boolean'));
}

// Neither a field named like an answer nor any of the fixture's secret strings may appear in what leaves main.
function assertNoAnswer(value, secrets, where) {
  const walk = item => {
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      assert.ok(!ANSWER_FIELD.test(key), `${where} carries the field ${key}`);
      walk(child);
    }
  };
  walk(value);
  const text = JSON.stringify(value);
  for (const secret of secrets) assert.ok(!text.includes(secret), `${where} contains a secret`);
}

function assertTasks(tasks, provider, where) {
  assert.ok(Array.isArray(tasks), where + ' is a list');
  assert.equal(new Set(tasks.map(task => task.id)).size, tasks.length, where + ' ids are unique');
  for (const task of tasks) {
    assert.ok(TASK_ID.test(task.id), `${where}: ${task.id} matches TASK_ID`);
    assert.equal(task.source, provider.id);
    if (provider.id !== 'history') assert.ok(task.id.startsWith(provider.id + '-'), `${task.id} carries its source`);
    for (const key of ['title', 'text', 'kind', 'why']) assert.equal(typeof task[key], 'string', `${task.id}.${key}`);
  }
}

async function assertWorkspaceClean(directory, secrets) {
  for (const entry of await fs.readdir(directory, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name);
    if (!entry.isFile() || path.relative(directory, file).split(path.sep).includes('.git')) continue;
    const content = await fs.readFile(file);
    for (const secret of secrets) assert.ok(!content.includes(secret), `${file} contains a secret`);
  }
}

// fixture: { query: LabSampleQuery, selection: LabSelection without tasks, secrets?: strings no task, description or
// workspace may hold (gold patch lines, hidden test text), ctx?: overrides of the provider context (fake tools,
// getProjects, credential), forged?: a well-formed id the provider does not know }. Resolves to { info, tasks, canonical }.
async function conformance(provider, fixture) {
  assertProvider(provider);
  const { query, selection, secrets = [] } = fixture;
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lab-conformance-')));
  try {
    const folder = async name => { await fs.mkdir(path.join(temporary, name)); return path.join(temporary, name); };
    const ctx = {
      signal: new AbortController().signal, t: (source, values) => translate('zh', source, values),
      cacheDirectory: await folder('cache'), tools, getProjects: () => [], platform: process.platform, credential: () => null,
      ...fixture.ctx,
    };
    const info = await provider.describe(ctx);
    assertInfo(info, provider);
    assertNoAnswer(info, secrets, 'describe()');
    const broken = () => { throw new Error('broken context'); };
    const failing = await provider.describe({
      ...ctx, cacheDirectory: path.join(temporary, 'missing'), getProjects: broken, credential: broken,
      tools: new Proxy({}, { get: broken }),
    });
    assertInfo(failing, provider);

    const tasks = await provider.sample(query, ctx);
    assertTasks(tasks, provider, 'sample()');
    assert.ok(tasks.length <= query.size);
    assert.deepEqual(await provider.sample(structuredClone(query), ctx), tasks, 'sample() is deterministic');
    assertNoAnswer(tasks, secrets, 'sample()');

    const forged = fixture.forged || (provider.id === 'history' ? 'f'.repeat(40) : provider.id + '-forged-0');
    const ids = tasks.map(task => ({ id: task.id }));
    for (const id of [forged, '../' + forged]) {
      await assert.rejects(provider.canonical({ ...selection, tasks: [...ids, { id }] }, ctx), `canonical() rejects ${id}`);
    }
    if (!tasks.length) return { info, tasks, canonical: null };

    const canonical = await provider.canonical({ ...selection, tasks: ids }, ctx);
    assert.ok(typeof canonical.scopeKey === 'string' && canonical.scopeKey && typeof canonical.scopeLabel === 'string');
    assertTasks(canonical.tasks, provider, 'canonical()');
    assert.deepEqual(canonical.tasks.map(task => task.id), tasks.map(task => task.id));
    assertNoAnswer(canonical.tasks, secrets, 'canonical()');

    await provider.fetch?.(canonical.scope, ctx);
    const runCtx = {
      ...ctx, workspaceRoot: await folder('workspaces'), artifactDirectory: await folder('artifacts'),
      session: fakeSession(), testTimeoutMs: 120000, reference: null,
    };
    const workspace = await provider.prepare(canonical.tasks[0], canonical.scope, runCtx);
    for (const key of ['cwd', 'baseline', 'real', 'gitDirectory']) assert.equal(typeof workspace[key], 'string', 'workspace.' + key);
    assert.ok(Array.isArray(workspace.files));
    const relative = path.relative(runCtx.workspaceRoot, workspace.real);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'the workspace stays in workspaceRoot');
    await assertWorkspaceClean(workspace.cwd, secrets);
    return { info, tasks, canonical };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

module.exports = { conformance, fakeSession };
