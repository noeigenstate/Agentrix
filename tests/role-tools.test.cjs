const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createRoleTools, serve, TOOLS } = require('../integration/role-tools.cjs');
const { argumentsOf, run, dispatchEvent } = require('../integration/dispatch.cjs');

// A bootstrap with a mode file and live seats, as main writes them beside a session's bootstrap.
function session(t, mode, seats = { developer: { model: 'gpt-6.2-sol', effort: 'high', fast: true }, reviewer: { model: 'opus', effort: 'high' } }) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-role-tools-'));
  const cleanups = [];
  t.after(() => {
    try { for (const cleanup of cleanups) cleanup(); }
    finally { fs.rmSync(folder, { recursive: true, force: true }); }
  });
  const bootstrap = path.join(folder, 'boot.json');
  fs.writeFileSync(bootstrap, '{}');
  fs.writeFileSync(bootstrap + '.mode', mode + '\n');
  fs.writeFileSync(bootstrap + '.seats', JSON.stringify({ orchestrator: { model: 'opus', effort: 'high' }, ...seats }));
  return { env: { AGENTRIX_BOOTSTRAP: bootstrap }, folder, cleanups };
}

const { started: startEvent, ended: endEvent, running: runningEvent, failure: failEvent, stopped: stopEvent } =
  require('./helpers/dispatch-events.cjs');

// The engine stand-in records each call and emits the same wire events as the helper.
function engine(answers) {
  const calls = [];
  const run = async (args, context) => {
    calls.push(args);
    const events = await answers(args, context.onTiming, context);
    for (const event of [events ?? []].flat()) context.onEvent(event);
    return 0;
  };
  return { calls, run };
}

function gitFixture(project) {
  const git = (args, cwd = project) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  git(['init', '--quiet', '--template=']);
  fs.writeFileSync(path.join(project, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(project, 'source'), 'committed');
  git(['add', '--', 'source', '.gitignore']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '--no-gpg-sign', '-m', 'fixture']);
  return git;
}

test('native mode refuses every role and names conductor mode', async t => {
  const { env } = session(t, 'native'), fake = engine(() => []);
  const { tools } = createRoleTools({ env, cwd: os.tmpdir(), engine: fake.run });
  await assert.rejects(tools.start_role({ seat: 'developer', title: 'x', brief: 'y', allow: ['src/**'] }), /Conductor mode is off/);
  assert.equal(fake.calls.length, 0);
});

test('the versioned mode is authoritative, with the old mode used only when it is absent', async t => {
  const { env, folder } = session(t, 'conductor');
  const file = env.AGENTRIX_BOOTSTRAP + '.mode.env';
  const fake = engine(() => startEvent('mode-run'));
  const { tools } = createRoleTools({ env, cwd: folder, engine: fake.run });
  const task = { seat: 'reviewer', title: 'Inspect', brief: 'Read', readOnly: true };
  for (const fields of ['version=1\nmode=native', 'version=2\nmode=conductor']) {
    fs.writeFileSync(file, 'format=agentrix.session-mode\n' + fields + '\n');
    await assert.rejects(tools.start_role(task), /Conductor mode is off/);
  }
  fs.unlinkSync(env.AGENTRIX_BOOTSTRAP + '.mode');
  fs.writeFileSync(file, 'format=agentrix.session-mode\nversion=1\nmode=conductor\n');
  assert.equal((await tools.start_role(task)).id, 'mode-run');
  assert.equal(fake.calls.length, 1);
});

test('start_role launches the seat on its own agent in the background and checks scope', async t => {
  const { env, folder } = session(t, 'conductor');
  const fake = engine(args => args.includes('--detach') ? startEvent('run-1', 'codex', { model: 'gpt-6.2-sol', effort: 'high', fast: true }) : []);
  const { tools } = createRoleTools({ env, cwd: os.tmpdir(), engine: fake.run });
  await assert.rejects(tools.start_role({ seat: 'developer', title: 'x', brief: 'y' }), /needs allow/);
  for (const seat of ['nonexistent', 'frontend', 'orchestrator']) {
    await assert.rejects(tools.start_role({ seat, title: 'x', brief: 'y', readOnly: true }), {
      message: `Seat ${seat} is not an enabled role on this team.`,
    });
  }
  assert.equal(fake.calls.length, 0);
  const started = await tools.start_role({ seat: 'developer', title: 'Fix it', brief: 'Do the fix', allow: ['src/**'], cwd: folder });
  assert.equal(started.id, 'run-1');
  const args = fake.calls.at(-1);
  assert.deepEqual(args.slice(0, 6), ['codex', '--detach', '--seat', 'developer', '--role', 'exec']);
  assert.ok(!args.includes('--model'), 'the engine takes the model from the seat');
  assert.deepEqual(args.slice(args.indexOf('--allow'), args.indexOf('--allow') + 2), ['--allow', 'src/**']);
  assert.equal(args[args.indexOf('--cwd') + 1], folder);
  assert.equal(fs.readFileSync(args[args.indexOf('--brief') + 1], 'utf8'), 'Do the fix');
});

test('start_role refuses empty or whitespace-only briefs and titles before calling the engine', async t => {
  const { env } = session(t, 'conductor'), fake = engine(() => startEvent('run-1'));
  const { tools } = createRoleTools({ env, engine: fake.run });
  const request = { seat: 'developer', title: 'Build', brief: 'Make the change', allow: ['src/**'] };
  for (const field of ['brief', 'title']) {
    for (const value of ['', ' \t\n']) {
      await t.test(`${field} ${JSON.stringify(value)}`, async () => {
        await assert.rejects(tools.start_role({ ...request, [field]: value }), { message: `A role needs a non-empty ${field}.` });
      });
    }
  }
  assert.equal(fake.calls.length, 0);
});

test('role wait and result return structured refusals while status summarizes the settled receipt', async t => {
  const { env, folder } = session(t, 'conductor');
  const refused = [{ action: 'Bash: run tests', reason: 'read_only' }];
  const fake = engine((args, onTiming) => {
    if (args.includes('--detach')) {
      fs.writeFileSync(args[args.indexOf('--out') + 1], '## Needs approval\nRun tests.');
      return startEvent('run-1', 'claude');
    }
    onTiming({ id: 'run-1', refused, endedAt: Date.now() });
    return endEvent('run-1', 'permission', { agent: 'claude', refused: { count: 1, first: refused[0] } });
  });
  const { tools } = createRoleTools({ env, cwd: folder, engine: fake.run });
  await tools.start_role({ seat: 'reviewer', title: 'Review', brief: 'Inspect', readOnly: true });
  assert.deepEqual((await tools.wait_roles())[0].refused, refused);
  const { roles: [summary] } = await tools.roles_status();
  assert.equal(summary.refusedCount, 1);
  assert.equal(summary.reason, 'permission');
  assert.equal(summary.refused, undefined);
  const result = await tools.role_result({ id: 'run-1' });
  assert.deepEqual(result.refused, refused);
  assert.match(result.answer, /^## Needs approval/);
  assert.equal(result.needsDecision, undefined);
});

test('role results and status expose a settled decision without reading the answer for status', async t => {
  const { env, folder } = session(t, 'conductor');
  const answer = 'Completed the independent work.\n\n## Needs decision\n\nOptions for the lead.';
  let out, settled = false;
  const fake = engine((args, onTiming) => {
    if (args.includes('--detach')) {
      out = args[args.indexOf('--out') + 1];
      return startEvent('run-1', 'claude');
    }
    if (!settled) return runningEvent('run-1');
    onTiming({ id: 'run-1', endedAt: Date.now(), needsDecision: true });
    return endEvent('run-1', 'exit', { agent: 'claude', needsDecision: true });
  });
  const { tools } = createRoleTools({ env, cwd: folder, engine: fake.run });
  await tools.start_role({ seat: 'reviewer', title: 'Review', brief: 'Inspect', readOnly: true });
  assert.equal((await tools.roles_status()).roles[0].needsDecision, undefined);
  settled = true;
  const { roles: [ended] } = await tools.roles_status();
  assert.equal(ended.needsDecision, true);
  assert.equal(ended.reason, 'exit');
  fs.writeFileSync(out, answer);
  const result = await tools.role_result({ id: 'run-1' });
  assert.equal(result.needsDecision, true);
  assert.equal(result.answer, answer);
});

test('start_role passes small through to the engine and refuses wide writable scopes before checkout', async t => {
  const { env, folder } = session(t, 'conductor'), fake = engine(() => startEvent('run-1'));
  const { tools } = createRoleTools({ env, cwd: folder, engine: fake.run });
  const request = { seat: 'developer', title: 'Inspect', brief: 'Inspect src/a.js.', small: true };
  const message = 'A small writable role needs one or two named files in allow, without wildcards.';
  for (const allow of [[], ['a', 'b', 'c'], ['src/**'], ['src/a?.js'], ['src/[ab].js'], ['src/{a,b}.js']]) {
    await assert.rejects(tools.start_role({ ...request, allow, worktree: 'wide' }), { message });
  }
  assert.equal(fake.calls.length, 0);
  assert.equal(TOOLS.find(tool => tool.name === 'start_role').inputSchema.properties.small.type, 'boolean');

  for (const scope of [{ readOnly: true }, { allow: ['src/a.js'] }, { allow: ['src/a.js', 'src/b.js'] }]) {
    await tools.start_role({ ...request, ...scope });
    const argv = fake.calls.at(-1), options = argumentsOf(argv, env);
    assert.equal(options.small, true);
    assert.equal(options.readOnly, !!scope.readOnly);
    assert.deepEqual(options.allow, scope.allow ?? []);
  }
  assert.throws(() => argumentsOf([...fake.calls.at(-1), '--allow', 'src/c.js'], env), { message });
  assert.throws(() => argumentsOf([...fake.calls[1], '--allow', 'src/**'], env), { message });
});

test('start_role resolves a developer specialty through its enabled base seat', async t => {
  const { env, folder } = session(t, 'conductor');
  const fake = engine(args => {
    const { agent, model, effort } = argumentsOf(args, env);
    return startEvent('run-1', agent, { model, effort });
  });
  const { tools } = createRoleTools({ env, cwd: folder, engine: fake.run });
  const started = await tools.start_role({ seat: 'developer/frontend', title: 'Inspect', brief: 'Read the code', readOnly: true });
  assert.deepEqual(started, { id: 'run-1', seat: 'developer/frontend',
    started: 'codex model gpt-6.2-sol effort high fast unreported · routing ok · pid 7 session synthetic' });
});

test('start_role returns the engine error for a missing working directory', async t => {
  const { env, folder } = session(t, 'conductor'), missing = path.join(folder, 'missing');
  const { tools } = createRoleTools({ env, cwd: folder, engine: (args, context) => run(args, {
    ...context, launch: () => assert.fail('A missing working directory must fail before launch'),
  }) });
  await assert.rejects(tools.start_role({ seat: 'developer', title: 'Build', brief: 'Make the change', allow: ['src/**'], cwd: missing }), /^Error: \[dispatch\] failed: ENOENT/);
  assert.deepEqual(await tools.roles_status(), { roles: [], earlierEnded: 0, omittedRecentEnded: 0 });
});

test('start_role creates local worktrees from HEAD, copies private dependencies and rejects invalid requests', async t => {
  const { env, folder, cleanups } = session(t, 'conductor');
  const project = path.join(folder, 'project');
  fs.mkdirSync(project);
  const fake = engine(args => startEvent(path.basename(args[args.indexOf('--cwd') + 1])));
  const { tools } = createRoleTools({ env, cwd: project, engine: fake.run });
  const request = { seat: 'developer', title: 'Build', brief: 'Implement the update', allow: ['source'], worktree: 'frontend' };
  await assert.rejects(tools.start_role({ ...request, readOnly: true }), /read-only role cannot create a worktree/);
  await assert.rejects(tools.start_role(request), /not a Git repository/);
  assert.equal(fake.calls.length, 0);

  const git = gitFixture(project);
  const head = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(project, 'source'), 'uncommitted');
  const modules = path.join(project, 'node_modules');
  fs.mkdirSync(modules);
  fs.writeFileSync(path.join(modules, 'fixture'), 'shared');

  const attempts = await Promise.allSettled([tools.start_role(request), tools.start_role(request)]);
  const created = attempts.filter(result => result.status === 'fulfilled');
  for (const { value } of created) cleanups.push(() => {
    git(['worktree', 'remove', '--force', value.cwd]);
  });
  assert.equal(created.length, 1);
  assert.equal(attempts.find(result => result.status === 'rejected').reason.message, 'Branch work/frontend already exists.');
  const { cwd, branch, base } = created[0].value;
  assert.equal(branch, 'work/frontend');
  assert.equal(base, git(['rev-parse', '--short', head]));
  assert.deepEqual(created[0].value.baseSource, { kind: 'project', cwd: git(['rev-parse', '--show-toplevel']), ref: 'HEAD' });
  assert.equal(path.dirname(cwd), os.tmpdir());
  assert.equal(git(['branch', '--show-current'], cwd), branch);
  assert.equal(git(['rev-parse', 'HEAD'], cwd), head);
  assert.equal(fs.readFileSync(path.join(cwd, 'source'), 'utf8'), 'committed');
  const workModules = path.join(cwd, 'node_modules');
  assert.equal(fs.lstatSync(workModules).isSymbolicLink(), false);
  fs.writeFileSync(path.join(workModules, 'fixture'), 'private');
  assert.equal(fs.readFileSync(path.join(modules, 'fixture'), 'utf8'), 'shared');
  assert.equal(fake.calls[0][fake.calls[0].indexOf('--cwd') + 1], cwd);
  assert.equal(git(['status', '--porcelain'], cwd), '');

  const linked = await tools.start_role({ ...request, worktree: 'second-link' });
  cleanups.push(() => {
    git(['worktree', 'remove', '--force', linked.cwd]);
  });
  assert.equal(git(['status', '--porcelain'], linked.cwd), '');
  const exclude = git(['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], linked.cwd);
  assert.equal(fs.readFileSync(exclude, 'utf8').split(/\r?\n/).filter(line => line === 'node_modules').length, 1);

  fs.unlinkSync(path.join(modules, 'fixture'));
  fs.rmdirSync(modules);
  const other = await tools.start_role({ ...request, worktree: 'backend' });
  cleanups.push(() => git(['worktree', 'remove', '--force', other.cwd]));
  assert.equal(other.branch, 'work/backend');
  assert.equal(fs.existsSync(path.join(other.cwd, 'node_modules')), false);
});

test('start_role bases a new worktree on the lead checkout or a verified explicit revision', async t => {
  const { env, folder, cleanups } = session(t, 'conductor');
  const project = path.join(folder, 'project'), lead = path.join(folder, 'lead');
  fs.mkdirSync(project);
  const git = gitFixture(project);
  const projectHead = git(['rev-parse', 'HEAD']);
  git(['worktree', 'add', '--quiet', '-b', 'lead-branch', lead]);
  cleanups.push(() => git(['worktree', 'remove', '--force', lead]));
  fs.writeFileSync(path.join(lead, 'source'), 'lead commit');
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '--no-gpg-sign', '-am', 'lead change'], lead);
  const leadHead = git(['rev-parse', 'HEAD'], lead);
  fs.writeFileSync(path.join(lead, 'source'), 'uncommitted lead change');
  const modules = path.join(project, 'node_modules');
  fs.mkdirSync(modules);
  fs.writeFileSync(path.join(modules, 'fixture'), 'shared');
  const fake = engine(args => startEvent(path.basename(args[args.indexOf('--cwd') + 1])));
  const { tools } = createRoleTools({ env, cwd: project, engine: fake.run, tempRoot: folder });
  const task = { seat: 'developer', title: 'Build', brief: 'Build it', allow: ['source'] };
  const blob = git(['rev-parse', 'HEAD:source']);
  for (const from of ['', '--all', 'missing-branch', blob]) {
    await assert.rejects(tools.start_role({ ...task, cwd: lead, worktree: 'invalid', from }), /from must/);
  }
  await assert.rejects(tools.start_role({ ...task, from: 'lead-branch' }), /requires worktree/);
  assert.equal(fake.calls.length, 0);
  assert.equal(git(['branch', '--list', 'work/invalid']), '');
  for (const [worktree, cwd, from, expected] of [
    ['lead', lead, undefined, leadHead],
    ['explicit-head', lead, 'HEAD', leadHead],
    ['explicit-branch', folder, 'lead-branch', leadHead],
    ['explicit-commit', lead, projectHead, projectHead],
    ['non-git', path.join(folder, 'missing'), undefined, projectHead],
  ]) {
    const started = await tools.start_role({ ...task, cwd, worktree, from });
    cleanups.push(() => {
      git(['worktree', 'remove', '--force', started.cwd]);
    });
    assert.equal(started.base, git(['rev-parse', '--short', expected]));
    assert.equal(git(['rev-parse', 'HEAD'], started.cwd), expected);
    assert.equal(fs.readFileSync(path.join(started.cwd, 'source'), 'utf8'), expected === leadHead ? 'lead commit' : 'committed');
    assert.equal(fs.readFileSync(path.join(started.cwd, 'node_modules', 'fixture'), 'utf8'), 'shared');
    assert.equal(fs.lstatSync(path.join(started.cwd, 'node_modules')).isSymbolicLink(), false);
  }
});

test('start_role defaults to the last role directory in this conversation when it still belongs to the project', async t => {
  const { env, folder, cleanups } = session(t, 'conductor');
  const project = path.join(folder, 'project'), previous = path.join(folder, 'previous'), foreign = path.join(folder, 'foreign');
  fs.mkdirSync(project);
  fs.mkdirSync(foreign);
  const git = gitFixture(project);
  gitFixture(foreign);
  const projectRoot = git(['rev-parse', '--show-toplevel']);
  const projectHead = git(['rev-parse', 'HEAD']);
  git(['worktree', 'add', '--quiet', '-b', 'previous-role', previous]);
  cleanups.push(() => { if (fs.existsSync(previous)) git(['worktree', 'remove', '--force', previous]); });

  let count = 0;
  const fake = engine(() => startEvent('role-' + ++count));
  const { tools } = createRoleTools({ env, cwd: project, engine: fake.run, tempRoot: folder });
  const task = { seat: 'developer', title: 'Build', brief: 'Build it', allow: ['source'] };
  await tools.start_role({ ...task, cwd: previous });
  fs.writeFileSync(path.join(previous, 'source'), 'previous role commit');
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '--no-gpg-sign', '-am', 'role change'], previous);
  const previousHead = git(['rev-parse', 'HEAD'], previous);

  const projectSource = { kind: 'project', cwd: projectRoot, ref: 'HEAD' };
  for (const [worktree, options, head, source] of [
    ['recent', {}, previousHead, { kind: 'last-role', cwd: previous, ref: 'HEAD' }],
    ['explicit-head', { from: 'HEAD' }, projectHead, projectSource],
    ['explicit-cwd', { cwd: project }, projectHead, { kind: 'cwd', cwd: project, ref: 'HEAD' }],
    ['foreign', {}, projectHead, projectSource],
    ['deleted', {}, projectHead, projectSource],
  ]) {
    if (worktree !== 'recent') await tools.start_role({ ...task, cwd: previous });
    if (worktree === 'foreign') await tools.start_role({ ...task, cwd: foreign });
    if (worktree === 'deleted') git(['worktree', 'remove', '--force', previous]);
    const started = await tools.start_role({ ...task, worktree, ...options });
    cleanups.push(() => git(['worktree', 'remove', '--force', started.cwd]));
    assert.deepEqual(started.baseSource, source, worktree);
    assert.equal(started.base, git(['rev-parse', '--short', head]), worktree);
    assert.equal(git(['rev-parse', 'HEAD'], started.cwd), head, worktree);
  }
});

test('start_role rolls back a failed worktree checkout or launch and allows a retry with the same suffix', async t => {
  const { env, folder, cleanups } = session(t, 'conductor');
  const git = gitFixture(folder);
  const modules = path.join(folder, 'node_modules');
  fs.mkdirSync(modules);
  fs.writeFileSync(path.join(modules, 'fixture'), 'shared');
  const makeTemp = fs.promises.mkdtemp;
  const worktrees = [];
  t.mock.method(fs.promises, 'mkdtemp', async (...args) => {
    const work = await makeTemp(...args);
    if (path.basename(work).startsWith('agentrix-role-worktree-')) worktrees.push(work);
    return work;
  });
  const baseline = git(['worktree', 'list', '--porcelain']);
  const request = { seat: 'developer', title: 'Build', brief: 'Build it', allow: ['source'], worktree: 'retry' };
  for (const [failure, message] of [
    ['checkout', 'Git could not check out the worktree branch.'],
    ['brief', 'Cannot write brief'],
    ['engine', '[dispatch] failed: fixture failure'],
    ['no-start', 'The role did not start.'],
    ['throw', 'Engine threw'],
  ]) {
    const attributes = path.join(folder, '.git', 'info', 'attributes');
    if (failure === 'checkout') {
      fs.mkdirSync(path.dirname(attributes), { recursive: true });
      git(['config', 'filter.fixture.required', 'true']);
      git(['config', 'filter.fixture.smudge', 'exit 1']);
      fs.writeFileSync(attributes, 'source filter=fixture\n');
    }
    const write = fs.writeFileSync;
    const mock = failure === 'brief' ? t.mock.method(fs, 'writeFileSync', (file, ...args) => {
      if (path.basename(file) === 'brief.md') throw new Error(message);
      return write(file, ...args);
    }) : undefined;
    const fake = engine(() => {
      assert.ok(!['checkout', 'brief'].includes(failure));
      if (failure === 'throw') throw new Error(message);
      return failure === 'engine' ? failEvent('fixture failure') : [];
    });
    const { tools } = createRoleTools({ env, cwd: folder, engine: fake.run });
    try {
      await assert.rejects(tools.start_role(request), { message });
      const work = worktrees.at(-1);
      assert.equal(fs.existsSync(work), false, failure);
      assert.equal(fs.existsSync(path.join(folder, '.git', 'worktrees', path.basename(work))), false, failure);
      assert.equal(git(['worktree', 'list', '--porcelain']), baseline, failure);
      assert.equal(git(['branch', '--list', 'work/retry']), '', failure);
      assert.equal(fs.readFileSync(path.join(modules, 'fixture'), 'utf8'), 'shared');
    } finally {
      mock?.mock.restore();
      if (failure === 'checkout') fs.unlinkSync(attributes);
      const work = worktrees.at(-1);
      if (work && fs.existsSync(work)) git(['worktree', 'remove', '--force', work]);
    }
  }
  const { tools } = createRoleTools({ env, cwd: folder, engine: engine(() => startEvent('retry')).run });
  const started = await tools.start_role(request);
  cleanups.push(() => {
    git(['worktree', 'remove', '--force', started.cwd]);
  });
  assert.equal(started.branch, 'work/retry');
});

test('a read-only Claude reviewer runs with dontAsk as a review', async t => {
  const { env } = session(t, 'conductor');
  const fake = engine(args => args.includes('--detach') ? startEvent('run-2', 'claude', { model: 'opus', effort: 'high', fast: false }) : []);
  const { tools } = createRoleTools({ env, cwd: os.tmpdir(), engine: fake.run });
  await tools.start_role({ seat: 'reviewer', title: 'Review', brief: 'Read the diff', readOnly: true });
  const args = fake.calls[0];
  assert.deepEqual(args.slice(0, 6), ['claude', '--detach', '--seat', 'reviewer', '--role', 'review']);
  assert.deepEqual(args.slice(args.indexOf('--permission'), args.indexOf('--permission') + 2), ['--permission', 'dontAsk']);
});

test('a Claude role reports the effort passed to its fake CLI when the CLI leaves it out', async t => {
  const { env, folder } = session(t, 'conductor', { reviewer: { model: 'sonnet', effort: 'medium' } });
  const { tools } = createRoleTools({ env, cwd: folder, engine: (args, { onEvent }) => run(args.filter(arg => arg !== '--detach'), {
    env: { AGENTRIX_SEATS: fs.readFileSync(env.AGENTRIX_BOOTSTRAP + '.seats', 'utf8') }, onEvent,
    resolveExecutable: (_agent, argv) => ({ file: 'fake-claude', args: argv }),
    launch: (_file, argv) => {
      assert.deepEqual(argv.slice(argv.indexOf('--effort'), argv.indexOf('--effort') + 2), ['--effort', 'medium']);
      const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake-session', model: 'claude-sonnet-5-5', fast_mode_state: 'off' }) + '\n');
        child.stderr.end(); child.exitCode = 0; child.emit('exit', 0, null); child.emit('close', 0, null);
      });
      return child;
    },
  }) });
  const started = await tools.start_role({ seat: 'reviewer', title: 'Review', brief: 'Read the diff', readOnly: true });
  assert.match(started.started, /model claude-sonnet-5-5 effort medium fast off · routing ok ·/);
});

test('local and SSH launches keep the configured Codex seat and use the project folder by default', async t => {
  const { env, folder } = session(t, 'conductor');
  for (const remote of [false, true]) {
    const fake = engine(args => {
      assert.equal(args[0], 'codex');
      assert.equal(args[args.indexOf('--cwd') + 1], folder);
      assert.equal(argumentsOf(args, env).model, 'gpt-6.2-sol');
      return startEvent('run-1', 'codex');
    });
    const { tools } = createRoleTools({ env: { ...env, ...(remote && { AGENTRIX_REMOTE_ROLE_TOOLS: '1' }) }, cwd: folder, engine: fake.run });
    const started = await tools.start_role({ seat: 'developer', title: 'Review', brief: 'Read the diff', readOnly: true });
    assert.equal(started.id, 'run-1');
    assert.equal(fake.calls.length, 1);
    if (remote) await assert.rejects(tools.answer_role({ id: 'run-1' }), /SSH roles have no interactive menu/);
  }
});

test('status, result and stop follow the engine and read the answer once the role ends', async t => {
  const { env } = session(t, 'conductor');
  let ended = false;
  const fake = engine(args => {
    if (args.includes('--detach')) return startEvent('run-3', 'codex', { model: 'gpt-6.2-sol', effort: 'high', fast: true });
    if (args[0] === 'wait') return ended ? endEvent('run-3') : runningEvent('run-3');
    return stopEvent('run-3');
  });
  const { tools } = createRoleTools({ env, cwd: os.tmpdir(), engine: fake.run });
  await tools.start_role({ seat: 'developer', title: 'Build', brief: 'b', allow: ['a/**'] });
  const { roles: [running] } = await tools.roles_status();
  assert.equal(running.state, 'running');
  assert.match(running.activity, /still running run-3/);
  const pending = await tools.role_result({ id: 'run-3' });
  assert.equal(fake.calls.at(-1).at(-1), '1');
  assert.equal(pending.state, 'running');
  assert.equal(pending.answer, null);
  assert.equal((await tools.stop_role({ id: 'run-3' })).stop, '[dispatch] stop queued run-3');
  const out = fake.calls[0][fake.calls[0].indexOf('--out') + 1];
  fs.writeFileSync(out, 'All done');
  ended = true;
  const result = await tools.role_result({ id: 'run-3' });
  assert.equal(result.state, 'ended');
  assert.equal(result.answer, 'All done');
  const callCount = fake.calls.length;
  const stopped = await tools.stop_role({ id: 'run-3' });
  assert.equal(stopped.state, 'ended');
  assert.equal(stopped.end, result.end);
  for (const tool of ['role_result', 'stop_role']) {
    await assert.rejects(tools[tool]({ id: 'other' }), { message: 'No role run other in this conversation.' });
  }
  assert.equal(fake.calls.length, callCount);
});

test('role timing follows the engine across delayed queries, running roles, stops and legacy receipts', async t => {
  const startedAt = Date.UTC(2026, 0, 1), confirmedAt = startedAt + 5000;
  for (const state of ['ended', 'running', 'stopped', 'legacy']) {
    await t.test(state, async t => {
      const { env, folder } = session(t, 'conductor');
      let now = startedAt - 2000, stopQueued = false;
      t.mock.method(Date, 'now', () => now);
      const endedAt = startedAt + 31000, id = 'run-1';
      const fake = engine((args, onTiming) => {
        if (args.includes('--detach')) {
          if (state !== 'legacy') onTiming({ id, startedAt, confirmedAt });
          now = confirmedAt + 3000;
          return startEvent(id, args[0]);
        }
        if (args[0] === 'stop') {
          stopQueued = true;
          now = startedAt + 40000;
          return stopEvent(id);
        }
        const settled = state === 'ended' || state === 'legacy' || stopQueued;
        if (state !== 'legacy') onTiming({ id, startedAt, confirmedAt, endedAt: settled ? endedAt : undefined });
        return settled ? endEvent(id, state === 'legacy' ? 'unknown' : stopQueued ? 'killed' : 'exit',
          state === 'legacy' ? { result: { source: 'legacy', out: null } } : {}) : runningEvent(id);
      });
      const { tools } = createRoleTools({ env, cwd: folder, engine: fake.run });
      await tools.start_role({ seat: state === 'stopped' ? 'reviewer' : 'developer', title: 'Inspect', brief: 'Read the code', readOnly: true });
      const args = fake.calls[0], answer = args[args.indexOf('--out') + 1];
      t.after(() => fs.rmSync(path.dirname(answer), { recursive: true, force: true }));
      fs.writeFileSync(answer, 'Final answer');

      now = startedAt + (state === 'running' ? 16000 : state === 'stopped' ? 30000 : 97000);
      const result = state === 'stopped' ? await tools.stop_role({ id })
        : state === 'running' ? (await tools.roles_status()).roles[0] : (await tools.wait_roles())[0];
      assert.equal(result.startSeconds, state === 'legacy' ? 10 : 7);
      assert.equal(result.seconds, state === 'running' ? 16 : state === 'legacy' ? 89 : 31);
      assert.equal(result.endedAt, state === 'running' ? null : new Date(state === 'legacy' ? now : endedAt).toISOString());
      if (state === 'legacy') assert.deepEqual({ legacy: result.legacy, reason: result.reason }, { legacy: true, reason: 'unknown' });
      if (state === 'stopped') assert.equal(result.stop, `[dispatch] stop queued ${id}`);
      const final = await tools.role_result({ id });
      assert.equal(final.seconds, result.seconds);
      assert.equal(final.endedAt, result.endedAt);
      assert.equal(final.answer, state === 'running' ? null : 'Final answer');
    });
  }
});

test('wait_roles selects running roles, returns on the first ending across folders and supports a timeout', async t => {
  const { env, folder } = session(t, 'conductor');
  const firstEnded = Promise.withResolvers();
  let next = 0;
  const fake = engine(async (args, _timing, { untilAny, signal }) => {
    if (args.includes('--detach')) return startEvent('run-' + ++next);
    assert.equal(untilAny, true);
    const [id] = args.slice(1);
    if (args.at(-1) === '240') {
      if (id === 'run-1') { await firstEnded.promise; return endEvent(id); }
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    } else assert.ok(['0', '2', '540'].includes(args.at(-1)));
    return runningEvent(id);
  });
  const { tools } = createRoleTools({ env, cwd: folder, engine: fake.run });
  assert.deepEqual(await tools.wait_roles(), []);
  const request = { seat: 'developer', title: 'Inspect', brief: 'Read the code', readOnly: true };
  await tools.start_role(request);
  await tools.start_role({ ...request, cwd: path.dirname(folder) });
  const waiting = tools.wait_roles();
  assert.deepEqual(fake.calls.slice(-2).map(args => [args[1], args[3], args.at(-1)]), [
    ['run-1', folder, '240'], ['run-2', path.dirname(folder), '240'],
  ]);
  firstEnded.resolve();
  const roles = await waiting;
  assert.deepEqual(roles.map(({ id, state }) => [id, state]), [['run-1', 'ended'], ['run-2', 'running']]);
  assert.match(roles[0].end, /ended run-1/);
  assert.equal(roles[1].activity, undefined);
  for (const options of [{ seconds: 2 }, { ids: ['run-2', 'run-2'], seconds: 540 }]) {
    const remaining = await tools.wait_roles(options);
    assert.deepEqual(remaining.map(({ id, state }) => [id, state]), [['run-2', 'running']]);
    assert.equal(fake.calls.at(-1).at(-1), String(options.seconds));
  }
  const [settled] = await tools.wait_roles({ ids: ['run-1', 'run-2'] });
  assert.equal(settled.state, 'ended');
  assert.equal(settled.end, undefined);
  assert.deepEqual(await tools.wait_roles({ ids: [] }), []);
  await assert.rejects(tools.wait_roles({ ids: ['other'] }), /No role run other in this conversation/);
  await assert.rejects(tools.wait_roles({ seconds: 541 }), /between 0 and 540/);
});

test('roles_status keeps the ten-minute boundary and role_result can still read older answers', async t => {
  const { env, folder } = session(t, 'conductor');
  const startedAt = Date.UTC(2026, 0, 1), endedAt = startedAt + 31000;
  let now = startedAt;
  t.mock.method(Date, 'now', () => now);
  let next = 0;
  const fake = engine((args, onTiming) => {
    if (args.includes('--detach')) {
      const out = args[args.indexOf('--out') + 1];
      t.after(() => fs.rmSync(path.dirname(out), { recursive: true, force: true }));
      fs.writeFileSync(out, 'Final answer');
      const id = `run-${++next}`;
      onTiming({ id, startedAt });
      return startEvent(id);
    }
    return args.slice(1, args.indexOf('--cwd')).map(id => {
      if (id === 'run-3') return runningEvent('run-3');
      onTiming({ id, endedAt });
      return endEvent(id);
    });
  });
  const { tools } = createRoleTools({ env, cwd: folder, engine: fake.run });
  await Promise.all(Array.from({ length: 3 }, () => tools.start_role({ seat: 'developer', title: 'Inspect', brief: 'Read', readOnly: true })));
  now = endedAt + 700000;
  const [first] = await tools.wait_roles({ ids: ['run-1'] });
  assert.equal(first.seconds, 31);
  now++;
  const justObserved = await tools.roles_status();
  assert.equal(justObserved.earlierEnded, 0);
  assert.deepEqual(justObserved.roles.map(role => role.id), ['run-3', 'run-2', 'run-1']);
  now += 600000;
  const { roles, earlierEnded } = await tools.roles_status();
  assert.equal(earlierEnded, 1);
  assert.deepEqual(roles.map(({ id, state }) => [id, state]), [['run-3', 'running'], ['run-2', 'ended']]);
  assert.equal((await tools.role_result({ id: 'run-1' })).answer, 'Final answer');
});

test('roles_status caps recent endings by settlement time and writes each summary on one line', async t => {
  const { env, folder } = session(t, 'conductor');
  const startedAt = Date.UTC(2026, 0, 1), title = 'Review '.repeat(20);
  let next = 0;
  t.mock.method(Date, 'now', () => startedAt + 30_000);
  const fake = engine((args, onTiming) => {
    if (args.includes('--detach')) {
      const id = String(++next);
      onTiming({ id, startedAt });
      return startEvent(id, 'claude');
    }
    return args.slice(1, args.indexOf('--cwd')).map(id => {
      if (id === '13') return runningEvent('13');
      onTiming({ id, endedAt: startedAt + (13 - Number(id)) * 1000, needsDecision: id === '1' });
      return endEvent(id, 'exit', { agent: 'claude', needsDecision: id === '1' });
    });
  });
  const roles = createRoleTools({ env, cwd: folder, engine: fake.run, tempRoot: folder });
  for (const _ of Array(13)) await roles.tools.start_role({ seat: 'reviewer', title, brief: 'Read', readOnly: true });
  const input = new PassThrough(), output = new PassThrough(), result = Promise.withResolvers();
  output.on('data', chunk => result.resolve(JSON.parse(chunk).result.content[0].text));
  const done = serve({ roles, input, output });
  input.end('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"roles_status"}}\n');
  await done;
  const text = await result.promise;
  const { roles: [running, ...ended], earlierEnded, omittedRecentEnded } = JSON.parse(text);
  assert.equal(running.id, '13');
  assert.equal(running.title, title);
  assert.match(running.activity, /last activity/);
  assert.deepEqual(ended.map(role => role.id), Array.from({ length: 10 }, (_, index) => String(index + 1)));
  assert.deepEqual(ended[0], { id: '1', seat: 'reviewer', title: title.slice(0, 63) + '…', state: 'ended', seconds: 12,
    reason: 'exit', needsDecision: true, refusedCount: 0 });
  assert.ok(text.split('\n').some(line => line.trim() === JSON.stringify(ended[0]) + ','));
  assert.equal(earlierEnded, 0);
  assert.equal(omittedRecentEnded, 2);
  assert.equal((await roles.tools.role_result({ id: '12' })).title, title);
});

test('a wait failure leaves every role running and only its unknown receipt ends a role', async t => {
  const { env, folder } = session(t, 'conductor');
  let waitResponse = failEvent('ENOENT: missing working directory');
  const fake = engine(args => {
    if (!args.includes('--detach')) return waitResponse;
    const out = args[args.indexOf('--out') + 1];
    t.after(() => fs.rmSync(path.dirname(out), { recursive: true, force: true }));
    fs.writeFileSync(out, 'Answer after recovery');
    return startEvent(args[args.indexOf('--title') + 1]);
  });
  const { tools } = createRoleTools({ env, cwd: folder, engine: fake.run });
  for (const title of ['missing', 'recovered']) await tools.start_role({ seat: 'developer', title, brief: 'Read', readOnly: true });
  assert.deepEqual((await tools.roles_status()).roles.map(role => role.state), ['running', 'running']);
  waitResponse = [dispatchEvent('unknown-run', 'missing'), endEvent('recovered')];
  const roles = new Map((await tools.wait_roles()).map(role => [role.id, role]));
  assert.equal(roles.get('missing').end, 'lost: unknown run missing');
  assert.equal(roles.get('recovered').reason, undefined);
  assert.equal((await tools.role_result({ id: 'missing' })).answer, null);
  assert.equal((await tools.role_result({ id: 'recovered' })).answer, 'Answer after recovery');
  assert.deepEqual(await tools.wait_roles(), []);
});

test('MCP starts roles concurrently and answers a status request while a wait is pending', { timeout: 5000 }, async t => {
  const { env, folder } = session(t, 'conductor');
  const firstStart = Promise.withResolvers(), roleEnd = Promise.withResolvers();
  const fake = engine(async (args, _timing, { untilAny }) => {
    if (args.includes('--detach')) {
      const title = args[args.indexOf('--title') + 1];
      if (title === 'first') await firstStart.promise;
      return startEvent(title);
    }
    if (untilAny) { await roleEnd.promise; return endEvent('second'); }
    return runningEvent('second');
  });
  const input = new PassThrough(), output = new PassThrough(), replies = new Map();
  t.after(() => { firstStart.resolve(); roleEnd.resolve(); input.end(); });
  output.on('data', chunk => {
    const reply = JSON.parse(String(chunk));
    replies.get(reply.id).resolve(JSON.parse(reply.result.content[0].text));
  });
  const done = serve({ roles: createRoleTools({ env, cwd: folder, engine: fake.run }), input, output });
  function request(id, name, args) {
    const answer = Promise.withResolvers();
    replies.set(id, answer);
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    return answer.promise;
  }
  const inspect = { seat: 'developer', brief: 'Read', readOnly: true };
  const first = request(1, 'start_role', { ...inspect, title: 'first' });
  assert.equal((await request(2, 'start_role', { ...inspect, title: 'second' })).id, 'second');
  const waiting = request(3, 'wait_roles', { ids: ['second'] });
  const status = await request(4, 'roles_status', {});
  assert.deepEqual(status.roles.map(({ id, state }) => [id, state]), [['second', 'running']]);
  firstStart.resolve();
  assert.equal((await first).id, 'first');
  roleEnd.resolve();
  assert.equal((await waiting)[0].state, 'ended');
  input.end();
  await done;
});

test('concurrent refreshes update activity in completion order and preserve the first legacy end timestamp', async t => {
  const { env, folder } = session(t, 'conductor');
  let now = Date.UTC(2026, 0, 1);
  t.mock.method(Date, 'now', () => now);
  const laterActivity = Promise.withResolvers(), duplicateEnd = Promise.withResolvers(), lateRunning = Promise.withResolvers();
  let queries = 0;
  const fake = engine(args => {
    if (args.includes('--detach')) return startEvent('run-1');
    if (++queries === 1) return laterActivity.promise;
    if (queries === 2) return runningEvent('run-1', 'earlier activity');
    if (queries === 3) return duplicateEnd.promise;
    if (queries === 4) return lateRunning.promise;
    return endEvent('run-1');
  });
  const { tools } = createRoleTools({ env, cwd: folder, engine: fake.run });
  await tools.start_role({ seat: 'developer', title: 'Inspect', brief: 'Read', readOnly: true });
  const slowStatus = tools.roles_status();
  assert.match((await tools.roles_status()).roles[0].activity, /earlier activity/);
  laterActivity.resolve(runningEvent('run-1', 'current activity'));
  assert.match((await slowStatus).roles[0].activity, /current activity/);
  const slowEnd = tools.roles_status();
  const slowRunning = tools.roles_status();
  const ended = (await tools.roles_status()).roles[0];
  now += 10000;
  duplicateEnd.resolve(endEvent('run-1'));
  lateRunning.resolve(runningEvent('run-1', 'late activity'));
  assert.deepEqual((await slowEnd).roles[0], ended);
  assert.deepEqual((await slowRunning).roles[0], ended);
});

test('the MCP server lists the role tools and answers a call as an error result', async t => {
  const { env } = session(t, 'native');
  const input = new PassThrough(), output = new PassThrough(), replies = [];
  output.on('data', chunk => replies.push(...String(chunk).trim().split('\n').map(line => JSON.parse(line))));
  const done = serve({ roles: createRoleTools({ env, engine: engine(() => []).run }), input, output });
  for (const message of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'start_role', arguments: { seat: 'developer', title: 'x', brief: 'y' } } },
    { jsonrpc: '2.0', id: 4, method: 'nothing' },
  ]) input.write(JSON.stringify(message) + '\n');
  input.end();
  await done;
  replies.sort((a, b) => a.id - b.id);
  assert.deepEqual(replies.map(reply => reply.id), [1, 2, 3, 4]);
  assert.equal(replies[0].result.serverInfo.name, 'agentrix');
  assert.deepEqual(replies[1].result.tools.map(tool => tool.name), TOOLS.map(tool => tool.name));
  const start = replies[1].result.tools.find(tool => tool.name === 'start_role');
  assert.match(start.description, /\. Claude roles can run commands and decide whether to run tests and which task-related tests to run/);
  assert.match(start.description, /never commit, push, or run git reset --hard.*Read-only roles must leave project files untouched/);
  assert.match(start.inputSchema.properties.readOnly.description, /Leave project files untouched.*Claude roles can run commands and tests/);
  assert.deepEqual(replies[1].result.tools.filter(tool => tool.annotations?.readOnlyHint).map(tool => tool.name),
    ['roles_status', 'wait_roles', 'role_result']);
  assert.equal(replies[2].result.isError, true);
  assert.match(replies[2].result.content[0].text, /Conductor mode is off/);
  assert.equal(replies[3].error.code, -32601);
});

test('MCP contains a synchronous tool reply failure while input stays open', { timeout: 5000 }, async t => {
  const input = new PassThrough(), attempted = Promise.withResolvers(), ping = Promise.withResolvers();
  t.after(() => input.end());
  const output = { write(line) {
    if (JSON.parse(line).id === 1) {
      attempted.resolve();
      throw new Error('fixture output failed');
    }
    ping.resolve();
  } };
  const done = serve({ roles: { tools: { roles_status: async () => ({ roles: [] }) } }, input, output });
  input.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"roles_status"}}\n');
  await attempted.promise;
  input.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
  await ping.promise;
  input.end();
  await done;
});

test('MCP cancels a pending wait when stdin closes', { timeout: 5000 }, async t => {
  const { env, folder } = session(t, 'conductor');
  const waiting = Promise.withResolvers(), release = Promise.withResolvers();
  const fake = engine(async (args, _timing, { signal }) => {
    if (args.includes('--detach')) return startEvent('run-1');
    signal?.addEventListener('abort', release.resolve, { once: true });
    waiting.resolve(signal);
    await release.promise;
    return runningEvent('run-1');
  });
  const roles = createRoleTools({ env, cwd: folder, engine: fake.run });
  await roles.tools.start_role({ seat: 'developer', title: 'Inspect', brief: 'Read', readOnly: true });
  const input = new PassThrough();
  t.after(() => { release.resolve(); input.end(); });
  const done = serve({ roles, input, output: new PassThrough() });
  input.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"wait_roles"}}\n');
  const signal = await waiting.promise;
  input.end();
  assert.ok(signal);
  await done;
  assert.equal(signal.aborted, true);
});
