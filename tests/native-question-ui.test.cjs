const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { hookHarness } = require('./helpers/hook-harness.cjs');
const { NativeApprovals } = require('../electron/features/terminal/native-approvals.cjs');
const { CodexProtocol, ClaudeProtocol } = require('../electron/features/terminal/native-protocol.cjs');
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : React.isValidElement(value) ? [value, ...nodes(value.props.children)] : [];

function fixture(t, request, provider = 'codex', options = {}) {
  const binding = { provider, projectId: 'project', terminalId: 'terminal', sessionId: 'generation' }, writes = [], calls = [], errors = [];
  const registry = new NativeApprovals(binding), protocol = provider === 'codex' ? new CodexProtocol(registry) : new ClaudeProtocol(registry);
  protocol.server(request);
  const prior = { window: global.window, document: global.document };
  const composer = { focus() { assert.fail('question stole composer focus'); } };
  global.document = { activeElement: composer };
  global.window = { agentrix: { writeTerminal: () => assert.fail('PTY keys'), writeApproval: () => assert.fail('screen permission'),
    answerNativeApproval: () => assert.fail('question used approval bridge'),
    async answerNativeQuestion(id, answer) {
      calls.push([id, answer]);
      try { if (options.fail) throw new Error('Question expired'); return { ok: true, value: registry.answer(binding, answer, message => writes.push(message), true) }; }
      catch (error) { return { ok: false, error: error.message }; }
    },
  } };
  const ui = hookHarness('src/features/reading/NativeQuestionCard.tsx', { './i18n': { t: value => value }, './native-question.css': {} });
  const record = registry.list()[0]; assert.ok(record?.question);
  const render = () => ui.render('NativeQuestionCard', { request: record, onError: value => errors.push(value) }).result;
  t.after(() => { ui.dispose(); registry.close(); global.window = prior.window; global.document = prior.document; });
  const elements = () => nodes(render());
  const submit = () => render().props.children.flat(Infinity).find(node => node?.type === 'form').props.onSubmit({ preventDefault() {}, stopPropagation() {} });
  return { render, elements, submit, registry, protocol, record, writes, calls, errors, composer };
}
const input = (questions, id = 1) => ({ id, method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', itemId: 'item', isBlocking: true, questions } });
const choice = () => ({ id: 'q', header: 'Choice', question: 'Choose <script> & a path', isOther: true,
  options: [{ label: 'One', description: 'First option' }, { label: 'Two', description: 'Second option' }] });

test('native question mounts without focus or writes; radio and free text edit locally until explicit submit', async t => {
  const h = fixture(t, input([choice()]));
  assert.equal(global.document.activeElement, h.composer); assert.equal(h.calls.length, 0);
  assert.ok(h.elements().every(node => !node.props.autoFocus));
  const html = renderToStaticMarkup(h.render()); assert.match(html, /Choose &lt;script&gt; &amp; a path/); assert.match(html, /必填/);
  assert.ok(h.elements().find(node => node.props.type === 'submit').props.disabled);
  h.elements().find(node => node.props.type === 'radio' && node.props.value === 'Two').props.onChange();
  assert.equal(h.calls.length, 0); assert.equal(h.elements().find(node => node.props.type === 'radio' && node.props.value === 'Two').props.checked, true);
  h.elements().find(node => node.props.type === 'text').props.onChange({ target: { value: 'An explicit custom answer' } });
  assert.equal(h.elements().filter(node => node.props.type === 'radio' && node.props.checked).length, 0);
  h.submit(); h.submit(); await Promise.resolve();
  assert.deepEqual(h.calls, [['terminal', { token: h.record.token, decision: 'submit', values: { q: 'An explicit custom answer' } }]]);
  assert.deepEqual(h.writes, [{ id: 1, result: { answers: { q: { answers: ['An explicit custom answer'] } } } }]);
});

test('Claude multi-select, preview text and Other are keyboard-native controls and submit once', async t => {
  const request = { type: 'control_request', request_id: 'ask', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [
    { question: 'Pick features', header: 'Features', multiSelect: true, options: [{ label: 'A', description: 'First', preview: '<img onerror="bad">' }, { label: 'B', description: 'Second' }] },
  ] } } };
  const h = fixture(t, request, 'claude');
  assert.match(renderToStaticMarkup(h.render()), /&lt;img onerror=/);
  h.elements().find(node => node.props.type === 'checkbox' && node.props.value === 'A').props.onChange();
  h.elements().find(node => node.props.type === 'checkbox' && node.props.value === 'B').props.onChange();
  h.elements().find(node => node.props.type === 'checkbox' && node.props.value === 'A').props.onChange();
  h.submit(); await Promise.resolve();
  assert.equal(h.writes[0].response.response.updatedInput.answers['Pick features'], 'B'); assert.equal(h.calls.length, 1);
});

test('typed form displays required flags and preserves false, numbers, defaults and optional omissions', async t => {
  const h = fixture(t, { id: 'form', method: 'mcpServer/elicitation/request', params: { threadId: 'thread', turnId: null, serverName: 'probe', message: 'A typed form', mode: 'form', requestedSchema: {
    type: 'object', properties: { enabled: { type: 'boolean', default: false }, count: { type: 'integer', minimum: 0, maximum: 5 }, note: { type: 'string' } }, required: ['enabled', 'count'],
  } } });
  const html = renderToStaticMarkup(h.render()); assert.match(html, /boolean/); assert.match(html, /integer/); assert.match(html, /选填/);
  assert.equal(h.elements().find(node => node.type === 'select').props.value, 'false');
  const numeric = h.elements().find(node => node.props.type === 'number'); assert.equal(numeric.props.step, 1); assert.equal(numeric.props.min, 0);
  numeric.props.onChange({ target: { value: '0' } }); h.submit(); await Promise.resolve();
  assert.deepEqual(h.writes[0].result, { action: 'accept', content: { enabled: false, count: 0 } });
});

test('secret free text uses a password input and is not exposed as a value elsewhere', t => {
  const h = fixture(t, input([{ id: 'secret', header: 'Secret', question: 'Local secret', isSecret: true }]));
  assert.equal(h.elements().filter(node => node.props.type === 'password').length, 1);
  assert.equal(h.elements().filter(node => node.type === 'pre').length, 0);
});

test('cancel has button semantics, never submits, and error responses cannot be retried', async t => {
  const h = fixture(t, input([choice()]), 'codex', { fail: true });
  const cancel = h.elements().find(node => node.type === 'button' && node.props.children === '取消'); assert.equal(cancel.props.type, 'button');
  cancel.props.onClick(); cancel.props.onClick(); await Promise.resolve();
  assert.deepEqual(h.calls, [['terminal', { token: h.record.token, decision: 'cancel' }]]); assert.equal(h.writes.length, 0); assert.deepEqual(h.errors, ['Question expired']);
  assert.ok(h.elements().filter(node => node.type === 'button').every(node => node.props.disabled));
});

test('a held question callback cannot answer a visually identical newer native request', async t => {
  const h = fixture(t, input([choice()])); const cancel = h.elements().find(node => node.type === 'button' && node.props.children === '取消').props.onClick;
  h.protocol.server({ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 1 } }); h.protocol.server(input([choice()], 2));
  cancel(); await Promise.resolve(); assert.equal(h.writes.length, 0); assert.equal(h.registry.list()[0].requestId, 2);
});

test('unsupported managed forms offer only explicit decline/cancel and no terminal action or editable fields', async t => {
  const h = fixture(t, { type: 'control_request', request_id: 'unknown-form', request: { subtype: 'elicitation', mode: 'form', mcp_server_name: 'probe', message: 'Nested form', requested_schema: { type: 'object', properties: { nested: { type: 'object' } } } } }, 'claude');
  assert.equal(h.elements().filter(node => ['input', 'select', 'textarea'].includes(node.type)).length, 0);
  assert.equal(h.elements().filter(node => node.type === 'button').length, 2); assert.match(renderToStaticMarkup(h.render()), /此表单暂不支持/);
  h.elements().find(node => node.type === 'button' && node.props.children === '拒绝').props.onClick(); await Promise.resolve();
  assert.deepEqual(h.writes[0].response.response, { action: 'decline' });
});

test('approval entry routes question records to their card without changing the reading-view import boundary', () => {
  const ui = hookHarness('src/features/reading/NativeApprovalCard.tsx', { './NativeQuestionCard': { NativeQuestionCard: function Question() {} } });
  const request = { params: {}, decisions: ['cancel'], question: { title: 'Question', fields: [] } };
  const root = ui.render('NativeApprovalCard', { request, onError() {} }).result;
  assert.equal(root.type.name, 'Question'); assert.equal(root.props.request, request); ui.dispose();
  const css = fs.readFileSync(path.join(__dirname, '../src/features/reading/native-question.css'), 'utf8');
  assert.match(css, /:focus-visible/); assert.match(css, /min-height: 32px/);
});
