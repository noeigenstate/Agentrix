const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConversationLog, claudeConversation, codexConversation } = require('../electron/conversation.cjs');
const { ActionLog, claudePrompt, claudeRecord } = require('../electron/agent-actions.cjs');
const { PromptQueue, promptText, promptSummary } = require('../electron/prompt-queue.cjs');
const { CompletionWork } = require('../electron/completion-work.cjs');
const { CodexActivityReader } = require('../electron/codex-activity.cjs');
const { roundsOf } = require('../electron/features/agents/project-memory.cjs');
const { promptTitle } = require('../electron/claude-sessions.cjs');
const { blocks, conversationTurns } = require('../src/features/reading/useVisibleTail.ts');
const { createPendingPrompts, addPendingPrompt, reconcilePendingPrompts, pendingPromptCards } = require('../src/features/reading/pending-prompts.ts');
const fixture = require('./fixtures/claude-usage-reset.json');

const reset = fixture.records[0].content, base = Date.parse(fixture.records[0].timestamp);
const stamp = offset => new Date(base + offset).toISOString();
const user = (text, offset, uuid, extra = {}) => ({ type: 'user', uuid, timestamp: stamp(offset), message: { content: text }, ...extra });
const queued = (operation, content, offset, extra = {}) => ({ type: 'queue-operation', operation, content, timestamp: stamp(offset), ...extra });
const pending = log => log.list.filter(entry => entry.queued && !entry.cancelled);

function harness(t) {
  const activity = new PromptQueue(() => {}, { now: () => base + 10000 });
  const work = new CompletionWork({ now: () => base + 10000 });
  const log = new ConversationLog(({ entry }) => {
    const at = entry?.receivedAt ?? entry?.at;
    if (entry?.cancelled) activity.cancel(entry.original ?? entry.text, at, entry.id);
    else if (entry?.role === 'user' && entry.queued) activity.enqueue(entry.original ?? entry.text, at, entry.id);
    else if (entry?.role === 'user') activity.start(entry.original ?? entry.text, at, entry.id);
  });
  t.after(() => { activity.reset(); work.reset(); });
  const feed = record => { claudeConversation(log, record); work.record(record, 'claude'); };
  return { activity, work, log, feed };
}

test('sanitised real reset records create no user, queue, task or memory prompt', t => {
  const h = harness(t), actions = new ActionLog();
  h.activity.start('Initial request.', base - 1000, 'initial');
  const before = h.activity.list();
  for (const record of fixture.records) { h.feed(record); claudeRecord(actions, record); }
  assert.deepEqual(h.log.list.map(entry => entry.role), ['assistant']);
  assert.deepEqual(h.log.queue, []);
  assert.deepEqual(pendingPromptCards([], h.log.list).prompts, []);
  assert.deepEqual(h.activity.list(), before);
  assert.equal(h.activity.task.text, 'Initial request.');
  assert.deepEqual(roundsOf(h.log.list, 'claude', 'anonymous'), []);
  assert.equal(claudePrompt(fixture.records[2]), false);
  assert.equal(promptTitle(fixture.records[2]), '');
  assert.equal(promptTitle(user(reset, 100, 'unmarked-reset')), '');
});

test('the unmarked reset text has one semantic classification for local, history, activity and completion', t => {
  const h = harness(t), log = new ConversationLog();
  h.activity.start('Real request.', base - 1000, 'real');
  h.work.record({ type: 'assistant', uuid: 'end', timestamp: stamp(-500), message: { content: [], stop_reason: 'end_turn' } }, 'claude');
  const before = { turn: h.work.turn, reviewAt: h.work.reviewAt, tasks: h.work.tasks.size, notices: h.work.notifications.size };
  for (const record of [queued('enqueue', reset, 0), queued('remove', reset, 50), user(reset, 100, 'unmarked'),
    { type: 'attachment', uuid: 'attachment', timestamp: stamp(150), attachment: { type: 'queued_command', prompt: reset } }]) h.feed(record);
  assert.equal(promptText(reset), null);
  assert.equal(promptSummary(reset), '');
  assert.deepEqual(h.log.list, []);
  assert.deepEqual({ turn: h.work.turn, reviewAt: h.work.reviewAt, tasks: h.work.tasks.size, notices: h.work.notifications.size }, before);
  h.activity.submit(reset, true); h.activity.start(reset, base + 200, 'synthetic');
  assert.equal(h.activity.list().length, 1);
  const reader = new CodexActivityReader('<home>/project');
  reader.snapshot = { state: 'complete', updatedAt: base - 500, prompt: 'Real request.' };
  const record = { type: 'event_msg', timestamp: stamp(100), payload: { type: 'user_message', message: reset } };
  codexConversation(log, record); reader.record(record);
  assert.deepEqual(log.list, []);
  assert.equal(reader.snapshot.prompt, 'Real request.');
  assert.equal(reader.snapshot.state, 'complete');
});

// Synthetic additions, deliberately separate from the evidence-derived fixture.
test('a genuine queued follow-up beside the injection stays queued until its own receipt and round', t => {
  const h = harness(t), text = 'Real follow-up.';
  let state = addPendingPrompt(createPendingPrompts('anonymous'), 'echo', text, base - 10);
  h.activity.start('Initial request.', base - 1000, 'initial');
  h.activity.submit(text, true, base - 10);
  h.feed(queued('enqueue', text, -5));
  for (const record of fixture.records.slice(0, 3)) h.feed(record);
  h.activity.finish(base + 80);
  state = reconcilePendingPrompts(state, 'anonymous', h.log.list, base + 25000);
  assert.deepEqual(pending(h.log).map(entry => entry.text), [text]);
  let cards = pendingPromptCards(state.prompts, h.log.list);
  assert.deepEqual(cards.prompts.map(entry => [entry.text, entry.sending]), [[text, false]]);
  assert.equal(cards.queuedIds.has('echo'), true, 'accepted entries remain excluded from the resend candidates');
  h.feed(user(text, 200, 'real-follow-up'));
  state = reconcilePendingPrompts(state, 'anonymous', h.log.list, base + 25001);
  cards = pendingPromptCards(state.prompts, h.log.list);
  assert.deepEqual(cards.prompts, []);
  assert.deepEqual(h.activity.list().map(entry => entry.state), ['working']);
  h.activity.finish(base + 150);
  assert.equal(h.activity.list().length, 1, 'an older stop cannot complete the later prompt');
  h.activity.finish(base + 300);
  assert.deepEqual(h.activity.list(), []);
});

test('a named handoff acknowledges the echo without any dequeue or same-content user record', t => {
  const h = harness(t), text = 'Accepted work.';
  let state = addPendingPrompt(createPendingPrompts('anonymous'), 'echo', text, base);
  h.activity.submit(text, true, base);
  h.feed(queued('enqueue', text, 10));
  h.feed(queued('remove', text, 200, { reason: 'absorbed_mid_turn' }));
  state = reconcilePendingPrompts(state, 'anonymous', h.log.list, base + 25000);
  assert.deepEqual(pendingPromptCards(state.prompts, h.log.list).prompts, [], 'a proven handoff must never leave a resendable echo');
  assert.deepEqual(h.activity.list().map(entry => entry.state), ['working']);
  h.activity.finish(base + 150); assert.equal(h.activity.list().length, 1);
  h.activity.finish(base + 300); assert.deepEqual(h.activity.list(), []);
});

test('a late same-content receipt after a named handoff consumes no second queued send', t => {
  const h = harness(t), text = 'Repeated work.';
  h.activity.submit(text, true, base);
  h.feed(queued('enqueue', text, 10));
  h.feed(queued('remove', text, 200));
  h.activity.submit(text, true, base + 300);
  h.feed(queued('enqueue', text, 310));
  h.feed(user(text, 210, 'late-first'));
  h.feed(user(text, 210, 'late-first'));
  assert.equal(pending(h.log).length, 1);
  assert.deepEqual(h.activity.list().map(entry => entry.state), ['working', 'queued']);
  assert.equal(h.log.list.filter(entry => entry.role === 'user' && !entry.queued).length, 1);
  h.activity.finish(base + 250);
  assert.deepEqual(h.activity.list().map(entry => entry.state), ['queued']);
});

test('later explicit machine provenance retires only its matching unmarked queue occurrence', t => {
  for (const receipt of ['user', 'attachment', 'remove']) for (const flags of [{ isMeta: true }, { isCompactSummary: true }, { isVisibleInTranscriptOnly: true }, { queueTranscriptOnly: true }, { origin: { kind: 'auto-continuation' } }, { promptSource: 'system' }, { turnOrigin: 'auto_continuation' }, { humanTurn: false }, { commandMode: 'task-notification' }]) {
    const h = harness(t), text = 'Neutral automatic continuation.';
    h.feed(queued('enqueue', text, 0)); h.feed(queued('enqueue', 'Actual user work.', 10));
    const record = receipt === 'user' ? user(text, 100, 'machine', flags)
      : receipt === 'remove' ? queued('remove', text, 100, flags)
        : { type: 'attachment', uuid: 'machine', timestamp: stamp(100), attachment: { type: 'queued_command', prompt: text, ...flags } };
    h.feed(record); h.feed(record);
    assert.deepEqual(pending(h.log).map(entry => entry.text), ['Actual user work.']);
    assert.deepEqual(h.log.list.filter(entry => !entry.queued), []);
    assert.deepEqual(h.activity.list().map(entry => [entry.text, entry.state]), [['Actual user work.', 'queued']]);
  }
});

test('review: late machine provenance retracts the promoted receipt and activity item, preserving a later identical send', t => {
  const h = harness(t), text = 'Automatic neutral message';
  h.feed(queued('enqueue', text, 0));
  h.feed(queued('remove', text, 50));
  h.feed(queued('enqueue', text, 75));
  h.feed(user(text, 100, 'machine-late', { isMeta: true }));
  h.feed(user(text, 100, 'machine-late', { isMeta: true }));
  assert.equal(h.log.queue.length, 1);
  assert.deepEqual(h.log.list.filter(entry => !entry.queued), []);
  assert.deepEqual(h.activity.list().map(entry => [entry.text, entry.state]), [[text, 'queued']]);
  assert.notEqual(h.activity.task?.text, text);
});

test('review: ignored removal and user receipts pair once in either order beside an identical human send', t => {
  for (const first of ['remove', 'user']) for (const markSecond of [true, false]) {
    const h = harness(t), text = 'Automatic neutral message';
    const event = (kind, at, flags) => kind === 'remove' ? queued('remove', text, at, flags) : user(text, at, 'machine-pair', flags);
    h.feed(queued('enqueue', text, 0));
    h.feed(event(first, 50, { isMeta: true }));
    h.feed(queued('enqueue', text, 75));
    h.feed(event(first === 'remove' ? 'user' : 'remove', 100, markSecond ? { isMeta: true } : {}));
    assert.equal(h.log.queue.length, 1);
    assert.deepEqual(h.log.list.filter(entry => !entry.queued), []);
    assert.deepEqual(h.activity.list().map(entry => entry.state), ['queued']);
  }
});

test('review: a queueOnly receipt can later publish its full entry without consuming the next identical queue item', t => {
  const h = harness(t), text = 'Real neutral message';
  h.feed(queued('enqueue', text, 0));
  const firstId = h.log.queue[0].id;
  const record = user(text, 100, 'history-then-full');
  claudeConversation(h.log, record, undefined, { queueOnly: true });
  h.feed({ type: 'assistant', uuid: 'before-uptake', timestamp: stamp(150), message: { content: [{ type: 'text', text: 'Previous turn step.' }] } });
  h.feed(queued('enqueue', text, 200));
  h.feed(record); h.feed(record);
  assert.equal(h.log.queue.length, 1);
  assert.deepEqual(h.log.list.filter(entry => !entry.queued).map(entry => entry.id), ['a:before-uptake:0', firstId]);
  assert.deepEqual(h.activity.list().map(entry => entry.state), ['working', 'queued']);
});

test('review: a backdated queued-command receipt clears one echo using its confirmed watermark', t => {
  const h = harness(t), text = 'Real neutral message';
  let state = addPendingPrompt(createPendingPrompts('anonymous'), 'first', text, base + 1000);
  h.feed(queued('enqueue', text, 1010));
  const receipt = { type: 'attachment', uuid: 'backdated', timestamp: stamp(0), attachment: { type: 'queued_command', prompt: text } };
  h.feed(receipt);
  state = reconcilePendingPrompts(state, 'anonymous', h.log.list, base + 1500);
  assert.deepEqual(state.prompts, []);
  state = addPendingPrompt(state, 'later', text, base + 2000);
  h.feed(queued('enqueue', text, 2010)); h.feed(receipt);
  state = reconcilePendingPrompts(state, 'anonymous', h.log.list, base + 30000);
  const cards = pendingPromptCards(state.prompts, h.log.list);
  assert.deepEqual(cards.prompts.map(entry => entry.id), ['later']);
  assert.equal(cards.queuedIds.has('later'), true);
});

test('review: named handoff watermark survives backdated queueOnly and full receipts and an older stop', t => {
  for (const prefixFirst of [false, true]) {
    const h = harness(t), text = 'Real neutral message';
    h.feed(queued('enqueue', text, 0)); h.feed(queued('remove', text, 200));
    const receipt = user(text, 100, 'backdated-user');
    if (prefixFirst) claudeConversation(h.log, receipt, undefined, { queueOnly: true });
    h.feed(receipt);
    assert.equal(h.log.list[0].at, base + 100);
    assert.equal(h.log.list[0].receivedAt, base + 200);
    h.activity.finish(base + 150); assert.equal(h.activity.list().length, 1);
    h.activity.finish(base + 250); assert.equal(h.activity.list().length, 0);
  }
});

test('review: named uptake moves the user boundary after all steps of the previous turn', t => {
  const h = harness(t), text = 'Real follow-up';
  const assistant = (name, at) => ({ type: 'assistant', uuid: name, timestamp: stamp(at), message: { content: [{ type: 'text', text: name }] } });
  h.feed(assistant('A', -100)); h.feed(queued('enqueue', text, 0));
  const id = h.log.queue[0].id;
  h.feed(assistant('B', 25)); h.feed(queued('remove', text, 50)); h.feed(assistant('C', 75));
  assert.deepEqual(h.log.list.map(entry => entry.text), ['A', 'B', text, 'C']);
  assert.equal(h.log.list[2].id, id); assert.equal(h.log.list[2].at, base);
  assert.equal(h.log.list[2].receivedAt, base + 50);
  const turns = conversationTurns(blocks(h.log.list));
  assert.deepEqual(turns.map(turn => turn.kind), ['agent', 'user', 'agent']);
  assert.deepEqual(turns[0].blocks.map(block => block.entry.text), ['A', 'B']);
  assert.equal(turns[2].blocks[0].entry.text, 'C');
});

test('review: sidechains and tool results cannot retract an unrelated main-thread queue', t => {
  const h = harness(t), text = 'Real neutral message';
  h.feed(queued('enqueue', text, 0));
  h.feed(user(text, 100, 'child', { isSidechain: true, isMeta: true }));
  h.feed(user([{ type: 'tool_result', tool_use_id: 'tool', content: text }, { type: 'text', text }], 100, 'result', { isCompactSummary: true }));
  assert.equal(h.log.queue.length, 1);
  assert.equal(h.activity.list().length, 1);
});

test('explicit queued user provenance reconciles delayed prompt writes without a second activity start', t => {
  const h = harness(t), text = 'Accepted after a slow hook.';
  h.feed(queued('enqueue', text, 6000));
  h.feed(queued('remove', text, 6500));
  h.feed(user(text, 1000, 'delayed-queued', { parentUuid: null, promptSource: 'queued', origin: { kind: 'human' }, turnOrigin: 'human' }));
  assert.equal(h.log.list.length, 1);
  assert.equal(h.log.list[0].at, base + 1000, 'the original prompt timestamp is retained');
  assert.deepEqual(h.activity.list().map(entry => [entry.state, entry.at]), [['working', base + 6000]]);
  h.activity.finish(base + 6200);
  assert.equal(h.activity.list().length, 1, 'the recorded handoff starts after the older completion');
  h.activity.finish(base + 6600); assert.deepEqual(h.activity.list(), []);
});

test('queued-command attachment provenance cannot create a completion review', t => {
  const h = harness(t);
  h.work.record({ type: 'assistant', uuid: 'end', timestamp: stamp(-100), message: { content: [], stop_reason: 'end_turn' } }, 'claude');
  h.feed({ type: 'attachment', uuid: 'machine', timestamp: stamp(100), attachment: { type: 'queued_command', prompt: 'Neutral automatic continuation.', origin: { kind: 'auto-continuation' }, promptSource: 'system' } });
  assert.deepEqual(h.log.list, []);
  assert.equal(h.work.reviewAt, 0);
  assert.equal(h.work.turn.state, 'complete');
});

test('late old boundaries and a delayed first prompt cannot retire later accepted queue entries', t => {
  const h = harness(t), text = 'Later real work.';
  h.feed(queued('enqueue', text, 1000));
  h.feed(user(text, -1000, 'delayed-first', { parentUuid: null }));
  h.feed(queued('remove', text, 500));
  h.feed({ type: 'assistant', uuid: 'older-end', timestamp: stamp(600), message: { content: [{ type: 'text', text: 'Earlier reply.' }], stop_reason: 'end_turn' } });
  h.activity.finish(base + 600);
  assert.equal(h.log.list[0].id, 'u:delayed-first', 'the delayed first prompt still precedes its reply');
  assert.deepEqual(pending(h.log).map(entry => entry.text), [text]);
  assert.deepEqual(h.activity.list().map(entry => entry.state), ['queued']);
  h.feed(user(text, 1100, 'machine-old', { isMeta: true }));
  assert.deepEqual(pending(h.log), [], 'explicit provenance retires its exact queue occurrence');
});

test('queue-only prefix replay acknowledges receipts without replaying completed user entries', t => {
  for (const namedRemoval of [true, false]) {
    const h = harness(t), text = 'Historical queued work.';
    const feed = record => claudeConversation(h.log, record, undefined, { queueOnly: true });
    let state = addPendingPrompt(createPendingPrompts('anonymous'), 'echo', text, base - 1100);
    feed(queued('enqueue', text, -1000));
    if (namedRemoval) feed(queued('remove', text, -900));
    feed(user(text, -800, 'historical'));
    state = reconcilePendingPrompts(state, 'anonymous', h.log.list, base + 30000);
    assert.deepEqual(pendingPromptCards(state.prompts, h.log.list).prompts, []);
    assert.deepEqual(h.log.list.filter(entry => !entry.queued), []);
    assert.deepEqual(h.log.queue, []);
    assert.deepEqual(h.activity.list(), [], 'prefix handoffs cannot leave a permanent confirmed activity item');
    assert.equal(h.activity.task, null, 'historical receipts do not replay task lifecycle');
  }
});
