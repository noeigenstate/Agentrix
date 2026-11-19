const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerTerminalIpc } = require('../electron/features/terminal/ipc.cjs');

test('terminal start forwards only the terminal id from the renderer', () => {
  const handlers = new Map(), starts = [];
  registerTerminalIpc({ handle: (name, fn) => handlers.set(name, fn), listen() {}, startTerminal: (...args) => starts.push(args) });
  handlers.get('terminal:start')('terminal', true, { sessionKey: 'renderer-value' });
  assert.deepEqual(starts, [['terminal']]);
});

test('an approved terminal restart preserves dispatched calls and a refused restart changes nothing', async () => {
  const handlers = new Map(), events = [];
  let approved = false;
  registerTerminalIpc({ handle: (name, fn) => handlers.set(name, fn), listen() {},
    confirmTerminalClose: async () => approved,
    forgetRestorePlan: id => events.push(['forget', id]),
    disposeTerminal: (id, options) => events.push(['dispose', id, options]),
    startTerminal: id => events.push(['start', id]) });
  assert.equal(await handlers.get('terminal:restart')('terminal'), false);
  assert.deepEqual(events, []);
  approved = true;
  assert.equal(await handlers.get('terminal:restart')('terminal'), true);
  assert.deepEqual(events, [['forget', 'terminal'], ['dispose', 'terminal', { preserveCalls: true }], ['start', 'terminal']]);
});
