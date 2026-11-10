const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { createNativeSessions } = require('../electron/features/native-session/index.cjs');
const { fakeSdk } = require('./fixtures/claude-sdk.cjs');
const { panelCommand, contextFacts, createTally, initFacts } = require('../electron/features/claude-sdk/panel.cjs');

// Claude's /context, /cost, /status and /usage in native mode answer in the send receipt's `local` field, from the SDK and from what the session already saw. A fake SDK
// stands in everywhere: no real CLI, key or account is touched.
const settle = async () => { for (let round = 0; round < 8; round++) await new Promise(resolve => setImmediate(resolve)); };
const CONTEXT = { model: 'fake-model', totalTokens: 58400, maxTokens: 167000, rawMaxTokens: 1000000, percentage: 5.8, isAutoCompactEnabled: true, autoCompactThreshold: 830000,
  categories: [{ id: 'system-prompt', name: 'System prompt', tokens: 14200, color: 'x', kind: 'used' }, { id: 'messages', name: 'Messages', tokens: 25800, kind: 'used' }, { id: 'free-space', name: 'Free space', tokens: 941600, kind: 'free' },
    { id: 'empty', name: 'Empty', tokens: 0, kind: 'used' }, { name: 7, tokens: 1, kind: 'used' }, { name: 'Odd kind', tokens: 5, kind: 'surprise' }, { id: 7, name: 'No usable id', tokens: 4 }],
  memoryFiles: [{ path: 'C:\\Users\\someone\\project\\CLAUDE.md', type: 'Project', tokens: 3100 }, { path: '/home/someone/.claude/CLAUDE.md', type: 'User', tokens: 900 }],
  mcpTools: [{ name: 'browser_click', serverName: 'playwright', tokens: 3000 }, { name: 'browser_type', serverName: 'playwright', tokens: 3800 }, { name: 'ping', serverName: 'other', tokens: 100 }],
  skills: { totalSkills: 2, includedSkills: 2, tokens: 3000, skillFrontmatter: [{ name: 'model-routing', source: 'project', tokens: 2400 }, { name: 'tiny', source: 'user', tokens: 600 }] } };

function fixture(t, context = async () => CONTEXT) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-panel-')), fake = fakeSdk({ uniqueSessions: true }), query = fake.sdk.query;
  fake.sdk.query = spec => ({ ...query(spec), getContextUsage: context, setModel: async () => {}, applyFlagSettings: async () => {} });
  const runtime = createClaudeRuntime({ directory: path.join(root, 'state'), loadSdk: async () => fake.sdk, resolveExecutable: async () => 'synthetic-only',
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  runtime.credentials.save('sk-ant-offline-panel-fixture-only');
  t.after(async () => { await runtime.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, fake, runtime, session: () => runtime.create({ owner: 'gui', cwd: root, env: { PATH: '' }, runtimeSessionId: randomUUID(), monthlyBudgetUsd: 10, effort: 'high' }, () => {}) };
}

test('only the four exact words are panel commands', () => {
  assert.deepEqual(['/context', '/cost', ' /status ', '/usage'].map(panelCommand), ['context', 'cost', 'status', 'usage']);
  for (const words of ['/cost x', '/costs', 'cost', '/Context', '/status\nnow', '!/cost', '/model']) assert.equal(panelCommand(words), null, words);
});

test('the SDK’s context usage is read tolerantly: what is not a count or a name is dropped, nothing is invented', () => {
  const facts = contextFacts(CONTEXT);
  assert.deepEqual([facts.model, facts.tokens, facts.window, facts.autoCompact, facts.autoCompactThreshold], ['fake-model', 58400, 1000000, true, 830000], 'the window is the model’s, not the part left for the conversation');
  assert.deepEqual(facts.categories, [{ id: 'free-space', name: 'Free space', tokens: 941600, kind: 'free' }, { id: 'messages', name: 'Messages', tokens: 25800, kind: 'used' }, { id: 'system-prompt', name: 'System prompt', tokens: 14200, kind: 'used' },
    { id: null, name: 'Odd kind', tokens: 5, kind: null }, { id: null, name: 'No usable id', tokens: 4, kind: null }], 'biggest first, with id and kind as the SDK gave them (null when not a string or not a kind); no empty part and no nameless one');
  assert.deepEqual(facts.memory, [{ name: 'CLAUDE.md', tokens: 3100 }, { name: 'CLAUDE.md', tokens: 900 }], 'a file by its name, whichever separator its path has');
  assert.deepEqual(facts.mcp, [{ name: 'playwright', tokens: 6800 }, { name: 'other', tokens: 100 }], 'a server’s tools added up');
  assert.deepEqual(facts.skills, [{ name: 'model-routing', tokens: 2400 }, { name: 'tiny', tokens: 600 }]);
  const nothing = contextFacts({ totalTokens: -1, maxTokens: '9', categories: 'x', isAutoCompactEnabled: 'yes', skills: [] });
  assert.deepEqual([nothing.model, nothing.tokens, nothing.window, nothing.autoCompact, nothing.categories, nothing.mcp, nothing.skills], [null, null, null, null, [], [], []]);
  assert.deepEqual(contextFacts(null).categories, []);
});

test('the tally keeps the newest cumulative totals, adds the durations and ignores a zeroed failure', () => {
  const tally = createTally();
  assert.deepEqual(tally.facts(), { costUsdMicros: null, durationMs: null, apiDurationMs: null, models: [], tokens: { input: null, output: null, cacheRead: null, cacheWrite: null } }, 'before any result nothing is known');
  const row = (input, output) => ({ costUSD: 0.5, inputTokens: input, outputTokens: output, cacheReadInputTokens: 2, cacheCreationInputTokens: 3 });
  tally.result({ total_cost_usd: 1.5, duration_ms: 1000, duration_api_ms: 400, modelUsage: { opus: row(10, 4) } });
  tally.result({ total_cost_usd: 2.25, duration_ms: 2000, duration_api_ms: 600, modelUsage: { opus: row(30, 9), haiku: row(1, 1) } });
  tally.result({ is_error: true, total_cost_usd: 0, duration_ms: 5, modelUsage: {} });
  const facts = tally.facts();
  assert.deepEqual([facts.costUsdMicros, facts.durationMs, facts.apiDurationMs], [2250000, 3000, 1000], 'the cost is the newest cumulative total, the times are added');
  assert.deepEqual(facts.models.map(model => [model.model, model.costUsdMicros, model.input, model.output]), [['opus', 500000, 30, 9], ['haiku', 500000, 1, 1]]);
  assert.deepEqual(facts.tokens, { input: 31, output: 10, cacheRead: 4, cacheWrite: 6 });
  tally.result({ total_cost_usd: 3, modelUsage: { opus: { inputTokens: 1 } } });
  assert.deepEqual([tally.facts().tokens.output, tally.facts().models[0].costUsdMicros], [null, null], 'a token count a result lacks makes the sum unknown, not smaller');
  assert.deepEqual(initFacts({ claude_code_version: '2.1.318', permissionMode: 'default', mcp_servers: [{ name: 'playwright', status: 'connected' }, { status: 'x' }, 7] }), { version: '2.1.318', permission: 'default', mcp: [{ name: 'playwright', status: 'connected' }] });
  assert.deepEqual(initFacts({}), { version: null, permission: null, mcp: [] });
});

test('/context and /status read the SDK’s context usage and answer in the receipt: no input to the model, no event, no turn', async t => {
  const f = fixture(t), session = f.session();
  await session.start();
  const before = session.snapshot().events.length, receipt = await session.send({ clientMessageId: 'p1', text: '/context' });
  assert.deepEqual([receipt.clientMessageId, receipt.status, receipt.local.agent, receipt.local.command], ['p1', 'consumed', 'claude', 'context']);
  assert.deepEqual([receipt.local.context.tokens, receipt.local.context.window, receipt.local.context.model], [58400, 1000000, 'fake-model']);
  assert.deepEqual([f.fake.inputs.length, session.snapshot().events.length], [0, before], 'nothing was sent to the model and nothing was published');
  const status = await session.send({ clientMessageId: 'p2', text: ' /status ' }), local = status.local;
  assert.deepEqual([local.command, local.session.model, local.session.effort, typeof local.session.cwd, local.account.kind, local.errors], ['status', 'fake-model', 'high', 'string', 'unknown', []]);
  assert.equal(local.context.tokens, 58400);
  assert.equal(f.fake.inputs.length, 0);
  assert.deepEqual((await session.send({ clientMessageId: 'p1', text: '/context' })).status, 'consumed', 'asking again with the same id is asked again: it is no input');
  await assert.rejects(session.send({ clientMessageId: 'p3', text: '/cost', images: ['data:image/png;base64,AAAA'] }), /命令不能附带图片/);
});

test('/status without context usage still answers and says what it could not read; /context then fails plainly', async t => {
  let broken = false;
  const f = fixture(t, async () => { if (broken) throw Object.assign(new Error('sk-ant-offline-panel-fixture-only is the secret'), { code: 'x' }); return CONTEXT; }), session = f.session();
  await session.start(); await session.send({ clientMessageId: 'p1', text: '/context' }); broken = true;
  const status = (await session.send({ clientMessageId: 'p2', text: '/status' })).local;
  assert.deepEqual([status.context, status.errors], [null, [{ source: 'context', reason: '原因未知' }]], 'no reason from the SDK is repeated');
  assert.equal(status.session.model, 'fake-model', 'the model the session already saw is still told');
  await assert.rejects(session.send({ clientMessageId: 'p3', text: '/context' }), error => error.message === '无法读取上下文用量。' && !/sk-ant/.test(error.message));
});

test('/cost and /usage come from the results the session saw and from the usage ledger; a read needs no query', async t => {
  const f = fixture(t), session = f.session();
  await session.start();
  const empty = (await session.send({ clientMessageId: 'c0', text: '/cost' })).local;
  assert.deepEqual([empty.costUsdMicros, empty.durationMs, empty.models, empty.month], [null, null, [], { spentMicros: null, budgetUsd: 10 }], 'before any result: not known, not zero');
  assert.equal(f.fake.calls.length, 0, 'no query was started to answer');
  await session.send({ clientMessageId: 'one', text: 'first' }); await settle();
  assert.equal(f.fake.inputs.length, 1);
  const cost = (await session.send({ clientMessageId: 'c1', text: '/cost' })).local;
  assert.deepEqual([cost.command, cost.costUsdMicros, cost.models.map(model => [model.model, model.costUsdMicros, model.input, model.output]), cost.month], ['cost', 100000, [['fake', null, 10, 4]], { spentMicros: 100000, budgetUsd: 10 }]);
  const usage = (await session.send({ clientMessageId: 'u1', text: '/usage' })).local;
  assert.deepEqual([usage.command, usage.month, usage.today, usage.tokens, usage.limits, usage.notice], ['usage', { spentMicros: 100000, budgetUsd: 10 }, { spentMicros: 100000 }, { input: 10, output: 4, cacheRead: 2, cacheWrite: 3 }, [], null]);
  assert.equal(f.fake.inputs.length, 1, 'the reads were no input of the model');
});

test('through the router a panel query returns its answer and leaves no event, input or turn behind', async t => {
  const f = fixture(t), events = [];
  const native = createNativeSessions({ directory: path.join(f.root, 'native'), claude: f.runtime, codex: {}, emit: event => events.push(event),
    resolveSpec: id => ({ owner: 'gui', cwd: f.root, env: { PATH: '' }, terminalId: id, projectId: 'project', agent: 'claude' }),
    activateNative() {}, terminal: () => assert.fail('no terminal'), saveSession() {} });
  t.after(() => native.close());
  const started = await native.start('terminal', { agent: 'claude' }), before = native.snapshot('terminal').events.length;
  for (const command of ['context', 'cost', 'status', 'usage']) {
    const receipt = await native.send('terminal', started.runtimeSessionId, { clientMessageId: `q-${command}`, text: `/${command}` });
    assert.deepEqual([receipt.status, receipt.local.agent, receipt.local.command], ['consumed', 'claude', command]);
  }
  assert.deepEqual([native.snapshot('terminal').events.length, f.fake.inputs.length], [before, 0]);
  await assert.rejects(native.send('terminal', 'not-this-session', { clientMessageId: 'q-old', text: '/cost' }), Error, 'an old binding cannot ask');
});

test('/usage tells the quota windows and the notice the SDK reported', async t => {
  const f = fixture(t), session = f.session();
  await session.start(); await session.send({ clientMessageId: 'one', text: 'first' }); await settle();
  f.fake.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.9, resetsAt: 2000000000 } }); await settle();
  const windows = (await session.send({ clientMessageId: 'u1', text: '/usage' })).local;
  assert.deepEqual(windows.limits, [{ id: 'five_hour', usedPercent: 90, resetsAtMs: 2000000000000 }]);
  assert.equal(windows.notice, null);
});
