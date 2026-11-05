require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { promptText, rememberClaudeSource } = require('../electron/prompt-queue.cjs');
const { createNormalizer } = require('../electron/features/claude-sdk/normalize.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function folder(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-n-review-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })); return root;
}
test('N5 two CLI shell blocks are machine context, never owner prompts', () => {
  rememberClaudeSource('shell-owner', 'gui');
  const blocks = [{ type: 'text', text: '<bash-input>echo test</bash-input>\n' },
    { type: 'text', text: '<bash-stdout>test</bash-stdout><bash-stderr></bash-stderr>' }];
  assert.equal(promptText(blocks, { session_id: 'shell-owner', turnOrigin: 'sdk', promptSource: 'sdk' }), null);
  assert.equal(promptText(blocks, { session_id: 'shell-owner' }), null);
  assert.equal(promptText([{ type: 'text', text: 'Explain this' }, ...blocks], { session_id: 'shell-owner', turnOrigin: 'sdk', promptSource: 'sdk' }), 'Explain this');
});
test('N4 only a real compact boundary suppresses this turn compact feedback', () => {
  const visible = [], normalize = createNormalizer((type, payload) => { if (type === 'item.upsert') visible.push(payload.content.text); });
  const local = id => ({ type: 'assistant', uuid: id, local_command_run: { command: 'compact', args: '' }, message: { id, content: [{ type: 'text', text: 'NO COMPACTION' }] } });
  normalize(local('empty')); assert.deepEqual(visible, ['NO COMPACTION']);
  normalize({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual' } });
  normalize(local('done')); assert.equal(visible.length, 1);
  normalize({ type: 'result' }); normalize(local('failed-next')); assert.equal(visible.length, 2);
});
for (const mode of ['unavailable', 'reserve']) test(`N6 shell output survives ${mode} model delivery failure and says it was not delivered`, async t => {
  const root = folder(t), fake = fakeSdk(), events = [];
  const runtime = require('../electron/features/claude-sdk/index.cjs').createClaudeRuntime({ directory: root, loadSdk: async () => fake.sdk,
    resolveExecutable: async () => 'fake-only', safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  t.after(() => runtime.close()); runtime.credentials.save('sk-ant-offline-review-output-only');
  if (mode === 'reserve') runtime.usage.reserve = () => { throw new Error('NO_BUDGET'); };
  const session = runtime.create({ owner: 'gui', cwd: root, env: { ...process.env, GIT_CEILING_DIRECTORIES: root }, mayContinue: () => mode !== 'unavailable' }, event => events.push(event));
  await session.start();
  await assert.rejects(session.shell('shell', 'printf PRESERVED_OUTPUT'), /输出未发送给模型/, 'the shell RPC must refuse delivery so the composer always shows the reason');
  const card = events.findLast(event => event.type === 'item.upsert' && event.itemId === 'shell:shell');
  assert.match(card.payload.content.output, /PRESERVED_OUTPUT/); assert.equal(card.payload.content.exitCode, 0);
  assert.equal(card.payload.status, 'completed'); assert.equal(card.payload.content.modelDelivery, 'rejected');
  assert.ok(events.some(event => event.type === 'error' && event.payload.code === 'shell_context_rejected'));
});
test('N7 a returned background job outlives its foreground timeout, but close can reap it', { timeout: 10000 }, async t => {
  const root = folder(t), abort = new AbortController();
  const result = await require('../electron/features/claude-sdk/shell.cjs').runShell({ cwd: root, env: { ...process.env, GIT_CEILING_DIRECTORIES: root },
    command: '(sleep 3; printf alive > background-proof) & echo started', signal: abort.signal, timeout: 2000, output() {} });
  try { await pause(3400); assert.equal(fs.readFileSync(path.join(root, 'background-proof'), 'utf8'), 'alive'); }
  finally { abort.abort(); await result.closed; }
});

test('generated image metadata uses the host translation', () => {
  const { itemPayload } = require('../electron/features/codex-app-server/events.cjs');
  const payload = itemPayload({ type: 'imageGeneration', savedPath: '/tmp/generated_images/run/image.png' }, true, () => null, () => 'Translated host image notice');
  assert.equal(payload.content.text, 'Translated host image notice');
});

test('N5 malformed non-text blocks do not hide or crash an owner message', () => {
  assert.equal(promptText([{ type: 'text', text: 'Owner words' }, null], {}), 'Owner words');
});
