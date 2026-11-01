const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const execute = promisify(execFile);
const { LabEngine } = require('../electron/features/lab/engine.cjs');
const { LabStore } = require('../electron/features/lab/store.cjs');
const { sampleHistory, profileTask, selectTasks } = require('../electron/features/lab/history.cjs');
const { experimentInput, sampleRequest, taskPasses, estimateExperiment, armEstimate } = require('../electron/features/lab/values.cjs');
const { testResult, reviewResult, restoreTests } = require('../electron/features/lab/grading.cjs');
const { dispatch, workerArguments, taskBrief } = require('../electron/features/lab/dispatch.cjs');
const { phaseEvidence, LabUsage } = require('../electron/features/lab/usage.cjs');
const prices = require('../electron/features/dashboard/prices.json');

const fakeHelper = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const args = process.argv.slice(2), value = key => args[args.indexOf(key) + 1];
const cwd = value('--cwd'), out = value('--out'), model = value('--model'), role = value('--role'), id = randomUUID();
const config = JSON.parse(fs.readFileSync(process.env.AGENTRIX_BOOTSTRAP, 'utf8'));
const send = event => new Promise(resolve => {
  const socket = net.connect(config.pipeName);
  socket.on('error', resolve); socket.on('close', resolve);
  socket.on('connect', () => socket.end(JSON.stringify({ ...config, ...event }) + '\n'));
});
(async () => {
  if (process.env.LAB_FAKE_CALLS) fs.appendFileSync(process.env.LAB_FAKE_CALLS, JSON.stringify(args) + '\n');
  await send({ type: 'dispatch-start', id, agent: args[0], model, role, kind: value('--kind'), startedAt: Date.now(),
    title: value('--title'), cwd, fast: args.includes('--fast'), effort: value('--effort') });
  if (process.env.LAB_FAKE_HANG === 'yes') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: process.platform !== 'win32', stdio: 'ignore' });
    fs.writeFileSync(process.env.LAB_FAKE_CHILD, String(child.pid));
    setInterval(() => {}, 1000); return;
  }
  if (role === '审查') {
    const patch = fs.readFileSync(path.join(cwd, 'change.patch'), 'utf8');
    const brief = fs.readFileSync(value('--brief'), 'utf8');
    if (/orchestrated|sonnet|gpt-6|LabArm|Approach:/.test(brief)) throw new Error('review was not blind');
    fs.writeFileSync(out, JSON.stringify({ issues: /\+module.exports = 2/.test(patch) ? 1 : 0, findings: [] }));
  } else {
    const orchestrated = /Run the full pipeline:/.test(fs.readFileSync(value('--brief'), 'utf8'));
    if (orchestrated) {
      const childId = randomUUID(), childCwd = path.join(path.dirname(cwd), 'workers', 'a');
      execFileSync('git', ['worktree', 'add', '--detach', childCwd, 'HEAD'], { cwd, stdio: 'ignore' });
      const dependencies = fs.realpathSync(path.join(cwd, 'node_modules'));
      fs.symlinkSync(dependencies, path.join(childCwd, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      await send({ type: 'dispatch-start', id: childId, agent: 'codex', model: 'gpt-6.1-sol', role: '执行', kind: 'core', cwd: childCwd, startedAt: Date.now() });
      await send({ type: 'dispatch-end', id: childId, model: 'gpt-6.1-sol', outputTokens: 50, reportedCostUsd: 0.04, activeMs: 2000, endedAt: Date.now() });
      const journalDirectory = path.join(path.dirname(cwd), 'repository.git', 'agentrix');
      fs.mkdirSync(journalDirectory, { recursive: true });
      fs.writeFileSync(path.join(journalDirectory, 'journal.jsonl'), [
        { type: 'end', id: 'plan', kind: 'investigate', activeMs: 120 },
        { type: 'end', id: 'meeting', role: '圆桌', activeMs: 50 },
        { type: 'end', id: childId, role: '执行', activeMs: 2000 },
        { type: 'end', id: 'review', role: '审查', activeMs: 200 },
        { type: 'finding', fixed: true },
        { type: 'consolidate' },
      ].map(entry => JSON.stringify(entry)).join('\n'));
    }
    const correct = model === 'gpt-6.1-sol' || orchestrated;
    fs.writeFileSync(path.join(cwd, 'src/a/value.cjs'), 'module.exports = ' + (correct ? 3 : 2) + ';\n');
    fs.mkdirSync(path.join(cwd, 'src/new'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src/new/helper.cjs'), 'module.exports = true;\n');
    fs.writeFileSync(out, 'Done');
  }
  await send({ type: 'dispatch-end', id, model, fast: args.includes('--fast'), exitCode: 0, reason: 'exit', endedAt: Date.now(),
    outputTokens: 40, totalOutputTokens: 50, activeMs: 2000, inputTokens: 100, cachedTokens: 10,
    reportedCostUsd: process.env.LAB_FAKE_UNKNOWN === 'yes' ? null : 0.04,
    ...(process.env.LAB_FAKE_UNKNOWN === 'yes' ? { inputTokens: null, cachedTokens: null } : {}) });
  process.stdout.write('[dispatch] ended ' + id + ' ' + args[0] + ' model ' + (process.env.LAB_FAKE_MODEL || model) + ' effort high fast off · 20 token/s (40 output tokens in 2 s) · exit 0 reason ' + (process.env.LAB_FAKE_REASON || 'exit') + ' · scope ok · out ' + out + '\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

async function temporary(t) {
  const base = process.platform === 'darwin' ? path.join(os.homedir(), '.ctmp') : os.tmpdir();
  await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'lab-engine-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixture(t, options = {}) {
  const directory = await temporary(t), projectPath = path.join(directory, 'project'), userData = path.join(directory, 'data');
  await fs.mkdir(projectPath); await fs.mkdir(userData);
  const git = async (...args) => (await execute('git', ['-c', 'core.hooksPath=', '-c', 'user.name=Lab fixture', '-c', 'user.email=lab@example.invalid',
    ...args], { cwd: projectPath, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }, windowsHide: true })).stdout.trim();
  await git('init');
  for (const folder of ['src/a', 'src/b', 'tests', 'node_modules']) await fs.mkdir(path.join(projectPath, folder), { recursive: true });
  await fs.writeFile(path.join(projectPath, '.gitignore'), 'node_modules/\n');
  await fs.writeFile(path.join(projectPath, 'src/a/value.cjs'), 'module.exports = 0;\n');
  await fs.writeFile(path.join(projectPath, 'tests/value.test.cjs'), "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\ntest('value', () => assert.equal(require('../src/a/value.cjs'), 0));\n");
  await git('add', '.'); await git('commit', '-m', 'initial tree');
  const base = await git('rev-parse', 'HEAD');
  await fs.writeFile(path.join(projectPath, 'src/a/value.cjs'), 'module.exports = 3;\n');
  await fs.writeFile(path.join(projectPath, 'src/b/support.cjs'), 'module.exports = true;\n');
  await fs.writeFile(path.join(projectPath, 'tests/value.test.cjs'), "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\ntest('value', () => assert.equal(require('../src/a/value.cjs'), 3));\n");
  await git('add', '.'); await git('commit', '-m', 'Fix a cross-module calculation', '-m', 'Return the expected result while keeping the public interface.');
  const commit = await git('rev-parse', 'HEAD'), helper = path.join(directory, 'fake-dispatch.cjs');
  await fs.writeFile(helper, fakeHelper);
  const project = { id: 'p', name: 'Fixture', path: projectPath, kind: 'local' }, recorded = [], calls = path.join(directory, 'calls.jsonl');
  const records = { async read() { return []; }, run(...args) { recorded.push(args); } };
  const engine = new LabEngine({ userData, getProjects: () => [project], helper, prices, records,
    env: { ...process.env, LAB_FAKE_CALLS: calls }, ...options });
  t.after(async () => { engine.close(); await engine.active?.done; });
  const task = await profileTask(projectPath, commit);
  const input = { projectId: 'p', source: 'history', tasks: [task], arms: ['sol', 'sonnet'], repeats: 1, budgetUsd: 10 };
  return { directory, userData, projectPath, project, git, base, commit, task, helper, engine, input, recorded, calls };
}

test('history samples only source changes with executable Node tests and profiles modules without exposing a diff', async t => {
  const f = await fixture(t), original = await f.git('status', '--porcelain');
  const tasks = await sampleHistory(f.projectPath, { projectId: 'p', size: 3, preferShortComplex: true });
  assert.equal(tasks.length, 1); assert.deepEqual(tasks[0], f.task);
  assert.equal(f.task.base, f.base); assert.equal(f.task.commit, f.commit);
  assert.deepEqual(f.task.modules, ['src/a', 'src/b']); assert.deepEqual(f.task.hiddenTests, ['tests/value.test.cjs']);
  assert.match(f.task.why, /跨 2 个模块 · 改动 \d+ 行/); assert.match(f.task.text, /public interface/);
  assert.doesNotMatch(f.task.text, /diff --git|module.exports/);
  assert.deepEqual(await sampleHistory(f.projectPath, { projectId: 'p', size: 1, preferShortComplex: false, exclude: [f.commit] }), []);
  assert.equal(await f.git('status', '--porcelain'), original);
  await fs.writeFile(path.join(f.projectPath, 'tests/value.test.cjs'), "const { test } = require('vitest');\ntest('not node', () => {});\n");
  await fs.writeFile(path.join(f.projectPath, 'src/a/value.cjs'), 'module.exports = 4;\n');
  await f.git('add', '.'); await f.git('commit', '-m', 'unsupported test runner');
  assert.equal(await profileTask(f.projectPath, await f.git('rev-parse', 'HEAD')), null);
});

test('representative selection spreads modules and sizes and can prefer short complex tasks', () => {
  const tasks = [
    { id: 'large', modules: ['a'], linesChanged: 800 }, { id: 'short', modules: ['b', 'c'], linesChanged: 20 },
    { id: 'medium', modules: ['d'], linesChanged: 100 }, { id: 'duplicate', modules: ['b', 'c'], linesChanged: 22 },
  ];
  assert.equal(selectTasks(tasks, 1, true)[0].id, 'short');
  assert.equal(selectTasks([...tasks, { id: 'sweep', modules: Array.from({ length: 20 }, (_, i) => 'm' + i), linesChanged: 10000 }], 1, true)[0].id, 'short');
  assert.deepEqual(new Set(selectTasks(tasks, 3, true).map(task => task.id)), new Set(['short', 'large', 'medium']));
  assert.equal(selectTasks(tasks, 1, true, ['short'])[0].id, 'duplicate');
});

test('validation rejects unsupported sources, duplicate arms, forged commits, bounds and path-like ids', () => {
  const valid = { projectId: 'p', source: 'history', tasks: [{ commit: 'a'.repeat(40) }], arms: ['sol', 'opus'], repeats: 1, budgetUsd: 2 };
  for (const value of [null, {}, { ...valid, source: 'oss' }, { ...valid, arms: ['sol'] }, { ...valid, arms: ['sol', 'sol'] },
    { ...valid, repeats: 0 }, { ...valid, repeats: 6 }, { ...valid, budgetUsd: NaN }, { ...valid, budgetUsd: 0 },
    { ...valid, tasks: [{ commit: '../HEAD' }] }, { ...valid, name: '\nunsafe' }]) assert.throws(() => experimentInput(value));
  assert.doesNotThrow(() => experimentInput(valid));
  assert.throws(() => sampleRequest({ projectId: 'p', size: 11, preferShortComplex: true }));
  assert.throws(() => sampleRequest({ projectId: 'p', size: 1, preferShortComplex: true, exclude: ['../HEAD'] }));
});

test('estimate uses recorded model cost and active time when known and defaults otherwise', () => {
  const records = [{ model: 'gpt-6.1-sol', role: '执行', reason: 'exit', exitCode: 0, fast: true, activeMs: 60000, reportedCostUsd: 0.2 }];
  assert.deepEqual(armEstimate('sol', records, prices), { minutes: 1, costUsd: 0.2, basis: 'history' });
  assert.equal(armEstimate('opus', records, prices).basis, 'default');
  assert.deepEqual(estimateExperiment({ tasks: [1, 2], arms: ['sol', 'sonnet'], repeats: 2 }, [], prices),
    { runs: 8, minutes: 36, costUsd: 3.2, basis: 'default' });
});

test('pass rule needs all hidden tests in a strict majority and never counts a tie or zero tests', () => {
  const pass = { state: 'passed', testsPassed: 2, testsTotal: 2 }, fail = { state: 'failed', testsPassed: 1, testsTotal: 2 };
  assert.equal(taskPasses([pass, pass, fail], 3), true); assert.equal(taskPasses([pass, fail], 2), false);
  assert.equal(taskPasses([{ state: 'passed', testsPassed: 0, testsTotal: 0 }], 1), false);
  assert.equal(taskPasses([{ ...pass, state: 'stopped' }], 1), false);
});

test('a fake helper runs, grades and saves both arms without changing the original tree or team journal', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.projectPath, 'src/a/value.cjs'), 'module.exports = 99;\n');
  await fs.writeFile(path.join(f.projectPath, 'owner-notes.txt'), 'The owner is still working here.\n');
  const before = await f.git('status', '--porcelain');
  const id = await f.engine.start(f.input), done = f.engine.active.done;
  await assert.rejects(f.engine.start(f.input), /已有实验/); await done;
  const experiment = (await f.engine.list())[0];
  assert.equal(experiment.id, id); assert.equal(experiment.state, 'done');
  for (const run of experiment.runs.filter(run => run.state === 'error')) {
    t.diagnostic(await fs.readFile(path.join(f.userData, 'lab', id, 'runs', run.id, 'artifacts/tests.log'), 'utf8').catch(() => run.error));
  }
  assert.deepEqual(experiment.runs.map(run => run.state), ['passed', 'failed'], JSON.stringify(experiment.runs));
  assert.deepEqual(experiment.runs.map(run => [run.testsPassed, run.testsTotal, run.reviewIssues]), [[1, 1, 0], [0, 1, 1]]);
  assert.ok(Math.abs(experiment.spentUsd - 0.16) < 1e-8);
  assert.deepEqual(experiment.runs.map(run => run.outputTokens), [100, 100]); assert.equal(f.recorded.length, 4);
  for (const run of experiment.runs) {
    const folder = path.join(f.userData, 'lab', id, 'runs', run.id);
    const diff = await fs.readFile(path.join(folder, 'artifacts/change.patch'), 'utf8');
    assert.match(diff, /src\/new\/helper.cjs/); assert.doesNotMatch(diff, /node_modules/);
    assert.match(await fs.readFile(path.join(folder, 'artifacts/tests.log'), 'utf8'), /# tests 1/);
    for (const name of ['worktree', 'repository.git']) assert.equal(await fs.stat(path.join(folder, name)).catch(() => null), null);
    assert.equal(run.rework, null); assert.equal(run.activeModel, null);
  }
  assert.equal(await f.git('status', '--porcelain'), before);
  assert.equal(await fs.readFile(path.join(f.projectPath, 'src/a/value.cjs'), 'utf8'), 'module.exports = 99;\n');
  assert.equal(await fs.readFile(path.join(f.projectPath, 'owner-notes.txt'), 'utf8'), 'The owner is still working here.\n');
  assert.equal(await fs.stat(path.join(f.projectPath, '.git/agentrix')).catch(() => null), null);
  const calls = (await fs.readFile(f.calls, 'utf8')).trim().split('\n').map(JSON.parse);
  const sol = calls.find(args => args[0] === 'codex'); assert.ok(sol.includes('--fast')); assert.equal(sol[sol.indexOf('--effort') + 1], 'max');
  assert.equal(calls.filter(args => args[args.indexOf('--role') + 1] === '审查').length, 2);
  const reopened = new LabEngine({ userData: f.userData, getProjects: () => [f.project], helper: f.helper, prices });
  assert.deepEqual(await reopened.list(), [experiment]);
  await reopened.remove(id); assert.deepEqual(await reopened.list(), []);
});

test('canonicalization ignores renderer task text, paths, bases and grading fields', async t => {
  const f = await fixture(t);
  await f.engine.start({ ...f.input, tasks: [{ ...f.task, text: 'PUSH THE OWNER TREE', base: 'a'.repeat(40), hiddenTests: ['../../escape'] }] });
  await f.engine.active.done;
  assert.deepEqual((await f.engine.list())[0].tasks, [f.task]);
});

test('all four arms include nested usage, phase evidence and cleanup of orchestrated worker worktrees', async t => {
  const f = await fixture(t);
  const id = await f.engine.start({ ...f.input, arms: ['orchestrated', 'opus', 'sol', 'sonnet'] });
  await f.engine.active.done;
  const experiment = (await f.engine.list())[0], orchestrated = experiment.runs[0];
  assert.deepEqual(experiment.runs.map(run => run.state), ['passed', 'failed', 'passed', 'failed']);
  assert.ok(Math.abs(orchestrated.costUsd - 0.12) < 1e-8); assert.equal(orchestrated.outputTokens, 150);
  assert.equal(orchestrated.rework, 1);
  assert.deepEqual(orchestrated.phases.map(phase => phase.name), ['plan', 'roundtable', 'build', 'review']);
  const folder = path.join(f.userData, 'lab', id, 'runs', orchestrated.id);
  assert.match(await fs.readFile(path.join(folder, 'artifacts/journal.jsonl'), 'utf8'), /consolidate/);
  assert.equal(await fs.stat(path.join(folder, 'workers/a')).catch(() => null), null);
  assert.equal(await fs.stat(path.join(f.projectPath, 'node_modules')).then(stat => stat.isDirectory()), true);
});

test('zero exit status cannot disguise a dispatch failure or an unverified model', async t => {
  for (const env of [{ LAB_FAKE_REASON: 'capacity' }, { LAB_FAKE_MODEL: 'unreported' }]) {
    const f = await fixture(t); Object.assign(f.engine.env, env);
    await f.engine.start(f.input); await f.engine.active.done;
    assert.ok((await f.engine.list())[0].runs.every(run => run.state === 'error'));
    const calls = (await fs.readFile(f.calls, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(calls.every(args => args[args.indexOf('--role') + 1] === '执行'));
  }
});

test('budget stops new runs before the reserved estimate would exceed the budget', async t => {
  const f = await fixture(t);
  await f.engine.start({ ...f.input, budgetUsd: 0.35 }); await f.engine.active.done;
  const experiment = (await f.engine.list())[0];
  assert.equal(experiment.state, 'stopped'); assert.equal(experiment.spentUsd, 0);
  assert.ok(experiment.runs.every(run => run.state === 'stopped'));
  assert.equal(await fs.stat(f.calls).catch(() => null), null);
});

test('unknown real cost remains null while budget accounting reserves the estimate', async t => {
  const f = await fixture(t);
  f.engine.env.LAB_FAKE_UNKNOWN = 'yes';
  await f.engine.start({ ...f.input, budgetUsd: 0.7 }); await f.engine.active.done;
  const experiment = (await f.engine.list())[0];
  assert.equal(experiment.runs[0].costUsd, null); assert.equal(experiment.spentUsd, 0.5);
  assert.deepEqual(experiment.runs.map(run => run.state), ['passed', 'stopped'], JSON.stringify(experiment.runs));
});

test('stop kills detached descendants before worktree cleanup and marks the remaining runs stopped', async t => {
  const f = await fixture(t), pidFile = path.join(f.directory, 'child.pid');
  f.engine.env.LAB_FAKE_HANG = 'yes'; f.engine.env.LAB_FAKE_CHILD = pidFile;
  const id = await f.engine.start(f.input);
  for (let i = 0; i < 200 && !await fs.stat(pidFile).catch(() => null); i++) await new Promise(resolve => setTimeout(resolve, 20));
  const pid = Number(await fs.readFile(pidFile, 'utf8'));
  await assert.rejects(f.engine.remove(id), /请先停止/);
  await f.engine.stop(id);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const experiment = (await f.engine.list())[0]; assert.equal(experiment.state, 'stopped');
  assert.ok(experiment.runs.every(run => run.state === 'stopped'));
  for (const run of experiment.runs) assert.equal(await fs.stat(path.join(f.userData, 'lab', id, 'runs', run.id, 'worktree')).catch(() => null), null);
});

test('a run timeout produces an error and ends its child before cleanup', async t => {
  const f = await fixture(t, { timeoutMs: 5000 }), pidFile = path.join(f.directory, 'child.pid');
  f.engine.env.LAB_FAKE_HANG = 'yes'; f.engine.env.LAB_FAKE_CHILD = pidFile;
  await f.engine.start({ ...f.input, budgetUsd: 0.6 }); await f.engine.active.done;
  const experiment = (await f.engine.list())[0]; assert.equal(experiment.runs[0].state, 'error');
  assert.match(experiment.runs[0].error, /超时/);
  const pid = Number(await fs.readFile(pidFile, 'utf8')); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('grading treats failed assertions as failed tests and unavailable or incomplete tests as errors', () => {
  const counts = '# tests 2\n# pass 1\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n';
  assert.deepEqual(testResult(counts, 1), { testsPassed: 1, testsTotal: 2 });
  for (const value of [counts + 'ERR_MODULE_NOT_FOUND', counts.replace('# skipped 0', '# skipped 1'), counts.replace('# tests 2', '# tests 0'), '']) {
    assert.throws(() => testResult(value, 1));
  }
  assert.equal(reviewResult('{"issues":2}'), 2); assert.equal(reviewResult('```json\n{"issues":0}\n```'), 0);
  for (const answer of ['fine', '{"issues":-1}', '{"issues":null}']) assert.throws(() => reviewResult(answer));
});

test('hidden test restoration rejects linked parent directories and files', async t => {
  const f = await fixture(t), destination = path.join(f.directory, 'destination'); await fs.mkdir(destination);
  await fs.symlink(f.projectPath, path.join(destination, 'tests'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(restoreTests(f.projectPath, destination, f.task), /链接/);
  await fs.unlink(path.join(destination, 'tests')); await fs.mkdir(path.join(destination, 'tests'));
  await fs.symlink(path.join(f.projectPath, 'tests/value.test.cjs'), path.join(destination, 'tests/value.test.cjs'));
  await assert.rejects(restoreTests(f.projectPath, destination, f.task), /链接/);
});

test('phase measurements use journal evidence and leave unreported rework unknown', () => {
  const entries = [{ type: 'end', id: 'plan', kind: 'investigate', activeMs: 120 },
    { type: 'end', id: 'meet', role: '圆桌', activeMs: 50 }, { type: 'end', id: 'build', role: '执行', activeMs: 1000 },
    { type: 'end', id: 'review', role: '审查', activeMs: 200 }, { type: 'skip', id: 'fix', reason: 'review follow-up' },
    { type: 'end', id: 'fix', role: '执行', activeMs: 100 }, { type: 'finding', fixed: true }];
  const result = phaseEvidence(entries, []);
  assert.deepEqual(result.phases.map(phase => [phase.name, phase.ms]), [['plan', 120], ['roundtable', 50], ['build', 1000], ['review', 200], ['rework', 100]]);
  assert.equal(result.rework, 1); assert.deepEqual(phaseEvidence([], []), { phases: [], rework: null });
});

test('persisted running experiments are stopped on reload and store ids cannot escape userData', async t => {
  const directory = await temporary(t), store = new LabStore(directory), id = randomUUID();
  const experiment = { id, createdAt: 1, state: 'running', tasks: [], runs: [{ state: 'running', activeModel: 'sol' }, { state: 'queued' }] };
  await store.save(experiment);
  const engine = new LabEngine({ userData: directory, getProjects: () => [], prices });
  assert.ok((await engine.list())[0].runs.every(run => run.state === 'stopped' && run.activeModel === null));
  assert.equal((await engine.list())[0].state, 'stopped');
  assert.throws(() => store.folder('../escape')); await assert.rejects(engine.remove('../escape'));
});

test('orchestrated prompts require the complete pipeline and single arms prohibit model delegation', () => {
  const task = { text: 'A difficult change' };
  assert.match(taskBrief(task, 'orchestrated', '/helper', '/run'), /roundtable.*worker|worker.*roundtable/s);
  assert.match(taskBrief(task, 'orchestrated', '/helper', '/run'), /independent Opus architecture review/);
  assert.match(taskBrief(task, 'sonnet', '/helper', '/run'), /Do not delegate/);
  const args = workerArguments({ arm: 'sol', cwd: '/run', brief: '/brief', out: '/out', helper: '/helper' });
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-6.1-sol'); assert.ok(args.includes('--fast'));
});

test('usage end lines are a fallback, unknown cost is null and duplicate end events are ignored', async t => {
  const directory = await temporary(t), usage = new LabUsage({ directory, socketDirectory: directory, project: { id: 'p' }, prices });
  usage.line('[dispatch] ended abc codex model gpt-6.1-sol effort max fast on · 20 token/s (40 output tokens in 2 s) · exit 0 reason exit · scope ok');
  assert.equal(usage.measurements().outputTokens, 40); assert.equal(usage.measurements().costUsd, null);
  usage.accept({ type: 'dispatch-start', id: 'abc', model: 'gpt-6.1-sol' });
  usage.accept({ type: 'dispatch-end', id: 'abc', outputTokens: 40, reportedCostUsd: 0.1, endedAt: 2 });
  usage.accept({ type: 'dispatch-end', id: 'abc', outputTokens: 8000, reportedCostUsd: 200, endedAt: 3 });
  assert.equal(usage.measurements().costUsd, 0.1); assert.equal(usage.measurements().outputTokens, 40);
});

test('usage channels handle long profile paths and reject unauthenticated events', async t => {
  const root = await temporary(t), directory = path.join(root, 'long-profile-'.repeat(12));
  await fs.mkdir(directory);
  const usage = new LabUsage({ directory, socketDirectory: directory, project: { id: 'p' }, prices });
  await usage.start();
  try {
    const send = event => new Promise((resolve, reject) => {
      const socket = net.connect(usage.address); socket.on('error', reject); socket.on('close', resolve);
      socket.on('connect', () => socket.end(JSON.stringify(event) + '\n'));
    });
    await send({ type: 'dispatch-end', id: 'bad', projectId: 'p', sessionKey: 'wrong', endedAt: 2, reportedCostUsd: 1000 });
    assert.equal(usage.calls.size, 0);
    await send({ type: 'dispatch-end', id: 'good', projectId: 'p', sessionKey: usage.key, endedAt: 2, reportedCostUsd: 0.1, outputTokens: 2 });
    assert.equal(usage.measurements().costUsd, 0.1);
  } finally { await usage.close(); }
  if (usage.socketAlias) assert.equal(await fs.lstat(usage.socketAlias).catch(() => null), null);
  assert.equal(await fs.stat(path.join(directory, 'bootstrap.json')).catch(() => null), null);
});

test('stop during brief preparation cannot launch a worker afterwards', async t => {
  const directory = await temporary(t), controller = new AbortController();
  const pending = dispatch({ arm: 'sol', cwd: directory, directory, helper: path.join(directory, 'must-not-start.cjs'),
    task: { text: 'No worker must start' }, usage: { bootstrap: path.join(directory, 'bootstrap.json') }, signal: controller.signal });
  queueMicrotask(() => controller.abort());
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(await fs.stat(path.join(directory, 'worker.log')).catch(() => null), null);
});

test('closing the lab during initial persistence prevents a late experiment launch', async t => {
  const f = await fixture(t), original = f.engine.store.save.bind(f.engine.store);
  let release, saving;
  const entered = new Promise(resolve => { saving = resolve; });
  f.engine.store.save = async experiment => {
    if (!release) { await new Promise(resolve => { release = resolve; saving(); }); }
    return original(experiment);
  };
  const pending = f.engine.start(f.input);
  await entered; f.engine.close(); release();
  await assert.rejects(pending, /已关闭/);
  assert.equal(f.engine.active, null);
  assert.equal((await f.engine.list())[0].state, 'stopped');
  assert.equal(await fs.stat(f.calls).catch(() => null), null);
});
