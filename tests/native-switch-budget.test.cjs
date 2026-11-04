const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { createNativeSessions } = require('../electron/features/native-session/index.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');

test('clearing a live owner monthly budget through IPC removes the old query cap at the next explicit idle send', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-budget-null-')), fake = fakeSdk(), events = [], handlers = new Map();
  const claude = createClaudeRuntime({ directory, loadSdk: async () => fake.sdk, resolveExecutable: async () => 'offline-only',
    safeStorage: { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: data => data.toString() } });
  claude.credentials.save('sk-ant-offline-budget-null-test-only');
  const facade = createNativeSessions({ directory, claude, resolveSpec: id => ({ owner: 'gui', agent: 'claude', projectId: 'p', terminalId: id, cwd: directory }),
    emit: event => events.push(event) });
  facade.register((channel, handle) => handlers.set(channel, handle));
  t.after(async () => { await facade.close(); await claude.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  handlers.get('native:settings-set')({ claudePath: 'api-only', monthlyBudgetUsd: 10 });
  const { runtimeSessionId } = await facade.start('t', { agent: 'claude' });
  await facade.send('t', runtimeSessionId, { clientMessageId: 'first', text: 'first input' });
  const idle = async n => {
    for (let i = 0; i < 100; i++) {
      if (events.filter(event => event.type === 'turn.completed').length === n && facade.snapshot('t').state === 'idle') return;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('offline query did not become idle');
  };
  await idle(1); assert.equal(fake.calls[0].options.maxBudgetUsd, 5);
  const closes = fake.closes.length;
  assert.equal(handlers.get('native:settings-set')({ monthlyBudgetUsd: null }).monthlyBudgetUsd, null);
  assert.equal(fake.closes.length, closes, 'saving settings alone does not terminate a live query');
  await facade.send('t', runtimeSessionId, { clientMessageId: 'second', text: 'second input' }); await idle(2);
  assert.equal(fake.calls.at(-1).options.maxBudgetUsd, undefined);
  assert.equal(fake.calls.at(-1).options.resume, fake.sessionId);
  assert.deepEqual(fake.inputs.map(input => input.message.content), ['first input', 'second input']);
});
