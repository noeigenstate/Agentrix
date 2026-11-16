// A terminal lead's Claude worker in a hidden terminal (electron/features/worker-terminals/BOUNDARY.md): a fake PTY stands
// in for the CLI, the test plays its hooks and writes its transcript, and the real dispatch helper runs against main's
// real control channel.
require('./fixtures/team-isolation.cjs');
const { test, resources } = require('./fixtures/codex-app-server-lifecycle.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createHmac, randomUUID } = require('node:crypto');
const { run } = require('../integration/dispatch.cjs');
const { createDispatchControl } = require('../electron/features/agents/dispatch-control.cjs');
const { createInterventions } = require('../electron/features/agents/interventions.cjs');
const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
const { acceptDispatch } = require('../electron/features/agents/dispatch-events.cjs');
const { createEventServer } = require('../electron/events.cjs');
const { registerClaudeWorker } = require('../electron/features/native-session/worker.cjs');
const { terminalHooks } = require('../electron/features/terminal-events/hook-channel.cjs');
const { encodeClaudeCwd } = require('../electron/claude-sessions.cjs');
const { projectTeam } = require('../electron/features/team/team.cjs');
const { createWorkerTerminals } = require('../electron/features/worker-terminals/worker-terminals.cjs');

const SHIMS = path.join(__dirname, '../integration/shims');
const PRIVATE_NAMES = ['AGENTRIX_BOOTSTRAP', 'AGENTRIX_CONTROL_ADDRESS', 'AGENTRIX_CAPABILITY', 'AGENTRIX_SESSION_KEY', 'AGENTRIX_READING_NOTE',
  'AGENTRIX_READING_NOTE_FILE', 'AGENTRIX_SOCKET', 'AGENTRIX_PROJECT_ID', 'AGENTRIX_HOOK_PORT', 'AGENTRIX_HOOK_SETTINGS', 'AGENTRIX_HOOK_FALLBACK',
  'AGENTRIX_EVENT_HELPER', 'AGENTRIX_START_DIR', 'AGENTRIX_NODE', 'AGENTRIX_USER_ZDOTDIR', 'CLAUDE_CODE_ENTRYPOINT'];

async function until(predicate, label = 'the synthetic worker') {
  for (let n = 0; n < 500; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`Timed out waiting for ${label}`);
}
const iso = ms => new Date(ms).toISOString();

function fakeSpawn(spawned) {
  return (file, args, options) => {
    const pty = { pid: 4242, file, args, options, writes: [], killed: 0, size: null,
      onData(callback) { this.emit = callback; }, onExit(callback) { this.exit = callback; },
      write(data) { this.writes.push(data); }, resize(cols, rows) { this.size = [cols, rows]; },
      kill() { this.killed++; this.exit?.({ exitCode: 0 }); } };
    spawned.push(pty); return pty;
  };
}

// A parent terminal as main holds it: its env carries the shell integration and credentials a worker must not inherit,
// and its bootstrap names the shims and its own private claude-env copy.
function parentTerminal(root, extra = {}) {
  const claudeHome = path.join(root, 'claude-home'), parentCopy = path.join(root, 'parent-claude-env.sh');
  fs.mkdirSync(claudeHome, { recursive: true }); fs.writeFileSync(parentCopy, '# parent copy\n');
  const bootstrap = path.join(root, 'bootstrap.json');
  const env = { ...Object.fromEntries(PRIVATE_NAMES.map(name => [name, `synthetic-${name.toLowerCase()}`])), PATH: '', CLAUDE_CONFIG_DIR: claudeHome,
    KEEP_ME: 'kept', ZDOTDIR: path.join(root, 'agentrix-zsh'), AGENTRIX_USER_ZDOTDIR: path.join(root, 'user-zdotdir'), AGENTRIX_BOOTSTRAP: bootstrap };
  return { claudeHome, parentCopy, bootstrap, env, write: fields => fs.writeFileSync(bootstrap, JSON.stringify({ shims: SHIMS, claudeEnvFile: parentCopy, ...fields, ...extra })) };
}
const hooksFor = ({ terminalId, sessionKey, env, cwd }) => terminalHooks({ port: 4567, terminalId, sessionKey, eventServer: { address: 'synthetic-socket', name: 'synthetic-pipe' },
  env, cwd, shell: { posix: false, powershellPath: 'powershell.exe', script: 'claude-hook.ps1' }, read: () => { throw new Error('absent'); } });

function transcript(claudeHome, cwd, sessionId) {
  const file = path.join(claudeHome, 'projects', encodeClaudeCwd(cwd), `${sessionId}.jsonl`);
  return {
    append(...records) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, records.map(record => JSON.stringify({ sessionId, ...record }) + '\n').join('')); },
    prompt: (uuid, text, at) => ({ type: 'user', uuid, parentUuid: null, timestamp: iso(at), message: { role: 'user', content: text } }),
    reply: (uuid, parentUuid, id, text, at, output = 120) => ({ type: 'assistant', uuid, parentUuid, timestamp: iso(at),
      message: { id, role: 'assistant', model: 'synthetic-model', content: [{ type: 'text', text }], usage: { output_tokens: output, input_tokens: 5 } } }),
  };
}

// The real helper and control channel, under a terminal lead whose terminal main knows.
async function fixture(t) {
  const lifetime = resources(t);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agx-terminal-worker-'))), main = path.join(root, 'main'), repo = path.join(root, 'worker');
  fs.mkdirSync(path.join(main, 'src'), { recursive: true });
  fs.writeFileSync(path.join(main, 'src/a.js'), 'base'); fs.writeFileSync(path.join(main, '.gitignore'), '.dispatch/\n');
  const git = args => execFileSync('git', args, { cwd: main, windowsHide: true, stdio: 'ignore' });
  git(['init', '-q']); git(['add', '-A']); git(['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'Synthetic fixture']);
  git(['worktree', 'add', '-qb', 'synthetic-worker', repo]);
  const team = projectTeam(repo, true), events = [], calls = new AgentCalls({ local: false });
  const owner = { terminalId: 'terminal', sessionKey: 'synthetic-owner' };
  const eventServer = await createEventServer(event => { events.push(event); acceptDispatch(owner, event, calls); });
  lifetime.defer('close events', () => eventServer.close());
  const control = createDispatchControl({ resolveRun: auth => {
    const entry = team.live().find(value => value.id === auth.runId);
    return auth.sessionKey === owner.sessionKey && auth.capability === 'synthetic-capability' && entry ? { runId: entry.id, projectId: owner.terminalId,
      cwd: repo, worktree: repo, allow: entry.allow, readOnly: false, roundtable: false, agent: entry.agent, local: true, leadMode: 'terminal' } : null;
  } });
  const { address } = await control.listen();
  lifetime.defer('close control', () => control.close());
  const parent = parentTerminal(root);
  parent.write({ pipeName: eventServer.address, controlAddress: address, controlCapability: 'synthetic-capability', ...owner, projectId: owner.terminalId });
  const spawned = [], notices = [];
  const terminals = createWorkerTerminals({ spawn: fakeSpawn(spawned), claudeFile: () => path.join(root, 'stand-in', 'claude'), hooks: hooksFor,
    parent: binding => binding.projectId === owner.terminalId ? { env: parent.env, sessionKey: owner.sessionKey, bootstrapFile: parent.bootstrap } : null,
    calls: () => calls, runtimeDir: () => root, claudeHome: () => assert.fail('the worker env names its Claude home'),
    schedule: (fn, ms) => ms === 15000 ? notices.push(fn) : setTimeout(fn, ms), kill: pty => pty.kill() });
  registerClaudeWorker({ control, claude: {}, settings: () => assert.fail('a terminal worker reads no Claude path setting'), terminals });
  const brief = path.join(root, 'brief.md'), out = path.join(repo, '.dispatch/answer.md');
  fs.mkdirSync(path.dirname(out)); fs.writeFileSync(brief, 'Synthetic terminal task');
  let stdout = '', finished = false;
  const result = run(['claude', '--role', 'exec', '--title', 'Synthetic terminal worker', '--model', 'synthetic-model', '--effort', 'high',
    '--permission', 'acceptEdits', '--cwd', repo, '--brief', brief, '--out', out, '--allow', 'src/**', '--skip-meeting', 'Synthetic terminal regression'], {
    env: { PATH: '', HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), CODEX_HOME: path.join(root, 'codex'), AGENTRIX_BOOTSTRAP: parent.bootstrap },
    stdout: { write: text => { stdout += text; } }, rateInterval: 20,
    resolveExecutable: () => assert.fail('a terminal worker never resolves a CLI in the helper'),
    launch: () => assert.fail('a terminal worker never spawns a CLI from the helper'),
  }).finally(() => { finished = true; });
  lifetime.defer('finish helper', async () => {
    if (!finished) { control.close(); terminals.closeAll(); }
    await lifetime.wait(result, `helper result; output=${stdout}`);
  });
  t.after(async () => { calls.dispose(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await until(() => spawned.length === 1, 'the worker terminal to start');
  const id = team.live()[0].id, sessionId = randomUUID(), pty = spawned[0];
  const api = createInterventions({ resolve: () => ({ terminalId: 'terminal', callId: `dispatch:${id}`, parentSessionId: 'planner', confirmed: true, route: 'dispatch',
    runId: id, title: 'Synthetic terminal worker', cwd: repo, projectPath: repo, local: true }), pushControl: control.pushControl });
  return { root, repo, id, pty, sessionId, parent, events, calls, out, result, api, terminals, notices, brief,
    stdout: () => stdout, item: () => calls.snapshot().flatMap(group => group.items).find(item => item.id === `dispatch:${id}`),
    feed: () => calls.feeds.owned(calls.byId(`dispatch:${id}`))?.snapshot,
    log: transcript(parent.claudeHome, repo, sessionId),
    hook: (event, payload = {}) => terminals.hook({ terminalId: `worker-${id}`, event, sessionId, payload }) };
}

test("a terminal planner's worker shows its rate, waits for the owner and writes output on Stop", async t => {
  const f = await fixture(t), at = Date.now();
  assert.equal(f.pty.args.at(-1), `Read the task brief in ${path.join(f.root, `worker-${f.id}`, 'brief.md')} and carry it out.`);
  assert.match(fs.readFileSync(path.join(f.root, `worker-${f.id}`, 'brief.md'), 'utf8'), /Synthetic terminal task/);
  f.pty.emit('Claude Code is ready\r\n');
  f.log.append(f.log.prompt('p1', 'Synthetic terminal task', at), f.log.reply('r1', 'p1', 'm1', 'Looking at the files.', at + 2000));
  f.hook('UserPromptSubmit', { prompt: 'Read the task brief' });
  await until(() => f.stdout().includes('[dispatch] started') && f.item()?.state === 'running', 'the started row');
  await until(() => group(f)?.rate?.outputTokens === 120, 'the worker rate');
  assert.equal(group(f).rate.activeMs, 2000);
  assert.equal(f.item().awaiting, undefined);

  f.hook('PermissionRequest', { tool_name: 'Bash' });
  await until(() => f.item().awaiting === 'owner' && f.feed()?.awaiting === 'owner', 'the owner wait');
  f.hook('PostToolUse', { tool_name: 'Bash' });
  await until(() => f.item().awaiting === undefined && f.feed()?.awaiting === undefined, 'the wait to clear');

  f.log.append(f.log.reply('r2', 'r1', 'm2', 'Final synthetic answer', at + 4000, 30));
  f.hook('Stop');
  assert.equal(await f.result, 0, f.stdout());
  assert.equal(fs.readFileSync(f.out, 'utf8'), 'Final synthetic answer');
  assert.match(f.stdout(), /transport \S+ claude-terminal: terminal lead \(subscription\)/);
  assert.ok(f.pty.killed >= 1, 'the PTY is killed when the run ends');
  assert.equal(fs.existsSync(path.join(f.root, `worker-${f.id}`)), false, 'the private folder is removed');
});
const group = f => f.calls.snapshot().find(group => group.items.some(item => item.id === `dispatch:${f.id}`));

test("billing follows the lead's mode and no client identity is set", async t => {
  const f = await fixture(t), at = Date.now();
  const { args, options: { env } } = f.pty;
  for (const flag of ['-p', '--print', '--output-format', '--input-format']) assert.ok(!args.includes(flag), `no ${flag}`);
  assert.deepEqual(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2), ['--permission-mode', 'acceptEdits']);
  for (const name of [...PRIVATE_NAMES, 'AGENTRIX_SDK_PARENT', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(env[name], undefined, name);
  assert.equal(env.KEEP_ME, 'kept');
  assert.equal(env.AGENTRIX_SHIM_USER_ZDOTDIR, path.join(f.root, 'user-zdotdir'), 'the user\'s own zsh folder is back, behind the shims');
  assert.equal(env.AGENTRIX_DISPATCH_DEPTH, '1'); assert.equal(env.AGENTRIX_RUN_ID, f.id);
  assert.equal(env.AGENTRIX_RUN_PROOF, createHmac('sha256', 'synthetic-owner').update(`agentrix-run:${f.id}`).digest('hex'));
  assert.equal(env.CLAUDE_ENV_FILE, path.join(f.root, `worker-${f.id}`, 'claude-env.sh'));
  assert.notEqual(env.CLAUDE_ENV_FILE, f.parent.parentCopy);
  assert.equal(fs.readFileSync(f.parent.parentCopy, 'utf8'), '# parent copy\n', 'the parent\'s copy is untouched');
  assert.equal(fs.readFileSync(env.CLAUDE_ENV_FILE, 'utf8'), fs.readFileSync(path.join(SHIMS, 'hooks/claude-env.sh'), 'utf8'));

  f.log.append(f.log.prompt('p1', 'Synthetic terminal task', at), f.log.reply('r1', 'p1', 'm1', 'Done.', at + 1000));
  f.hook('UserPromptSubmit'); f.hook('Stop');
  assert.equal(await f.result, 0, f.stdout());
  await until(() => f.events.some(event => event.type === 'dispatch-start'), 'the start event');
  assert.equal(f.events.find(event => event.type === 'dispatch-start').billingPath, 'subscription');
  assert.equal(f.events.find(event => event.type === 'dispatch-start').costCompleteness, 'unknown');

  // An SSH terminal lead and a Codex lead keep their paths: no worker terminal.
  let handler;
  const terminals = { create: () => assert.fail('only a local terminal lead gets a worker terminal') };
  registerClaudeWorker({ control: { onRequest: (_name, fn) => { handler = fn; } }, terminals, settings: () => ({ claudePath: 'terminal-only' }),
    claude: { refreshAvailability: async () => {}, apiState: () => ({ status: 'ready' }) } });
  for (const binding of [{ leadMode: 'terminal', local: false }, { leadMode: 'codex', local: true }]) {
    const emitted = [];
    await handler({ runId: 'r', projectId: 'terminal', agent: 'claude', cwd: f.repo, worktree: f.repo, allow: [], readOnly: false, ...binding },
      { prompt: 'Synthetic task', permission: 'acceptEdits' }, { emit: event => emitted.push(event), onControl: () => () => {} });
    assert.deepEqual(emitted.map(event => [event.type, event.payload.selected]), [['path.changed', 'terminal']], binding.leadMode);
  }
});

test('an intervention is written once when idle and never resent', async t => {
  const f = await fixture(t), at = Date.now(), text = 'Owner correction for the terminal worker';
  const pasted = () => f.pty.writes.filter(data => data === `\x1b[200~${text}\x1b[201~`).length;
  f.log.append(f.log.prompt('p1', 'Synthetic terminal task', at), f.log.reply('r1', 'p1', 'm1', 'Working.', at + 1000));
  f.hook('UserPromptSubmit');
  await until(() => f.stdout().includes('[dispatch] started'), 'the start');
  await f.api.interveneAgent('terminal', `dispatch:${f.id}`, text);
  await until(() => new RegExp(`intervention ${f.id} \\S+ queued`).test(f.stdout()), 'the queued receipt');
  assert.equal(pasted(), 0, 'nothing is written while the turn runs');

  f.log.append(f.log.reply('r2', 'r1', 'm2', 'First answer', at + 2000));
  f.hook('Stop');
  await until(() => pasted() === 1 && f.pty.writes.includes('\r'), 'the write at idle');
  f.log.append(f.log.prompt('p2', text, at + 3000), f.log.reply('r3', 'p2', 'm3', 'Corrected answer', at + 4000));
  f.hook('UserPromptSubmit', { prompt: text });
  await until(() => new RegExp(`intervention ${f.id} \\S+ consumed`).test(f.stdout()), 'the consumed receipt');
  f.hook('Stop');
  assert.equal(await f.result, 0, f.stdout());
  assert.equal(fs.readFileSync(f.out, 'utf8'), 'Corrected answer');
  assert.equal(pasted(), 1, 'the intervention is never resent');
  // The owner's item names the correction's channel before its transcript record reaches the meter.
  await until(() => f.events.some(event => event.type === 'dispatch-input' && event.entryId === 'u:p2'), 'the input facts');
  assert.equal(f.events.find(event => event.type === 'dispatch-input' && event.entryId === 'u:p2').origin, 'owner');
  assert.equal(f.events.find(event => event.type === 'dispatch-input' && event.entryId === 'u:p1').origin, 'planner');
});

// One worker terminal behind main's worker handler, without the helper.
async function unit(t, { calls = null } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agx-terminal-worker-unit-')));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const parent = parentTerminal(root); parent.write({ sessionKey: 'synthetic-owner' });
  const spawned = [], notices = [], sent = [], channels = {}, killed = [], awaited = [];
  const terminals = createWorkerTerminals({ spawn: fakeSpawn(spawned), claudeFile: () => path.join(root, 'stand-in', 'claude'), hooks: hooksFor,
    parent: () => ({ env: parent.env, sessionKey: 'synthetic-owner', bootstrapFile: parent.bootstrap }),
    calls: () => calls || { setAwaiting: (id, value) => awaited.push([id, value]) }, runtimeDir: () => root, claudeHome: () => parent.claudeHome,
    send: (channel, data) => sent.push([channel, data]), schedule: (fn, ms) => ms === 15000 ? notices.push(fn) : setTimeout(fn, ms),
    kill: pty => { killed.push(pty); pty.kill(); } });
  terminals.register({ handle: (channel, fn) => { channels[channel] = fn; }, listen: (channel, fn) => { channels[channel] = fn; } });
  let handler, control;
  registerClaudeWorker({ control: { onRequest: (_name, fn) => { handler = fn; } }, claude: {}, settings: () => ({}), terminals });
  const binding = { runId: 'run-1', projectId: 'terminal', agent: 'claude', cwd: path.join(root, 'project'), worktree: path.join(root, 'project'),
    allow: [], readOnly: false, roundtable: false, local: true, leadMode: 'terminal' };
  const events = [];
  const result = handler(binding, { prompt: 'Synthetic brief', permission: 'acceptEdits' }, { supportsFinish: true, emit: event => events.push(event),
    onControl: fn => { control = fn; return () => {}; } });
  await until(() => spawned.length === 1, 'the worker terminal to start');
  return { root, terminals, pty: spawned[0], notices, sent, channels, killed, awaited, events, result, control: message => control(message), parent,
    hook: (event, payload = {}) => terminals.hook({ terminalId: 'worker-run-1', event, sessionId: 'synthetic-session', payload }) };
}

test("a worker's hooks never reach a project terminal or its completion", async t => {
  let finishedCount = 0, changes = 0;
  const calls = new AgentCalls({ local: false, finished: () => { finishedCount++; }, changed: () => { changes++; } });
  t.after(() => calls.dispose());
  calls.dispatch({ type: 'dispatch-declared', id: 'run-1', agent: 'claude', requested: { model: 'synthetic-model', effort: 'high', fast: null },
    role: 'exec', title: 'Synthetic', cwd: '/synthetic', worktree: '/synthetic', at: Date.now(), helperPid: process.pid });
  const f = await unit(t, { calls });
  const workerId = 'worker-run-1', env = f.pty.options.env, workerKey = keyOfWorker(f);
  const expected = hooksFor({ terminalId: workerId, sessionKey: workerKey, env, cwd: path.join(f.root, 'project') });
  assert.notEqual(workerKey, 'synthetic-owner', 'the worker has a session key of its own');
  assert.equal(f.terminals.keyOf('terminal'), undefined, 'a project terminal\'s key is never the module\'s');
  assert.equal(f.terminals.keyOf(workerId), expected.key);
  assert.equal(f.terminals.hook({ terminalId: 'terminal', event: 'Stop' }), false);
  assert.equal(f.terminals.event({ projectId: 'terminal', type: 'agent-activity', hookEvent: 'Stop' }), false);
  assert.equal(f.terminals.event({ projectId: workerId, sessionKey: 'forged', type: 'agent-activity', hookEvent: 'PermissionRequest', state: 'attention' }), true);
  assert.equal(calls.snapshot()[0].items[0].awaiting, undefined, 'a forged command event changes nothing');

  // The worker's --settings are exactly terminalHooks()'s for its own id and key, with no note file.
  assert.equal(fs.readFileSync(f.pty.args[f.pty.args.indexOf('--settings') + 1], 'utf8'), expected.settings.http);
  assert.ok(!Object.keys(env).some(name => /READING_NOTE/i.test(name)));
  assert.deepEqual(fs.readdirSync(path.join(f.root, workerId)).sort(), ['brief.md', 'claude-env.sh', 'settings.json']);

  // A command-hook event with the worker's key and the HTTP hooks reach only the worker's call.
  f.terminals.event({ projectId: workerId, sessionKey: workerKey, type: 'agent-activity', hookEvent: 'Notification', state: 'attention', sessionId: 'synthetic-session' });
  await until(() => calls.snapshot()[0].items[0].awaiting === 'owner', 'the command-hook wait');
  f.hook('UserPromptSubmit'); f.hook('Stop');
  await until(() => f.events.some(event => event.type === 'session.state' && event.payload.state === 'idle'), 'the idle worker');
  assert.equal(calls.snapshot()[0].items[0].awaiting, undefined);
  assert.equal(finishedCount, 0, 'no completion or accounting hook fires for the worker terminal');

  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  assert.match(main, /keyOf: id => workerTerminals\.keyOf\(id\) \?\? sessions\.get\(id\)\?\.hooks\?\.key/);
  assert.match(main, /deliver: event => workerTerminals\.hook\(event\) \|\| claudeHook\(event\)/);
  assert.match(main, /createEventServer\(event => workerTerminals\.event\(event\) \|\| onEvent\(event\)\)/);
  const source = fs.readFileSync(path.join(__dirname, '../electron/features/worker-terminals/worker-terminals.cjs'), 'utf8');
  assert.doesNotMatch(source, /notifyCompletion|expectCompletion|applyActivity|claudeActivity|setRestore|sessions\.(?:get|set)/);
  await f.control({ type: 'stop' }); assert.deepEqual(await f.result, { status: 'interrupted' });
  assert.ok(changes > 0);
});
// The worker's private session key is the module's; a test reads it back from the command its hooks run.
function keyOfWorker(f) {
  const settings = JSON.parse(fs.readFileSync(f.pty.args[f.pty.args.indexOf('--settings') + 1], 'utf8'));
  return /-SessionKey (\S+)/.exec(settings.hooks.SessionStart[0].hooks[0].command)[1];
}

test('keys reach the worker only while it awaits the owner', async t => {
  const f = await unit(t), callId = 'dispatch:run-1';
  f.pty.emit('Do you trust the files in this folder?');
  const attached = await f.channels['worker-terminal:attach']('terminal', callId);
  assert.equal(attached.data, 'Do you trust the files in this folder?'); assert.equal(attached.awaiting, null);
  assert.equal(await f.channels['worker-terminal:attach']('other-terminal', callId), null);
  const keys = (data, epoch = attached.epoch, terminal = 'terminal') => f.channels['worker-terminal:keys'](terminal, callId, epoch, data);
  keys('1'); assert.deepEqual(f.pty.writes, [], 'no keys before the worker waits for the owner');

  // A start-up dialog fires no hook: drawn output and no prompt after 15 s.
  assert.equal(f.notices.length, 1); f.notices[0]();
  assert.deepEqual(f.awaited.at(-1), ['run-1', 'owner']);
  keys('1', 'stale-epoch'); keys('1', attached.epoch, 'other-terminal'); keys(42);
  assert.deepEqual(f.pty.writes, []);
  keys('1'); assert.deepEqual(f.pty.writes, ['1']);
  f.hook('UserPromptSubmit');
  await until(() => f.awaited.at(-1)[1] === null, 'the submitted prompt');
  keys('x'); assert.deepEqual(f.pty.writes, ['1']);

  // After a denial the CLI waits for guidance without a hook: the wait holds until the next progress hook.
  const mark = f.awaited.length;
  f.hook('PermissionRequest', { tool_name: 'Bash' });
  await until(() => f.awaited.length > mark, 'the permission wait');
  keys('n'); keys('Use the docs folder instead');
  assert.deepEqual(f.pty.writes, ['1', 'n', 'Use the docs folder instead']);
  f.hook('Notification', { notification_type: 'idle_prompt' }); f.hook('PreToolUse');
  await until(() => f.awaited.at(-1)[1] === null, 'the next progress hook');
  assert.deepEqual(f.awaited.slice(mark), [['run-1', 'owner'], ['run-1', null]], 'an idle notice is no progress');
  keys('y'); assert.equal(f.pty.writes.at(-1), 'Use the docs folder instead');

  f.channels['worker-terminal:resize']('terminal', callId, attached.epoch, 0, 0);
  f.channels['worker-terminal:resize']('terminal', callId, attached.epoch, 100, 40);
  assert.deepEqual(f.pty.size, [100, 40]);
  f.pty.emit('more');
  assert.deepEqual(f.sent.at(-1), ['worker-terminal:data', { terminalId: 'terminal', callId, epoch: attached.epoch, seq: 2, data: 'more' }]);

  await f.control({ type: 'stop' });
  assert.deepEqual(await f.result, { status: 'interrupted' });
  assert.deepEqual(f.killed, [f.pty]);
  assert.equal(fs.existsSync(path.join(f.root, 'worker-run-1')), false);
  keys('z'); assert.equal(f.pty.writes.at(-1), 'Use the docs folder instead');
  assert.equal(await f.channels['worker-terminal:attach']('terminal', callId), null);
});
