require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), Module = require('node:module');
const ts = require('typescript');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createCodexRuntime } = require('../electron/features/codex-app-server/index.cjs');
const { createRouter } = require('../electron/features/native-session/router.cjs');

// JSON-RPC envelopes and response fields follow the archived 0.166 schemas.
// No executable, account directory, network request or credential store is used.
function server(cwd, tier = 'fast') {
  const child = new EventEmitter(), wire = [];
  const failures = new Set(), held = new Map();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); };
  const send = message => child.stdout.write(JSON.stringify(message) + '\n');
  child.stdin = new Writable({ write(bytes, _encoding, done) {
    for (const line of bytes.toString().trim().split('\n')) {
      const request = JSON.parse(line); wire.push(request); if (request.id == null) continue;
      queueMicrotask(() => {
        const p = request.params || {};
        if (failures.has(request.method)) return send({ id: request.id, error: { code: -32603, message: 'private server message' } });
        if (['thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt'].includes(request.method) && !p.threadId) return send({ id: request.id, error: { code: -32602, message: 'missing threadId' } });
        let result;
        if (request.method === 'initialize') result = { userAgent: 'codex/0.166.0' };
        else if (request.method === 'thread/start') result = { thread: { id: 'offline-thread', sessionId: 'offline-session', turns: [], cliVersion: '0.166.0', cwd, modelProvider: 'openai', source: 'vscode',
          preview: '', projectId: null, ephemeral: true, status: { type: 'idle' }, createdAt: 2000000000, updatedAt: 2000000000 },
        cwd, model: 'gpt-6.1-sol', modelProvider: 'openai', reasoningEffort: 'high', serviceTier: tier, approvalPolicy: p.approvalPolicy || 'on-request', approvalsReviewer: 'user',
          sandbox: { type: { 'danger-full-access': 'dangerFullAccess', 'workspace-write': 'workspaceWrite' }[p.sandbox] || 'readOnly' } };
        else if (request.method === 'account/read') result = { account: { type: 'chatgpt', email: 'private@example.invalid', planType: 'pro' }, requiresOpenaiAuth: true };
        else if (request.method === 'account/rateLimits/read') result = { rateLimits: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: { usedPercent: 70, windowDurationMins: 10080, resetsAt: 2000500000 } }, rateLimitsByLimitId: {} };
        else if (request.method === 'turn/start') result = { turn: { id: 'offline-turn', status: 'inProgress', items: [] } };
        else if (request.method === 'turn/steer') result = { turnId: 'offline-turn' };
        else if (request.method === 'skills/list') result = { data: [{ cwd, skills: [{ name: 'deploy', enabled: true, path: path.join(cwd, 'deploy', 'SKILL.md'), description: 'Offline skill' }] }] };
        else result = {};
        // A held method answers only when the test releases it: a read that is still on its way.
        if (held.has(request.method)) held.get(request.method).push(() => send({ id: request.id, result })); else send({ id: request.id, result });
      });
    }
    done();
  } });
  return { child, wire, failures, hold: method => held.set(method, []), release(method) { for (const answer of held.get(method)) answer(); held.delete(method); }, notify: (method, params) => send({ method, params: { threadId: 'offline-thread', ...params } }) };
}
async function fixture(t, tier = 'fast') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-status-offline-')), fake = server(root, tier), events = [];
  const provider = createCodexRuntime({ resolveExecutable: async () => 'fake-only', spawnProcess: () => fake.child });
  const create = provider.create.bind(provider); let session;
  provider.create = (...args) => session = create(...args);
  const router = createRouter({ codex: provider, claude: { apiState: () => ({ status: 'no_key' }) }, emit: row => events.push(row),
    settings: { get: () => ({}) }, resolveSpec: () => ({ terminalId: 't', projectId: 'p', owner: 'gui', cwd: root, preserveRunOptions: true, env: { CODEX_HOME: root, PATH: '' } }) });
  t.after(async () => { await router.close(); fs.rmSync(root, { force: true, recursive: true }); });
  const started = await router.start('t', { agent: 'codex' });
  return { ...fake, root, events, router, providerSnapshot: () => session.snapshot(), id: started.runtimeSessionId };
}
// A query is answered by the send receipt alone: it is no item, no input receipt event and no turn, in the renderer's events, in either snapshot or on the wire.
const conversational = row => row.type === 'item.upsert' || row.type === 'item.delta' || row.type === 'input.receipt' || row.type.startsWith('turn.');
test('Codex /status and /usage answer in the receipt only: no item, receipt event, turn or snapshot entry', async t => {
  const f = await fixture(t);
  const count = () => [f.events, f.router.snapshot('t').events, f.providerSnapshot().events].map(list => list.filter(conversational).length), before = count(), answers = [];
  for (const [n, text] of ['/status', '/usage', '/status'].entries()) answers.push(await f.router.send('t', f.id, { clientMessageId: 'query-' + n, text }));
  assert.deepEqual(answers.map(row => [row.status, row.clientMessageId, row.local.command]), [['consumed', 'query-0', 'status'], ['consumed', 'query-1', 'usage'], ['consumed', 'query-2', 'status']]);
  assert.equal(f.wire.filter(row => row.method === 'turn/start' && row.params.threadId).length, 0);
  assert.deepEqual(count(), before, 'nothing was published to the window, and a reload or a replay cannot show it again');
  assert.ok(!JSON.stringify([f.router.snapshot('t'), f.providerSnapshot()]).includes('query-'), 'and the ids are nowhere in either snapshot');
  const { nativeEntries, nativePending } = ui('native-entries.ts'), model = ui('native-model.ts').fromSnapshot(f.router.snapshot('t'));
  assert.deepEqual([nativeEntries(model).length, nativePending(model, []).prompts.length], [0, 0], 'the conversation stays empty');
});

const loaded = new Map();
function ui(file) {
  if (loaded.has(file)) return loaded.get(file).exports;
  const filename = path.join(__dirname, '../src/features/native-session', file), mod = new Module(filename, module);
  loaded.set(file, mod); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  mod.require = name => name === '../../shared/i18n' ? { t: key => key, currentLanguage: () => 'zh' }
    : name === '../reading/feed-parts' ? { splitQuote: text => ({ rest: text }) }
      : name.startsWith('./') ? ui(name.slice(2).replace(/\.ts$/, '') + '.ts') : original(name);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, filename);
  return mod.exports;
}

test('Codex /status reports provider data, both quota windows and safe failures, never a model request', async t => {
  const f = await fixture(t);
  f.notify('thread/tokenUsage/updated', { turnId: 'offline-turn', tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 10, totalTokens: 130 }, last: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 60 }, modelContextWindow: 200000 } });
  const { local } = await f.router.send('t', f.id, { clientMessageId: 'known', text: '/status' });
  assert.deepEqual(local.session, { model: 'gpt-6.1-sol', effort: 'high', fast: true, cwd: local.session.cwd, sandbox: 'dangerFullAccess', approval: 'never', permissions: 'full' });
  assert.equal(typeof local.session.cwd, 'string');
  assert.deepEqual(local.account, { provider: 'openai', kind: 'subscription' });
  assert.deepEqual(local.tokens, { total: 130, input: 100, output: 30, cachedInput: 20, reasoning: 10, context: 60, window: 200000 });
  assert.deepEqual(local.limits.map(row => [row.id, row.usedPercent]), [['5h', 25], ['week', 70]]);
  assert.ok(local.limits.every(row => Number.isSafeInteger(row.resetsAtMs) && new Date(row.resetsAtMs).getFullYear() === 2033), 'reset times are the provider’s, in milliseconds');
  assert.deepEqual(local.errors, []);
  assert.doesNotMatch(JSON.stringify(local), /private@|planType|email/, 'the account’s address and plan are not carried');
  f.failures.add('account/read'); f.failures.add('account/rateLimits/read');
  const failed = (await f.router.send('t', f.id, { clientMessageId: 'failure', text: '/usage' })).local;
  assert.equal(failed.command, 'usage');
  assert.deepEqual(failed.errors, [{ source: 'account', reason: 'RPC -32603' }, { source: 'limits', reason: 'RPC -32603' }]);
  assert.doesNotMatch(JSON.stringify(failed), /private server message/, 'a failure gives its code, not the server’s own words');
  assert.deepEqual(failed.limits.map(row => [row.usedPercent, row.resetsAtMs]), [[null, null], [null, null]]);
  assert.equal(failed.account.kind, 'unknown');
});

test('a /status still reading keeps no message waiting behind it', async t => {
  const f = await fixture(t);
  f.hold('account/read');
  const status = f.router.send('t', f.id, { clientMessageId: 'slow', text: '/status' });
  const message = await Promise.race([f.router.send('t', f.id, { clientMessageId: 'after', text: 'go on' }), new Promise(resolve => setTimeout(resolve, 500, 'waited behind the read'))]);
  assert.equal(message.status, 'delivered');
  f.release('account/read');
  assert.deepEqual([(await status).status, (await status).local.errors], ['consumed', []]);
});

test('a dispatched worker’s text is never a command: a leading / or ! goes to the model as written', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-status-worker-')), fake = server(root);
  const worker = createCodexRuntime({ resolveExecutable: async () => 'fake-only', spawnProcess: () => fake.child })
    .create({ terminalId: 't', projectId: 'p', owner: 'dispatch', readOnly: true, cwd: root, env: { CODEX_HOME: root, PATH: '' } }, () => {});
  t.after(async () => { await worker.close(); fs.rmSync(root, { force: true, recursive: true }); });
  await worker.start();
  // The window's questions, the local commands, the menu's settings, a shell line and a built-in the native mode refuses: every family the owner's session reads.
  const briefs = ['/status of the build: say whether it passes', '/usage', '/compact', '/review the diff before you answer', '/model gpt-6.1-sol', '/effort high', '/fast', '/new', '/clear', '!npm test', '/vim', '/deploy the build'];
  for (const [at, text] of briefs.entries()) {
    const receipt = await worker.send({ clientMessageId: `brief-${at}`, text });
    assert.deepEqual([receipt.status, receipt.local], ['delivered', undefined], text);
  }
  const sent = fake.wire.filter(row => ['turn/start', 'turn/steer'].includes(row.method) && row.params.threadId).map(row => row.params.input);
  assert.deepEqual(sent.map(input => input.map(part => [part.type, part.text])), briefs.map(text => [['text', text]]), 'each is one piece of text: no skill of the same name rides along');
  assert.deepEqual(fake.wire.filter(row => ['thread/compact/start', 'review/start', 'thread/shellCommand', 'model/list', 'account/read', 'skills/list'].includes(row.method)).map(row => row.method), [], 'nothing was run or read in the worker’s name');
});

test('the owner’s own /name still attaches the enabled skill of that name', async t => {
  const f = await fixture(t);
  assert.equal((await f.router.send('t', f.id, { clientMessageId: 'skill', text: '/deploy the build' })).status, 'delivered');
  assert.deepEqual(f.wire.find(row => row.method === 'turn/start' && row.params.threadId).params.input.map(part => part.type), ['text', 'skill']);
});

test('a refused local command cannot poison the queue for the next /status', async t => {
  const f = await fixture(t);
  await assert.rejects(f.router.send('t', f.id, { clientMessageId: 'bad', text: '/status unexpected' }));
  await assert.rejects(f.router.send('t', f.id, { clientMessageId: 'bad-usage', text: '/usage unexpected' }));
  assert.equal((await f.router.send('t', f.id, { clientMessageId: 'good', text: '/status' })).status, 'consumed');
});

test('unknown values stay unknown (null), including Fast, approval, sandbox, tokens and the account', () => {
  const { statusPanel } = require('../electron/features/codex-app-server/status.cjs');
  const panel = statusPanel({ options: { model: null, effort: null, fast: null }, thread: {}, cwd: null, usage: null, account: null, limits: null, errors: [] });
  assert.deepEqual(panel.session, { model: null, effort: null, fast: null, cwd: null, sandbox: null, approval: null, permissions: null });
  assert.deepEqual(Object.values(panel.tokens), [null, null, null, null, null, null, null]);
  assert.deepEqual(panel.limits, [{ id: '5h', usedPercent: null, resetsAtMs: null }, { id: 'week', usedPercent: null, resetsAtMs: null }]);
  assert.deepEqual([panel.account, panel.errors], [{ provider: null, kind: 'unknown' }, []]);
  assert.equal(statusPanel({ options: { fast: null }, thread: {}, usage: { input: 1.5, output: 2 }, errors: [] }).tokens.total, null, 'a count that is not a count is not summed');
  const granular = statusPanel({ options: { fast: null }, thread: { approvalPolicy: { granular: {} }, serviceTier: 'default' }, cwd: null, usage: { input: 3, output: 4 }, account: { kind: 'none' }, limits: null, errors: [['account/read', { code: 'timeout' }]] }, value => value);
  assert.deepEqual([granular.session.approval, granular.session.fast, granular.tokens.total, granular.account.kind, granular.errors], ['granular', false, 7, 'none', [{ source: 'account', reason: '请求超时' }]]);
});

test('/status does not turn an unreported service tier into Fast off', async t => {
  const f = await fixture(t, null);
  const { local } = await f.router.send('t', f.id, { clientMessageId: 'unknown-fast', text: '/status' });
  assert.equal(local.session.fast, null);
});

test('read-only /status does not clear an owner stop when a late interrupted turn arrives', async t => {
  const { createEventStream } = require('../electron/features/native-session/events.cjs');
  let stream; const markers = [];
  const provider = { create(spec, emit) {
    stream = createEventStream(spec, emit);
    return { start: async () => ({}), close: async () => {}, interrupt: async () => {}, snapshot: () => ({ state: 'idle' }), send: async () => ({ status: 'consumed' }) };
  } };
  const router = createRouter({ codex: provider, claude: { apiState: () => ({ status: 'ready' }) }, resolveSpec: () => ({ projectId: 'p', terminalId: 't' }), settings: { get: () => ({}) }, emit() {}, saveInterrupted: (_id, value) => markers.push(value) });
  t.after(() => router.close());
  const { runtimeSessionId } = await router.start('t', { agent: 'codex' });
  await router.interrupt('t', runtimeSessionId);
  await router.send('t', runtimeSessionId, { clientMessageId: 'status', text: '/status' });
  stream.publish('turn.completed', { status: 'interrupted', durationMs: null, apiDurationMs: null, costUsdMicros: null, tokens: null });
  assert.equal(markers.at(-1), false);
});
