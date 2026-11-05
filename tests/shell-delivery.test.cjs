require('./fixtures/team-isolation.cjs');
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');
const reply = content => ({ type: 'assistant', message: { model: 'real-model', content } });
const cases = [
  ['none', null, true], ['empty', reply([]), true],
  ['synthetic', { ...reply([{ type: 'text', text: 'API error' }]), message: { model: '<synthetic>', content: [{ type: 'text', text: 'API error' }] } }, true],
  ['child', { ...reply([{ type: 'text', text: 'Child answer' }]), parent_tool_use_id: 'child' }, true],
  ['text', reply([{ type: 'text', text: 'Partial reply' }]), false],
  ['stream', { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Partial reply' } } }, false],
  ['tool', reply([{ type: 'tool_use', id: 'tool', name: 'Read', input: {} }]), false],
];
async function check(t, message, rejected, result = {}, interrupt = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-shell-delivery-')), fake = fakeSdk({ auto: false }), events = [];
  const runtime = require('../electron/features/claude-sdk/index.cjs').createClaudeRuntime({ directory: root, loadSdk: async () => fake.sdk,
    resolveExecutable: async () => 'fake-only', safeStorage: { isEncryptionAvailable: () => true, encryptString: Buffer.from, decryptString: value => value.toString() } });
  t.after(async () => { await runtime.close(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });
  runtime.credentials.save('sk-ant-offline-shell-delivery-only');
  const session = runtime.create({ owner: 'gui', cwd: root, env: { ...process.env, GIT_CEILING_DIRECTORIES: root }, runtimeSessionId: 'shell-test' }, event => events.push(event));
  await session.start(); await session.shell('shell', 'echo OUTPUT');
  if (message) fake.emit(message);
  if (interrupt) await session.interrupt();
  else fake.emit({ type: 'result', uuid: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, ...result });
  for (let n = 0; n < 100 && !events.some(event => event.type === 'turn.completed'); n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(events.some(event => event.type === 'turn.completed'));
  if (interrupt) assert.equal(events.find(event => event.type === 'turn.completed').payload.status, 'interrupted');
  const card = events.findLast(event => event.itemId === 'shell:shell'); assert.equal(card.payload.status, 'completed');
  assert.equal(card.payload.content.modelDelivery === 'rejected', rejected);
  assert.equal(events.filter(event => event.type === 'error' && event.payload.code === 'shell_context_rejected').length, rejected ? 1 : 0);
  if (rejected) assert.equal(events.filter(event => event.type === 'error').at(-1).payload.code, 'shell_context_rejected');
}
test('shell delivery none distinguishes parent reply from CLI errors', { timeout: 20000 }, t => check(t, null, true));
test('owner interrupt retains shell output without a delivery failure warning', { timeout: 20000 }, t => check(t, null, false, {}, true));
test('shell budget notice remains visible after final result', { timeout: 20000 }, t => check(t, null, true, {
  terminal_reason: 'budget_exhausted', subtype: 'error_max_budget_usd',
}));
for (const [name, message, rejected] of cases.filter(([name]) => name !== 'none')) {
  test(`shell delivery ${name} distinguishes parent reply from CLI errors`, { timeout: 20000 }, t => check(t, message, rejected));
}
