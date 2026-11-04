const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');
const { queryOptions } = require('../electron/features/claude-sdk/query.cjs');
const { routeSettings } = require('../electron/features/claude-sdk/routing.cjs');
const { apiEnvironment } = require('../electron/features/claude-sdk/credentials.cjs');
const { promptText } = require('../electron/prompt-queue.cjs');
const { ConversationLog, claudeConversation } = require('../electron/conversation.cjs');
const { createNormalizer } = require('../electron/features/claude-sdk/normalize.cjs');
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
function fixture(t, auto = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-review3-')), cwd = path.join(directory, 'project'), home = path.join(directory, 'home');
  for (const folder of [path.join(cwd, '.claude'), path.join(home, '.claude')]) fs.mkdirSync(folder, { recursive: true });
  const env = { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') }, fake = fakeSdk({ auto }), events = [];
  const runtime = createClaudeRuntime({ directory: path.join(directory, 'state'), safeStorage, loadSdk: async () => fake.sdk, resolveExecutable: async () => 'offline-only' });
  runtime.credentials.save('sk-ant-offline-review-three-key');
  const spec = { owner: 'gui', agent: 'claude', projectId: 'p', terminalId: 't', runtimeSessionId: 'r', cwd, env, monthlyBudgetUsd: 10 };
  t.after(async () => { await runtime.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, cwd, home, env, fake, events, runtime, spec, create: () => runtime.create(spec, event => events.push(event)) };
}

test('B1 terminal error records show a reason while SDK errors remain out of assistant prose', () => {
  const emitted = [], normalize = createNormalizer((...args) => emitted.push(args)), log = new ConversationLog();
  for (const [i, text] of ["You've hit your limit · resets 5pm", 'Not logged in · Please run /login', 'API Error: Request rejected (429) · enforced_spend_limit_reached', 'API Error: 400 {"type":"invalid_request_error"}'].entries()) {
    const record = { type: 'assistant', uuid: `error-${i}`, isApiErrorMessage: true, error: i === 1 ? 'authentication_failed' : 'rate_limit',
      message: { id: `error-${i}`, content: [{ type: 'text', text }] } };
    claudeConversation(log, record); normalize(record);
  }
  assert.equal(log.list.length, 4); assert.match(log.list[0].text, /resets 5pm/);
  assert.ok(log.list.every(entry => entry.role === 'assistant' && entry.text));
  assert.doesNotMatch(JSON.stringify(log.list), /enforced_spend_limit_reached|invalid_request_error|API Error:/);
  assert.deepEqual(emitted, []);
});

test('B2 only the explicit owner entrypoint makes SDK input a human prompt', () => {
  const source = { turnOrigin: 'sdk', promptSource: 'sdk' };
  assert.equal(promptText('owner words', { ...source, entrypoint: 'agentrix-sdk' }), 'owner words');
  assert.equal(promptText('worker brief', { ...source, entrypoint: 'sdk-ts' }), null);
  assert.equal(promptText('ambiguous old SDK words', source), null);
  const env = { CLAUDE_CODE_ENTRYPOINT: 'agentrix-sdk' };
  assert.equal(apiEnvironment(env, 'fake', 'gui').CLAUDE_CODE_ENTRYPOINT, 'agentrix-sdk');
  assert.notEqual(apiEnvironment(env, 'fake', 'dispatch').CLAUDE_CODE_ENTRYPOINT, 'agentrix-sdk');
});

for (const filename of ['settings.json', 'settings.local.json']) test(`B3 invalid project ${filename} does not block input or leak reservations`, async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.cwd, '.claude', filename), '{invalid');
  const session = f.create(); await session.start();
  await session.send({ clientMessageId: 'first', text: 'first' }); await tick();
  await session.send({ clientMessageId: 'second', text: 'second' }); await tick(); await session.close();
  assert.equal(f.fake.inputs.length, 2); assert.equal(f.runtime.usage.available(10), 9800000);
  const ledger = JSON.parse(fs.readFileSync(path.join(f.directory, 'state/usage.json'), 'utf8'));
  assert.deepEqual(ledger.reservations, {});
});

for (const cause of ['user config', 'SDK throws']) test(`B3 startup failure (${cause}) leaves no persisted reservation`, async t => {
  const f = fixture(t);
  if (cause === 'user config') fs.writeFileSync(path.join(f.home, '.claude/settings.json'), '{invalid');
  else f.fake.sdk.query = () => { throw new Error('offline startup failure'); };
  const session = f.create(); await session.start();
  await assert.rejects(session.send({ clientMessageId: 'first', text: 'never delivered' }));
  await session.close(); assert.equal(f.runtime.usage.available(10), 10000000);
  const ledgerFile = path.join(f.directory, 'state/usage.json');
  if (fs.existsSync(ledgerFile)) assert.deepEqual(JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).reservations, {});
});

test('B4 a mode change during a turn retains its query and background tasks for the coordinator', async t => {
  const f = fixture(t, false); let allow = true; f.spec.mayContinue = () => allow;
  const session = f.create(); await session.start(); await session.send({ clientMessageId: 'first', text: 'start work' }); await tick();
  f.fake.emit({ type: 'system', subtype: 'task_started', task_id: 'owned', run_id: 1, is_backgrounded: true }); await tick();
  allow = false;
  f.fake.emit({ type: 'result', uuid: 'result', terminal_reason: 'completed', subtype: 'success', total_cost_usd: 0, modelUsage: {} }); await tick();
  assert.equal(f.fake.closes.length, 0); assert.equal(session.activity().count, 1); assert.equal(session.snapshot().state, 'idle');
  session.policyChanged(); await tick(); assert.equal(f.fake.closes.length, 0);
  f.fake.emit({ type: 'assistant', uuid: 'auto', message: { id: 'auto', content: [{ type: 'text', text: 'automatic continuation' }] } }); await tick();
  assert.ok(f.fake.interrupts.length > 0); assert.equal(f.fake.closes.length, 0); assert.equal(session.activity().count, 1);
});

test('B5 unset TLS and proxy variables stay absent unless a project actually overrides them', t => {
  const f = fixture(t), value = routeSettings(f.spec).env;
  for (const name of ['SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'AWS_CA_BUNDLE', 'HTTPS_PROXY']) assert.equal(Object.hasOwn(value, name), false, name);
  fs.writeFileSync(path.join(f.cwd, '.claude/settings.json'), JSON.stringify({ env: { SSL_CERT_FILE: 'project.pem', HTTPS_PROXY: 'http://trap.invalid' } }));
  const pinned = routeSettings(f.spec).env;
  assert.equal(pinned.SSL_CERT_FILE, ''); assert.equal(pinned.HTTPS_PROXY, '');
  assert.equal(pinned.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
});

test('B6 routing secrets travel in a private settings file, never serialized SDK settings argv, and abort removes it', t => {
  const f = fixture(t), abort = new AbortController(); t.after(() => abort.abort());
  f.env.HTTPS_PROXY = 'http://user:offline-proxy-secret@127.0.0.1:9';
  f.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Probe: offline-header-secret';
  f.env.CLAUDE_CODE_CLIENT_KEY_PASSPHRASE = 'offline-mtls-secret';
  fs.writeFileSync(path.join(f.cwd, '.claude/settings.json'), JSON.stringify({ env: { HTTPS_PROXY: 'http://trap.invalid', CLAUDE_CODE_CLIENT_KEY_PASSPHRASE: 'trap' } }));
  const options = queryOptions(f.spec, { key: 'fake-saved-key', abort, executable: 'offline-only', policy: () => ({ behavior: 'allow' }) });
  assert.equal(typeof options.settings, 'string');
  assert.doesNotMatch(options.settings, /offline-(?:proxy|header|mtls)-secret|fake-saved-key/);
  const data = fs.readFileSync(options.settings, 'utf8'); assert.match(data, /offline-header-secret/); assert.doesNotMatch(data, /fake-saved-key/);
  const filename = options.settings; abort.abort(); assert.equal(fs.existsSync(filename), false);
});

test('B7 project and local API-key replacements fail before any query or budget reservation', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.cwd, '.claude/settings.local.json'), JSON.stringify({ env: { anthropic_api_key: 'untrusted-key' } }));
  assert.throws(() => routeSettings(f.spec), /项目.*密钥/);
  const session = f.create(); await session.start(); await assert.rejects(session.send({ clientMessageId: 'first', text: 'never sent' }));
  assert.equal(f.fake.calls.length, 0); assert.equal(f.runtime.usage.available(10), 10000000);
});

test('image-only input passes IPC and Claude receives an image block without empty text', async t => {
  const f = fixture(t), session = f.create(), image = 'data:image/png;base64,AAAA';
  const handlers = new Map();
  require('../electron/features/native-session/ipc.cjs').registerIpc({ handle: (name, fn) => handlers.set(name, fn),
    router: { send: (_t, _r, value) => session.send(value) } });
  await session.start();
  await handlers.get('native:send')('t', 'r', 'picture', '', [image]); await tick();
  assert.deepEqual(f.fake.inputs[0].message.content.map(block => block.type), ['image']);
  assert.throws(() => handlers.get('native:send')('t', 'r', 'empty', '', []));
});

test('B10 latest-session candidates exclude unmarked SDK worker transcripts', async t => {
  const f = fixture(t), { listClaudeSessions, encodeClaudeCwd } = require('../electron/claude-sessions.cjs');
  const folder = path.join(f.env.CLAUDE_CONFIG_DIR, 'projects', encodeClaudeCwd(f.cwd)); fs.mkdirSync(folder, { recursive: true });
  for (const [id, entrypoint] of [['owner', 'agentrix-sdk'], ['worker', 'sdk-ts']]) fs.writeFileSync(path.join(folder, id + '.jsonl'), JSON.stringify({ type: 'user', turnOrigin: 'sdk', promptSource: 'sdk', entrypoint, message: { content: id } }) + '\n');
  assert.deepEqual((await listClaudeSessions(f.cwd, null, f.env.CLAUDE_CONFIG_DIR)).map(item => item.id), ['owner']);
});

test('B8 full close stops owned background tasks before closing the query', async t => {
  const f = fixture(t, false), original = f.fake.sdk.query, calls = [];
  f.fake.sdk.query = options => {
    const query = original(options);
    return { ...query, stopTask: async id => { calls.push(id); f.fake.emit({ type: 'system', subtype: 'task_notification', task_id: id, run_id: 1, status: 'stopped' }); },
      close() { calls.push('close'); query.close(); } };
  };
  const session = f.create(); await session.start(); await session.send({ clientMessageId: 'first', text: 'work' }); await tick();
  f.fake.emit({ type: 'system', subtype: 'task_started', task_id: 'owned', run_id: 1, is_backgrounded: true });
  f.fake.emit({ type: 'result', uuid: 'result', terminal_reason: 'completed', subtype: 'success', total_cost_usd: 0, modelUsage: {} }); await tick();
  await session.close(); assert.deepEqual(calls, ['owned', 'close']);
});
