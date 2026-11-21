const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createRoleTools, serve, TOOLS } = require('../integration/role-tools.cjs');
const { argumentsOf, run } = require('../integration/dispatch.cjs');

// A bootstrap with a mode file and live seats, as main writes them beside a session's bootstrap.
function session(t, mode, seats = { developer: { model: 'gpt-6.2-sol', effort: 'high', fast: true }, reviewer: { model: 'opus', effort: 'high' } }) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-role-tools-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const bootstrap = path.join(folder, 'boot.json');
  fs.writeFileSync(bootstrap, '{}');
  fs.writeFileSync(bootstrap + '.mode', mode + '\n');
  fs.writeFileSync(bootstrap + '.seats', JSON.stringify({ orchestrator: { model: 'opus', effort: 'high' }, ...seats }));
  return { env: { AGENTRIX_BOOTSTRAP: bootstrap }, folder };
}

// The engine stand-in records each call and answers as the real one prints.
function engine(answers) {
  const calls = [];
  const run = async (args, { stdout, onTiming }) => { calls.push(args); stdout.write(answers(args, onTiming)); return 0; };
  return { calls, run };
}

test('native mode refuses every role and names conductor mode', async t => {
  const { env } = session(t, 'native'), fake = engine(() => '');
  const { tools } = createRoleTools({ env, cwd: os.tmpdir(), engine: fake.run });
  await assert.rejects(tools.start_role({ seat: 'developer', title: 'x', brief: 'y', allow: ['src/**'] }), /Conductor mode is off/);
  assert.equal(fake.calls.length, 0);
});

test('start_role launches the seat on its own agent in the background and checks scope', async t => {
  const { env, folder } = session(t, 'conductor');
  const fake = engine(args => args.includes('--detach') ? '[dispatch] started run-1 codex model gpt-6.2-sol effort high fast on · routing ok\n' : '');
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
  const { env } = session(t, 'conductor'), fake = engine(() => '[dispatch] started run-1 codex\n');
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

test('start_role resolves a developer specialty through its enabled base seat', async t => {
  const { env, folder } = session(t, 'conductor');
  const fake = engine(args => {
    const { agent, model, effort } = argumentsOf(args, env);
    return `[dispatch] started run-1 ${agent} model ${model} effort ${effort}\n`;
  });
  const { tools } = createRoleTools({ env, cwd: folder, engine: fake.run });
  const started = await tools.start_role({ seat: 'developer/frontend', title: 'Inspect', brief: 'Read the code', readOnly: true });
  assert.deepEqual(started, { id: 'run-1', seat: 'developer/frontend', started: 'codex model gpt-6.2-sol effort high' });
});

test('start_role returns the engine error for a missing working directory', async t => {
  const { env, folder } = session(t, 'conductor'), missing = path.join(folder, 'missing');
  const { tools } = createRoleTools({ env, cwd: folder, engine: (args, context) => run(args, {
    ...context, launch: () => assert.fail('A missing working directory must fail before launch'),
  }) });
  await assert.rejects(tools.start_role({ seat: 'developer', title: 'Build', brief: 'Make the change', allow: ['src/**'], cwd: missing }), /^Error: \[dispatch\] failed: ENOENT/);
  assert.deepEqual(await tools.roles_status(), []);
});

test('a read-only Claude reviewer runs in plan mode as a review', async t => {
  const { env } = session(t, 'conductor');
  const fake = engine(args => args.includes('--detach') ? '[dispatch] started run-2 claude model opus effort high fast off · routing ok\n' : '');
  const { tools } = createRoleTools({ env, cwd: os.tmpdir(), engine: fake.run });
  await tools.start_role({ seat: 'reviewer', title: 'Review', brief: 'Read the diff', readOnly: true });
  const args = fake.calls[0];
  assert.deepEqual(args.slice(0, 6), ['claude', '--detach', '--seat', 'reviewer', '--role', 'review']);
  assert.deepEqual(args.slice(args.indexOf('--permission'), args.indexOf('--permission') + 2), ['--permission', 'plan']);
});

test('a Claude role reports the effort passed to its fake CLI when the CLI leaves it out', async t => {
  const { env, folder } = session(t, 'conductor', { reviewer: { model: 'sonnet', effort: 'medium' } });
  const { tools } = createRoleTools({ env, cwd: folder, engine: (args, { stdout }) => run(args.filter(arg => arg !== '--detach'), {
    env: { AGENTRIX_SEATS: fs.readFileSync(env.AGENTRIX_BOOTSTRAP + '.seats', 'utf8') }, stdout,
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

test('status, result and stop follow the engine and read the answer once the role ends', async t => {
  const { env } = session(t, 'conductor');
  let ended = false;
  const fake = engine(args => {
    if (args.includes('--detach')) return '[dispatch] started run-3 codex model gpt-6.2-sol effort high fast on · routing ok\n';
    if (args[0] === 'wait') return ended ? '[dispatch] ended run-3 codex · exit 0 reason exit\n' : '[dispatch] still running run-3 · 4 s · last activity now\n';
    return '[dispatch] stop queued run-3\n';
  });
  const { tools } = createRoleTools({ env, cwd: os.tmpdir(), engine: fake.run });
  await tools.start_role({ seat: 'developer', title: 'Build', brief: 'b', allow: ['a/**'] });
  const [running] = await tools.roles_status();
  assert.equal(running.state, 'running');
  assert.match(running.activity, /still running run-3/);
  const pending = await tools.role_result({ id: 'run-3' });
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
          return `[dispatch] started ${id} ${args[0]}\n`;
        }
        if (args[0] === 'stop') {
          stopQueued = true;
          now = startedAt + 40000;
          return `[dispatch] stop queued ${id}\n`;
        }
        const settled = state === 'ended' || state === 'legacy' || stopQueued;
        if (state !== 'legacy') onTiming({ id, startedAt, confirmedAt, endedAt: settled ? endedAt : undefined });
        return settled ? `[dispatch] ended ${id} exit 0 reason ${stopQueued ? 'killed' : 'exit'}\n` : `[dispatch] still running ${id} · last activity now\n`;
      });
      const { tools } = createRoleTools({ env, cwd: folder, engine: fake.run });
      await tools.start_role({ seat: state === 'stopped' ? 'reviewer' : 'developer', title: 'Inspect', brief: 'Read the code', readOnly: true });
      const args = fake.calls[0], answer = args[args.indexOf('--out') + 1];
      t.after(() => fs.rmSync(path.dirname(answer), { recursive: true, force: true }));
      fs.writeFileSync(answer, 'Final answer');

      now = startedAt + (state === 'running' ? 16000 : state === 'stopped' ? 30000 : 97000);
      const result = state === 'stopped' ? await tools.stop_role({ id }) : (await tools.roles_status())[0];
      assert.equal(result.startSeconds, state === 'legacy' ? 10 : 7);
      assert.equal(result.seconds, state === 'running' ? 16 : state === 'legacy' ? 89 : 31);
      assert.equal(result.endedAt, state === 'running' ? null : new Date(state === 'legacy' ? now : endedAt).toISOString());
      if (state === 'stopped') assert.equal(result.stop, `[dispatch] stop queued ${id}`);
      const final = await tools.role_result({ id });
      assert.equal(final.seconds, result.seconds);
      assert.equal(final.endedAt, result.endedAt);
      assert.equal(final.answer, state === 'running' ? null : 'Final answer');
    });
  }
});

test('the MCP server lists the four tools and answers a call as an error result', async t => {
  const { env } = session(t, 'native');
  const input = new PassThrough(), output = new PassThrough(), replies = [];
  output.on('data', chunk => replies.push(...String(chunk).trim().split('\n').map(line => JSON.parse(line))));
  const done = serve({ roles: createRoleTools({ env, engine: engine(() => '').run }), input, output });
  for (const message of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'start_role', arguments: { seat: 'developer', title: 'x', brief: 'y' } } },
    { jsonrpc: '2.0', id: 4, method: 'nothing' },
  ]) input.write(JSON.stringify(message) + '\n');
  input.end();
  await done;
  assert.deepEqual(replies.map(reply => reply.id), [1, 2, 3, 4]);
  assert.equal(replies[0].result.serverInfo.name, 'agentrix');
  assert.deepEqual(replies[1].result.tools.map(tool => tool.name), TOOLS.map(tool => tool.name));
  assert.equal(replies[2].result.isError, true);
  assert.match(replies[2].result.content[0].text, /Conductor mode is off/);
  assert.equal(replies[3].error.code, -32601);
});
