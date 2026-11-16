// The Claude terminal's session machine (terminal-events/session-machine.cjs) and its adapter in claude-activity.cjs:
// hooks, transcript reads and the renderer's screen facts (terminal:screenFacts) drive one phase that only moves forward.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { defineMain } = require('./helpers/main-modules.cjs');
const { registerTerminalIpc } = require('../electron/features/terminal/ipc.cjs');

function fixture({ channel = 'http' } = {}) {
  let now = 2000, armed = false, notifications = 0;
  const project = { id: 'p', kind: 'ssh' }, subagents = [];
  const s = { terminalId: 't', projectId: 'p', sessionId: 'pty', agent: 'claude', codexActive: true, activitySince: 1000, activityInputAt: 0,
    claudeSessionId: 'provider', hooks: { channel }, promptQueue: { finish() {}, list: () => [] }, actions: { settle() {} }, conversation: { settle() {}, list: [] },
    completionWork: { tasks: new Map(), notifications: new Set(), begin() {}, end() {}, state: snapshot => snapshot.state } };
  const context = vm.createContext({ sessions: new Map([['t', s]]), Date: class extends Date { static now() { return now; } }, broadcast() {},
    scheduleState() {}, store: { projects: [project], setRestore() {}, expectCompletion(_id, value = true) { armed = value; }, complete() { if (!armed) return false; armed = false; return true; } },
    notifyCompletion() { notifications++; }, summarizeTask: () => '', isLocalAgentCommand: require('../electron/agent-commands.cjs').isLocalAgentCommand,
    promptText: require('../electron/prompt-queue.cjs').promptText, followClaude() {}, memoryFolder: () => '', memoryDir: () => '', roundsOf: () => [],
    remember: async () => {}, setTimeout: () => ({ unref() {} }), refreshClaudeAccounts() {}, scrubProjectSkills: async () => {},
    callsOf: () => ({ subagent: signal => subagents.push(signal), finishContinuation() {} }) });
  defineMain(context, 'publishCliState', 'applyActivity', 'claudeActivity', 'claudeHook');
  const listeners = new Map();
  registerTerminalIpc({ handle() {}, listen: (channel, callback) => listeners.set(channel, callback), getSession: id => context.sessions.get(id),
    applyActivity: (...args) => context.applyActivity(...args), now: () => now });
  let seq = 0, revision = 0;
  const hook = (event, payload = {}) => context.claudeHook({ seq: ++seq, terminalId: 't', event, at: now, sessionId: payload.session_id ?? 'provider',
    transcriptPath: '', promptId: payload.prompt_id ?? null, toolUseId: payload.tool_use_id ?? null, agentId: payload.agent_id ?? null, payload });
  const facts = (flags = {}) => ({ sessionId: 'pty', revision: ++revision, inputPresent: true, busy: false, dialog: false, menu: false, queueShown: false, draft: false, ...flags });
  return { s, context, project, hook, subagents, notifications: () => notifications, advance(ms = 1) { now += ms; },
    screen: (flags, payload = facts(flags)) => listeners.get('terminal:screenFacts')?.('t', payload), facts,
    record(state, at = now) { context.applyActivity(project, s, { state, turnId: state === 'complete' ? `record-${at}` : null, threadId: 'provider', updatedAt: at, transcriptRead: true }); } };
}

test('Esc without Stop reaches idle', () => {
  const h = fixture();
  h.hook('UserPromptSubmit', { prompt: 'Do the task', prompt_id: 'p1' }); h.advance();
  // A frame drawn before the working line appeared proves nothing.
  h.screen({ busy: false }); assert.equal(h.s.cliState.state, 'working');
  h.advance(); h.screen({ busy: true }); h.advance();
  h.hook('PermissionRequest', { tool_name: 'Bash', prompt_id: 'p1' }); assert.equal(h.s.cliState.state, 'waiting');
  // Esc answers the dialog and interrupts the turn: no Stop, no transcript record, only newer screen facts.
  h.advance(); h.screen({ busy: false, dialog: true, inputPresent: false }); assert.equal(h.s.cliState.state, 'waiting');
  h.advance(); h.screen({ busy: false });
  assert.equal(h.s.cliState.state, 'idle'); assert.equal(h.s.cliState.phase, 'ready'); assert.equal(h.s.needsInput, null);
  assert.equal(h.s.codexActivity, 'interrupted'); assert.equal(h.notifications(), 0);
  // Facts that are malformed, carry text, or belong to another PTY session are refused before the machine sees them.
  const revision = h.s.cliState.revision;
  h.advance(); h.hook('UserPromptSubmit', { prompt: 'Next task', prompt_id: 'p2' }); h.advance(); h.screen({ busy: true }); h.advance();
  for (const payload of [{ ...h.facts(), sessionId: 'old-pty' }, { ...h.facts(), draft: 'typed words' }, { ...h.facts(), text: 'x' }, null, [], { ...h.facts(), revision: -1 }]) h.screen(null, payload);
  assert.equal(h.s.cliState.state, 'working'); assert.ok(h.s.cliState.revision > revision);
  // An older frame, once a newer one was taken, changes nothing; a Claude-less terminal takes no facts.
  h.screen(null, { ...h.facts(), revision: 1 }); assert.equal(h.s.cliState.state, 'working');
  h.s.agent = 'codex'; h.advance(); h.screen({ busy: false }); h.s.agent = 'claude'; assert.equal(h.s.cliState.state, 'working');
});

test('on a command hook channel the screen turns the light idle and a trailing Stop still completes the round', () => {
  const h = fixture({ channel: 'command-async' });
  h.hook('UserPromptSubmit', { prompt: 'Do the task', prompt_id: 'p1' }); h.advance(); h.screen({ busy: true }); h.advance(); h.screen({ busy: false });
  assert.equal(h.s.cliState.state, 'idle'); assert.notEqual(h.s.codexActivity, 'interrupted', 'the Stop can trail the screen here');
  h.advance(); h.hook('Stop', { prompt_id: 'p1' });
  assert.equal(h.notifications(), 1);
});

test('repeats, reordering and late transcript records never move the phase back', () => {
  const h = fixture();
  h.hook('UserPromptSubmit', { prompt: 'Do the task', prompt_id: 'p1' }); h.advance();
  h.hook('PreToolUse', { tool_use_id: 'tool', prompt_id: 'p1' }); h.advance();
  const stopped = h.context.Date.now();
  h.hook('Stop', { prompt_id: 'p1' }); assert.equal(h.s.cliState.state, 'idle'); assert.equal(h.notifications(), 1);
  const revision = h.s.cliState.revision;
  // A repeated UserPromptSubmit of the finished prompt, its tool hooks, and a transcript record dated before its Stop.
  h.advance(); h.hook('UserPromptSubmit', { prompt: 'Do the task', prompt_id: 'p1' });
  h.advance(); h.hook('PostToolUse', { tool_use_id: 'tool', prompt_id: 'p1' });
  h.advance(); h.record('working', stopped - 1);
  assert.equal(h.s.cliState.revision, revision); assert.equal(h.s.cliState.state, 'idle'); assert.equal(h.s.cliState.phase, 'ready');
  assert.notEqual(h.s.codexActivity, 'working');
  // An older prompt's late UserPromptSubmit after a newer one, then the newer turn ends by Esc on the screen.
  // The next turn ends by Esc on the screen; a repeated busy frame first changes nothing.
  h.advance(); h.hook('UserPromptSubmit', { prompt: 'Second', prompt_id: 'p3' }); h.advance(); h.screen({ busy: true }); h.screen({ busy: true });
  const ended = h.context.Date.now(); h.advance(10); h.screen({ busy: false }); assert.equal(h.s.cliState.state, 'idle');
  // The transcript's interrupt record and a record written before Esc, read later, keep it ended.
  h.advance(); h.record('interrupted', ended + 5); h.record('working', ended + 6); h.screen({ busy: false });
  assert.equal(h.s.cliState.state, 'idle'); assert.equal(h.s.cliState.phase, 'ready');
  // A new prompt is new and works as ever.
  h.advance(); h.hook('UserPromptSubmit', { prompt: 'Next', prompt_id: 'p4' }); assert.equal(h.s.cliState.state, 'working');
});

test("seeded orders of one prompt's hooks, with repeats and late records, never move the phase back once its Stop applied", () => {
  const { createSessionMachine, reduce } = require('../electron/features/terminal-events/session-machine.cjs');
  let seed = 7;
  const pick = list => list[Math.floor((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 * list.length)];
  for (let run = 0; run < 200; run++) {
    let state = createSessionMachine({ terminalSession: 'pty', claudeSession: 'provider', launch: 0 }), at = 10, revision = 0;
    const step = signal => { state = reduce(state, { at: at++, claudeSession: 'provider', ...signal }).state; };
    const frame = busy => ({ type: 'screen', terminalSession: 'pty', revision: ++revision, busy, inputPresent: true });
    step({ type: 'start', prompt: 'p1' });
    for (let i = 0; i < run % 5; i++) step(pick([{ type: 'progress', prompt: 'p1' }, { type: 'attention', prompt: 'p1' }, frame(true), { type: 'record', state: 'working' }]));
    step({ type: 'stop', prompt: 'p1' });
    const stoppedAt = at, seen = [];
    for (let i = 0; i < 12; i++) {
      const signal = pick([{ type: 'start', prompt: 'p1' }, { type: 'progress', prompt: 'p1' }, { type: 'progress', prompt: 'p1', async: true }, { type: 'stop', prompt: 'p1' },
        { type: 'record', state: 'working', at: stoppedAt - 2 }, { type: 'record', state: 'working', at: stoppedAt - 1 }, { type: 'record', state: 'interrupted', at: stoppedAt - 1 },
        { type: 'attention', prompt: 'p1', async: true, notice: true }, { type: 'start', prompt: 'p0', at: 1 }, { type: 'settled' }, frame(true), frame(false)]);
      step(typeof signal.revision === 'number' ? frame(signal.busy) : signal); seen.push(signal.type);
      assert.equal(state.phase, 'ready', `run ${run}: ${seen.join(',')}`);
    }
    // An old epoch changes nothing: another Claude session, a launch before this one, another PTY session's frame.
    for (const signal of [{ type: 'start', prompt: 'x', claudeSession: 'other' }, { type: 'stop', at: -1 }, { type: 'screen', terminalSession: 'old', revision: 99 }]) {
      assert.equal(reduce(state, { at, claudeSession: 'provider', ...signal }).state, state);
    }
  }
});

test('a completion effect needs Stop, an empty queue and no background work', async () => {
  // Through the adapter: CompletionWork's running background task holds the alert; the round's next Stop raises it once.
  const h = fixture();
  let read;
  h.s.activityMonitor = { poll: () => new Promise(resolve => { read = resolve; }) };
  // The read is in flight until the test answers it; the adapter applies the round once it has.
  const stop = () => {
    const applied = new Promise(resolve => { const apply = h.context.applyActivity; h.context.applyActivity = (...args) => { h.context.applyActivity = apply; apply(...args); resolve(); }; });
    h.hook('Stop', { prompt_id: 'p1' }); read(); return applied;
  };
  h.hook('UserPromptSubmit', { prompt: 'Do the task', prompt_id: 'p1' }); h.advance();
  h.s.completionWork.tasks.set('shell', { id: 'shell' });
  const first = stop(); assert.equal(h.s.cliState.state, 'idle', 'Stop publishes at once; the read only gates completion');
  await first;
  assert.equal(h.notifications(), 0); assert.equal(h.s.cliState.background, true);
  h.s.completionWork.tasks.clear(); h.advance();
  await stop();
  assert.equal(h.notifications(), 1);
  h.advance(); await stop();
  h.advance(); h.record('complete'); h.advance(); h.screen({ busy: false });
  assert.equal(h.notifications(), 1);

  // The machine itself: each condition alone withholds the effect, and nothing rearms it.
  const { createSessionMachine, reduce } = require('../electron/features/terminal-events/session-machine.cjs');
  let state = createSessionMachine({ terminalSession: 'pty', claudeSession: 'provider' }), at = 10;
  const step = signal => { const result = reduce(state, { at: at++, ...signal }); state = result.state; return result.effects; };
  const completions = signal => step(signal).filter(effect => effect.type === 'completion').length;
  step({ type: 'start', prompt: 'p1' });
  assert.equal(completions({ type: 'settled' }), 0, 'no Stop yet');
  step({ type: 'start', prompt: 'p1' }); assert.equal(state.queue, 1);
  step({ type: 'stop', prompt: 'p1' }); assert.equal(state.phase, 'stopping');
  assert.equal(completions({ type: 'settled' }), 0, 'a prompt is queued');
  step({ type: 'progress', prompt: 'p2' }); assert.equal(state.phase, 'working'); assert.equal(state.queue, 0);
  step({ type: 'stop', prompt: 'p2' });
  assert.equal(completions({ type: 'settled', background: true }), 0, 'background work runs'); assert.equal(state.background, true);
  step({ type: 'stop', prompt: 'p2' });
  assert.equal(completions({ type: 'settled', queued: true }), 0, 'the transcript shows a queued prompt');
  step({ type: 'stop', prompt: 'p2' });
  assert.equal(completions({ type: 'settled' }), 1);
  // A repeated Stop, an idle callback, a background callback, a StopFailure or the screen never rearm it.
  for (const signal of [{ type: 'stop', prompt: 'p2' }, { type: 'settled' }, { type: 'record', state: 'complete' }, { type: 'stop', prompt: 'p2', failed: true },
    { type: 'screen', terminalSession: 'pty', revision: 1 }, { type: 'progress', prompt: 'p2' }, { type: 'settled' }]) assert.equal(completions(signal), 0);
  step({ type: 'start', prompt: 'p3', local: true }); step({ type: 'stop', prompt: 'p3' });
  assert.equal(completions({ type: 'settled' }), 0, 'a local command is no owner round');
});

test('a machine fed before the first publish survives that publish, and sub-agent signals keep the C-15 shape', () => {
  const h = fixture();
  h.hook('SubagentStart', { agent_id: 'child', agent_type: 'Explore', agent_transcript_path: '/subagents/agent-child.jsonl' });
  const meta = h.s.cliStateMeta;
  assert.ok(meta?.machine, 'the sub-agent signal went through the machine');
  h.hook('UserPromptSubmit', { prompt: 'Do the task', prompt_id: 'p1' });
  assert.equal(h.s.cliStateMeta, meta); assert.equal(meta.machine.turn, 1); assert.equal(h.s.cliState.turn, 1);
  h.hook('PreToolUse', { tool_name: 'SendMessage', tool_use_id: 'send-1', tool_input: { to: 'child' } });
  assert.deepEqual(JSON.parse(JSON.stringify(h.subagents)), [
    { kind: 'start', terminalId: 't', agentId: 'child', agentType: 'Explore', transcriptPath: '/subagents/agent-child.jsonl', toolUseId: null, at: 2000 },
    { kind: 'continue', terminalId: 't', agentId: 'child', agentType: '', transcriptPath: null, toolUseId: 'send-1', at: 2000 }]);
  // A session's end leaves later hooks of it without effect until a new session starts.
  h.hook('SessionEnd', {}); h.advance(); h.hook('PermissionRequest', { tool_name: 'Bash', prompt_id: 'p1' });
  assert.equal(h.s.cliState.state, 'working'); assert.equal(h.s.cliStateMeta.machine.phase, 'exited');
});
