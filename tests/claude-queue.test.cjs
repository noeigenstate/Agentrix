const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConversationLog, claudeConversation, codexConversation } = require('../electron/conversation.cjs');
const { PromptQueue } = require('../electron/prompt-queue.cjs');
const { roundsOf } = require('../electron/features/agents/project-memory.cjs');
const { createPendingPrompts, addPendingPrompt, reconcilePendingPrompts, pendingPromptCards } = require('../src/features/reading/pending-prompts.ts');

const stamp = at => new Date(at).toISOString();
const queued = log => log.list.filter(entry => entry.queued && !entry.cancelled).map(entry => entry.text);
function harness(limit = 400) {
  const activity = new PromptQueue(() => {}, { now: () => 1000 });
  const log = new ConversationLog(({ entry }) => {
    if (entry?.cancelled) activity.cancel(entry.original ?? entry.text, entry.at);
    else if (entry?.role === 'user' && !entry.queued) activity.start(entry.original ?? entry.text, entry.at, entry.id);
  }, limit);
  const feed = record => claudeConversation(log, record);
  return { log, activity, feed,
    queue: (operation, content, at = 1100, extra = {}) => feed({ type: 'queue-operation', operation, content, timestamp: stamp(at), ...extra }),
    user: (text, at = 1500, uuid = `user-${at}`) => feed({ type: 'user', uuid, timestamp: stamp(at), message: { content: text } }),
    attachment: (prompt, at = 1500, uuid = `attachment-${at}`) => feed({ type: 'attachment', uuid, timestamp: stamp(at), attachment: { type: 'queued_command', commandMode: 'prompt', prompt } }),
  };
}

test('removals compare full text blocks, pasted tags, image marks and whitespace in either direction', () => {
  const variants = ['[Image #3] first\r\n second  ', [{ type: 'text', text: 'first\nsecond' }], '<pasted_content id="1">\nfirst\nsecond\n</pasted_content>'];
  for (const operation of ['remove', 'dequeue']) for (const content of variants) for (const removal of variants) {
    const h = harness();
    h.queue('enqueue', content); h.queue(operation, removal, 1200);
    assert.deepEqual(queued(h.log), [], `${operation}: ${JSON.stringify(content)} -> ${JSON.stringify(removal)}`);
  }
});

test('a real user record or queued-command receipt retires a queue card even without a matching removal', () => {
  for (const kind of ['user', 'attachment']) {
    const h = harness();
    h.queue('enqueue', 'already taken up'); h.queue('remove', 'different expanded content', 1200);
    h[kind]([{ type: 'text', text: 'already taken up' }]);
    assert.deepEqual(queued(h.log), []);
    assert.deepEqual(h.log.list.filter(entry => entry.role === 'user').map(entry => entry.text), ['already taken up']);
    assert.deepEqual(roundsOf(h.log.list, 'claude', 'session').map(round => round.ask), ['already taken up']);
  }
});

test('anonymous dequeues cannot identify a waiting human message among priority-selected machine messages', () => {
  for (const first of ['<task-notification>done</task-notification>', '<agent-message>done</agent-message>', undefined]) {
    const h = harness();
    h.queue('enqueue', first, 1000); h.queue('enqueue', 'waiting', 1100);
    h.queue('dequeue', undefined, 1200); h.queue('dequeue', null, 1250);
    assert.deepEqual(queued(h.log), ['waiting'], 'only the actual receipt identifies which command was selected');
    h.attachment('waiting', 1300);
    assert.deepEqual(queued(h.log), []);
  }
});

test('a tail starting mid-queue leaves the visible waiting prompt until its own receipt', () => {
  const h = harness();
  // The unseen enqueue belongs to a different message before the 8 MiB tail.
  h.queue('enqueue', 'still waiting'); h.queue('dequeue', null, 1200); h.user('older unseen prompt', 1250);
  assert.deepEqual(queued(h.log), ['still waiting']);
  h.user('still waiting', 1400); assert.deepEqual(queued(h.log), []);
});

test('a late old user record, compaction and tool results do not acknowledge a newer identical send', () => {
  const h = harness();
  h.queue('enqueue', 'same', 5000); h.user('same', 1000, 'old');
  h.feed({ type: 'user', isCompactSummary: true, timestamp: stamp(5100), message: { content: 'same' } });
  h.feed({ type: 'user', timestamp: stamp(5200), message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'same' }] } });
  assert.deepEqual(queued(h.log), ['same']);
  h.user('same', 5300); assert.deepEqual(queued(h.log), []);
});

test('a queued-command receipt keeps the send timestamp even when hooks delay enqueue logging', () => {
  const h = harness();
  h.queue('enqueue', 'taken up after a slow hook', 6000);
  h.queue('enqueue', 'still waiting', 6100);
  h.attachment('taken up after a slow hook', 1000);
  assert.deepEqual(queued(h.log), ['still waiting']);
});

test('duplicate receipts consume one occurrence, including a replay after the visible entry was evicted', () => {
  const h = harness(2);
  h.queue('enqueue', 'same', 1100); h.queue('enqueue', 'same', 1150);
  h.user('same', 1200, 'one');
  assert.equal(h.log.queue.length, 1);
  h.user('unrelated', 1300); h.user('another', 1400);
  h.user('same', 1200, 'one');
  assert.equal(h.log.queue.length, 1, 'replayed receipt cannot swallow the second send');
  h.user('same', 1500, 'two'); assert.equal(h.log.queue.length, 0);
});

test('queue identities cannot collide when messages share a timestamp and an earlier item is removed', () => {
  const h = harness();
  h.queue('enqueue', 'first'); h.queue('enqueue', 'second'); h.queue('remove', 'first'); h.queue('enqueue', 'third');
  assert.deepEqual(queued(h.log), ['second', 'third']);
});

test('a named removal and its user receipt acknowledge the same occurrence, leaving its duplicate waiting', () => {
  for (const operation of ['remove', 'dequeue']) {
    const h = harness();
    h.queue('enqueue', 'same', 1000); h.queue('enqueue', 'same', 1100);
    h.queue(operation, 'same', 1200); h.attachment('same', 1800, 'first');
    assert.deepEqual(queued(h.log), ['same']);
    h.user('same', 2000, 'second'); assert.deepEqual(queued(h.log), []);
  }
});

test('a named removal arriving after its user receipt cannot take up the next identical send', () => {
  const h = harness();
  h.queue('enqueue', 'same', 1000); h.queue('enqueue', 'same', 2000);
  h.user('same', 1500, 'first'); h.queue('remove', 'same', 1550);
  assert.deepEqual(queued(h.log), ['same']);
  h.user('same', 2500, 'second'); h.queue('remove', 'same', 2550);
  assert.deepEqual(queued(h.log), []);
});

test('matching does not truncate long prompts or treat paste summaries as the expanded text', () => {
  const h = harness(), prefix = 'x'.repeat(61000);
  h.queue('enqueue', prefix + 'A'); h.queue('enqueue', prefix + 'B', 1150);
  h.queue('remove', prefix + 'B', 1200);
  assert.equal(h.log.queue.length, 1); assert.ok((h.log.queue[0].original ?? h.log.queue[0].text).endsWith('A'));
  h.queue('enqueue', '[Pasted text #1 +10 lines]', 1300);
  h.user('a completely different expanded paste', 1400);
  assert.equal(h.log.queue.length, 2, 'an opaque input summary is not proof of receipt');
});

test('Esc popAll, popOne and cancellation remove only the withdrawn occurrences and never resend their echoes', () => {
  for (const operation of ['popAll', 'popOne', 'remove']) {
    const h = harness();
    let state = addPendingPrompt(createPendingPrompts('session'), 'one', 'same', 1000);
    state = addPendingPrompt(state, 'two', 'same', 1050);
    h.activity.submit('same', true, 1000); h.activity.submit('same', true, 1050);
    h.queue('enqueue', 'same', 1100); h.queue('enqueue', 'same', 1150);
    h.queue(operation, 'same', 1200, operation === 'remove' ? { reason: 'cleared_on_cancel' } : {});
    assert.deepEqual(queued(h.log), ['same']);
    state = reconcilePendingPrompts(state, 'session', h.log.list, 25000);
    assert.deepEqual(state.prompts.map(prompt => prompt.id), ['two']);
    const cards = pendingPromptCards(state.prompts, h.log.list);
    assert.deepEqual([...cards.queuedIds], ['two']);
    assert.equal(h.activity.list().length, 1);
    assert.deepEqual(roundsOf(h.log.list, 'claude', 'session'), [], 'withdrawals are not worked user turns');
  }
});

test('a clear or contentless popAll cancels the visible human queue, while commands and notices have no cards', () => {
  for (const operation of ['clear', 'popAll']) {
    const h = harness();
    for (const content of ['first', 'second', '/usage', '!ls', '<command-name>/usage</command-name>', '<task-notification>done</task-notification>']) h.queue('enqueue', content);
    assert.deepEqual(queued(h.log), ['first', 'second']);
    h.queue(operation, undefined, 1200); assert.deepEqual(queued(h.log), []);
    h.log.reset(); assert.deepEqual(h.log.list, []); assert.equal(h.log.queue.length, 0);
  }
});

test('an accepted duplicate leaves the next identical echo queued until its own receipt', () => {
  const h = harness();
  let state = addPendingPrompt(createPendingPrompts('session'), 'one', 'same', 1000);
  state = addPendingPrompt(state, 'two', 'same', 1050);
  h.queue('enqueue', 'same', 1100); h.queue('enqueue', 'same', 1150); h.user('same', 1200, 'one');
  state = reconcilePendingPrompts(state, 'session', h.log.list, 1250);
  assert.deepEqual(pendingPromptCards(state.prompts, h.log.list).prompts.map(prompt => prompt.id), ['two']);
  h.user('same', 1300, 'two'); state = reconcilePendingPrompts(state, 'session', h.log.list, 1400);
  assert.deepEqual(pendingPromptCards(state.prompts, h.log.list).prompts, []);
});

test('Codex user records never produce queued cards and a session reset removes Claude queue state', () => {
  const h = harness(); h.queue('enqueue', 'Claude pending');
  codexConversation(h.log, { type: 'session_meta', payload: { cwd: '/project' } });
  codexConversation(h.log, { type: 'event_msg', timestamp: stamp(1500), payload: { type: 'user_message', message: 'Codex received' } });
  assert.deepEqual(queued(h.log), []); assert.deepEqual([...pendingPromptCards([], h.log.list).queuedIds], []);
});
