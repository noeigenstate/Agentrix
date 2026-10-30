const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hookHarness } = require('./helpers/hook-harness.cjs');
const buffer = require('../src/features/reading/conversation-buffer.ts');
const entry = id => ({ id, role: 'assistant', at: 0 });

function conversationHarness(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests = [], subscribers = new Set(), previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { agentrix: {
    terminalConversation: id => new Promise(resolve => requests.push({ id, resolve })),
    terminalConversationPage: (id, request) => new Promise(resolve => requests.push({ id, request, resolve })),
    onTerminalConversation: callback => { subscribers.add(callback); return () => subscribers.delete(callback); },
  } } });
  const h = hookHarness('src/features/reading/useReadingConversation.ts', { './conversation-buffer': buffer });
  t.after(() => { h.dispose(); if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; });
  return {
    requests, subscribers,
    render: (id = 'first', session = 'session') => h.render('useReadingConversation', id, session).result,
    history: scope => h.render('useReadingHistory', 'first', 'session', scope).result,
    packet: packet => subscribers.forEach(callback => callback(packet)),
    dispose: () => h.dispose(),
  };
}

test('reading mount coalesces snapshot and stream packets and ignores other terminals', async t => {
  const h = conversationHarness(t);
  assert.deepEqual(h.render(), []);
  h.packet({ id: 'other', list: [entry('wrong')] });
  h.packet({ id: 'first', changes: [entry('live')] });
  h.requests[0].resolve({ ok: true, value: [entry('history')] }); await Promise.resolve();
  t.mock.timers.tick(49); assert.deepEqual(h.render(), []);
  t.mock.timers.tick(1); assert.deepEqual(h.render(), [entry('history'), entry('live')]);
});

test('session changes hide old entries immediately and cancel old buffered updates', async t => {
  const h = conversationHarness(t);
  h.render(); h.requests[0].resolve({ ok: true, value: [entry('old')] }); await Promise.resolve();
  t.mock.timers.tick(50); assert.deepEqual(h.render(), [entry('old')]);
  h.packet({ id: 'first', changes: [entry('old-pending')] });
  assert.deepEqual(h.render('first', 'new-session'), []);
  t.mock.timers.tick(50); assert.deepEqual(h.render('first', 'new-session'), []);
  h.requests[1].resolve({ ok: true, value: [entry('new')] }); await Promise.resolve();
  t.mock.timers.tick(50); assert.deepEqual(h.render('first', 'new-session'), [entry('new')]);
  assert.equal(h.subscribers.size, 1);
});

test('terminal switching ignores late IPC replies and unmount cancels work', async t => {
  const h = conversationHarness(t);
  h.render(); assert.deepEqual(h.render('second'), []);
  h.requests[0].resolve({ ok: true, value: [entry('stale')] }); await Promise.resolve();
  t.mock.timers.tick(50); assert.deepEqual(h.render('second'), []);
  h.packet({ id: 'second', changes: [entry('live')] });
  h.requests[1].resolve({ ok: false, error: 'gone' }); await Promise.resolve();
  t.mock.timers.tick(50); assert.deepEqual(h.render('second'), [entry('live')]);
  h.packet({ id: 'second', changes: [entry('late')] }); h.dispose();
  t.mock.timers.tick(50); assert.equal(h.subscribers.size, 0);
});

test('the first history binding retains the live legacy entries until its initial page arrives', async t => {
  const h = conversationHarness(t);
  h.history(); h.requests[0].resolve({ ok: true, value: [entry('first-turn')] }); await Promise.resolve(); t.mock.timers.tick(50);
  assert.deepEqual(h.history().entries, [entry('first-turn')]);
  const scope = { key: 'first-binding', agent: 'codex', threadId: 'first-thread' };
  assert.deepEqual(h.history(scope).entries, [entry('first-turn')]);
  assert.equal(h.requests[1].request.key, scope.key);
  h.requests[1].resolve(page(scope.key, [entry('first-turn'), entry('reply')])); await Promise.resolve(); t.mock.timers.tick(50);
  assert.deepEqual(h.history(scope).entries, [entry('first-turn'), entry('reply')]);
});

function pagedHarness(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests = [], subscribers = new Set(), previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { agentrix: {
    terminalConversation: () => { throw new Error('paged reading must not request the legacy 400-entry snapshot'); },
    terminalConversationPage: (id, request) => new Promise(resolve => requests.push({ id, request, resolve })),
    onTerminalConversation: callback => { subscribers.add(callback); return () => subscribers.delete(callback); },
  } } });
  const h = hookHarness('src/features/reading/useReadingConversation.ts', { './conversation-buffer': buffer });
  t.after(() => { h.dispose(); if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; });
  return { requests, subscribers, render: (key = 'A', session = 'runtime') => h.render('useReadingHistory', 'first', session, { key, agent: 'codex', threadId: key }).result,
    packet: packet => subscribers.forEach(callback => callback({ id: 'first', historyKey: 'A', sessionId: 'runtime', ...packet })), dispose: () => h.dispose() };
}
const page = (key, entries, beforeCursor = 'older') => ({ ok: true, value: { key, entries, beforeCursor } });

test('paged reading coalesces its initial page and scoped live events while refusing other epochs', async t => {
  const h = pagedHarness(t); assert.deepEqual(h.render().entries, []);
  h.packet({ historyKey: 'other', changes: [entry('wrong')] });
  h.packet({ sessionId: 'old-runtime', changes: [entry('wrong-runtime')] });
  h.packet({ changes: [entry('live')] });
  h.requests[0].resolve(page('A', [entry('history')])); await Promise.resolve();
  t.mock.timers.tick(50);
  const state = h.render(); assert.deepEqual(state.entries, [entry('history'), entry('live')]); assert.equal(state.hasEarlier, true);
  // Starting the actual PTY keeps the validated history mounted but changes which runtime events are accepted.
  assert.deepEqual(h.render('A', 'new-runtime').entries, state.entries);
  h.packet({ changes: [entry('stale-runtime')] }); t.mock.timers.tick(50);
  assert.equal(h.render('A', 'new-runtime').entries.some(e => e.id === 'stale-runtime'), false);
});

test('older pages are single-flight, preserve live updates and survive beyond the rolling cap', async t => {
  const h = pagedHarness(t); h.render();
  h.requests[0].resolve(page('A', [entry('latest')])); await Promise.resolve(); t.mock.timers.tick(50);
  const load = h.render().loadEarlier(); await h.render().loadEarlier();
  assert.equal(h.requests.length, 2); assert.equal(h.requests[1].request.cursor, 'older');
  h.packet({ changes: [{ ...entry('latest'), text: 'updated' }, entry('new-live')] }); t.mock.timers.tick(50);
  const old = Array.from({ length: 500 }, (_, n) => entry(`old-${n}`));
  h.requests[1].resolve(page('A', [...old, entry('latest')], null)); await load;
  const state = h.render(); assert.equal(state.entries.length, 502); assert.equal(state.entries.at(-2).text, 'updated');
  assert.equal(state.hasEarlier, false);
});

test('paged A to B to A discards late requests and never paints the previous scope during loading', async t => {
  const h = pagedHarness(t); h.render('A'); h.render('B');
  h.requests[1].resolve(page('B', [entry('B')])); await Promise.resolve(); t.mock.timers.tick(50);
  assert.deepEqual(h.render('B').entries, [entry('B')]);
  assert.deepEqual(h.render('A').entries, []);
  h.requests[0].resolve(page('A', [entry('stale A')])); await Promise.resolve(); t.mock.timers.tick(50);
  assert.deepEqual(h.render('A').entries, []);
  h.requests[2].resolve(page('A', [entry('fresh A')])); await Promise.resolve(); t.mock.timers.tick(50);
  assert.deepEqual(h.render('A').entries, [entry('fresh A')]);
  h.dispose(); assert.equal(h.subscribers.size, 0);
});

test('returning to the bottom evicts loaded old pages and re-pages them from a fresh cursor', async t => {
  const h = pagedHarness(t); h.render();
  const latest = Array.from({ length: 80 }, (_, n) => entry(`latest-${n}`));
  h.requests[0].resolve(page('A', latest)); await Promise.resolve(); t.mock.timers.tick(50);
  const loading = h.render().loadEarlier();
  const older = Array.from({ length: 400 }, (_, n) => entry(`old-${n}`));
  h.requests[1].resolve(page('A', older, 'farther')); await loading;
  assert.equal(h.render().entries.length, 480);
  const compacting = h.render().compact(); assert.equal(h.requests[2].request.cursor, null);
  h.packet({ changes: [entry('during-refresh')] }); t.mock.timers.tick(50);
  h.requests[2].resolve(page('A', latest, 'fresh-older')); await compacting;
  assert.equal(h.render().entries.length, 81); assert.equal(h.render().entries.at(-1).id, 'during-refresh');
  const repaging = h.render().loadEarlier(); assert.equal(h.requests[3].request.cursor, 'fresh-older');
  h.requests[3].resolve(page('A', older.slice(-40))); await repaging;
  assert.equal(h.render().entries.length, 121);
});

test('a failed tail compaction retains loaded history and its earlier cursor', async t => {
  const h = pagedHarness(t); h.render();
  h.requests[0].resolve(page('A', [entry('latest')])); await Promise.resolve(); t.mock.timers.tick(50);
  const loading = h.render().loadEarlier(), older = Array.from({ length: 300 }, (_, n) => entry(`old-${n}`));
  h.requests[1].resolve(page('A', older, 'original-older')); await loading;
  const before = h.render().entries, compacting = h.render().compact();
  h.requests[2].resolve({ ok: false, error: 'temporary read failure' }); await compacting;
  assert.deepEqual(h.render().entries, before); assert.equal(h.render().error, 'temporary read failure');
  assert.equal(h.render().hasEarlier, true);
});
