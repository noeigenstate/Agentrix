const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { spawn } = require('node:child_process');
const execute = promisify(execFile);
const { LabEngine } = require('../electron/features/lab/engine.cjs');
const { LabStore } = require('../electron/features/lab/store.cjs');
const { sampleHistory, profileTask, selectTasks } = require('../electron/features/lab/history.cjs');
const { experimentInput, sampleRequest, taskPasses, estimateExperiment, armEstimate } = require('../electron/features/lab/values.cjs');
const { testResult, reviewResult, restoreTests } = require('../electron/features/lab/grading.cjs');
const { dispatch, workerArguments, taskBrief } = require('../electron/features/lab/dispatch.cjs');
const { phaseEvidence, LabUsage } = require('../electron/features/lab/usage.cjs');
const { LabSession } = require('../electron/features/lab/session.cjs');
const { ownerState } = require('../electron/features/lab/workspace.cjs');
const { markedPids, killMarked } = require('../electron/features/lab/process.cjs');
const { sandboxProfile, cleanEnvironment } = require('../electron/features/lab/sandbox.cjs');
const prices = require('../electron/features/dashboard/prices.json');

const isolatedTest = (name, run) => test(name, {
  skip: process.platform !== 'darwin' ? 'macOS filesystem isolation is required' : false,
}, run);

function fakeDispatchModule() {
  const fs = require('node:fs');
  const path = require('node:path');
  const net = require('node:net');
  const { randomUUID } = require('node:crypto');
  function fakeModel() {
    const fs = require('node:fs'), path = require('node:path');
    const { spawn, spawnSync } = require('node:child_process');
    const config = JSON.parse(process.env.LAB_FAKE_CONFIG), cwd = process.cwd();
    const tell = value => process.stdout.write(JSON.stringify(value) + '\n');
    if (process.env.LAB_FAKE_HANG === 'yes' || process.env.LAB_FAKE_ORPHAN === 'yes') {
      const child = spawn('/usr/bin/nohup', [process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
        detached: true, stdio: 'ignore',
      });
      child.unref(); tell({ kind: 'orphan', pid: child.pid });
      if (process.env.LAB_FAKE_HANG === 'yes') { setInterval(() => {}, 1000); return; }
    }
    if (config.role === '审查') {
      const patch = fs.readFileSync('change.patch', 'utf8'), brief = fs.readFileSync(config.brief, 'utf8');
      if (/orchestrated|sonnet|gpt-6|LabArm|Approach:/.test(brief)) throw new Error('review was not blind');
      if (cwd.includes('/runs/') || /LEAD_NOTE_ONLY/.test(patch)) throw new Error('review has worker provenance');
      tell({ kind: 'answer', text: JSON.stringify({ issues: /\+module.exports = 2/.test(patch) ? 1 : 0, findings: [] }) });
      return;
    }
    const brief = fs.readFileSync(config.brief, 'utf8'), orchestrated = /Run the full pipeline:/.test(brief);
    if (process.env.LAB_FAKE_PROOF) {
      const forbidden = file => { try { fs.readFileSync(file); return false; } catch { return true; } };
      const git = args => spawnSync('git', args, { encoding: 'utf8' });
      const owner = process.env.LAB_FAKE_OWNER, fix = process.env.LAB_FAKE_FIX;
      const objects = git(['cat-file', '--batch-all-objects', '--batch-check']).stdout;
      const proof = {
        ownerUnreadable: forbidden(path.join(owner, 'src/a/value.cjs')),
        secretUnreadable: forbidden(config.secret),
        originalHelperUnreadable: forbidden(process.env.LAB_FAKE_ORIGINAL_HELPER),
        bootstrapRemoved: process.env.AGENTRIX_BOOTSTRAP === undefined,
        helperPathHidden: !brief.includes(process.env.LAB_FAKE_ORIGINAL_HELPER),
        noAlternates: !fs.existsSync(path.join(cwd, '.git/objects/info/alternates')),
        oneCommit: git(['rev-list', '--all', '--count']).stdout.trim() === '1',
        fixUnreachable: git(['cat-file', '-e', fix]).status !== 0 && !objects.includes(fix),
        ownerObjectsUnreadable: git(['--git-dir', path.join(owner, '.git'), 'cat-file', '--batch-all-objects', '--batch-check']).status !== 0,
        copiedDependencies: !fs.lstatSync('node_modules').isSymbolicLink(),
      };
      if (process.env.LAB_FAKE_OTHER) proof.otherWorktreeUnreadable =
        forbidden(path.join(process.env.LAB_FAKE_OTHER, 'src/a/value.cjs'));
      try {
        fs.linkSync(config.secret, 'key-copy');
        fs.readFileSync('key-copy'); proof.secretHardlinkUnreadable = false;
      } catch { proof.secretHardlinkUnreadable = true; }
      fs.rmSync('key-copy', { force: true });
      try { proof.keyPipeNotInherited = !fs.readFileSync(3, 'utf8').includes('sessionKey'); }
      catch { proof.keyPipeNotInherited = true; }
      fs.writeFileSync(path.join(cwd, 'node_modules/fixture-pkg/index.cjs'), 'module.exports = 77;\n');
      try { fs.writeFileSync(path.join(owner, 'node_modules/fixture-pkg/index.cjs'), 'bad'); proof.ownerDependencyProtected = false; }
      catch { proof.ownerDependencyProtected = true; }
      tell({ kind: 'proof', proof });
    }
    if (orchestrated) {
      const { execFileSync } = require('node:child_process');
      const childCwd = path.join(path.dirname(cwd), 'workers', 'a');
      execFileSync('git', ['worktree', 'add', '--detach', childCwd, 'HEAD'], { stdio: 'ignore' });
      fs.symlinkSync(fs.realpathSync('node_modules'), path.join(childCwd, 'node_modules'), 'dir');
      const entry = /entrypoint for every model invocation: (.+)/.exec(brief)[1];
      const childBrief = path.join(path.dirname(config.out), 'child.md'), childOut = childBrief + '.out';
      fs.writeFileSync(childBrief, 'Implement the requested change yourself.');
      const result = spawnSync(process.execPath, [entry, 'codex', '--role', '执行', '--title', 'Build fixture',
        '--model', 'gpt-6.1-sol', '--effort', 'max', '--fast', '--cwd', childCwd, '--brief', childBrief,
        '--out', childOut, '--kind', 'core', '--allow', 'src/**', '--skip-meeting', 'fixture comparison'],
        { encoding: 'utf8', timeout: 15000 });
      if (result.status !== 0) throw new Error(result.stdout + result.stderr);
      tell({ kind: 'nested', output: result.stdout });
      const childId = /\[dispatch\] ended ([\w-]+)/.exec(result.stdout)[1];
      const journal = path.join(cwd, '.git/agentrix'); fs.mkdirSync(journal, { recursive: true });
      fs.writeFileSync(path.join(journal, 'journal.jsonl'), [
        { type: 'end', id: 'plan', kind: 'investigate', activeMs: 120 },
        { type: 'end', id: 'meeting', role: '圆桌', activeMs: 50 },
        { type: 'end', id: childId, role: '执行', activeMs: 2000 },
        { type: 'end', id: 'review', role: '审查', activeMs: 200 },
        { type: 'finding', fixed: true }, { type: 'consolidate' },
      ].map(entry => JSON.stringify(entry)).join('\n'));
    }
    const code = process.env.LAB_FAKE_EARLY_EXIT === 'yes' ? 'process.exit(0);\n'
      : 'module.exports = ' + (config.model === 'gpt-6.1-sol' || orchestrated ? 3 : 2) + ';\n';
    fs.writeFileSync('src/a/value.cjs', code);
    fs.mkdirSync('src/new', { recursive: true }); fs.writeFileSync('src/new/helper.cjs', 'module.exports = true;\n');
    fs.writeFileSync('plan.md', 'LEAD_NOTE_ONLY\n');
    tell({ kind: 'answer', text: 'Done' });
  }
  module.exports.run = async function(args, { env, launch }) {
    const value = name => args[args.indexOf(name) + 1], id = randomUUID();
    const cwd = value('--cwd'), out = value('--out'), model = value('--model'), role = value('--role');
    const send = event => globalThis.__AGENTRIX_LAB_SINK(event);
    process.stdout.write('[lab-fixture-call] ' + JSON.stringify(args) + '\n');
    await send({ type: 'dispatch-start', id, agent: args[0], model, role, kind: value('--kind'), cwd,
      startedAt: Date.now(), title: value('--title'), fast: args.includes('--fast'), effort: value('--effort') });
    const child = launch(process.execPath, ['-e', '(' + fakeModel.toString() + ')()'], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, LAB_FAKE_CONFIG: JSON.stringify({
        model, role, out, brief: value('--brief'), secret: env.AGENTRIX_BOOTSTRAP,
      }) },
    });
    let output = '', errors = '';
    child.stdin.end();
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { errors += chunk; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      const lines = output.split('\n'); output = lines.pop();
      for (const line of lines) {
        const message = JSON.parse(line);
        if (message.kind === 'nested') process.stdout.write(message.output);
        if (message.kind === 'answer') fs.writeFileSync(out, message.text);
        if (message.kind === 'proof') process.stdout.write('[lab-fixture-proof] ' + JSON.stringify(message.proof) + '\n');
        if (message.kind === 'orphan') {
          process.stdout.write('[lab-fixture-orphan] ' + message.pid + '\n');
          if (env.LAB_FAKE_LIVE_COST) void send({ type: 'dispatch-rate', id,
            reportedCostUsd: Number(env.LAB_FAKE_LIVE_COST), outputTokens: 100, activeMs: 1000 });
        }
      }
    });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (code !== 0) { process.stderr.write(errors); return code || 1; }
    if (env.LAB_FAKE_PARTIAL) {
      const missing = randomUUID();
      await send({ type: 'dispatch-start', id: missing, model, role: '执行', startedAt: Date.now() });
      await send({ type: 'dispatch-end', id: missing, model, reportedCostUsd: null, outputTokens: null, endedAt: Date.now() });
    }
    await send({ type: 'dispatch-end', id, model, fast: args.includes('--fast'), exitCode: 0, reason: 'exit', endedAt: Date.now(),
      outputTokens: 40, totalOutputTokens: 50, activeMs: 2000, inputTokens: 100, cachedTokens: 10,
      reportedCostUsd: env.LAB_FAKE_UNKNOWN === 'yes' ? null : Number(env.LAB_FAKE_COST || 0.04),
      ...(env.LAB_FAKE_UNKNOWN === 'yes' ? { inputTokens: null, cachedTokens: null } : {}) });
    process.stdout.write('[dispatch] ended ' + id + ' ' + args[0] + ' model ' + (env.LAB_FAKE_MODEL || model) +
      ' effort high fast off · 20 token/s (40 output tokens in 2 s) · exit 0 reason ' +
      (env.LAB_FAKE_REASON || 'exit') + ' · scope ok · out ' + out + '\n');
    return 0;
  };
}
const fakeHelper = '(' + fakeDispatchModule.toString() + ')();\n';

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
  for (const folder of ['src/a', 'src/b', 'tests/fixtures', 'node_modules/fixture-pkg']) {
    await fs.mkdir(path.join(projectPath, folder), { recursive: true });
  }
  await fs.writeFile(path.join(projectPath, '.gitignore'), 'node_modules/\n');
  await fs.writeFile(path.join(projectPath, 'node_modules/fixture-pkg/index.cjs'), 'module.exports = 11;\n');
  await fs.writeFile(path.join(projectPath, 'tests/fixtures/helper.cjs'), 'module.exports = 1;\n');
  await fs.writeFile(path.join(projectPath, 'tests/fixtures/input.bin'), Buffer.from([128]));
  await fs.writeFile(path.join(projectPath, 'src/a/value.cjs'), 'module.exports = 0;\n');
  const testSource = expected => "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\n" +
    "test('value', () => assert.equal(require('../src/a/value.cjs') + require('./fixtures/helper.cjs'), " + expected + "));\n";
  await fs.writeFile(path.join(projectPath, 'tests/value.test.cjs'), testSource(1));
  await git('add', '.'); await git('commit', '-m', 'initial tree');
  const base = await git('rev-parse', 'HEAD');
  await fs.writeFile(path.join(projectPath, 'src/a/value.cjs'), 'module.exports = 3;\n');
  await fs.writeFile(path.join(projectPath, 'src/b/support.cjs'), 'module.exports = true;\n');
  await fs.writeFile(path.join(projectPath, 'tests/fixtures/helper.cjs'),
    "module.exports = require('node:fs').readFileSync(require('node:path').join(__dirname, 'input.bin'))[0];\n");
  await fs.writeFile(path.join(projectPath, 'tests/fixtures/input.bin'), Buffer.from([255]));
  await fs.writeFile(path.join(projectPath, 'tests/value.test.cjs'), testSource(258) +
    (options.twoTests ? "test('second', () => assert.equal(1, 1));\n" : ''));
  await git('add', '.'); await git('commit', '-m', 'Fix a cross-module calculation', '-m', 'Return the expected result while keeping the public interface.');
  const commit = await git('rev-parse', 'HEAD'), helper = path.join(directory, 'fake-dispatch.cjs');
  await fs.writeFile(helper, fakeHelper);
  const project = { id: 'p', name: 'Fixture', path: projectPath, kind: 'local' }, recorded = [];
  const records = { async read() { return []; }, run(...args) { recorded.push(args); } };
  const env = {
    ...cleanEnvironment(process.env), CODEX_HOME: path.join(directory, 'fake-codex'),
    CLAUDE_CONFIG_DIR: path.join(directory, 'fake-claude'),
  };
  for (const key of Object.keys(env)) if (/(?:API_KEY|OAUTH_TOKEN|ACCESS_TOKEN)$/.test(key)) delete env[key];
  const engine = new LabEngine({ userData, getProjects: () => [project], helper, prices, records, env, ...options });
  t.after(async () => { engine.close(); await engine.active?.done; });
  const task = await profileTask(projectPath, commit);
  const input = { projectId: 'p', source: 'history', tasks: [task], arms: ['sol', 'sonnet'], repeats: 1, budgetUsd: 10 };
  const logs = async () => {
    const values = [];
    for (const experiment of await engine.list()) for (const run of experiment.runs) for (const name of ['worker', 'review']) {
      const file = path.join(userData, 'lab', experiment.id, 'runs', run.id, 'artifacts', name + '.log');
      values.push(await fs.readFile(file, 'utf8').catch(() => ''));
    }
    return values.join('\n');
  };
  const readCalls = async () => [...(await logs()).matchAll(/^\[lab-fixture-call\] (.+)$/gm)].map(match => JSON.parse(match[1]));
  return { directory, userData, projectPath, project, git, base, commit, task, helper, engine, input, recorded, logs, readCalls };
}

async function orphanPid(f) {
  for (let i = 0; i < 250; i++) {
    const found = /\[lab-fixture-orphan\] (\d+)/.exec(await f.logs());
    if (found) return Number(found[1]);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The fake worker did not start its orphan.');
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
  assert.deepEqual(armEstimate('sol', records, prices), { minutes: 2, costUsd: 0.32, basis: 'default' });
  assert.equal(armEstimate('opus', records, prices).basis, 'default');
  assert.deepEqual(estimateExperiment({ tasks: [1, 2], arms: ['sol', 'sonnet'], repeats: 2 }, [], prices),
    { runs: 8, minutes: 44, costUsd: 4.16, basis: 'default' });
});

test('pass rule needs all hidden tests in a strict majority and never counts a tie or zero tests', () => {
  const pass = { state: 'passed', testsPassed: 2, testsTotal: 2 }, fail = { state: 'failed', testsPassed: 1, testsTotal: 2 };
  assert.equal(taskPasses([pass, pass, fail], 3), true); assert.equal(taskPasses([pass, fail], 2), false);
  assert.equal(taskPasses([{ state: 'passed', testsPassed: 0, testsTotal: 0 }], 1), false);
  assert.equal(taskPasses([{ ...pass, state: 'stopped' }], 1), false);
});

isolatedTest('a fake helper runs, grades and saves both arms without changing the original tree or team journal', async t => {
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
  assert.deepEqual(experiment.runs.map(run => run.outputTokens), [100, 100]); assert.equal(f.recorded.length, 0);
  for (const run of experiment.runs) {
    const folder = path.join(f.userData, 'lab', id, 'runs', run.id);
    const diff = await fs.readFile(path.join(folder, 'artifacts/change.patch'), 'utf8');
    assert.match(diff, /src\/new\/helper.cjs/); assert.doesNotMatch(diff, /node_modules/);
    assert.doesNotMatch(diff, /LEAD_NOTE_ONLY/);
    assert.match(await fs.readFile(path.join(folder, 'artifacts/tests.log'), 'utf8'), /# tests 1/);
    if (run.state === 'failed') assert.ok(run.error.includes(path.join(folder, 'artifacts/tests.log')));
    for (const name of ['worktree', 'repository.git']) assert.equal(await fs.stat(path.join(folder, name)).catch(() => null), null);
    assert.equal(run.rework, null); assert.equal(run.activeModel, null);
  }
  assert.equal(await f.git('status', '--porcelain'), before);
  assert.equal(await fs.readFile(path.join(f.projectPath, 'src/a/value.cjs'), 'utf8'), 'module.exports = 99;\n');
  assert.equal(await fs.readFile(path.join(f.projectPath, 'owner-notes.txt'), 'utf8'), 'The owner is still working here.\n');
  assert.equal(await fs.stat(path.join(f.projectPath, '.git/agentrix')).catch(() => null), null);
  const calls = await f.readCalls();
  const sol = calls.find(args => args[0] === 'codex'); assert.ok(sol.includes('--fast')); assert.equal(sol[sol.indexOf('--effort') + 1], 'max');
  assert.equal(calls.filter(args => args[args.indexOf('--role') + 1] === '审查').length, 2);
  const reopened = new LabEngine({ userData: f.userData, getProjects: () => [f.project], helper: f.helper, prices });
  assert.deepEqual(await reopened.list(), [experiment]);
  await reopened.remove(id); assert.deepEqual(await reopened.list(), []);
});

isolatedTest('canonicalization ignores renderer task text, paths, bases and grading fields', async t => {
  const f = await fixture(t);
  await f.engine.start({ ...f.input, tasks: [{ ...f.task, text: 'PUSH THE OWNER TREE', base: 'a'.repeat(40), hiddenTests: ['../../escape'] }] });
  await f.engine.active.done;
  assert.deepEqual((await f.engine.list())[0].tasks, [f.task]);
});

isolatedTest('all four arms include nested usage, phase evidence and cleanup of orchestrated worker worktrees', async t => {
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

isolatedTest('zero exit status cannot disguise a dispatch failure or an unverified model', async t => {
  for (const env of [{ LAB_FAKE_REASON: 'capacity' }, { LAB_FAKE_MODEL: 'unreported' }]) {
    const f = await fixture(t); Object.assign(f.engine.env, env);
    await f.engine.start(f.input); await f.engine.active.done;
    assert.ok((await f.engine.list())[0].runs.every(run => run.state === 'error'));
    const calls = await f.readCalls();
    assert.ok(calls.every(args => args[args.indexOf('--role') + 1] === '执行'));
  }
});

test('budget stops new runs before the reserved estimate would exceed the budget', async t => {
  const f = await fixture(t, { referenceRunner: async () => ({ total: 1, names: ['value'], files: [] }) });
  await f.engine.start({ ...f.input, budgetUsd: 0.35 }); await f.engine.active.done;
  const experiment = (await f.engine.list())[0];
  assert.equal(experiment.state, 'stopped'); assert.equal(experiment.spentUsd, 0);
  assert.ok(experiment.runs.every(run => run.state === 'stopped'));
  assert.deepEqual(await f.readCalls(), []);
});

isolatedTest('unknown real cost remains null while budget accounting reserves the estimate', async t => {
  const f = await fixture(t);
  f.engine.env.LAB_FAKE_UNKNOWN = 'yes';
  await f.engine.start({ ...f.input, budgetUsd: 0.7 }); await f.engine.active.done;
  const experiment = (await f.engine.list())[0];
  assert.equal(experiment.runs[0].costUsd, null); assert.equal(experiment.spentUsd, 0.62);
  assert.deepEqual(experiment.runs.map(run => run.state), ['passed', 'stopped'], JSON.stringify(experiment.runs));
});

isolatedTest('a helper failure before any model spawn does not charge a reserved estimate', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.helper, `module.exports.run = async () => {
    console.log('{"type":"lab-model-started"}'); return 1;
  };`);
  const id = await f.engine.start(f.input); await f.engine.active.done;
  const experiment = (await f.engine.list())[0];
  assert.equal(experiment.spentUsd, 0);
  assert.deepEqual(experiment.runs.map(run => run.state), ['error', 'error']);
  for (const run of experiment.runs) {
    const measured = JSON.parse(await fs.readFile(path.join(f.engine.store.folder(id), 'runs', run.id,
      'artifacts/measurements.json'), 'utf8'));
    assert.equal(measured.modelStarted, false); assert.deepEqual(measured.calls, []);
    assert.equal(run.costUsd, null); assert.equal('modelStarted' in run, false);
  }
  const reopened = new LabEngine({ userData: f.userData, getProjects: () => [f.project], prices });
  assert.equal((await reopened.list())[0].spentUsd, 0);
});

isolatedTest('an actually spawned fake model with lost usage still reserves the unknown cost', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.helper, `module.exports.run = async (args, { env, launch }) => {
    const child = launch(process.execPath, ['-e', 'process.stdout.write("fake-model");'], {
      env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  };`);
  await f.engine.start({ ...f.input, budgetUsd: 0.7 }); await f.engine.active.done;
  const experiment = (await f.engine.list())[0];
  assert.equal(experiment.spentUsd, 0.62);
  assert.deepEqual(experiment.runs.map(run => run.state), ['error', 'stopped']);
});

test('known spending survives even when the model-start flag is false', async t => {
  const f = await fixture(t, {
    referenceRunner: async () => ({ total: 1, names: ['value'], files: [] }),
    runner: async () => ({ state: 'error', costUsd: null, knownCostUsd: 0.1, modelStarted: false }),
  });
  await f.engine.start(f.input); await f.engine.active.done;
  assert.equal((await f.engine.list())[0].spentUsd, 0.2);
});

isolatedTest('stop kills detached descendants before worktree cleanup and marks the remaining runs stopped', async t => {
  const f = await fixture(t), pidFile = path.join(f.directory, 'child.pid');
  f.engine.env.LAB_FAKE_HANG = 'yes'; f.engine.env.LAB_FAKE_CHILD = pidFile;
  const id = await f.engine.start(f.input);
  const pid = await orphanPid(f);
  await assert.rejects(f.engine.remove(id), /请先停止/);
  await f.engine.stop(id);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const experiment = (await f.engine.list())[0]; assert.equal(experiment.state, 'stopped');
  assert.ok(experiment.runs.every(run => run.state === 'stopped'));
  for (const run of experiment.runs) assert.equal(await fs.stat(path.join(f.userData, 'lab', id, 'runs', run.id, 'worktree')).catch(() => null), null);
});

isolatedTest('a run timeout produces an error and ends its child before cleanup', async t => {
  const f = await fixture(t, { timeoutMs: 5000 }), pidFile = path.join(f.directory, 'child.pid');
  f.engine.env.LAB_FAKE_HANG = 'yes'; f.engine.env.LAB_FAKE_CHILD = pidFile;
  await f.engine.start({ ...f.input, budgetUsd: 0.7 }); await f.engine.active.done;
  const experiment = (await f.engine.list())[0]; assert.equal(experiment.runs[0].state, 'error');
  assert.match(experiment.runs[0].error, /超时/);
  const pid = await orphanPid(f); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('grading treats failed assertions as failed tests and unavailable or incomplete tests as errors', () => {
  const counts = '# Subtest: first\n# Subtest: second\n1..2\n# tests 2\n# pass 1\n# fail 1\n' +
    '# cancelled 0\n# skipped 0\n# todo 0\n';
  assert.deepEqual(testResult(counts, 1), { testsPassed: 1, testsTotal: 2, names: ['first', 'second'] });
  for (const value of [counts + 'ERR_MODULE_NOT_FOUND', counts.replace('# skipped 0', '# skipped 1'), counts.replace('# tests 2', '# tests 0'), '']) {
    assert.throws(() => testResult(value, 1));
  }
  assert.equal(reviewResult('{"issues":2}'), 2); assert.equal(reviewResult('```json\n{"issues":0}\n```'), 0);
  for (const answer of ['fine', '{"issues":-1}', '{"issues":null}']) assert.throws(() => reviewResult(answer));
});

test('unsupported platforms fail closed before starting any model workers', {
  skip: process.platform === 'darwin' ? 'macOS isolation is available' : false,
}, async t => {
  const f = await fixture(t);
  await assert.rejects(f.engine.start(f.input), /Secure lab execution is unavailable/);
  assert.deepEqual(await f.readCalls(), []);
  assert.equal(f.engine.active, null);
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

test('metering accepts only authenticated run events and ignores duplicates, text and late events', async t => {
  const directory = await temporary(t), usage = new LabUsage({ directory, socketDirectory: directory, project: { id: 'p' }, prices });
  usage.line('[dispatch] ended abc codex model gpt-6.1-sol effort max fast on · 20 token/s (40 output tokens in 2 s) · exit 0 reason exit');
  assert.equal(usage.measurements().outputTokens, null); assert.equal(usage.measurements().costUsd, null);
  const auth = { projectId: usage.projectId, sessionKey: usage.key };
  usage.accept({ ...auth, sessionKey: 'wrong', type: 'dispatch-start', id: 'forged', model: 'gpt-6.1-sol' });
  assert.equal(usage.calls.size, 0);
  usage.accept({ ...auth, type: 'dispatch-start', id: 'abc', model: 'gpt-6.1-sol' });
  usage.accept({ ...auth, type: 'dispatch-end', id: 'abc', outputTokens: 40, reportedCostUsd: 0.1, endedAt: 2 });
  usage.accept({ ...auth, type: 'dispatch-end', id: 'abc', outputTokens: 8000, reportedCostUsd: 200, endedAt: 3 });
  assert.equal(usage.measurements().costUsd, 0.1); assert.equal(usage.measurements().outputTokens, 40);
  assert.ok(usage.measurements().calls.every(call => call.source === 'lab'));
  await usage.close();
  usage.accept({ ...auth, type: 'dispatch-start', id: 'late', model: 'gpt-6.1-sol' });
  assert.equal(usage.calls.size, 1);
});

test('usage channels handle long profile paths and reject unauthenticated events', async t => {
  const root = await temporary(t), directory = path.join(root, 'long-profile-'.repeat(12));
  await fs.mkdir(directory);
  const usage = new LabUsage({ directory, socketDirectory: directory, project: { id: 'p' }, prices });
  await usage.start();
  try {
    const send = event => new Promise((resolve, reject) => {
      const socket = net.connect(usage.address); socket.on('error', reject); socket.on('close', resolve);
      socket.resume();
      socket.on('connect', () => socket.end(JSON.stringify(event) + '\n'));
    });
    await send({ type: 'dispatch-end', id: 'bad', projectId: 'p', sessionKey: 'wrong', endedAt: 2, reportedCostUsd: 1000 });
    assert.equal(usage.calls.size, 0);
    await send({ type: 'dispatch-start', id: 'good', projectId: usage.projectId, sessionKey: usage.key, model: 'gpt-6.1-sol' });
    await send({ type: 'dispatch-end', id: 'good', projectId: usage.projectId, sessionKey: usage.key, endedAt: 2, reportedCostUsd: 0.1, outputTokens: 2 });
    assert.equal(usage.measurements().costUsd, 0.1);
  } finally { await usage.close(); }
  if (usage.socketAlias) assert.equal(await fs.lstat(usage.socketAlias).catch(() => null), null);
  assert.equal(await fs.stat(path.join(directory, 'bootstrap.json')).catch(() => null), null);
});

test('stop during brief preparation cannot launch a worker afterwards', async t => {
  const directory = await temporary(t), controller = new AbortController();
  let launched = false;
  const session = {
    control: directory, workspaceRoot: directory, publicHelper: path.join(directory, 'must-not-start.cjs'),
    root: async () => { launched = true; throw new Error('must not launch'); },
  };
  const pending = dispatch({ arm: 'sol', cwd: directory, directory, helper: path.join(directory, 'must-not-start.cjs'),
    task: { text: 'No worker must start' }, session, usage: {}, signal: controller.signal });
  queueMicrotask(() => controller.abort());
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(launched, false);
  assert.equal(await fs.stat(path.join(directory, 'worker.log')).catch(() => null), null);
});

test('closing the lab during initial persistence prevents a late experiment launch', async t => {
  const f = await fixture(t, { referenceRunner: async () => ({ total: 1, names: ['value'], files: [] }) }), original = f.engine.store.save.bind(f.engine.store);
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
  assert.deepEqual(await f.readCalls(), []);
});

test('stop cancels the persisted reference stage without starting any model', async t => {
  let entered;
  const checking = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { referenceRunner: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('实验已停止。'), { name: 'AbortError' })), { once: true });
    entered();
  }) });
  const pending = f.engine.start(f.input).catch(error => error);
  await checking;
  const experiment = (await f.engine.list())[0];
  assert.equal(experiment.state, 'running'); assert.ok(experiment.runs.every(run => run.state === 'queued'));
  await f.engine.stop(experiment.id);
  assert.equal((await pending).name, 'AbortError');
  assert.equal((await f.engine.list())[0].state, 'stopped');
  assert.ok((await f.engine.list())[0].runs.every(run => run.state === 'stopped'));
  assert.deepEqual(await f.readCalls(), []);
});

isolatedTest('archives isolate owner refs, fix objects, other worktrees, dependencies and the metering capability', async t => {
  const f = await fixture(t), other = path.join(f.directory, 'other');
  await f.git('worktree', 'add', '--detach', other, 'HEAD');
  const before = await ownerState(f.projectPath);
  assert.match(await f.git('cat-file', '--batch-all-objects', '--batch-check'), new RegExp(f.commit));
  Object.assign(f.engine.env, {
    LAB_FAKE_PROOF: 'yes', LAB_FAKE_OWNER: f.projectPath, LAB_FAKE_FIX: f.commit,
    LAB_FAKE_OTHER: other, LAB_FAKE_ORIGINAL_HELPER: f.helper,
  });
  await f.engine.start(f.input); await f.engine.active.done;
  const experiment = (await f.engine.list())[0];
  assert.deepEqual(experiment.runs.map(run => run.state), ['passed', 'failed'], JSON.stringify(experiment.runs));
  const proofs = [...(await f.logs()).matchAll(/^\[lab-fixture-proof\] (.+)$/gm)].map(match => JSON.parse(match[1]));
  assert.equal(proofs.length, 2);
  for (const proof of proofs) for (const [name, passed] of Object.entries(proof)) assert.equal(passed, true, name);
  assert.deepEqual(await ownerState(f.projectPath), before);
  assert.equal(await fs.readFile(path.join(f.projectPath, 'node_modules/fixture-pkg/index.cjs'), 'utf8'), 'module.exports = 11;\n');
});

isolatedTest('owner changes halt the experiment with before and after evidence and preserve the owner edit', async t => {
  const f = await fixture(t), actual = f.engine.runner;
  let changed = false;
  f.engine.runner = options => actual({ ...options, changed(model) {
    if (model && !changed) {
      changed = true;
      require('node:fs').writeFileSync(path.join(f.projectPath, 'owner-edit.txt'), 'The owner edited this.\n');
    }
    options.changed(model);
  } });
  const id = await f.engine.start(f.input); await f.engine.active.done;
  const experiment = (await f.engine.list())[0], run = experiment.runs[0];
  assert.equal(experiment.state, 'error'); assert.equal(run.state, 'error'); assert.equal(experiment.runs[1].state, 'stopped');
  assert.match(run.error, /original project changed/);
  const artifacts = path.join(f.userData, 'lab', id, 'runs', run.id, 'artifacts');
  const before = JSON.parse(await fs.readFile(path.join(artifacts, 'owner-before.json'), 'utf8'));
  const after = JSON.parse(await fs.readFile(path.join(artifacts, 'owner-after.json'), 'utf8'));
  assert.notEqual(before.status, after.status);
  assert.equal(await fs.readFile(path.join(f.projectPath, 'owner-edit.txt'), 'utf8'), 'The owner edited this.\n');
  assert.equal((await f.readCalls()).filter(args => args[args.indexOf('--role') + 1] === '执行').length, 1);
});

isolatedTest('reference tests run once per task and restore changed helpers and binary fixtures', async t => {
  const f = await fixture(t), validate = f.engine.referenceRunner;
  let checks = 0;
  f.engine.referenceRunner = options => { checks++; return validate(options); };
  await f.engine.start({ ...f.input, repeats: 2 }); await f.engine.active.done;
  const experiment = (await f.engine.list())[0];
  assert.equal(checks, 1);
  assert.deepEqual(experiment.runs.map(run => run.state), ['passed', 'failed', 'passed', 'failed']);
  assert.ok(experiment.runs.every(run => run.testsTotal === 1));
});

isolatedTest('a failing reference rejects start with its reason and is excluded from the next sample', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.projectPath, 'src/a/value.cjs'), 'module.exports = 4;\n');
  await fs.writeFile(path.join(f.projectPath, 'tests/value.test.cjs'),
    "const { test } = require('node:test');\ntest('bad reference', () => { throw new Error('reference is broken'); });\n");
  await f.git('add', '.'); await f.git('commit', '-m', 'Invalid historical reference');
  const task = await profileTask(f.projectPath, await f.git('rev-parse', 'HEAD'));
  const failure = await f.engine.start({ ...f.input, tasks: [task] }).catch(error => error);
  assert.match(failure.message, /参考测试未通过[\s\S]*Invalid historical reference/);
  assert.deepEqual(await f.readCalls(), []); assert.equal(f.engine.active, null);
  const experiment = (await f.engine.list())[0];
  const log = path.join(f.engine.store.folder(experiment.id), 'references', task.id, 'tests.log');
  assert.equal(experiment.state, 'error'); assert.ok(experiment.runs.every(run => run.state === 'stopped'));
  assert.ok(failure.message.includes(log)); assert.ok(experiment.runs.every(run => run.error.includes(log)));
  assert.doesNotMatch(failure.message, /workspaces\/worktree/);
  assert.match(await fs.readFile(log, 'utf8'), /reference is broken/);
  const reopened = new LabEngine({ userData: f.userData, getProjects: () => [f.project], prices });
  assert.equal((await reopened.list())[0].state, 'error');
  assert.match(await fs.readFile(log, 'utf8'), /reference is broken/);
  const next = await f.engine.sample({ projectId: 'p', size: 3, preferShortComplex: true });
  assert.ok(next.every(candidate => candidate.id !== task.id));
});

isolatedTest('a reference needing Node and its package runs outside protected application dependencies', async t => {
  const f = await fixture(t);
  const app = path.join(f.projectPath, 'node_modules/electron/dist/fixture.app/Contents/MacOS/Electron');
  const bin = path.join(f.projectPath, 'node_modules/.bin');
  await fs.mkdir(path.dirname(app), { recursive: true }); await fs.mkdir(bin);
  await fs.writeFile(path.join(f.projectPath, 'node_modules/fixture-pkg/package.json'), '{"main":"index.cjs"}');
  for (const file of [app, path.join(bin, 'node')]) await fs.writeFile(file, '#!/bin/sh\nexit 42\n', { mode: 0o700 });
  const testFile = path.join(f.projectPath, 'tests/value.test.cjs');
  await fs.appendFile(testFile, "test('standalone Node and package', () => {\n" +
    "assert.equal(require('fixture-pkg'), 11); assert.equal(process.versions.electron, undefined);\n" +
    "const answer = require('node:child_process').execFileSync('node', ['-p', 'process.versions.electron || 42'], { encoding: 'utf8' });\n" +
    "assert.equal(answer.trim(), '42');\n});\n");
  await fs.writeFile(path.join(f.projectPath, 'src/b/support.cjs'), 'module.exports = false;\n');
  await f.git('add', '.'); await f.git('commit', '-m', 'Reference requires a standalone Node runtime and package');
  const task = await profileTask(f.projectPath, await f.git('rev-parse', 'HEAD'));
  const artifactDirectory = path.join(f.userData, 'lab', randomUUID(), 'references', task.id);
  const reference = await require('../electron/features/lab/runner.cjs').validateReference({
    project: f.project, task, socketDirectory: f.engine.store.directory, artifactDirectory, nodePath: app,
    env: { ...f.engine.env, PATH: bin + path.delimiter + f.engine.env.PATH },
  });
  assert.equal(reference.total, 2);
  assert.match(await fs.readFile(path.join(artifactDirectory, 'tests.log'), 'utf8'), /# pass 2/);
  assert.equal(await fs.stat(path.join(f.engine.store.directory, 'references')).then(async () =>
    (await fs.readdir(path.join(f.engine.store.directory, 'references'))).length), 0);
  assert.deepEqual(await f.readCalls(), []);
});

isolatedTest('a hidden test needing Electron distribution data retries the reference and gives every arm full dependencies', async t => {
  const f = await fixture(t), electron = path.join(f.projectPath, 'node_modules/electron');
  await fs.mkdir(path.join(electron, 'dist'), { recursive: true });
  await fs.writeFile(path.join(electron, 'package.json'), '{"main":"index.cjs"}');
  await fs.writeFile(path.join(electron, 'index.cjs'),
    "module.exports = require('node:fs').readFileSync(require('node:path').join(__dirname, 'dist/fixture.txt'), 'utf8');\n");
  await fs.writeFile(path.join(electron, 'dist/fixture.txt'), 'runtime fixture');
  await fs.appendFile(path.join(f.projectPath, 'tests/value.test.cjs'),
    "test('Electron distribution data', () => assert.equal(require('electron'), 'runtime fixture'));\n" +
    "test('pristine snapshot', () => { const fs = require('node:fs');\n" +
    "assert.equal(fs.existsSync('.reference-marker'), false); fs.writeFileSync('.reference-marker', 'attempted'); });\n");
  await fs.writeFile(path.join(f.projectPath, 'src/b/support.cjs'), 'module.exports = false;\n');
  await f.git('add', '.'); await f.git('commit', '-m', 'Hidden test needs Electron package data');
  const task = await profileTask(f.projectPath, await f.git('rev-parse', 'HEAD'));
  const validate = f.engine.referenceRunner;
  let reference;
  f.engine.referenceRunner = async options => (reference = await validate(options));
  const id = await f.engine.start({ ...f.input, tasks: [task] }); await f.engine.active.done;
  const experiment = (await f.engine.list())[0], artifacts = path.join(f.engine.store.folder(id), 'references', task.id);
  assert.equal(reference.electronDist, true); assert.equal(reference.total, 3);
  assert.match(await fs.readFile(path.join(artifacts, 'tests-compact.log'), 'utf8'), /ENOENT/);
  assert.match(await fs.readFile(path.join(artifacts, 'tests.log'), 'utf8'), /# pass 3/);
  assert.deepEqual(experiment.runs.map(run => [run.state, run.testsPassed, run.testsTotal]),
    [['passed', 3, 3], ['failed', 2, 3]]);
});

test('reference infrastructure cleanup errors do not blacklist a valid task', async t => {
  const f = await fixture(t, {
    referenceRunner: async () => { throw Object.assign(new Error('temporary cleanup failure'), { infrastructure: true }); },
  });
  await assert.rejects(f.engine.start(f.input), /temporary cleanup failure/);
  assert.equal(f.engine.referenceFailures.size, 0);
  const sample = await f.engine.sample({ projectId: 'p', size: 1, preferShortComplex: true });
  assert.equal(sample[0].id, f.task.id);
});

test('reference rejection goes through t with Chinese source text and preserves the task-specific reason', async t => {
  const seen = [];
  const f = await fixture(t, {
    referenceRunner: async () => { throw new Error('fixture reference reason'); },
    t(source, values) {
      seen.push(source);
      return source === '参考测试未通过，尚未启动模型。请换一组任务。' ? 'Translated reference rejection.' : source;
    },
  });
  await assert.rejects(f.engine.start(f.input), /Translated reference rejection\.[\s\S]*fixture reference reason/);
  assert.ok(seen.includes('参考测试未通过，尚未启动模型。请换一组任务。'));
});

isolatedTest('an early exit cannot pass a validated reference even with a zero process exit status', async t => {
  const f = await fixture(t, { twoTests: true });
  f.engine.env.LAB_FAKE_EARLY_EXIT = 'yes';
  await f.engine.start(f.input); await f.engine.active.done;
  const experiment = (await f.engine.list())[0];
  assert.ok(experiment.runs.every(run => run.state === 'error'));
  assert.ok(experiment.runs.every(run => /reference suite/.test(run.error)));
  for (const run of experiment.runs) {
    const log = path.join(f.engine.store.folder(experiment.id), 'runs', run.id, 'artifacts/tests.log');
    assert.ok(run.error.includes(log)); assert.match(await fs.readFile(log, 'utf8'), /reference suite/);
  }
  assert.ok((await f.readCalls()).every(args => args[args.indexOf('--role') + 1] === '执行'));
});

isolatedTest('normal dispatch completion sweeps a nohup grandchild before grading and cleanup', async t => {
  const f = await fixture(t); f.engine.env.LAB_FAKE_ORPHAN = 'yes';
  await f.engine.start(f.input); await f.engine.active.done;
  const pid = await orphanPid(f);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.deepEqual((await f.engine.list())[0].runs.map(run => run.state), ['passed', 'failed']);
});

isolatedTest('live authenticated spending stops the run and charges its known cost floor', async t => {
  const f = await fixture(t);
  Object.assign(f.engine.env, { LAB_FAKE_HANG: 'yes', LAB_FAKE_LIVE_COST: '2' });
  await f.engine.start({ ...f.input, budgetUsd: 1 }); await f.engine.active.done;
  const experiment = (await f.engine.list())[0];
  assert.equal(experiment.state, 'stopped');
  assert.deepEqual(experiment.runs.map(run => run.state), ['stopped', 'stopped']);
  assert.equal(experiment.runs[0].costUsd, null); assert.equal(experiment.spentUsd, 2);
  assert.match(experiment.runs[0].error, /预算/);
  const pid = await orphanPid(f);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

isolatedTest('partially unknown costs charge at least the known sum and lab records do not feed owner model estimates', async t => {
  const f = await fixture(t);
  Object.assign(f.engine.env, { LAB_FAKE_PARTIAL: 'yes', LAB_FAKE_COST: '0.9' });
  await f.engine.start(f.input); await f.engine.active.done;
  const experiment = (await f.engine.list())[0];
  assert.ok(experiment.runs.every(run => run.costUsd === null));
  assert.ok(Math.abs(experiment.spentUsd - 3.6) < 1e-9);
  const labOnly = [{ source: 'lab', model: 'gpt-6.1-sol', role: '执行', reason: 'exit',
    exitCode: 0, fast: true, activeMs: 1, reportedCostUsd: 10000 }];
  assert.deepEqual(armEstimate('sol', labOnly, prices), armEstimate('sol', [], prices));
  const measured = armEstimate('orchestrated', [], prices, { experiments: [{
    projectId: 'p', runs: [{ arm: 'orchestrated', state: 'passed', costUsd: 7, startedAt: 1000, endedAt: 61000 }],
  }], projectId: 'p' });
  assert.deepEqual(measured, { minutes: 1, costUsd: 7, basis: 'history' });
  assert.ok(armEstimate('orchestrated', [], prices).costUsd > armEstimate('opus', [], prices).costUsd);
});

test('startup kills reparented marked processes and removes stale repositories and workspaces', {
  skip: !['darwin', 'linux'].includes(process.platform) ? 'POSIX process markers are required' : false,
}, async t => {
  const f = await fixture(t), id = randomUUID(), runId = randomUUID();
  const directory = path.join(f.userData, 'lab', id, 'runs', runId);
  const privateDirectory = path.join(f.userData, 'lab/private', runId);
  await fs.mkdir(path.join(directory, 'repository.git'), { recursive: true });
  await fs.mkdir(path.join(directory, 'workspaces'), { recursive: true });
  await fs.mkdir(privateDirectory, { recursive: true });
  await fs.writeFile(path.join(privateDirectory, 'manifest.json'), JSON.stringify({ runId, directory }));
  const childCode = "const c=require('node:child_process').spawn('/usr/bin/nohup',[process.execPath,'-e'," +
    "'setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(c.pid);c.unref();";
  const result = await execute(process.execPath, ['-e', childCode], {
    env: { ...process.env, AGENTRIX_LAB_RUN: runId, AGENTRIX_LAB_JOB: randomUUID() },
  });
  const pid = Number(result.stdout.trim());
  t.after(() => killMarked(runId));
  assert.ok((await markedPids(runId)).includes(pid));
  await f.engine.store.save({
    ...f.input, id, createdAt: 1, state: 'running', spentUsd: 0,
    runs: [{ id: runId, state: 'running', activeModel: 'gpt-6.1-sol' }],
  });
  const restored = new LabEngine({ userData: f.userData, getProjects: () => [f.project], prices });
  assert.equal((await restored.list())[0].state, 'stopped');
  assert.deepEqual(await markedPids(runId), []);
  for (const file of [privateDirectory, path.join(directory, 'repository.git'), path.join(directory, 'workspaces')]) {
    assert.equal(await fs.stat(file).catch(() => null), null);
  }
});

test('the guardian closes its process group and detached descendants when the app IPC disconnects', {
  timeout: 10000, skip: process.platform !== 'darwin' ? 'macOS filesystem isolation is required' : false,
}, async t => {
  const directory = await fs.realpath(await temporary(t)), tools = path.join(directory, 'tools');
  const workspace = path.join(directory, 'workspace');
  await fs.mkdir(tools); await fs.mkdir(workspace);
  for (const name of ['executor.cjs', 'meter-sink.cjs']) {
    await fs.copyFile(path.join(__dirname, '../electron/features/lab', name), path.join(tools, name));
  }
  const runId = randomUUID(), job = randomUUID(), config = path.join(directory, 'host.json');
  const script = "const c=require('node:child_process').spawn('/usr/bin/nohup',[process.execPath,'-e'," +
    "'setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(c.pid);c.unref();setInterval(()=>{},1000);";
  await fs.writeFile(config, JSON.stringify({
    runId, job, cwd: workspace, executor: path.join(tools, 'executor.cjs'),
    profile: sandboxProfile({ labRoot: directory, readRoots: [workspace, tools], writeRoots: [workspace], protectedPaths: [] }),
    command: { file: process.execPath, args: ['-e', script] },
  }));
  const host = spawn(process.execPath, [path.join(__dirname, '../electron/features/lab/host.cjs'), config], {
    env: { ...cleanEnvironment(process.env), AGENTRIX_LAB_RUN: runId, AGENTRIX_LAB_JOB: job },
    detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => killMarked(runId));
  const done = new Promise((resolve, reject) => { host.once('error', reject); host.once('exit', resolve); });
  let errors = '';
  host.stderr.setEncoding('utf8'); host.stderr.on('data', value => { errors += value; });
  const pid = await new Promise((resolve, reject) => {
    host.stdout.once('data', value => resolve(Number(String(value).trim())));
    host.once('exit', () => reject(new Error('Guardian exited before the child started: ' + errors)));
  });
  host.disconnect();
  await done;
  assert.ok(pid > 0); assert.deepEqual(await markedPids(runId), []);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

isolatedTest('the real dispatch helper can load its private bundled runtime without exposing it to a model', async t => {
  const directory = await temporary(t), labRoot = path.join(directory, 'lab'), workspaceRoot = path.join(labRoot, 'workspace');
  await fs.mkdir(workspaceRoot, { recursive: true });
  const session = new LabSession({
    directory: workspaceRoot, labRoot, workspaceRoot, runId: randomUUID(),
    helper: path.join(__dirname, '../integration/dispatch.cjs'), protectedPaths: [],
    env: { ...cleanEnvironment(process.env), CODEX_HOME: path.join(directory, 'fake-codex'),
      CLAUDE_CONFIG_DIR: path.join(directory, 'fake-claude') },
  });
  try {
    await session.start();
    const result = await session.root(['codex', '--help'], { cwd: workspaceRoot });
    assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /Usage: node dispatch/);
  } finally { await session.close(); }
});
