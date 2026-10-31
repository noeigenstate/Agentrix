const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NativeApprovals, MAX_BYTES } = require('../electron/features/terminal/native-approvals.cjs');
const { CodexProtocol, ClaudeProtocol } = require('../electron/features/terminal/native-protocol.cjs');
const { registerNativeIpc } = require('../electron/features/terminal/native-ipc.cjs');
const { createNativeSession } = require('../electron/features/terminal/native-session.cjs');
const { formQuestion, validateValues } = require('../electron/features/terminal/native-questions.cjs');
const { timeoutScale } = require('../scripts/wait.mjs');

// Codex 0.166.0: app-server generate-json-schema --experimental (fresh CODEX_HOME).
// Claude 2.1.314: native-approval-probe.cjs claude --run-installed --questions, loopback model only.
const copy = value => JSON.parse(JSON.stringify(value));
const form = () => ({ type: 'object', properties: {
  name: { type: 'string', minLength: 2, maxLength: 12 }, count: { type: 'integer', minimum: 1, maximum: 5 },
  ratio: { type: 'number', minimum: 0, maximum: 1 }, enabled: { type: 'boolean', default: false },
  plan: { type: 'string', enum: ['basic', 'pro'], enumNames: ['Basic plan', 'Pro plan'] },
  features: { type: 'array', items: { anyOf: [{ const: 'a', title: 'Feature A' }, { const: 'b', title: 'Feature B' }] }, minItems: 1, maxItems: 2 },
}, required: ['name', 'count', 'ratio', 'enabled', 'plan', 'features'] });
const content = () => ({ name: 'Local', count: 2, ratio: 0.5, enabled: false, plan: 'basic', features: ['a'] });
const question = () => ({ id: 'q', header: 'Probe', question: 'Choose a local option', options: [{ label: 'One', description: 'First' }, { label: 'Two', description: 'Second' }], isOther: false, isSecret: false });
function message(kind, id = 1) {
  if (kind === 'codex-question') return { id, method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', itemId: 'item', isBlocking: true, questions: [question()] } };
  if (kind === 'codex-form') return { id, method: 'mcpServer/elicitation/request', params: { threadId: 'thread', turnId: null, serverName: 'probe', mode: 'form', message: 'Local form', requestedSchema: form() } };
  if (kind === 'claude-question') return { type: 'control_request', request_id: String(id), request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'native-tool', requires_user_interaction: true,
    input: { questions: [{ question: 'Choose a local option', header: 'Probe', options: question().options, multiSelect: true }], metadata: { source: 'test' } } } };
  return { type: 'control_request', request_id: String(id), request: { subtype: 'elicitation', mcp_server_name: 'probe', message: 'Local form', mode: 'form', requested_schema: form() } };
}
const valid = kind => kind.endsWith('form') ? content() : kind.startsWith('claude') ? { 'Choose a local option': ['One', 'Two'] } : { q: 'One' };
async function waitFor(terminal, check) {
  const end = Date.now() + 5000 * timeoutScale;
  while (!check()) { if (terminal.error || Date.now() > end) throw new Error(terminal.error || 'Native question fixture timeout'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
function harness(t, kind, options = {}) {
  const binding = { provider: kind.split('-')[0], projectId: 'project', terminalId: 'terminal', sessionId: 'generation' }, writes = [], failures = [];
  const registry = new NativeApprovals(binding, { write: value => writes.push(value), fail: reason => failures.push(reason), ...options });
  const protocol = binding.provider === 'codex' ? new CodexProtocol(registry) : new ClaudeProtocol(registry);
  t.after(() => registry.close());
  const add = (m = message(kind)) => { protocol.server(m); return registry.list().at(-1); };
  const answer = (r, values = valid(kind), decision = 'submit', extra = {}) => registry.answer(binding, { token: r.token, decision, ...(decision === 'submit' ? { values } : {}), ...extra }, value => writes.push(value), true);
  return { binding, writes, failures, registry, protocol, add, answer };
}

test('Codex real request_user_input shape keeps native ids and maps declared choices and secret free text', t => {
  const h = harness(t, 'codex-question'), m = message('codex-question', 'native:1');
  m.params.questions.push({ id: 'secret', header: 'Private', question: 'Local secret', options: null, isSecret: true });
  const r = h.add(m); assert.equal(r.question.fields[1].secret, true);
  h.answer(r, { q: 'Two', secret: 'synthetic-only' });
  assert.deepEqual(h.writes, [{ id: 'native:1', result: { answers: { q: { answers: ['Two'] }, secret: { answers: ['synthetic-only'] } } } }]);
});

test('MCP flat form covers declared primitives, titled single/multi enums and exact false values', t => {
  const h = harness(t, 'codex-form'), m = message('codex-form');
  m.params.requestedSchema.properties.tier = { type: 'string', oneOf: [{ const: 'x', title: 'Tier X' }] };
  const r = h.add(m); assert.equal(r.question.fields.find(field => field.id === 'plan').options[0].label, 'Basic plan');
  h.answer(r, { ...content(), tier: 'x' });
  assert.deepEqual(h.writes[0], { id: 1, result: { action: 'accept', content: { ...content(), tier: 'x' } } });
});

test('Claude AskUserQuestion adds only validated answers to the original input and supports its automatic Other', t => {
  const h = harness(t, 'claude-question'), m = message('claude-question'), original = copy(m.request.input), r = h.add(m);
  m.request.input.metadata.source = 'mutated';
  h.answer(r, { 'Choose a local option': ['Two', 'A custom local answer'] });
  assert.deepEqual(h.writes[0], { type: 'control_response', response: { subtype: 'success', request_id: '1', response: { behavior: 'allow', updatedInput: {
    ...original, answers: { 'Choose a local option': 'Two, A custom local answer' },
  } } } });
});

test('Claude elicitation uses SDK control response, not tool approval or terminal writes', t => {
  const h = harness(t, 'claude-form'), r = h.add(); h.answer(r);
  assert.deepEqual(h.writes[0], { type: 'control_response', response: { subtype: 'success', request_id: '1', response: { action: 'accept', content: content() } } });
});

for (const kind of ['codex-question', 'codex-form', 'claude-question', 'claude-form']) {
  test(`${kind}: validation refusals identify correctable answers and keep the same token live`, t => {
    const h = harness(t, kind), r = h.add(), answer = { token: r.token, decision: 'submit', values: valid(kind) };
    const circular = {}; circular.self = circular;
    for (const invalid of [null, [], { token: r.token, decision: 'submit' }, { ...answer, extra: true },
      { token: r.token, decision: 'unknown' }, { ...answer, values: {} }, { ...answer, values: { undeclared: true } },
      { ...answer, values: 'x'.repeat(MAX_BYTES) }, { ...answer, values: 1n }, { ...answer, values: circular }]) {
      assert.throws(() => h.registry.answer(h.binding, invalid, value => h.writes.push(value), true), { name: 'Error', message: /^Invalid native question/ });
      assert.equal(h.registry.list()[0].token, r.token); assert.equal(h.registry.closed, false); assert.deepEqual(h.writes, []);
    }
    assert.throws(() => h.answer(r, valid(kind), 'submit', { token: 'unknown' }), { message: 'Native approval expired or unsupported' });
    h.answer(r); assert.equal(h.writes.length, 1);
    assert.throws(() => h.answer(r), { message: 'Native approval expired or unsupported' });
  });

  test(`${kind}: typed capabilities reject forged fields, cross bindings, wrong endpoints and repeated answers`, t => {
    const h = harness(t, kind), r = h.add();
    for (const field of Object.keys(h.binding)) assert.throws(() => h.registry.answer({ ...h.binding, [field]: 'other' }, { token: r.token, decision: 'submit', values: valid(kind) }, () => assert.fail('cross binding'), true));
    for (const extra of [{ token: 'forged' }, { requestId: r.requestId }, { updatedInput: {} }, { question: {} }, { decision: 'allow' }]) assert.throws(() => h.answer(r, valid(kind), 'submit', extra));
    assert.throws(() => h.registry.answer(h.binding, { token: r.token, decision: 'cancel' }, () => assert.fail('approval endpoint accepted a question')));
    for (const values of [null, [], {}, { ...valid(kind), undeclared: 'injected' }, Object.fromEntries(Object.keys(valid(kind)).map(key => [key, {}]))]) assert.throws(() => h.answer(r, values));
    assert.equal(h.writes.length, 0); h.answer(r); assert.equal(h.writes.length, 1); assert.throws(() => h.answer(r));
  });

  test(`${kind}: duplicates are idempotent, conflicts and completed id reuse fail closed`, t => {
    const h = harness(t, kind), m = message(kind), r = h.add(m); h.add(copy(m)); assert.equal(h.registry.list().length, 1);
    h.answer(r); h.add(m); assert.equal(h.registry.closed, true); assert.deepEqual(h.failures, ['native-id-reuse']);
    const other = harness(t, kind), original = message(kind); other.add(original);
    const changed = copy(original); if (changed.params) changed.params.extra = true; else changed.request.extra = true;
    other.add(changed); assert.equal(other.registry.closed, true);
  });

  test(`${kind}: expiry sends the card cancellation once and leaves the session and later requests live`, t => {
    let now = 0; const h = harness(t, kind, { ttl: 10, now: () => now }), r = h.add();
    now = 5; const next = h.add(message(kind, 2)); now = 10;
    h.registry.expire(); h.registry.expire();
    const manual = harness(t, kind); manual.answer(manual.add(), undefined, 'cancel');
    assert.deepEqual(h.writes, manual.writes); assert.deepEqual(h.failures, []); assert.equal(h.registry.closed, false);
    assert.throws(() => h.answer(r), { message: 'Native approval expired or unsupported' });
    assert.equal(h.registry.list()[0].token, next.token); h.answer(next); assert.equal(h.writes.length, 2);
    h.answer(h.add(message(kind, 3))); assert.equal(h.writes.length, 3);
    if (kind.startsWith('codex')) assert.equal(h.protocol.client({ id: r.requestId, result: {} }), false, 'a late TUI reply cannot write a second response');
  });

  test(`${kind}: cancellation, new generation and channel loss revoke held callbacks`, t => {
    const h = harness(t, kind), r = h.add(); h.answer(r, undefined, 'cancel');
    const fresh = harness(t, kind), next = fresh.add(); assert.throws(() => fresh.answer(r));
    fresh.protocol.server(kind.startsWith('codex') ? { method: 'serverRequest/resolved', params: { requestId: next.requestId, threadId: 'thread' } } : { type: 'control_cancel_request', request_id: next.requestId });
    assert.throws(() => fresh.answer(next)); const closed = fresh.add(message(kind, 2)); fresh.registry.close(); assert.throws(() => fresh.answer(closed));
    assert.equal(fresh.writes.length, 0);
  });

  test(`${kind}: cancellation is a single owned response with no invented answers`, t => {
    const h = harness(t, kind), r = h.add(); h.answer(r, undefined, 'cancel');
    assert.equal(h.writes.length, 1); assert.throws(() => h.answer(r));
    const wire = h.writes[0];
    if (kind === 'codex-question') assert.deepEqual(wire.result, { answers: {} });
    else if (kind === 'claude-question') { assert.equal(wire.response.response.behavior, 'deny'); assert.equal(wire.response.response.updatedInput, undefined); }
    else assert.deepEqual(kind.startsWith('codex') ? wire.result : wire.response.response, { action: 'cancel' });
    if (kind.endsWith('form')) {
      const next = h.add(message(kind, 2)); h.answer(next, undefined, 'decline');
      assert.deepEqual(kind.startsWith('codex') ? h.writes[1].result : h.writes[1].response.response, { action: 'decline' });
    }
  });

  test(`${kind}: write failure consumes first, closes concurrent capabilities and never retries`, t => {
    const h = harness(t, kind), r = h.add(), next = h.add(message(kind, 2)); let attempts = 0;
    assert.throws(() => h.registry.answer(h.binding, { token: r.token, decision: 'submit', values: valid(kind) }, () => { attempts++; throw new Error('owned pipe failed'); }, true));
    assert.equal(attempts, 1); assert.throws(() => h.answer(r)); assert.throws(() => h.answer(next)); assert.deepEqual(h.failures, ['response-write-failed']);
  });

  test(`${kind}: expiry write failure consumes first, closes the channel and never retries`, t => {
    let now = 0, attempts = 0;
    const h = harness(t, kind, { ttl: 10, now: () => now, write: () => { attempts++; throw new Error('owned pipe failed'); } });
    const r = h.add(); h.add(message(kind, 2)); now = 10;
    h.registry.expire(); h.registry.expire();
    assert.equal(attempts, 1); assert.equal(h.registry.closed, true); assert.deepEqual(h.failures, ['response-write-failed']);
    assert.throws(() => h.answer(r), { message: 'Native approval expired or unsupported' }); assert.deepEqual(h.writes, []);
  });
}

test('synthetic Claude elicitation without a string message stays live as a server-titled cancellation-only card', t => {
  for (const value of [undefined, null, 42, {}, []]) {
    const h = harness(t, 'claude-form'), m = message('claude-form');
    if (value === undefined) delete m.request.message; else m.request.message = value;
    const r = h.add(m);
    assert.equal(h.registry.closed, false); assert.deepEqual(h.failures, []);
    assert.deepEqual(r.question, { title: 'probe', fields: [], unsupported: true }); assert.deepEqual(r.decisions, ['decline', 'cancel']);
    assert.throws(() => h.answer(r), { message: /^Invalid native question/ }); h.answer(r, undefined, 'cancel');
    assert.deepEqual(h.writes, [{ type: 'control_response', response: { subtype: 'success', request_id: '1', response: { action: 'cancel' } } }]);
  }
});

test('Codex number 1 and string 1 stay distinct; TUI response wins or loses exactly once', t => {
  const h = harness(t, 'codex-question'), numeric = h.add(message('codex-question', 1)), string = h.add(message('codex-question', '1'));
  assert.equal(h.protocol.client({ id: 1, result: { answers: {} } }), true); assert.throws(() => h.answer(numeric));
  h.answer(string); assert.equal(h.writes[0].id, '1'); assert.equal(h.protocol.client({ id: '1', result: { answers: {} } }), false);
});

test('question fields cannot bypass enums, numeric bounds, required flags, lengths or multi selection limits', t => {
  const h = harness(t, 'codex-form'), r = h.add();
  for (const patch of [{ name: 'x' }, { name: 'x'.repeat(13) }, { count: 1.2 }, { count: '2' }, { count: 6 }, { ratio: -1 }, { ratio: Infinity }, { enabled: 'false' },
    { plan: 'outside' }, { features: ['outside'] }, { features: ['a', 'a'] }, { features: [] }, { features: 'a' }]) assert.throws(() => h.answer(r, { ...content(), ...patch }));
  const q = harness(t, 'codex-question'), choice = q.add(); assert.throws(() => q.answer(choice, { q: 'outside' }));
  const ownMessage = message('codex-question', 2); ownMessage.params.questions[0].isOther = true;
  q.answer(q.add(ownMessage), { q: 'Custom answer explicitly enabled' }); assert.equal(q.writes.length, 1);
});

test('form defaults and required mean the declared JSON types, including false, zero and empty values', () => {
  const schema = { type: 'object', properties: { s: { type: 'string', default: '' }, n: { type: 'integer', default: 0 }, b: { type: 'boolean', default: false }, a: { type: 'array', items: { type: 'string', enum: ['x'] }, default: [] } }, required: ['s', 'n', 'b', 'a'] };
  const q = formQuestion(schema, 'Empty defaults'); assert.ok(q);
  assert.deepEqual(validateValues(q, { s: '', n: 0, b: false, a: [] }), { s: '', n: 0, b: false, a: [] });
  assert.throws(() => validateValues(q, { s: '', n: 0, b: false }));
  schema.properties.n.default = '0'; assert.equal(formQuestion(schema, 'Bad default'), null);
});

test('formats are validated by main rather than trusted to HTML input controls', () => {
  const q = formQuestion({ type: 'object', properties: { email: { type: 'string', format: 'email' }, uri: { type: 'string', format: 'uri' }, date: { type: 'string', format: 'date' }, time: { type: 'string', format: 'date-time' } }, required: ['email', 'uri', 'date', 'time'] }, 'Formats');
  const values = { email: 'probe@example.com', uri: 'https://example.com', date: '2024-02-29', time: '2024-02-29T12:00:00Z' };
  assert.deepEqual(validateValues(q, values), values);
  for (const patch of [{ email: 'no' }, { uri: 'relative' }, { date: '2023-02-29' }, { time: '2024-01-01' }, { time: '2023-02-29T12:00:00Z' }, { time: '2024-01-01T24:00:00Z' }]) assert.throws(() => validateValues(q, { ...values, ...patch }));
});

test('unknown schemas remain in Codex TUI and become cancellation-only explanations in managed Claude', t => {
  for (const schema of [{ type: 'object', properties: { nested: { type: 'object', properties: {} } } },
    { ...form(), additionalProperties: true }, { ...form(), allOf: [] }, { type: 'object', properties: { x: { type: 'string', pattern: '^a' } } },
    { type: 'object', properties: { x: { type: 'number', minimum: 4, maximum: 1 } } }, { type: 'object', properties: {}, required: ['absent'] }]) {
    const codex = harness(t, 'codex-form'), cm = message('codex-form'); cm.params.requestedSchema = schema;
    assert.equal(codex.protocol.server(cm), true); assert.deepEqual(codex.registry.list(), []); assert.equal(codex.registry.closed, false);
    const claude = harness(t, 'claude-form'), sm = message('claude-form'); sm.request.requested_schema = schema;
    const r = claude.add(sm); assert.equal(r.question.unsupported, true); assert.deepEqual(r.decisions, ['decline', 'cancel']);
    assert.throws(() => claude.answer(r)); claude.answer(r, undefined, 'decline');
  }
});

test('URL and extension modes never create editable fields or automatically open a URL', t => {
  const c = harness(t, 'codex-form'), m = message('codex-form'); Object.assign(m.params, { mode: 'url', elicitationId: 'url-id', url: 'https://example.com' }); delete m.params.requestedSchema;
  assert.equal(c.protocol.server(m), true); assert.equal(c.registry.list().length, 0);
  const s = harness(t, 'claude-form'), cm = message('claude-form'); Object.assign(cm.request, { mode: 'url', url: 'https://example.com', elicitation_id: 'url-id' }); delete cm.request.requested_schema;
  const r = s.add(cm); assert.equal(r.question.unsupported, true); s.answer(r, undefined, 'cancel');
});

test('canonical field definitions cannot be mutated by the renderer or the originating fixture', t => {
  const h = harness(t, 'codex-form'), m = message('codex-form'), r = h.add(m);
  m.params.requestedSchema.properties.count.maximum = 99; r.question.fields.find(f => f.id === 'count').maximum = 99;
  r.question.fields.find(f => f.id === 'plan').options.push({ value: 'injected', label: 'Injected' });
  assert.throws(() => h.answer(r, { ...content(), count: 99 })); assert.throws(() => h.answer(r, { ...content(), plan: 'injected' })); h.answer(r);
});

test('native question IPC checks live local sessions, exact tokens and capabilities without PTY fallback', t => {
  const h = harness(t, 'codex-question'), r = h.add(), handles = {}; let session;
  registerNativeIpc({ handle: (key, fn) => handles[key] = fn, findProject: id => { if (id !== 'terminal') throw new Error('Unknown terminal'); }, getSession: () => session });
  const payload = { token: r.token, decision: 'submit', values: { q: 'One' } };
  for (const s of [null, {}, { native: {}, approvalRemote: true }, { native: {}, status: 'exited' }]) { session = s; assert.throws(() => handles['terminal:native-question']('terminal', payload)); }
  session = { native: { answerQuestion: answer => h.registry.answer(h.binding, answer, value => h.writes.push(value), true) }, status: 'running', write: () => assert.fail('PTY fallback') };
  assert.throws(() => handles['terminal:native-question']('other', payload));
  assert.throws(() => handles['terminal:native-question']('terminal', { ...payload, values: { q: 'outside' } }), { name: 'Error', message: /^Invalid native question/ });
  assert.equal(h.registry.list()[0].token, r.token); assert.equal(h.writes.length, 0);
  handles['terminal:native-question']('terminal', payload);
  assert.equal(h.writes.length, 1); assert.throws(() => handles['terminal:native-question']('terminal', payload));
});

test('owned Claude stdio carries a question, validated response and completion using a fake Node CLI', async t => {
  const code = `const r=require('node:readline').createInterface({input:process.stdin});r.on('line',line=>{const m=JSON.parse(line);const emit=v=>console.log(JSON.stringify(v));if(m.type==='control_request')emit({type:'control_response',response:{request_id:m.request_id,subtype:'success',response:{}}});if(m.type==='user')emit(${JSON.stringify(message('claude-question', 'cli-native-id'))});if(m.type==='control_response')emit({type:'result',received:m.response});});`;
  const events = [], binding = { provider: 'claude', projectId: 'fixture', terminalId: 'fixture', sessionId: 'fixture' };
  const terminal = createNativeSession({ binding, mode: 'claude-sdk', cwd: __dirname, env: {}, cli: { file: process.execPath, prefix: ['-e', code, '--'], node: true }, event: value => events.push(value) });
  t.after(() => terminal.kill());
  await waitFor(terminal, () => events.some(e => e.type === 'managed-ready')); terminal.prompt('Synthetic prompt'); await waitFor(terminal, () => terminal.registry.list().length > 0);
  const r = terminal.registry.list()[0]; terminal.answerQuestion({ token: r.token, decision: 'submit', values: valid('claude-question') });
  await waitFor(terminal, () => events.some(e => e.type === 'result'));
  assert.equal(events.find(e => e.type === 'result').received.request_id, 'cli-native-id'); assert.equal(terminal.registry.list().length, 0);
});

test('owned Claude stdio cancels an expired form and accepts the next prompt using a fake Node CLI', async t => {
  const code = `const r=require('node:readline').createInterface({input:process.stdin});let seq=0;r.on('line',line=>{const m=JSON.parse(line);const emit=v=>console.log(JSON.stringify(v));if(m.type==='control_request')emit({type:'control_response',response:{request_id:m.request_id,subtype:'success',response:{}}});if(m.type==='user')emit({...${JSON.stringify(message('claude-form'))},request_id:'cli-native-id-'+ ++seq});if(m.type==='control_response')emit({type:'result',received:m.response});});`;
  const events = [], binding = { provider: 'claude', projectId: 'fixture', terminalId: 'fixture', sessionId: 'fixture' };
  const terminal = createNativeSession({ binding, mode: 'claude-sdk', cwd: __dirname, env: {}, cli: { file: process.execPath, prefix: ['-e', code, '--'], node: true }, event: value => events.push(value) });
  t.after(() => terminal.kill());
  await waitFor(terminal, () => events.some(e => e.type === 'managed-ready')); terminal.prompt('Synthetic expiring form');
  await waitFor(terminal, () => terminal.registry.list().length > 0);
  const r = terminal.registry.list()[0], expires = terminal.registry.tokens.get(r.token).expires;
  terminal.registry.now = () => expires; terminal.registry.expire(); terminal.registry.expire();
  await waitFor(terminal, () => events.some(e => e.type === 'result'));
  assert.deepEqual(events.find(e => e.type === 'result').received, { subtype: 'success', request_id: 'cli-native-id-1', response: { action: 'cancel' } });
  assert.throws(() => terminal.answerQuestion({ token: r.token, decision: 'submit', values: content() }), { message: 'Native approval expired or unsupported' });
  terminal.prompt('Next synthetic prompt'); await waitFor(terminal, () => terminal.registry.list().length > 0);
  const next = terminal.registry.list()[0]; terminal.answerQuestion({ token: next.token, decision: 'submit', values: content() });
  await waitFor(terminal, () => events.filter(e => e.type === 'result').length === 2);
  assert.equal(terminal.registry.closed, false); assert.equal(terminal.error, undefined); assert.equal(terminal.registry.list().length, 0);
  assert.deepEqual(events.filter(e => e.type === 'result')[1].received, { subtype: 'success', request_id: 'cli-native-id-2', response: { action: 'accept', content: content() } });
});
