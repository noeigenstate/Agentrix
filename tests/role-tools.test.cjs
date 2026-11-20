const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { createRoleTools, serve, TOOLS } = require('../integration/role-tools.cjs');

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
  const run = async (args, { stdout }) => { calls.push(args); stdout.write(answers(args)); return 0; };
  return { calls, run };
}

test('native mode refuses every role and names conductor mode', async t => {
  const { env } = session(t, 'native'), fake = engine(() => '');
  const { tools } = createRoleTools({ env, cwd: os.tmpdir(), engine: fake.run });
  await assert.rejects(tools.start_role({ seat: 'developer', title: 'x', brief: 'y', allow: ['src/**'] }), /Conductor mode is off/);
  assert.equal(fake.calls.length, 0);
});

test('start_role launches the seat on its own agent in the background and checks scope', async t => {
  const { env } = session(t, 'conductor');
  const fake = engine(args => args.includes('--detach') ? '[dispatch] started run-1 codex model gpt-6.2-sol effort high fast on · routing ok\n' : '');
  const { tools } = createRoleTools({ env, cwd: os.tmpdir(), engine: fake.run });
  await assert.rejects(tools.start_role({ seat: 'developer', title: 'x', brief: 'y' }), /needs allow/);
  await assert.rejects(tools.start_role({ seat: 'orchestrator', title: 'x', brief: 'y', readOnly: true }), /not an enabled role/);
  await assert.rejects(tools.start_role({ seat: 'designer', title: 'x', brief: 'y', readOnly: true }), /not an enabled role/);
  const started = await tools.start_role({ seat: 'developer', title: 'Fix it', brief: 'Do the fix', allow: ['src/**'] });
  assert.equal(started.id, 'run-1');
  const args = fake.calls.at(-1);
  assert.deepEqual(args.slice(0, 6), ['codex', '--detach', '--seat', 'developer', '--role', 'exec']);
  assert.ok(!args.includes('--model'), 'the engine takes the model from the seat');
  assert.deepEqual(args.slice(args.indexOf('--allow'), args.indexOf('--allow') + 2), ['--allow', 'src/**']);
  assert.equal(fs.readFileSync(args[args.indexOf('--brief') + 1], 'utf8'), 'Do the fix');
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

test('status, result and stop follow the engine and read the answer once the role ends', async t => {
  const { env } = session(t, 'conductor');
  let ended = false;
  const fake = engine(args => {
    if (args.includes('--detach')) return '[dispatch] started run-3 codex model gpt-6.2-sol effort high fast on · routing ok\n';
    if (args[0] === 'wait') return ended ? '[dispatch] ended run-3 codex · exit 0 reason exit\n' : '[dispatch] still running run-3 · 4 s · last activity now\n';
    return '[dispatch] stopped run-3\n';
  });
  const { tools } = createRoleTools({ env, cwd: os.tmpdir(), engine: fake.run });
  await tools.start_role({ seat: 'developer', title: 'Build', brief: 'b', allow: ['a/**'] });
  const [running] = await tools.roles_status();
  assert.equal(running.state, 'running');
  assert.match(running.activity, /still running run-3/);
  assert.equal((await tools.stop_role({ id: 'run-3' })).stop, '[dispatch] stopped run-3');
  const out = fake.calls[0][fake.calls[0].indexOf('--out') + 1];
  fs.writeFileSync(out, 'All done');
  ended = true;
  const result = await tools.role_result({ id: 'run-3' });
  assert.equal(result.state, 'ended');
  assert.equal(result.answer, 'All done');
  await assert.rejects(tools.role_result({ id: 'other' }), /No role run other/);
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
