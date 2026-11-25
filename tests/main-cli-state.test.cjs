const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { defineMain } = require('./helpers/main-modules.cjs');
const { createShellEvents } = require('../electron/features/terminal-events/shell-events.cjs');

function fixture(agent = 'claude') {
  let now = 2000, armed = false, notifications = 0, beginnings = 0;
  const frames = [], project = { id: 'p', kind: 'ssh' };
  const s = { terminalId: 't', projectId: 'p', sessionId: 'pty', sessionKey: 'cap', agent, cliActive: true, activitySince: 1000, activityInputAt: 0,
    claudeSessionId: agent === 'claude' ? 'provider' : null, reportedThreadId: agent === 'codex' ? 'provider' : null,
    promptQueue: { finish() {}, list: () => [] }, actions: { settle() {} }, conversation: { settle() {}, list: [] },
    completionWork: { begin() { beginnings++; }, end() {}, state: snapshot => snapshot.state } };
  const context = vm.createContext({ adapterOf: require('../electron/features/cli-adapters/registry.cjs').adapterOf,
    sessions: new Map([['t', s]]), Date: class extends Date { static now() { return now; } },
    broadcast() { frames.push(s.cliState && { ...s.cliState }); }, scheduleState: () => assert.fail('CLI transitions must not schedule delayed state'),
    store: { projects: [project], setRestore() {}, expectCompletion(_id, value = true) { armed = value; }, complete() { if (!armed) return false; armed = false; return true; } },
    notifyCompletion() { notifications++; }, summarizeTask: () => '', isLocalAgentCommand: require('../electron/agent-commands.cjs').isLocalAgentCommand,
    promptText: require('../electron/prompt-queue.cjs').promptText, followClaude() {}, memoryFolder: () => '', memoryDir: () => '', roundsOf: () => [],
    remember: async () => {}, setTimeout: () => ({ unref() {} }), refreshClaudeAccounts() {}, scrubProjectSkills: async () => {},
    reportHookChannel: require('../electron/features/terminal-events/hook-channel.cjs').reportHookChannel });
  context.now = () => now;
  context.onEvent = createShellEvents(context).onEvent;
  defineMain(context, 'publishCliState', 'applyActivity', 'claudeActivity', 'claudeHook', 'acceptDispatchEvent');
  let serial = 0;
  const hook = (state, extra = {}) => context.claudeActivity(project, s, { state, sessionId: 'provider', eventId: 'provider:hook-' + ++serial, sentAt: now, ...extra });
  return { s, frames, hook, context, project, advance(ms = 1) { now += ms; }, notifications: () => notifications, beginnings: () => beginnings,
    record(state, turnId, at = now) { context.applyActivity(project, s, { state, turnId, threadId: 'provider', updatedAt: at }); } };
}

test('host CLI transitions broadcast synchronously and Stop does not await a stalled transcript reader', () => {
  const h = fixture();
  h.hook('working', { prompt: 'Do the task' }); assert.equal(h.s.cliState.state, 'working'); assert.equal(h.beginnings(), 1);
  h.advance(); h.hook('attention', { hookEvent: 'PermissionRequest', message: 'Approve' }); assert.equal(h.frames.at(-1).state, 'waiting');
  h.advance(); h.hook('progress', { hookEvent: 'PostToolUse', requestId: 'sibling-tool' }); assert.equal(h.frames.at(-1).state, 'waiting'); assert.ok(h.s.needsInput);
  h.s.activityMonitor = { poll: () => new Promise(() => {}) };
  h.advance(); h.hook('complete'); assert.equal(h.frames.at(-1).state, 'idle'); assert.equal(h.s.needsInput, null);
  assert.equal(h.beginnings(), 1); assert.equal(h.notifications(), 0);
  assert.ok(h.frames.every((frame, index) => !index || frame.revision >= h.frames[index - 1].revision));
  assert.equal(h.frames.at(-1).revision, 4);
});

test('delayed permission hooks publish their send time in the local clock, not their arrival time', () => {
  for (const kind of ['local', 'ssh']) for (const hookEvent of ['PermissionRequest', 'Notification']) {
    const h = fixture(); h.project.kind = kind; h.s.activityClockOffset = 100;
    h.hook('working', { prompt: 'Task', sentAt: kind === 'ssh' ? 1900 : 2000 }); h.advance(100);
    h.hook('attention', { hookEvent, sentAt: kind === 'ssh' ? 1910 : 2010, message: 'Approve' });
    assert.equal(h.s.cliState.state, 'waiting');
    assert.equal(h.s.cliState.updatedAt, 2010, `${kind} ${hookEvent} keeps its observation time`);
    assert.equal(h.beginnings(), 1); assert.equal(h.notifications(), 0);
  }
});

test('HTTP permission state uses the ingest receipt time even when delivery is delayed', () => {
  const h = fixture(); h.project.kind = 'local';
  h.hook('working', { prompt: 'Task' }); h.advance(10);
  const { createHookIngest } = require('../electron/features/terminal-events/hook-ingest.cjs');
  const ingest = createHookIngest({ keyOf: () => 'key', now: () => 2010,
    deliver(event) { h.advance(100); h.context.claudeHook(event); } });
  ingest.take('t', 'PermissionRequest', JSON.stringify({ session_id: 'provider', tool_name: 'Bash' }));
  assert.equal(h.s.cliState.state, 'waiting'); assert.equal(h.s.cliState.updatedAt, 2010);
  assert.equal(h.beginnings(), 1); assert.equal(h.notifications(), 0);
});

test('hook state timestamps are bounded by now and never regress within the PTY session', () => {
  const h = fixture(); h.hook('working', { prompt: 'Task' }); h.advance(100);
  // A screen relight or another publisher can have a newer publication time than its event watermark.
  h.context.publishCliState(h.s, 'working', { at: 2000 });
  h.advance(100); h.hook('attention', { sentAt: 2050 });
  assert.equal(h.s.cliState.updatedAt, 2100, 'an older hook cannot move the published time backwards');
  h.hook('attention', { sentAt: 2300 });
  assert.equal(h.s.cliState.updatedAt, 2200, 'a future send time cannot outrank future screen frames');
});

test('a hook without a send time uses the current host time', () => {
  const h = fixture(); h.hook('working', { prompt: 'Task' }); h.advance(100);
  h.hook('attention', { sentAt: undefined });
  assert.equal(h.s.cliState.updatedAt, 2100);
});

test('old session, old event time, duplicate events and another tool cannot clear newer attention', () => {
  const h = fixture(); h.hook('working', { prompt: 'Task' }); h.advance(10);
  h.hook('attention', { requestId: 'new-tool', eventId: 'new-attention' });
  const revision = h.s.cliState.revision;
  h.hook('complete', { sessionId: 'old-provider' });
  h.hook('complete', { sentAt: 2000 });
  h.hook('progress', { requestId: 'old-tool' });
  h.hook('working', { eventId: 'new-attention', prompt: 'duplicate' });
  h.record('complete', 'old-stop', 2000);
  assert.equal(h.s.cliState.revision, revision); assert.equal(h.s.cliState.state, 'waiting'); assert.equal(h.beginnings(), 1);
  assert.equal(h.context.publishCliState(h.s, 'idle', { expectedRevision: revision - 1 }), false);
});

test('a delayed Stop poll cannot overwrite an attention event with a newer revision', async () => {
  const h = fixture(); h.hook('working', { prompt: 'Task' }); h.advance();
  let finish;
  h.s.activityMonitor = { poll: () => new Promise(resolve => { finish = resolve; }) };
  h.hook('complete'); h.advance(); h.hook('attention', { message: 'New dialog' });
  const revision = h.s.cliState.revision;
  finish(); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.s.cliState.revision, revision); assert.equal(h.s.cliState.state, 'waiting'); assert.equal(h.notifications(), 0);
});

test('local command completion clears attention, while progress and repeated Stop never rearm completion', () => {
  const h = fixture();
  h.hook('working', { prompt: '/status' }); h.advance(); h.hook('attention'); h.advance(); h.hook('complete');
  assert.equal(h.s.cliState.state, 'idle'); assert.equal(h.s.needsInput, null); assert.equal(h.beginnings(), 0);
  h.advance(); h.hook('working', { prompt: 'Actual task' }); h.advance(); h.hook('complete');
  assert.equal(h.notifications(), 1);
  h.advance(); h.hook('progress'); h.advance(); h.hook('complete'); h.advance(); h.hook('complete');
  assert.equal(h.notifications(), 1); assert.equal(h.beginnings(), 1); assert.equal(h.s.cliState.state, 'idle');
});

test('a previous Codex turn cannot end a newer turn even when its callback arrives later', () => {
  const h = fixture('codex');
  h.record('working', 'one'); h.advance(); h.record('working', 'two');
  const revision = h.s.cliState.revision;
  h.advance(); h.record('complete', 'one'); assert.equal(h.s.cliState.revision, revision); assert.equal(h.s.codexActivity, 'working');
  h.advance(); h.record('complete', 'two'); assert.equal(h.s.cliState.state, 'idle');
  h.advance(); h.record('working', 'one'); assert.equal(h.s.cliState.state, 'idle');
});

test('a restarted CLI keeps PTY revisions monotonic and compact does not invent an idle round', () => {
  const h = fixture(); h.hook('working', { prompt: 'Task' }); const revision = h.s.cliState.revision;
  h.advance(); h.hook('session', { sessionSource: 'compact' }); assert.equal(h.s.cliState.state, 'working'); assert.equal(h.beginnings(), 1);
  h.s.cliState = h.s.cliStateMeta = h.s.cliProviderId = null;
  h.advance(); h.hook('session'); assert.ok(h.s.cliState.revision > revision);
});

test('authenticated Codex completion notify publishes idle immediately and rejects a previous turn', () => {
  const h = fixture('codex'); h.record('working', 'one'); h.advance();
  const notify = turnId => h.context.onEvent({ projectId: 't', sessionKey: 'cap', type: 'turn-complete', threadId: 'provider', turnId, eventId: 'provider:' + turnId });
  notify('one'); assert.equal(h.s.cliState.state, 'idle');
  h.advance(); h.record('working', 'two'); const revision = h.s.cliState.revision;
  h.advance(); notify('one'); assert.equal(h.s.cliState.revision, revision); assert.equal(h.s.cliState.state, 'working');
});

for (const notifyFirst of [false, true]) test(`Codex ${notifyFirst ? 'notify-first' : 'record-first'} completion settles its own turn once`, () => {
  const h = fixture('codex'), ended = [], finished = [];
  h.s.completionWork.end = at => ended.push(at); h.s.promptQueue.finish = at => finished.push(at);
  h.context.store.expectCompletion('p'); h.record('working', 'one');
  const record = () => h.record('complete', 'one', 2010);
  const notify = () => h.context.onEvent({ projectId: 't', sessionKey: 'cap', type: 'turn-complete', threadId: 'provider', turnId: 'one', eventId: 'provider:one' });
  h.advance(260);
  if (notifyFirst) { notify(); record(); } else { record(); notify(); }
  assert.ok(ended.includes(2010)); assert.ok(finished.includes(2010));
  assert.equal(h.s.codexActivity, 'complete'); assert.equal(h.notifications(), 1);
  notify(); record(); assert.equal(h.notifications(), 1); assert.equal(h.beginnings(), 0);
});

test('SSH notify before the next 250 ms poll does not hide its earlier remote completion record', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = fixture('codex'); h.context.store.expectCompletion('p'); h.record('working', 'one');
  h.s.activityClockOffset = 60000;
  let endedAt = null; h.s.completionWork.end = at => { endedAt = at; };
  h.s.activityMonitor = { poll: () => new Promise(resolve => setTimeout(() => {
    h.record('complete', 'one', -57990 + h.s.activityClockOffset); resolve();
  }, 250)) };
  h.advance(50);
  h.context.onEvent({ projectId: 't', sessionKey: 'cap', type: 'turn-complete', threadId: 'provider', turnId: 'one', eventId: 'provider:one' });
  assert.equal(h.s.cliState.state, 'idle'); assert.equal(endedAt, null);
  h.advance(250); t.mock.timers.tick(250); await Promise.resolve();
  assert.equal(endedAt, 2010); assert.equal(h.s.codexActivity, 'complete'); assert.equal(h.notifications(), 1);
});

test('an uncorrelated PermissionRequest survives sibling progress and asynchronously reordered progress', () => {
  const h = fixture(); h.hook('working', { prompt: 'Task' }); h.advance(10);
  h.hook('attention', { hookEvent: 'PermissionRequest', message: 'Bash' });
  const revision = h.s.cliState.revision;
  for (const hookEvent of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'ElicitationResult']) {
    h.advance(); h.hook('progress', { hookEvent, requestId: 'sibling-tool' });
    h.hook('progress', { hookEvent, sentAt: 2000 });
  }
  assert.equal(h.s.cliState.revision, revision); assert.equal(h.s.cliState.state, 'waiting'); assert.equal(h.s.needsInput.message, 'Bash');
  h.advance(); h.hook('complete'); h.advance(); h.hook('progress', { hookEvent: 'PostToolUse', requestId: 'late-tool' });
  assert.equal(h.s.cliState.state, 'idle'); assert.equal(h.beginnings(), 1); assert.equal(h.notifications(), 1);
});

test('a late async tool observation cannot raise the working watermark above an earlier Stop', () => {
  const h = fixture(); h.hook('working', { prompt: 'Task' });
  const revision = h.s.cliState.revision;
  h.advance(100); h.hook('progress', { hookEvent: 'PostToolUse', requestId: 'delayed-child' });
  assert.equal(h.s.cliState.revision, revision);
  h.hook('complete', { sentAt: 2050 });
  assert.equal(h.s.cliState.state, 'idle'); assert.equal(h.notifications(), 1); assert.equal(h.beginnings(), 1);
});

test('progress releases a correlated host wait only with its exact request identity', () => {
  const h = fixture(); h.hook('working', { prompt: 'Task' }); h.advance();
  h.context.publishCliState(h.s, 'waiting', { requestId: 'root-request', message: 'Known request' });
  const revision = h.s.cliState.revision;
  h.advance(); h.hook('progress'); h.hook('progress', { requestId: 'other-request' });
  assert.equal(h.s.cliState.revision, revision);
  h.hook('progress', { requestId: 'root-request' });
  assert.equal(h.s.cliState.state, 'working'); assert.equal(h.s.needsInput, null); assert.equal(h.beginnings(), 1);
});

test('under command-async a late Stop of an older prompt does not end the newer turn', () => {
  const h = fixture();
  h.hook('working', { prompt: 'First task', promptId: 'p1' }); h.advance();
  h.hook('progress', { hookEvent: 'PostToolUse', promptId: 'p1' }); h.advance(10);
  // The first turn's Stop hook arrives after the next prompt's, its PowerShell having started later.
  h.hook('working', { prompt: 'Second task', promptId: 'p2' }); h.advance();
  h.hook('complete', { promptId: 'p1' });
  assert.equal(h.s.cliState.state, 'working'); assert.equal(h.notifications(), 0);
  h.advance(); h.hook('complete', { promptId: 'p2' });
  assert.equal(h.s.cliState.state, 'idle'); assert.equal(h.notifications(), 1);
  // A dequeued prompt has no UserPromptSubmit: its first hook, even its Stop, makes it the newest.
  const revision = h.s.cliState.revision;
  h.advance(); h.hook('complete', { promptId: 'p3' });
  assert.ok(h.s.cliState.revision > revision);
});

test('an HTTP hook event becomes the pipe event, and one that lost its payload belongs to the session the terminal follows', () => {
  const h = fixture();
  let seq = 0, at = 3000;
  const hook = (event, payload = {}) => h.context.claudeHook({ seq: ++seq, terminalId: 't', event, at: at++, sessionId: payload.session_id ?? '', transcriptPath: '',
    promptId: payload.prompt_id ?? null, toolUseId: payload.tool_use_id ?? null, agentId: null, payload });
  hook('UserPromptSubmit', { session_id: 'provider', prompt: 'Do the task', prompt_id: 'p1' });
  assert.equal(h.s.cliState.state, 'working'); assert.equal(h.beginnings(), 1);
  hook('Notification', { session_id: 'provider', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
  hook('SubagentStart', { session_id: 'provider', agent_id: 'a' });
  hook('Stop', { session_id: 'another-session' });
  assert.equal(h.s.cliState.state, 'working', 'an idle notice, an event the adapter does not map and another session change nothing');
  hook('PermissionRequest', { session_id: 'provider', tool_name: 'Bash', prompt_id: 'p1' });
  assert.equal(h.s.cliState.state, 'waiting'); assert.equal(h.s.needsInput.message, 'Bash');
  hook('Stop', {});
  assert.equal(h.s.cliState.state, 'idle'); assert.equal(h.notifications(), 1);
});

test("a wrapper's hook-channel report moves the terminal to command hooks and says why, never back", () => {
  const h = fixture();
  h.s.hooks = { channel: 'http', fallback: 'command-async', channelReason: null, key: 'k' };
  h.context.onEvent({ projectId: 't', sessionKey: 'other', type: 'hook-channel', command: 'HTTP_PROXY', sequence: 1 });
  assert.equal(h.s.hooks.channel, 'http');
  h.context.onEvent({ projectId: 't', sessionKey: 'cap', type: 'hook-channel', command: 'HTTP_PROXY', sequence: 2 });
  assert.equal(h.s.hooks.channel, 'command-async'); assert.deepEqual(h.s.hooks.channelReason.params, { variable: 'HTTP_PROXY', source: 'terminal' });
  const fallen = h.s.hooks;
  h.context.onEvent({ projectId: 't', sessionKey: 'cap', type: 'hook-channel', command: 'HTTPS_PROXY', sequence: 3 });
  assert.equal(h.s.hooks, fallen);
});

test('under command-async a permission notice older than a tool hook of its prompt raises no waiting light, and a sync dialog hook still does', () => {
  const h = fixture(); h.s.hooks = { channel: 'command-async' };
  h.hook('working', { prompt: 'Task', promptId: 'p1' }); h.advance(10);
  // The owner answered the dialog; the tool's hook is rejected as state, but its time is kept.
  h.hook('progress', { hookEvent: 'PostToolUse', promptId: 'p1', requestId: 'tool' });
  const revision = h.s.cliState.revision;
  h.hook('attention', { hookEvent: 'Notification', promptId: 'p1', message: 'Claude needs your permission', sentAt: 2005 });
  assert.equal(h.s.cliState.revision, revision); assert.equal(h.s.cliState.state, 'working'); assert.ok(!h.s.needsInput);
  h.advance(); h.hook('attention', { hookEvent: 'PermissionRequest', promptId: 'p1', message: 'Bash' });
  assert.equal(h.s.cliState.state, 'waiting');
  h.advance(); h.hook('attention', { hookEvent: 'Notification', promptId: 'p1', message: 'Claude needs your permission' });
  assert.equal(h.s.cliState.state, 'waiting', 'a notice newer than every tool hook still counts');
});

test('under command-async a late hook of a prompt whose Stop was applied changes nothing and never rearms completion', () => {
  const h = fixture(); h.s.hooks = { channel: 'command-async' };
  // A queued prompt's UserPromptSubmit carries the running prompt's id and comes before that prompt's Stop.
  h.hook('working', { prompt: 'Task', promptId: 'p1' }); h.advance();
  h.hook('working', { prompt: 'Queued', promptId: 'p1' }); h.advance();
  assert.equal(h.s.cliState.state, 'working'); assert.equal(h.beginnings(), 2);
  h.hook('complete', { promptId: 'p1' });
  assert.equal(h.s.cliState.state, 'idle'); assert.equal(h.notifications(), 1);
  const revision = h.s.cliState.revision;
  for (const state of ['working', 'progress', 'attention']) { h.advance(); h.hook(state, { prompt: 'Task', promptId: 'p1', hookEvent: 'Notification', message: 'late' }); }
  assert.equal(h.s.cliState.revision, revision); assert.equal(h.s.cliState.state, 'idle');
  assert.equal(h.beginnings(), 2); assert.equal(h.notifications(), 1);
  h.advance(); h.hook('complete', { promptId: 'p1' });
  assert.equal(h.notifications(), 1);
  // The next prompt is new and works as ever.
  h.advance(); h.hook('working', { prompt: 'Next', promptId: 'p2' });
  assert.equal(h.s.cliState.state, 'working'); assert.equal(h.beginnings(), 3);
});

test('a StopFailure ends the round without rearming completion when the turn failed', () => {
  const h = fixture();
  let seq = 0, at = 3000;
  const hook = (event, payload = {}) => h.context.claudeHook({ seq: ++seq, terminalId: 't', event, at: at++, sessionId: 'provider', transcriptPath: '',
    promptId: payload.prompt_id ?? null, toolUseId: null, agentId: null, payload });
  hook('UserPromptSubmit', { prompt: 'Do the task', prompt_id: 'p1' });
  assert.equal(h.s.cliState.state, 'working');
  hook('StopFailure', { prompt_id: 'p1', error: 'unknown', last_assistant_message: 'API Error: 400' });
  assert.equal(h.s.cliState.state, 'idle', 'the waiting light leaves working');
  assert.equal(h.s.codexActivity, 'interrupted'); assert.equal(h.notifications(), 0, 'a failed turn is not a completed round');
  // Nothing later rearms the alert: a repeated Stop or a StopFailure finds no armed completion.
  h.advance(); hook('Stop', { prompt_id: 'p1' }); hook('StopFailure', { prompt_id: 'p1' });
  assert.equal(h.notifications(), 0);
  // The next round still completes normally.
  hook('UserPromptSubmit', { prompt: 'Try again', prompt_id: 'p2' }); hook('Stop', { prompt_id: 'p2' });
  assert.equal(h.notifications(), 1);
});

test('a StopFailure on the command channel ends the round as interrupted without rearming completion', () => {
  const h = fixture(); h.s.hooks = { channel: 'command-async' };
  // The event agent-event.cjs sends for the stop-failed kind; claude-hook.ps1 sends the same state (hook-cli-state.test.cjs).
  const { claudeEvent } = require('../integration/agent-event.cjs');
  let serial = 0;
  const send = (kind, payload) => h.context.onEvent({ ...claudeEvent(JSON.stringify({ session_id: 'provider', ...payload }), 't', 'cap', kind), eventId: 'provider:command-' + ++serial });
  send('start', { hook_event_name: 'UserPromptSubmit', prompt: 'Do the task' });
  assert.equal(h.s.cliState.state, 'working'); assert.equal(h.beginnings(), 1);
  send('stop-failed', { hook_event_name: 'StopFailure', error: 'unknown', last_assistant_message: 'API Error: 400' });
  assert.equal(h.s.cliState.state, 'idle', 'the light leaves working at once, not at the next transcript read');
  assert.equal(h.s.codexActivity, 'interrupted'); assert.equal(h.notifications(), 0);
  send('stop', { hook_event_name: 'Stop' }); send('stop-failed', { hook_event_name: 'StopFailure' });
  assert.equal(h.notifications(), 0, 'nothing later rearms the alert');
});

test('a posix hook names its prompt, so a late Stop of an older prompt does not end the newer turn', () => {
  const h = fixture();
  const { claudeEvent } = require('../integration/agent-event.cjs');
  let serial = 0;
  const send = (kind, payload) => {
    const event = claudeEvent(JSON.stringify({ session_id: 'provider', ...payload }), 't', 'cap', kind);
    assert.equal(event.promptId, payload.prompt_id, 'agent-event.cjs forwards prompt_id as claude-hook.ps1 does');
    h.context.onEvent({ ...event, eventId: 'provider:posix-' + ++serial });
  };
  send('start', { hook_event_name: 'UserPromptSubmit', prompt: 'First task', prompt_id: 'p1' });
  send('start', { hook_event_name: 'UserPromptSubmit', prompt: 'Second task', prompt_id: 'p2' });
  send('stop', { hook_event_name: 'Stop', prompt_id: 'p1' });
  assert.equal(h.s.cliState.state, 'working'); assert.equal(h.notifications(), 0);
  send('stop', { hook_event_name: 'Stop', prompt_id: 'p2' });
  assert.equal(h.s.cliState.state, 'idle'); assert.equal(h.notifications(), 1);
});

test("a hook-channel report and its claude launch pair by sequence, whichever pipe connection lands first", () => {
  const h = fixture(), { startHookLaunch } = require('../electron/features/terminal-events/hook-channel.cjs');
  // A version run keeps the launch branch short; the hook channel follows every claude launch alike.
  Object.assign(h.context, { acceptShellEvent: require('../electron/terminal-input.cjs').acceptShellEvent, startHookLaunch, agentCommand: () => ({ name: 'version' }),
    readingHistory: { close() {} }, stopUsageAccount() {}, startSkillSession() {} });
  Object.assign(h.context.store, { findTerminal: () => null });
  Object.assign(h.s, { actions: { reset() {} }, conversation: { reset() {} }, promptQueue: { reset() {} } });
  h.s.hooks = { channel: 'http', fallback: 'command-async', channelReason: null, key: 'k' };
  const shell = (type, sequence, extra = {}) => h.context.onEvent({ projectId: 't', sessionKey: 'cap', type, sequence, agent: 'claude', ...extra });
  // Launch 1: agent-started (2) lands before the report (1) that precedes it.
  shell('agent-started', 2); shell('hook-channel', 1, { command: 'HTTP_PROXY' });
  assert.equal(h.s.hooks.channel, 'command-async');
  // Launch 2 follows no report: the terminal's own channel again.
  shell('agent-started', 4);
  assert.equal(h.s.hooks.channel, 'http');
  // A report of a past launch landing now changes nothing.
  shell('hook-channel', 1, { command: 'HTTP_PROXY' });
  assert.equal(h.s.hooks.channel, 'http');
});
