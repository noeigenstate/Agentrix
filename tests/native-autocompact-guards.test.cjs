require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
for (const mode of ['success', 'child', 'replay', 'interrupted', 'manual']) test(`Claude compact failure notice excludes ${mode}`, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-compact-guard-')), fake = fakeSdk({ auto: false, interruptResult: false }), events = [];
  const runtime = createClaudeRuntime({ directory, loadSdk: async () => fake.sdk, resolveExecutable: async () => 'fake-only',
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  t.after(async () => { await runtime.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  runtime.credentials.save('sk-ant-offline-compact-guard');
  const session = runtime.create({ owner: 'gui', cwd: directory, env: {}, runtimeSessionId: 'compact-guard', model: 'fake-model' }, row => events.push(row));
  const wait = async check => { for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('compact guard fixture did not settle'); };
  await session.start(); await session.send({ clientMessageId: 'input', text: 'Offline guard' }); await wait(() => events.some(row => row.type === 'routing.updated'));
  fake.emit({ type: 'system', subtype: 'status', status: 'compacting', ...(mode === 'child' ? { parent_tool_use_id: 'child' } : {}), isReplay: mode === 'replay' });
  if (mode === 'success') fake.emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 100 } });
  fake.emit({ type: 'assistant', error: 'invalid_request', message: { model: '<synthetic>', content: [{ type: 'text', text: 'offline compact failed' }] } });
  if (mode === 'interrupted') await session.interrupt();
  fake.emit({ type: 'result', uuid: 'result', subtype: 'success', terminal_reason: mode === 'success' ? 'completed' : 'prompt_too_long', is_error: mode !== 'success', total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, ...(mode === 'manual' ? { local_command: 'compact' } : {}) });
  await wait(() => events.some(row => row.type === 'turn.completed'));
  assert.equal(events.filter(row => row.type === 'error' && row.payload.code === 'context_compaction_failed').length, 0);
});
