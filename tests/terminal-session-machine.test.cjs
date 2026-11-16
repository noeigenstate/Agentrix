// The Claude terminal's session machine (terminal-events/session-machine.cjs) and its adapter in claude-activity.cjs:
// hooks, transcript reads and the renderer's screen facts (terminal:screenFacts) drive one phase that only moves forward.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { defineMain } = require('./helpers/main-modules.cjs');
const { registerTerminalIpc } = require('../electron/features/terminal/ipc.cjs');

const { PromptQueue } = require('../electron/prompt-queue.cjs');
const { CompletionWork } = require('../electron/completion-work.cjs');
const { SubmissionTracker } = require('../electron/terminal-input.cjs');

// real: the terminal's own prompt queue, completion work and submission tracker, with main's expiry replay.
function fixture({ channel = 'http', native = false, real = false } = {}) {
  let now = 2000, armed = false, notifications = 0;
  const project = { id: 'p', kind: 'ssh' }, subagents = [], timers = [];
  const s = { terminalId: 't', projectId: 'p', sessionId: 'pty', agent: 'claude', codexActive: true, activitySince: 1000, activityInputAt: 0,
    claudeSessionId: 'provider', hooks: { channel }, promptQueue: { finish() {}, list: () => [] }, actions: { settle() {} }, conversation: { settle() {}, list: [] },
    completionWork: { tasks: new Map(), notifications: new Set(), begin() {}, end() {}, state: snapshot => snapshot.state },
    ...(native ? { nativeStructured: true } : {}), flush() {}, chunks: [], seq: 0, status: 'codex', submissions: { write: () => false, sent: [] }, gate: { input() {} } };
  // An injected clock and timer queue: the screen's idle confirmation runs when the test moves time past it.
  const context = vm.createContext({ sessions: new Map([['t', s]]), Date: class extends Date { static now() { return now; } }, broadcast() {},
    scheduleState() {}, store: { projects: [project], setRestore() {}, expectCompletion(_id, value = true) { armed = value; }, complete(_id, _key, at) { if (!armed) return false; armed = false; project.lastCompletedAt = at; return true; } },
    notifyCompletion() { notifications++; }, summarizeTask: () => '', isLocalAgentCommand: require('../electron/agent-commands.cjs').isLocalAgentCommand,
    promptText: require('../electron/prompt-queue.cjs').promptText, followClaude() {}, memoryFolder: () => '', memoryDir: () => '', roundsOf: () => [],
    remember: async () => {}, setTimeout: (run, ms) => { timers.push({ run, due: now + ms }); return { unref() {} }; },
    refreshClaudeAccounts() {}, scrubProjectSkills: async () => {}, findProject() {},
    callsOf: () => ({ subagent: signal => subagents.push(signal), finishContinuation() {} }) });
  defineMain(context, 'publishCliState', 'applyActivity', 'claudeActivity', 'claudeHook', 'observeSwitchTerminal');
  if (real) Object.assign(s, { submissions: new SubmissionTracker(), completionWork: new CompletionWork({ now: () => now }),
    // main.cjs: a submission that expires releases its guard and replays the latest snapshot, which may end the round.
    promptQueue: new PromptQueue(expired => {
      if (!expired?.length) return;
      s.activityInputAt = Math.max(s.activityConfirmedInputAt || 0, ...s.promptQueue.items.map(item => item.at));
      if (s.activityRawSnapshot) context.applyActivity(project, s, s.activityRawSnapshot);
    }, { now: () => now }) });
  const listeners = new Map(), handles = new Map();
  registerTerminalIpc({ handle: (channel, callback) => handles.set(channel, callback), listen: (channel, callback) => listeners.set(channel, callback),
    findProject() {}, getSession: id => context.sessions.get(id), applyActivity: (...args) => context.applyActivity(...args), scheduleState() {}, getProjectById: () => project,
    acknowledgeProject() {}, expectCompletion: id => context.store.expectCompletion(id), pollAfterSubmission() {}, now: () => now });
  let seq = 0, revision = 0;
  const hook = (event, payload = {}) => context.claudeHook({ seq: ++seq, terminalId: 't', event, at: now, sessionId: payload.session_id ?? 'provider',
    transcriptPath: '', promptId: payload.prompt_id ?? null, toolUseId: payload.tool_use_id ?? null, agentId: payload.agent_id ?? null, payload });
  const facts = (flags = {}) => ({ sessionId: 'pty', revision: ++revision, inputPresent: true, busy: false, dialog: false, menu: false, queueShown: false, draft: false, ...flags });
  const elapse = ms => {
    const end = now + ms;
    for (let next; (next = timers.filter(timer => timer.due <= end).sort((a, b) => a.due - b.due)[0]);) {
      timers.splice(timers.indexOf(next), 1); now = Math.max(now, next.due); next.run();
    }
    now = end;
  };
  return { s, context, project, hook, subagents, notifications: () => notifications, armed: () => armed, advance(ms = 1) { now += ms; }, elapse,
    screen: (flags, payload = facts(flags)) => listeners.get('terminal:screenFacts')?.('t', payload), facts, attach: () => handles.get('terminal:attach')('t'),
    key: data => listeners.get('terminal:write')('t', data), type: line => listeners.get('terminal:write')('t', line + '\r'),
    switchState: () => context.observeSwitchTerminal({ identity: s }).state, light: () => s.cliState.screenIdle ? 'idle' : s.cliState.state,
    record(state, at = now) { context.applyActivity(project, s, { state, turnId: state === 'complete' ? `record-${at}` : null, threadId: 'provider', updatedAt: at, transcriptRead: true }); } };
}
// A working turn whose working line the screen has shown.
const working = h => { h.hook('UserPromptSubmit', { prompt: 'Do the task', prompt_id: 'p1' }); h.advance(); h.screen({ busy: true }); h.advance(); };

test('Esc without Stop reaches idle', () => {
  const h = fixture();
  h.hook('UserPromptSubmit', { prompt: 'Do the task', prompt_id: 'p1' }); h.advance();
  // A frame drawn before the working line appeared proves nothing.
  h.screen({ busy: false }); h.elapse(2000); assert.equal(h.light(), 'working');
  h.screen({ busy: true }); h.advance();
  h.hook('PermissionRequest', { tool_name: 'Bash', prompt_id: 'p1' }); assert.equal(h.light(), 'waiting');
  // Esc, typed in the terminal, answers the dialog and interrupts the turn: no Stop, no transcript record, only the key
  // and newer screen facts.
  h.advance(); h.key(''); assert.equal(h.s.needsInput, null);
  h.screen({ busy: false, dialog: true, inputPresent: false }); h.elapse(2000); assert.equal(h.light(), 'waiting');
  h.screen({ busy: false }); h.elapse(999); assert.equal(h.light(), 'waiting', 'an idle frame must stand for a second');
  h.elapse(1);
  assert.equal(h.light(), 'idle'); assert.equal(h.s.needsInput, null);
  // Facts that are malformed, carry text, or belong to another PTY session are refused before the machine sees them.
  const revision = h.s.cliState.revision;
  for (const payload of [{ ...h.facts(), sessionId: 'old-pty', busy: true }, { ...h.facts(), draft: 'typed words' }, { ...h.facts(), text: 'x' }, null, [],
    { ...h.facts(), revision: -1, busy: true }]) h.screen(null, payload);
  assert.equal(h.s.cliState.revision, revision); assert.equal(h.light(), 'idle');
  // A Claude-less terminal takes no facts.
  h.s.agent = 'codex'; h.screen({ busy: true }); h.s.agent = 'claude'; assert.equal(h.light(), 'idle');
});

test('a half frame after a dialog closes does not end the turn and the later Stop still completes once on HTTP', () => {
  const h = fixture();
  working(h);
  h.hook('PermissionRequest', { tool_name: 'Bash', prompt_id: 'p1' }); h.advance(100);
  // The owner answers in the terminal: the dialog goes and the next frame lacks the working line for a moment.
  h.screen({ busy: false }); h.elapse(300); h.screen({ busy: true }); h.elapse(5000);
  assert.equal(h.light(), 'waiting'); assert.equal(h.s.cliState.phase, 'working'); assert.equal(h.armed(), true);
  h.hook('PostToolUse', { tool_use_id: 'tool', prompt_id: 'p1' }); h.advance();
  h.hook('Stop', { prompt_id: 'p1' });
  assert.equal(h.light(), 'idle'); assert.equal(h.notifications(), 1);
  h.advance(); h.hook('Stop', { prompt_id: 'p1' }); assert.equal(h.notifications(), 1);
});

test('a short card without the working line does not end the turn while its hooks keep coming', () => {
  const h = fixture();
  working(h);
  // Claude's task list pushes the working line off a short card's live screen: every frame lacks it.
  h.screen({ busy: false });
  for (let i = 0; i < 6; i++) { h.elapse(500); h.hook('PreToolUse', { tool_use_id: `tool-${i}`, prompt_id: 'p1' }); }
  assert.equal(h.light(), 'working'); assert.equal(h.armed(), true);
  h.hook('Stop', { prompt_id: 'p1' }); assert.equal(h.notifications(), 1);
});

test('a confirmed screen idle turns only the light idle, and a later sign of the turn brings it back', () => {
  const h = fixture();
  working(h);
  h.screen({ busy: false }); h.elapse(1000);
  assert.equal(h.light(), 'idle');
  // The round is untouched: the state stays working for every reader that acts, completion stays armed, the turn open.
  assert.equal(h.s.cliState.state, 'working'); assert.equal(h.s.cliState.phase, 'working'); assert.equal(h.s.codexActivity, 'working');
  assert.equal(h.armed(), true);
  // A tool hook of the same turn shows it still runs; only a newer idle frame starts the quiet again.
  h.hook('PreToolUse', { tool_use_id: 'tool', prompt_id: 'p1' }); assert.equal(h.light(), 'working');
  h.elapse(1000); assert.equal(h.light(), 'working');
  h.screen({ busy: false, menu: true }); h.elapse(1000); assert.equal(h.light(), 'idle');
  // So does a transcript record dated after the screen idle; one dated before it does not.
  const idleAt = h.context.Date.now();
  h.record('working', idleAt - 500); assert.equal(h.light(), 'idle');
  h.advance(); h.record('working'); assert.equal(h.light(), 'working');
  // And a frame with the working line again.
  h.screen({ busy: false }); h.elapse(1000); assert.equal(h.light(), 'idle'); h.screen({ busy: true }); assert.equal(h.light(), 'working');
  // The real end still completes the round once.
  h.advance(); h.hook('Stop', { prompt_id: 'p1' }); assert.equal(h.notifications(), 1);
});

test('a hook after an idle-looking frame cancels the pending confirm until a newer idle frame arrives', () => {
  const h = fixture();
  working(h);
  // A short card: the working line is off-screen, then a long tool call runs with no hook and no new frame.
  h.screen({ busy: false }); h.elapse(500);
  h.hook('PreToolUse', { tool_use_id: 'long-tool', prompt_id: 'p1' }); h.elapse(10000);
  assert.equal(h.light(), 'working');
  h.screen({ busy: false, menu: true }); h.elapse(1000);
  assert.equal(h.light(), 'idle');
});

test('with a permission request open and no further screen facts, nothing is confirmed and the question stands', () => {
  const h = fixture();
  working(h);
  // An idle-looking frame, then the renderer stops sending (a reload or a hang) as Claude asks.
  h.screen({ busy: false }); h.elapse(500);
  h.hook('PermissionRequest', { tool_name: 'Bash', prompt_id: 'p1' }); h.elapse(10000);
  assert.equal(h.s.cliState.state, 'waiting'); assert.equal(h.s.needsInput?.message, 'Bash'); assert.equal(h.light(), 'waiting');
  // Even an idle frame while the question is asked confirms nothing.
  h.screen({ busy: false }); h.elapse(5000);
  assert.equal(h.s.cliState.state, 'waiting'); assert.equal(h.s.needsInput?.message, 'Bash');
});

// scripts/reading-smoke.mjs:280-311 on 1.6.0-beta.1: the stand-in's hooks and screens are statements typed into the
// terminal, so each is also a submission the prompt queue holds; the working line, an idle frame, then Stop.
for (const confirmed of [true, false]) test(`a Stop after an idle-looking screen ${confirmed ? 'confirmed' : 'not yet confirmed'} completes its round once, held submissions or not`, () => {
  const h = fixture({ real: true });
  const hook = (event, payload) => { h.type(`& { hook ${event} }`); h.advance(50); h.hook(event, payload); h.advance(50); };
  hook('UserPromptSubmit', { prompt: 'test interrupt' });
  h.type("Clear-Host; Write-Host 'spinner'; Show-ReadingFixtureInput"); h.screen({ busy: true }); h.advance(300);
  h.type('Clear-Host; Show-ReadingFixtureInput'); h.screen({ busy: false }); h.elapse(confirmed ? 1200 : 300);
  hook('Stop', {});
  assert.equal(h.s.cliState.state, 'idle');
  // The typed statements still wait as submissions; once they expire, the held round completes, as it did before.
  h.elapse(25000); h.s.promptQueue.list();
  assert.equal(h.s.codexActivity, 'complete'); assert.ok(Number.isFinite(h.project.lastCompletedAt)); assert.equal(h.notifications(), 1);
  const completedAt = h.project.lastCompletedAt;
  // Background progress and a repeated Stop, typed the same way, never complete it again.
  hook('PostToolUse', {}); hook('Stop', {}); h.elapse(25000); h.s.promptQueue.list();
  assert.equal(h.project.lastCompletedAt, completedAt); assert.equal(h.notifications(), 1);
});

// main.cjs's refreshCompletion: CompletionWork reports its background work ended and the latest snapshot is replayed.
test('a round held by background work completes once when that work ends and the Stop is replayed', () => {
  const h = fixture({ real: true });
  h.hook('UserPromptSubmit', { prompt: 'Do the task', prompt_id: 'p1' }); h.advance();
  h.s.completionWork.start('shell', h.context.Date.now(), 'shell');
  h.hook('Stop', { prompt_id: 'p1' });
  assert.equal(h.notifications(), 0); assert.equal(h.s.cliState.background, true);
  h.s.completionWork.finish('shell'); h.advance();
  h.context.applyActivity(h.project, h.s, h.s.activityRawSnapshot);
  assert.equal(h.notifications(), 1); assert.ok(Number.isFinite(h.project.lastCompletedAt));
  h.context.applyActivity(h.project, h.s, h.s.activityRawSnapshot); h.hook('Stop', { prompt_id: 'p1' });
  assert.equal(h.notifications(), 1);
});

test('a queued owner prompt keeps completion pending through its predecessor replay and completes once on its own hook Stop', () => {
  const h = fixture({ real: true });
  h.hook('UserPromptSubmit', { prompt: 'First task', prompt_id: 'p1' }); h.advance();
  h.s.promptQueue.enqueue('Second task', h.context.Date.now(), 'm2');
  // A queued UserPromptSubmit still names p1, but advances the owner round's turn number.
  h.hook('UserPromptSubmit', { prompt: 'Second task', prompt_id: 'p1' }); h.advance();
  h.hook('Stop', { prompt_id: 'p1' });
  const stopped = h.s.activityRawSnapshot, turn = h.s.cliStateMeta.machine.turn;
  assert.equal(h.notifications(), 0); assert.equal(h.s.cliStateMeta.machine.pending, turn);
  // M2 leaves the queue and its user record holds the final gate. refreshCompletion replays p1's Stop.
  h.advance();
  const at = h.context.Date.now();
  h.s.completionWork.record({ type: 'user', timestamp: new Date(at).toISOString(), message: { content: 'Second task' } }, 'claude');
  h.s.promptQueue.start('Second task', at, 'm2');
  assert.equal(h.s.promptQueue.list().some(item => item.state === 'queued'), false);
  assert.equal(h.s.completionWork.reviewAt, at);
  h.context.applyActivity(h.project, h.s, stopped);
  assert.equal(h.s.codexActivity, 'working'); assert.equal(h.notifications(), 0);
  assert.equal(h.s.cliStateMeta.machine.pending, turn, 'a final gate held by M2 must not spend p1\'s pending completion');
  // No transcript is followed from here: M2 runs and ends through hooks alone.
  h.advance(); h.hook('PreToolUse', { prompt_id: 'p2', tool_use_id: 'm2-tool' }); h.advance();
  h.hook('Stop', { prompt_id: 'p2' });
  assert.equal(h.notifications(), 1); assert.ok(Number.isFinite(h.project.lastCompletedAt));
  assert.equal(h.s.cliStateMeta.machine.completed, turn);
  const completedAt = h.project.lastCompletedAt;
  h.advance(); h.hook('Stop', { prompt_id: 'p2' });
  h.context.applyActivity(h.project, h.s, h.s.activityRawSnapshot);
  assert.equal(h.notifications(), 1); assert.equal(h.project.lastCompletedAt, completedAt);
});

test('a Stop with nothing held completes at once, whatever the screen showed before it', () => {
  for (const confirmed of [true, false]) {
    const h = fixture();
    working(h);
    h.screen({ busy: false }); h.elapse(confirmed ? 1200 : 300);
    h.hook('Stop', { prompt_id: 'p1' });
    assert.ok(Number.isFinite(h.project.lastCompletedAt)); assert.equal(h.notifications(), 1);
  }
});

test('a pending switch is not released by a screen idle', () => {
  const h = fixture();
  working(h);
  h.screen({ busy: false }); h.elapse(1000);
  assert.equal(h.light(), 'idle'); assert.equal(h.switchState(), 'working');
  h.hook('Stop', { prompt_id: 'p1' }); assert.equal(h.switchState(), 'idle');
});

test('the working line drawn before UserPromptSubmit still lets the screen notice Esc', () => {
  const h = fixture();
  // SessionStart (a command hook) comes first, as the CLI starts; the working line is drawn, then the prompt hook lands.
  h.context.claudeActivity(h.project, h.s, { state: 'session', sessionId: 'provider', eventId: 'provider:start', sessionSource: 'startup' }); h.advance();
  h.screen({ busy: true }); h.advance();
  h.hook('UserPromptSubmit', { prompt: 'Do the task', prompt_id: 'p1' }); h.advance();
  h.screen({ busy: false }); h.elapse(1000);
  assert.equal(h.light(), 'idle');
});

test('a renderer that attaches again sends frame revisions from the start', () => {
  const h = fixture();
  working(h);
  h.screen(null, { ...h.facts(), revision: 500, busy: true });
  h.attach();
  h.screen(null, { ...h.facts(), revision: 1 }); h.elapse(1000);
  assert.equal(h.light(), 'idle');
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
  // The next turn is interrupted: the transcript's interrupt record ends it, and a record written before, read later,
  // keeps it ended.
  h.advance(); h.hook('UserPromptSubmit', { prompt: 'Second', prompt_id: 'p3' }); h.advance(); h.screen({ busy: true });
  const before = h.context.Date.now(); h.advance(10);
  h.record('interrupted'); assert.equal(h.s.cliState.state, 'idle'); assert.equal(h.s.cliState.phase, 'ready');
  h.record('working', before); h.screen({ busy: false }); h.elapse(2000);
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
    const stoppedAt = at;
    step({ type: 'stop', prompt: 'p1' });
    const seen = [];
    for (let i = 0; i < 12; i++) {
      const signal = pick([{ type: 'start', prompt: 'p1' }, { type: 'progress', prompt: 'p1' }, { type: 'progress', prompt: 'p1', async: true }, { type: 'stop', prompt: 'p1' },
        { type: 'record', state: 'working', at: stoppedAt - 1 }, { type: 'record', state: 'interrupted', at: stoppedAt - 1 }, { type: 'confirm', at: at + 5000 },
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
  h.advance(); h.record('complete'); h.advance(); h.screen({ busy: false }); h.elapse(2000);
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
  assert.equal(completions({ type: 'settled', queued: true }), 0, 'the transcript shows a queued prompt');
  step({ type: 'progress', prompt: 'p2' }); assert.equal(state.phase, 'working'); assert.equal(state.queue, 0);
  step({ type: 'stop', prompt: 'p2' });
  assert.equal(completions({ type: 'settled', background: true }), 0, 'background work runs');
  step({ type: 'stop', prompt: 'p2' });
  assert.equal(completions({ type: 'settled', blocked: true }), 0, 'the final gate still holds the round');
  assert.equal(completions({ type: 'settled' }), 1);
  // A repeated Stop, an idle callback, a background callback, a StopFailure or the screen never rearm it.
  for (const signal of [{ type: 'stop', prompt: 'p2' }, { type: 'settled' }, { type: 'record', state: 'complete' }, { type: 'stop', prompt: 'p2', failed: true },
    { type: 'screen', terminalSession: 'pty', revision: 1 }, { type: 'confirm', at: 99999 }, { type: 'progress', prompt: 'p2' }, { type: 'settled' }]) assert.equal(completions(signal), 0);
  step({ type: 'start', prompt: 'p3', local: true }); step({ type: 'stop', prompt: 'p3' });
  assert.equal(completions({ type: 'settled' }), 0, 'a local command is no owner round');
  // A queued message Claude absorbed mid-turn runs no hook: the transcript's empty queue clears the machine's count.
  step({ type: 'start', prompt: 'p4' }); step({ type: 'start', prompt: 'p4' }); step({ type: 'stop', prompt: 'p4' });
  assert.equal(completions({ type: 'settled', queued: false }), 1); assert.equal(state.queue, 0);
});

test("a native Claude session's records skip the terminal machine, and a working record in the ending millisecond counts", () => {
  for (const native of [true, false]) {
    const h = fixture({ native });
    h.record('working', 2500); h.record('complete', 3000);
    // A queued message starts in the same millisecond as the previous turn's end.
    h.record('working', 3000);
    assert.equal(h.s.codexActivity, 'working', native ? 'native' : 'terminal');
  }
});

test('a machine fed before the first publish survives that publish, and sub-agent signals keep the C-15 shape', () => {
  const h = fixture();
  h.hook('SubagentStart', { agent_id: 'child', agent_type: 'Explore', agent_transcript_path: '/subagents/agent-child.jsonl' });
  const meta = h.s.cliStateMeta;
  assert.ok(meta?.machine, 'the sub-agent signal went through the machine');
  h.hook('UserPromptSubmit', { prompt: 'Do the task', prompt_id: 'p1' });
  assert.equal(h.s.cliStateMeta, meta); assert.equal(meta.machine.turn, 1); assert.equal(h.s.cliState.turn, 1);
  h.hook('PreToolUse', { tool_name: 'SendMessage', tool_use_id: 'send-1', tool_input: { to: 'child' } });
  // A session's end leaves later hooks of it without effect until a new session starts; its sub-agents' signals still land.
  h.hook('SessionEnd', {}); h.advance(); h.hook('PermissionRequest', { tool_name: 'Bash', prompt_id: 'p1' });
  assert.equal(h.s.cliState.state, 'working'); assert.equal(h.s.cliStateMeta.machine.phase, 'exited');
  h.hook('SubagentStop', { agent_id: 'child', agent_type: 'Explore' });
  assert.deepEqual(JSON.parse(JSON.stringify(h.subagents)), [
    { kind: 'start', terminalId: 't', agentId: 'child', agentType: 'Explore', transcriptPath: '/subagents/agent-child.jsonl', toolUseId: null, at: 2000 },
    { kind: 'continue', terminalId: 't', agentId: 'child', agentType: '', transcriptPath: null, toolUseId: 'send-1', at: 2000 },
    { kind: 'stop', terminalId: 't', agentId: 'child', agentType: 'Explore', transcriptPath: null, toolUseId: null, at: 2001 }]);
});
