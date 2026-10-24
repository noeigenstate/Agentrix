const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inboxItems, isWorking } = require('../src/features/home/inbox-items.ts');

const terminal = (id, extra = {}) => ({ id, title: id, sessionId: id, status: 'codex', codexActive: true, agent: 'codex', codexActivity: 'unknown', prompts: [], task: '', ...extra });
const project = (id, terminals) => ({ id, name: id, unread: 0, terminals });
const decision = (id, terminalId) => ({ id, terminalId, kind: 'approval' });

test('the inbox lists decisions first, then working sessions, then the rest', () => {
  const projects = [project('a', [terminal('idle')]), project('b', [terminal('busy', { codexActivity: 'working' })]), project('c', [terminal('asking')])];
  const items = inboxItems(projects, [decision('d1', 'asking')]);
  assert.deepEqual(items.map(item => [item.id, item.group]), [['d1', 'decide'], ['s:busy', 'working'], ['s:idle', 'other']]);
});

test('a session waiting on a decision is listed once, by its decision', () => {
  const projects = [project('a', [terminal('t1', { codexActivity: 'working' })])];
  const items = inboxItems(projects, [decision('d1', 't1'), decision('d2', 't1')]);
  assert.deepEqual(items.map(item => item.id), ['d1', 'd2']);
  assert.ok(items.every(item => item.terminal.id === 't1'));
});

test('only a live agent that is mid-round counts as working', () => {
  assert.equal(isWorking(terminal('x', { codexActivity: 'working' })), true);
  assert.equal(isWorking(terminal('x', { codexActivity: 'working', codexActive: false })), false);
  assert.equal(isWorking(terminal('x', { codexActivity: 'complete' })), false);
});
