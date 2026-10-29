const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { createEventServer } = require('../electron/events.cjs');
const { isLocalAgentCommand } = require('../electron/agent-commands.cjs');

const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
// Exercise the actual event handlers without opening Electron or the user's terminals.
function handlers() {
  const project = { id: 'p', completionArmed: false }, session = { terminalId: 't', projectId: 'p', sessionKey: 'key', codexActive: true, agent: 'claude', codexActivity: 'working', promptQueue: { reset() {} }, submissions: { reset() {} }, approval: new (require('../electron/features/terminal/approval-guard.cjs').ApprovalGuard)('pty') };
  const calls = { broadcast: 0, restore: 0, activity: 0, follow: 0, completion: [], usageDispose: 0 };
  session.usageAccount = { dispose() { calls.usageDispose++; } };
  session.bindUsageAccount = () => {};
  const context = vm.createContext({
    sessions: new Map([['t', session]]), store: { projects: [project], setRestore() { calls.restore++; },
      expectCompletion(id, expected = true) { assert.equal(id, project.id); calls.completion.push([id, expected]); project.completionArmed = expected; } }, quitting: false,
    broadcast() { calls.broadcast++; }, followClaude() { calls.follow++; }, applyActivity(_project, s, event) { calls.activity++; s.codexActivity = event.state; },
    acceptShellEvent: () => true, resumeAfterPrompt: async () => {}, isLocalAgentCommand, promptText: require('../electron/prompt-queue.cjs').promptText, t: text => text,
    endSkillSession() {},
  });
  // onEvent owns account-query cleanup on real agent/shell exit. Include that
  // legitimate dependency, with an observable subscription instead of a PTY.
  vm.runInContext(main.slice(main.indexOf('function stopUsageAccount('), main.indexOf('let claudeAccountTimer =')), context);
  vm.runInContext(main.slice(main.indexOf('function claudeActivity('), main.indexOf('async function resumeAfterPrompt(')), context);
  return { context, project, session, calls, send: event => context.onEvent({ projectId: 't', sessionKey: 'key', type: 'agent-activity', sessionId: 'session', eventId: 'session:1', ...event }) };
}

test('Claude permission notices broadcast waiting state without changing activity or restore plans', () => {
  const { session, calls, send } = handlers();
  const before = Date.now();
  send({ state: 'attention', message: '长'.repeat(400) });
  assert.equal(session.needsInput.message, '长'.repeat(300));
  assert.ok(session.needsInput.since >= before && session.needsInput.since <= Date.now());
  assert.equal(session.codexActivity, 'working');
  assert.deepEqual(calls, { broadcast: 1, restore: 0, activity: 0, follow: 0, completion: [], usageDispose: 0 });
  send({ state: 'attention', sessionKey: 'wrong', message: 'Ignored' });
  send({ state: 'attention', sessionId: '../invalid', message: 'Ignored' });
  send({ state: 'idle', message: 'Ignored' });
  assert.equal(calls.broadcast, 1);
  session.agent = 'codex'; send({ state: 'attention', message: 'Ignored' });
  assert.equal(calls.broadcast, 1);
  assert.deepEqual(calls.completion, []);
});

test('Claude hook event identities conservatively invalidate old approval actions without pretending to be native request IDs', () => {
  const { session, send, calls } = handlers();
  send({ state: 'attention', eventId: 'session:notice-A', message: 'Approve identical command' });
  const first = session.approval.stamp();
  send({ state: 'attention', eventId: 'session:notice-A', message: 'Approve identical command' });
  assert.deepEqual(session.approval.stamp(), first, 'duplicate observation leaves the stamp alone');
  send({ state: 'attention', eventId: 'session:notice-B', message: 'Approve different command' });
  send({ state: 'attention', eventId: 'session:notice-A', message: 'Approve identical command' });
  assert.equal(session.approval.matches(first), false, 'even a reused event string cannot restore an earlier epoch');
  const second = session.approval.stamp();
  send({ state: 'working', eventId: 'session:prompt-B', prompt: 'Another turn' });
  assert.equal(session.approval.matches(second), false);
  assert.deepEqual(calls.completion, [['p', true]], 'only the real prompt hook arms completion');
});

test('working and complete clear waiting without disposing usage; actual agent/shell exits clean up', () => {
  for (const event of [{ state: 'working', prompt: 'Actual task' }, { state: 'complete' }, { type: 'codex-exited', exitCode: 0 }, { type: 'shell-ready', cwd: '/project' }, { type: 'shell-prompt', cwd: '/project' }]) {
    const { session, calls, send } = handlers();
    const account = session.usageAccount, bind = session.bindUsageAccount;
    send({ state: 'attention', message: 'Approve tool' });
    assert.equal(calls.usageDispose, 0, 'attention leaves the usage subscription running');
    assert.equal(session.usageAccount, account);
    assert.equal(session.bindUsageAccount, bind);
    send(event);
    assert.equal(session.needsInput, null);
    assert.equal(calls.restore, 1);
    assert.equal(calls.activity, event.state ? 1 : 0);
    assert.equal(calls.broadcast, event.state ? 1 : 2);
    assert.deepEqual(calls.completion, event.state === 'working' ? [['p', true]] : []);
    assert.equal(calls.usageDispose, event.state ? 0 : 1);
    assert.equal(session.usageAccount, event.state ? account : null);
    assert.equal(session.bindUsageAccount, event.state ? bind : null);
  }
});

test('only distinct Claude UserPromptSubmit events arm completion; attention and Stop callbacks never rearm it', () => {
  const { project, session, calls, send } = handlers();
  const waiting = () => send({ state: 'attention', message: 'Approve tool' });
  waiting();
  send({ state: 'complete', eventId: 'session:background-stop' });
  assert.equal(session.needsInput, null, 'a Stop clears the waiting notice without new input');
  assert.deepEqual(calls.completion, []);
  assert.equal(project.completionArmed, false);

  waiting();
  send({ state: 'working', eventId: 'session:prompt-1', prompt: 'Run the task' });
  assert.equal(session.needsInput, null, 'UserPromptSubmit clears the waiting notice');
  assert.deepEqual(calls.completion, [['p', true]]);
  assert.equal(project.completionArmed, true);

  // Simulate the alert being consumed by applyActivity/WorkspaceStore, covered by backend-activity.test.cjs.
  project.completionArmed = false;
  waiting();
  assert.equal(project.completionArmed, false, 'permission notices cannot rearm a consumed alert');
  send({ state: 'complete', eventId: 'session:stop-1' });
  send({ state: 'complete', eventId: 'session:distinct-background-stop' });
  assert.equal(session.needsInput, null);
  assert.deepEqual(calls.completion, [['p', true]]);
  assert.equal(project.completionArmed, false);

  waiting();
  send({ state: 'working', eventId: 'session:prompt-1', prompt: 'Run the task' });
  assert.equal(session.needsInput, null, 'a duplicated hook still clears the waiting notice');
  assert.deepEqual(calls.completion, [['p', true]], 'the same submission event cannot arm twice');
  assert.equal(project.completionArmed, false);

  waiting();
  send({ state: 'working', eventId: 'session:prompt-2', prompt: 'Run the task' });
  assert.equal(session.needsInput, null);
  assert.deepEqual(calls.completion, [['p', true], ['p', true]], 'a distinct submission arms even with identical prompt text');
  assert.equal(project.completionArmed, true);
});

test('the key that answers Claude\'s permission prompt ends the waiting notice; moving through its options does not', () => {
  const listeners = {}, keys = [];
  let scheduled = 0;
  const waiting = () => ({ message: 'Claude needs your permission', since: 1 });
  const session = { status: 'running', codexActive: true, agent: 'claude', codexActivity: 'working', needsInput: waiting(),
    submissions: { write: () => false, sent: [] }, gate: { input: key => keys.push(key) } };
  require('../electron/features/terminal/ipc.cjs').registerTerminalIpc({ handle() {}, listen: (name, callback) => { listeners[name] = callback; },
    getSession: () => session, getProjectById: () => ({ id: 'p' }), scheduleState: () => { scheduled++; }, applyActivity: () => assert.fail('an answer is no interruption') });
  const write = key => listeners['terminal:write']('t', key);
  for (const key of ['\x1b[B', '\x1b[A', 'x']) write(key);
  assert.deepEqual(session.needsInput, waiting(), 'arrows and other keys leave the prompt open');
  for (const answer of ['\r', '2', '\x1b']) {
    session.needsInput = waiting(); write(answer);
    assert.equal(session.needsInput, null, `${JSON.stringify(answer)} answers it`);
  }
  assert.equal(scheduled, 3);
  assert.equal(session.codexActivity, 'working', 'Escape that answers the prompt does not end the round');
  assert.deepEqual(keys, ['\x1b[B', '\x1b[A', 'x', '\r', '2', '\x1b'], 'every key still reaches Claude');
  session.agent = 'codex'; session.needsInput = waiting(); write('\r');
  assert.deepEqual(session.needsInput, waiting(), 'only Claude\'s notice ends this way');
});

test('terminal commands IPC selects the session agent, defaults to Claude and excludes SSH paths', async () => {
  const registrations = new Map(), scans = [];
  const sessions = new Map([['codex', { agent: 'codex' }]]);
  require('../electron/features/agents/ipc.cjs').registerAgentsIpc({
    handle: (name, callback) => registrations.set(name, callback), getSession: id => sessions.get(id),
    findProject: id => ({ kind: id === 'ssh' ? 'ssh' : 'local', path: '/project' }),
    listAgentCommands: async options => { scans.push(options); return [{ source: 'builtin', description: 'Builtin' }, { source: 'project', description: 'Custom' }]; },
    t: text => `Translated ${text}`,
  });
  const list = registrations.get('terminal:commands');
  for (const id of ['codex', 'stopped', 'ssh']) {
    const commands = await list(id);
    assert.equal(commands[0].description, 'Translated Builtin'); assert.equal(commands[1].description, 'Custom');
  }
  assert.deepEqual(scans.map(item => [item.agent, item.projectPath]), [['codex', '/project'], ['claude', '/project'], ['claude', undefined]]);
});

test('terminals show in the order they were dragged into; a new one comes last and a stale order is refused', () => {
  const project = { id: 'p', terminals: [{ id: 'a' }, { id: 'b' }], terminalOrder: ['b', 'gone', 'p'] }, saved = [];
  const context = vm.createContext({ sessions: new Map([['p', {}]]), findProject: () => project, store: { setTerminalOrder: (id, ids) => saved.push([id, ids]) } });
  vm.runInContext(main.slice(main.indexOf('function terminalIds('), main.indexOf('function disposeProjectTerminals(')), context);
  assert.deepEqual([...context.shownTerminalIds(project)], ['b', 'p', 'a'], 'dragged ones first, in that order; the rest as opened');
  context.reorderTerminals('p', ['a', 'p', 'b']);
  assert.deepEqual(saved, [['p', ['a', 'p', 'b']]]);
  for (const ids of [['a', 'b'], ['a', 'b', 'x'], ['a', 'a', 'b'], null]) assert.throws(() => context.reorderTerminals('p', ids), /终端已变化/);
});

test('public state exposes waiting messages and null for terminals without a notice', () => {
  const context = vm.createContext({
    store: { projects: [{ id: 'p' }], settings: { language: 'zh' } }, sessions: new Map([['waiting', { needsInput: { message: 'Approve tool' } }]]),
    terminalIds: () => ['waiting', 'stopped'], shownTerminalIds: () => ['waiting', 'stopped'], getBranch: () => undefined, startupErrors: new Map(), t: text => text, localShell: () => ({ kind: 'powershell' }),
    process: { platform: 'win32', env: { AGENTRIX_DATA_DIR: 'isolated' } }, app: { getVersion: () => '1' },
    desktopGlassBackend: null, desktopGlassWindow: false, desktopGlassActive: false, windowZoom: null,
  });
  vm.runInContext(main.slice(main.indexOf('function publicState('), main.indexOf('function terminalIds(')), context);
  const terminals = context.publicState().projects[0].terminals;
  assert.equal(terminals[0].needsInput, 'Approve tool'); assert.equal(terminals[1].needsInput, null);
});

test('PowerShell Claude notification hooks filter idle events and send silent bounded permission notices', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const events = [], server = await createEventServer(event => events.push(event));
  t.after(() => server.close());
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const run = payload => new Promise((resolve, reject) => {
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '../integration/claude-hook.ps1'), '-PipeName', server.name, '-ProjectId', 'p', '-SessionKey', 'key', '-Kind', 'notify'], { windowsHide: true });
    let output = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    child.on('error', reject); child.on('close', code => resolve({ code, output }));
    child.stdin.end(JSON.stringify({ session_id: 's', ...payload }));
  });
  for (const notification_type of ['idle_prompt', 'auth_success', 'other', undefined]) assert.deepEqual(await run({ notification_type, message: 'Ignored' }), { code: 0, output: '' });
  assert.equal(events.length, 0);
  for (const notification_type of ['permission_prompt', 'elicitation_dialog']) assert.deepEqual(await run({ notification_type, message: '长'.repeat(400) }), { code: 0, output: '' });
  assert.equal(events.length, 2);
  assert.ok(events.every(event => event.state === 'attention' && event.message === '长'.repeat(300) && event.projectId === 'p' && event.sessionKey === 'key'));
});
