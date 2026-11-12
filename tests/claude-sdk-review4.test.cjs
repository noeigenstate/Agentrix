const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { routeSettings, ROUTE_ENV } = require('../electron/features/claude-sdk/routing.cjs');
const { startupFailure } = require('../electron/features/claude-sdk/identity.cjs');
const { workerEnvironment } = require('../electron/features/codex-app-server/environment.cjs');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');
const tick = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(t, auto = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-review4-')), cwd = path.join(directory, 'project'), home = path.join(directory, 'home');
  for (const folder of [path.join(cwd, '.claude'), path.join(home, '.claude')]) fs.mkdirSync(folder, { recursive: true });
  const env = { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') };
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, cwd, env, spec: { owner: 'gui', cwd, env }, file: path.join(cwd, '.claude/settings.local.json') };
}
const keyConfig = JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-ant-offline-project-override' } });
for (const [name, bytes] of [
  ['padded', keyConfig + ' '.repeat(1048577)], ['leading padded', '\n'.repeat(1048577) + keyConfig],
  ['UTF-16LE BOM', Buffer.concat([Buffer.from([255, 254]), Buffer.from(keyConfig, 'utf16le')])],
]) test(`F1 ${name} settings cannot bypass project key rejection`, t => {
  const f = fixture(t); fs.writeFileSync(f.file, bytes);
  assert.throws(() => routeSettings(f.spec), { code: 'project_api_key_override' });
});
test('F1 oversized files fail closed, while an unreadable syntax pins every known route', t => {
  const f = fixture(t); fs.writeFileSync(f.file, '{invalid');
  const config = routeSettings(f.spec);
  assert.ok(ROUTE_ENV.every(name => Object.hasOwn(config.env, name)));
  fs.truncateSync(f.file, 64 * 1024 * 1024 + 1);
  assert.throws(() => routeSettings(f.spec), { code: 'route_config_unreadable' });
});
test('F2 fallback worker environments never inherit owner entrypoint in any casing', () => {
  for (const parent of [undefined, '1']) {
    const original = { AGENTRIX_SDK_PARENT: parent, CLAUDE_CODE_ENTRYPOINT: 'agentrix-sdk', claude_code_entrypoint: 'agentrix-sdk' };
    const clean = workerEnvironment(original);
    assert.equal(Object.keys(clean).some(name => name.toUpperCase() === 'CLAUDE_CODE_ENTRYPOINT'), false);
    assert.equal(original.CLAUDE_CODE_ENTRYPOINT, 'agentrix-sdk');
  }
});
test('F3 dispatch refuses project keys in the settings its CLI loads', t => {
  const f = fixture(t); fs.writeFileSync(f.file, keyConfig);
  assert.throws(() => routeSettings({ ...f.spec, owner: 'dispatch' }), { code: 'project_api_key_override' });
});
test('F4 trusted startup errors keep the settings filename and remedy without key bytes', t => {
  const f = fixture(t); fs.writeFileSync(f.file, keyConfig);
  let failure; try { routeSettings(f.spec); } catch (error) { failure = startupFailure(error); }
  assert.equal(failure?.beforeInput, true); assert.match(failure.message, /settings\.local\.json/);
  assert.match(failure.message, /env\.ANTHROPIC_API_KEY/); assert.match(failure.message, /终端/);
  assert.doesNotMatch(failure.message, /sk-ant-offline-project-override/);
});
test('F5 future proxy and Node TLS changes are pinned while absent CA search variables stay absent', t => {
  const f = fixture(t), env = routeSettings(f.spec).env;
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED']) assert.ok(Object.hasOwn(env, name), name);
  for (const name of ['SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'AWS_CA_BUNDLE']) assert.equal(Object.hasOwn(env, name), false, name);
});
test('F6 a reservation failure leaves the session usable after its budget is raised', async t => {
  const f = fixture(t), fake = fakeSdk(), events = [];
  const runtime = createClaudeRuntime({ directory: path.join(f.directory, 'state'), loadSdk: async () => fake.sdk, resolveExecutable: async () => 'offline-only',
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  t.after(() => runtime.close()); runtime.credentials.save('sk-ant-offline-budget-race');
  const spec = { ...f.spec, agent: 'claude', projectId: 'p', terminalId: 't', runtimeSessionId: 'r', monthlyBudgetUsd: 0 };
  const session = runtime.create(spec, event => events.push(event)); await session.start();
  await assert.rejects(session.send({ clientMessageId: 'first', text: 'first' }), { code: 'budget_exhausted' });
  assert.equal(session.snapshot().state, 'idle'); assert.equal(events.some(event => event.payload.code === 'sdk_startup_failed'), false);
  spec.monthlyBudgetUsd = 10; await session.send({ clientMessageId: 'second', text: 'second' }); await tick();
  assert.equal(fake.inputs.length, 1);
});
test('F7 terminal synthetic API errors use the current main-process translator', t => {
  const conversation = require('../electron/conversation.cjs'), { translate } = require('../electron/i18n.cjs');
  let language = 'en'; conversation.setConversationTranslator?.(text => translate(language, text));
  t.after(() => conversation.setConversationTranslator?.(text => text));
  for (const selected of ['en', 'zh']) {
    language = selected; const log = new conversation.ConversationLog();
    conversation.claudeConversation(log, { type: 'assistant', uuid: 'error', isApiErrorMessage: true, error: 'rate_limit', message: { content: [{ type: 'text', text: 'API Error: 429' }] } });
    assert.equal(log.list[0].text, translate(selected, 'API 请求受到限流。'));
  }
});

test('F4 switching retains a trusted pre-input filename and remedy on the old path', async t => {
  const f = fixture(t), { createSwitches } = require('../electron/features/native-session/switches.cjs');
  fs.writeFileSync(f.file, keyConfig);
  const source = { identity: {}, path: 'terminal', spec: { ...f.spec, agent: 'claude', terminalId: 't', runtimeSessionId: 'old' } };
  const switches = createSwitches({ list: () => [source], choose: () => ({ path: 'api' }), observe: () => ({ state: 'idle', background: { known: true, count: 0 } }),
    prepare: async () => { try { routeSettings(f.spec); } catch (error) { throw startupFailure(error); } }, publish() {} });
  t.after(() => switches.close()); switches.reconcile(); await tick();
  const changeId = switches.state('t').changeId;
  switches.answer('t', 'old', { handoff: { changeId, draft: { version: 1, text: 'kept draft', images: [], undelivered: [] } } }); await tick();
  assert.equal(switches.state('t').current, 'terminal'); assert.equal(switches.state('t').outcome, 'failed');
  assert.match(switches.state('t').reason, /settings\.local\.json/); assert.match(switches.state('t').reason, /删除/);
});

test('F8 an exhausted cap with background tasks explains why an explicit send cannot renew it', async t => {
  const f = fixture(t), fake = fakeSdk({ auto: false }), events = [];
  const runtime = createClaudeRuntime({ directory: path.join(f.directory, 'state'), loadSdk: async () => fake.sdk, resolveExecutable: async () => 'offline-only',
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  t.after(() => runtime.close()); runtime.credentials.save('sk-ant-offline-background-cap');
  const spec = { ...f.spec, agent: 'claude', projectId: 'p', terminalId: 't', runtimeSessionId: 'r', monthlyBudgetUsd: 5 };
  const session = runtime.create(spec, event => events.push(event));
  await session.start(); await session.send({ clientMessageId: 'first', text: 'first' }); await tick();
  spec.monthlyBudgetUsd = 20;
  fake.emit({ type: 'system', subtype: 'task_started', task_id: 'owned', is_backgrounded: true });
  fake.emit({ type: 'result', uuid: 'result', terminal_reason: 'budget_exhausted', subtype: 'error_max_budget_usd', total_cost_usd: 5, modelUsage: {} }); await tick();
  assert.match(events.findLast(event => event.type === 'turn.completed').payload.error, /后台任务/);
  await assert.rejects(session.send({ clientMessageId: 'second', text: 'second' }), error => error.code === 'budget_exhausted' && /后台任务/.test(error.message));
  assert.equal(session.activity().count, 1); assert.equal(fake.calls.length, 1);
});
test('the native API channel clears a user apiKeyHelper (the owner decision), and keeps the other user helpers', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ apiKeyHelper: 'echo private-helper', proxyAuthHelper: 'echo proxy-helper' }));
  const config = routeSettings(f.spec);
  assert.equal(config.apiKeyHelper, ''); assert.equal(config.proxyAuthHelper, 'echo proxy-helper');
});
