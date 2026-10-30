const { test } = require('node:test');
const assert = require('node:assert/strict');
const { conversationBatchDelay, pollAfterSubmission } = require('../electron/conversation-timing.cjs');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let sequence = 0;
const change = (role, id = `e${++sequence}`, text = '') => ({ entry: { id, role, text } });

function publisher() {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const packets = [], session = { terminalId: 'terminal', conversation: { list: [], loading: false, snapshot() { return this.list; } } };
  const context = vm.createContext({
    sessions: new Map([['terminal', session]]), readingHistory: { summary: () => null }, conversationBatchDelay, setTimeout, clearTimeout,
    send: (channel, packet) => packets.push({ channel, packet }),
  });
  vm.runInContext(source.slice(source.indexOf('function publishConversation('), source.indexOf('// A skill step')), context);
  return { session, packets, publish: value => context.publishConversation(session, value) };
}

test('the main process delivers a user-only conversation batch after 30 ms', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, packets, publish } = publisher();
  publish(change('user')); t.mock.timers.tick(29); assert.equal(packets.length, 0);
  t.mock.timers.tick(1); assert.equal(packets.length, 1);
  assert.equal(packets[0].channel, 'terminal:conversation');
  assert.equal(packets[0].packet.changes[0].role, 'user');
  assert.equal(session.conversationTimer, null);
});

test('adding streaming data to a user batch switches it to the 50 ms window', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { packets, publish } = publisher();
  publish(change('user')); t.mock.timers.tick(10); publish(change('assistant'));
  t.mock.timers.tick(20); assert.equal(packets.length, 0, 'the old 30 ms timer was cancelled');
  t.mock.timers.tick(20); publish(change('tool'));
  t.mock.timers.tick(9); assert.equal(packets.length, 0);
  t.mock.timers.tick(1); assert.equal(packets.length, 1, 'streaming updates do not extend the existing batch');
  assert.equal(packets[0].packet.changes.length, 3);
});

test('conversation resets still publish a full list at 50 ms', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, packets, publish } = publisher();
  session.conversation.list = [{ id: 'restored', role: 'user', text: 'history' }];
  publish({ reset: true }); publish(change('user'));
  t.mock.timers.tick(49); assert.equal(packets.length, 0);
  t.mock.timers.tick(1); assert.equal(packets[0].packet.list, session.conversation.list);
});

test('only user-message batches flush at 30 ms', () => {
  assert.equal(conversationBatchDelay([change('user')]), 30);
  assert.equal(conversationBatchDelay([change('user'), change('user')]), 30);
});

test('streaming, mixed, reset and empty batches wait 50 ms, enough to gather an answer streamed word by word', () => {
  for (const changes of [[], [change('assistant')], [change('tool')], [change('user'), change('assistant')], [change('tool'), change('user')], [{ reset: true }, change('user')]]) {
    assert.equal(conversationBatchDelay(changes), 50);
  }
});

test('Codex and Claude are polled at 150, 400 and 900 ms after submission', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const agent of ['codex', 'claude']) {
    let polls = 0;
    const session = { agent, codexActive: true, activityMonitor: { poll: () => { polls++; } } };
    pollAfterSubmission(session, () => true);
    assert.equal(polls, 0);
    t.mock.timers.tick(149); assert.equal(polls, 0);
    t.mock.timers.tick(1); assert.equal(polls, 1);
    t.mock.timers.tick(249); assert.equal(polls, 1);
    t.mock.timers.tick(1); assert.equal(polls, 2);
    t.mock.timers.tick(499); assert.equal(polls, 2);
    t.mock.timers.tick(1); assert.equal(polls, 3);
    assert.equal(session.submissionPolls.size, 0);
  }
});

test('a Claude follower attached after submission receives the remaining polls', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let polls = 0;
  const session = { codexActive: true };
  pollAfterSubmission(session, () => true);
  t.mock.timers.tick(150);
  session.activityMonitor = { poll: () => { polls++; } };
  t.mock.timers.tick(250); assert.equal(polls, 1);
  t.mock.timers.tick(500); assert.equal(polls, 2);
});

test('delayed polls stop touching replaced or inactive sessions', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let polls = 0, current = true;
  const session = { codexActive: true, activityMonitor: { poll: () => { polls++; } } };
  pollAfterSubmission(session, () => current);
  t.mock.timers.tick(150); assert.equal(polls, 1);
  current = false; t.mock.timers.tick(750); assert.equal(polls, 1);
  current = true; pollAfterSubmission(session, () => current); session.codexActive = false;
  t.mock.timers.tick(900); assert.equal(polls, 1);
});

test('submission poll timers can all be cancelled when disposing the terminal', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let polls = 0;
  const session = { codexActive: true, activityMonitor: { poll: () => { polls++; } } };
  pollAfterSubmission(session, () => true);
  for (const timer of session.submissionPolls) clearTimeout(timer);
  t.mock.timers.tick(1000); assert.equal(polls, 0);
});

test('an answer streamed many times in one batch is sent once, as its latest version, in its place', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { packets, publish } = publisher();
  publish(change('user', 'u1', 'hi'));
  for (let index = 1; index <= 60; index++) publish(change('assistant', 'a1', 'word '.repeat(index)));
  publish(change('tool', 't1'));
  t.mock.timers.tick(120);
  assert.equal(packets.length, 1);
  assert.deepEqual(Array.from(packets[0].packet.changes, entry => [entry.id, entry.text.length]), [['u1', 2], ['a1', 300], ['t1', 0]], 'deltas of one answer do not force a full snapshot');
});
