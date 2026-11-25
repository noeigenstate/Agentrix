const { test } = require('node:test');
const assert = require('node:assert/strict');

test('material teardown awaits each isolated shell exit before asking the next PTY to close', async () => {
  const terminals = ['first', 'second'].map(id => ({ id, shellReady: true, status: 'shell' }));
  terminals.push({ id: 'agent', shellReady: false, cliActive: true });
  const { stopMaterialShells } = await import('../scripts/material-smoke-cleanup.mjs');
  const calls = [];
  await stopMaterialShells({
    state: async () => ({ projects: [{ terminals }] }),
    page: { async evaluate(_fn, id) {
      assert.ok(terminals.filter(value => value.id !== id && calls.includes(value.id)).every(value => value.status === 'exited'));
      calls.push(id);
    } },
    async waitFor(check, label, timeout) {
      assert.equal(label, 'material fixture shell exits'); assert.equal(timeout, 4000);
      assert.equal(await check(), false);
      terminals.find(value => value.id === calls.at(-1)).status = 'exited';
      assert.equal(await check(), true);
    },
  });
  assert.deepEqual(calls, ['first', 'second']);
});
