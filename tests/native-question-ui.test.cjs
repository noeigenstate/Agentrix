const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { hookHarness } = require('./helpers/hook-harness.cjs');
const { NativeApprovals } = require('../electron/features/terminal/native-approvals.cjs');
const { CodexProtocol, ClaudeProtocol } = require('../electron/features/terminal/native-protocol.cjs');
const { validateValues } = require('../electron/features/terminal/native-questions.cjs');
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
      try { if (options.fail && !(options.once && calls.length > 1)) throw new Error(options.fail === true ? 'Question expired' : options.fail); return { ok: true, value: registry.answer(binding, answer, message => writes.push(message), true) }; }
      catch (error) { return { ok: false, error: error.message }; }
    },
  } };
  const ui = hookHarness('src/features/reading/NativeQuestionCard.tsx', { './i18n': { t: (value, values) => value.replace(/\{(\w+)\}/g, (match, key) => values && key in values ? values[key] : match) }, './native-question.css': {} });
  const record = registry.list()[0]; assert.ok(record?.question);
  const render = () => ui.render('NativeQuestionCard', { request: record, onOpen: options.onOpen, onError: value => errors.push(value) }).result;
  t.after(() => { ui.dispose(); registry.close(); global.window = prior.window; global.document = prior.document; });
  const elements = () => nodes(render());
  const form = () => elements().find(node => node.type === 'form');
  const submit = () => form().props.onSubmit({ preventDefault() {}, stopPropagation() {} });
  const enter = tagName => form().props.onKeyDown({ key: 'Enter', nativeEvent: {}, target: { tagName } });
  const text = node => renderToStaticMarkup(node).replace(/<[^>]+>/g, '');
  const reasons = () => elements().filter(node => node.props.className === 'native-question-reason').map(text);
  return { render, elements, form, submit, enter, text, reasons, registry, protocol, record, writes, calls, errors, composer };
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
  const html = renderToStaticMarkup(h.render()); assert.match(html, /是或否/); assert.match(html, /整数/); assert.match(html, /选填/); assert.doesNotMatch(html, /boolean|integer|string/);
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
  assert.match(css, /min-height: 32px/); assert.doesNotMatch(css, /outline/, 'focus rings come from the shared --focus-ring rule');
});

const form = (properties, required = []) => ({ id: 'form', method: 'mcpServer/elicitation/request', params: { threadId: 'thread', turnId: null, serverName: 'deploy-helper', message: 'Configure the deployment', mode: 'form',
  requestedSchema: { type: 'object', properties, required } } });
const classes = node => String(node.props.className || '').split(' ');
const within = (root, node) => nodes(root.props.children).includes(node);

test('the head and body show people-facing text, never the tool or method names', t => {
  const codex = fixture(t, input([choice()])), html = renderToStaticMarkup(codex.render());
  assert.match(html, /Codex 需要你回答/); assert.doesNotMatch(html, /request_user_input|AskUserQuestion|codex</);
  assert.equal(codex.elements().filter(node => classes(node).includes('native-question-message')).length, 0);
  const claude = fixture(t, { type: 'control_request', request_id: 'ask', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [
    { question: 'Pick one', header: 'One', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }] } } }, 'claude');
  const claudeHtml = renderToStaticMarkup(claude.render());
  assert.match(claudeHtml, /Claude 需要你回答/); assert.doesNotMatch(claudeHtml, /AskUserQuestion|claude</);
  const mcpHtml = renderToStaticMarkup(fixture(t, form({ note: { type: 'string' } })).render());
  assert.match(mcpHtml, /deploy-helper 需要你回答/); assert.match(mcpHtml, /<p class="native-question-message">Configure the deployment<\/p>/);
  const unsupported = fixture(t, { type: 'control_request', request_id: 'u', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Bad' }] } } }, 'claude');
  const unsupportedHtml = renderToStaticMarkup(unsupported.render());
  assert.doesNotMatch(unsupportedHtml, /AskUserQuestion/); assert.match(unsupportedHtml, /此表单暂不支持/);
});

test('the actions and the status line share one footer outside the scrolling body, with the screen card action classes', async t => {
  const h = fixture(t, form({ a: { type: 'string' } }), 'codex', { fail: true, onOpen() {} });
  const parts = () => { const all = h.elements(); return { all, body: all.find(node => classes(node).includes('native-question-body')), footer: all.find(node => classes(node).includes('native-question-footer')) }; };
  const { all, body, footer } = parts(), buttons = all.filter(node => node.type === 'button');
  assert.equal(buttons.length, 4);
  for (const button of buttons) { assert.ok(within(footer, button)); assert.ok(!within(body, button)); }
  assert.deepEqual(buttons.filter(node => classes(node).includes('button')).map(node => classes(node).join(' ')), ['button primary small', 'button small', 'button small']);
  assert.ok(nodes(footer.props.children).some(node => classes(node).includes('reading-question-actions')));
  const css = fs.readFileSync(path.join(__dirname, '../src/features/reading/native-question.css'), 'utf8');
  assert.match(css, /\.native-question-body \{[^}]*overflow: auto/); assert.match(css, /\.reading-choice\.native-question \{[^}]*overflow: hidden/); assert.doesNotMatch(css, /\.native-question-footer \{[^}]*overflow/);
  assert.equal(h.elements().filter(node => node.props.role === 'status').length, 0);
  buttons.find(node => node.props.children === '拒绝').props.onClick(); await Promise.resolve();
  const after = parts(), status = after.all.filter(node => node.props.role === 'status');
  assert.equal(status.length, 1); assert.match(h.text(status[0]), /此操作已失效/);
  assert.ok(within(after.footer, status[0]) && !within(after.body, status[0]));
});

test('an unfinished form says why: submit stays disabled, reasons show once touched or after Enter, and Enter submits once valid', async t => {
  const h = fixture(t, form({ name: { type: 'string', minLength: 3 }, size: { type: 'integer', minimum: 1, maximum: 5 }, pick: { type: 'string', enum: ['x', 'y'] } }, ['name', 'size', 'pick']));
  assert.equal(h.form().props.noValidate, true);
  const submit = () => h.elements().find(node => node.props.type === 'submit'), status = () => h.elements().find(node => classes(node).includes('native-question-status'));
  const field = index => h.elements().find(node => node.props.id?.endsWith(`-${index}`));
  assert.ok(submit().props.disabled); assert.match(h.text(status()), /还有 3 项未完成/); assert.deepEqual(h.reasons(), []);
  assert.equal(submit().props['aria-describedby'], status().props.id);
  h.enter('INPUT'); assert.deepEqual(h.reasons(), ['请填写', '请填写', '请选择']); assert.equal(h.calls.length, 0);
  field(0).props.onChange({ target: { value: 'ab' } }); field(1).props.onChange({ target: { value: '9' } });
  assert.deepEqual(h.reasons(), ['至少 3 个字符', '不能大于 5', '请选择']);
  field(1).props.onChange({ target: { value: '0' } }); assert.equal(h.reasons()[1], '不能小于 1');
  assert.equal(h.elements().filter(node => node.props['aria-invalid']).length, 2);
  field(0).props.onChange({ target: { value: 'abc' } }); field(1).props.onChange({ target: { value: '3' } });
  h.elements().find(node => node.props.type === 'radio' && node.props.value === 'y').props.onChange();
  assert.equal(submit().props.disabled, false); assert.equal(status(), undefined); assert.deepEqual(h.reasons(), []);
  h.submit(); await Promise.resolve();
  assert.deepEqual(h.calls[0][1].values, { name: 'abc', size: 3, pick: 'y' });
});

test('submit is a no-op while any reason shows, so an out-of-range value never reaches main', async t => {
  const h = fixture(t, form({ size: { type: 'integer', minimum: 1, maximum: 5 } }, ['size']));
  h.elements().find(node => node.props.type === 'number').props.onChange({ target: { value: '99' } });
  assert.ok(h.elements().find(node => node.props.type === 'submit').props.disabled); h.submit(); await Promise.resolve();
  assert.equal(h.calls.length, 0); assert.deepEqual(h.reasons(), ['不能大于 5']);
});

test('the reasons agree with main on every format, bound and count, so the card cannot enable what main refuses', t => {
  const cases = {
    email: ['a@b', 'a@', 'a b@c', '@b'], uri: ['https://x.y', 'x', 'mailto:a@b', '://'], date: ['2026-01-31', '2026-02-31', '2026-1-1', '2026-13-01', '2026-02-29', '2024-02-29'],
    stamp: ['2026-01-31T09:30:00Z', '2026-01-31T24:00:00Z', '2026-01-31 09:30:00Z', '2026-01-31T09:30:00+02:00', '2026-01-31T09:30:60Z', '2026-01-31T09:30:00.5z', '2026-01-31T09:30Z'],
    short: ['a', 'ab', 'abcd', 'abcde', '😀😀', '😀😀😀😀😀'], count: ['0', '1', '5', '6', '1.5', '-3'], ratio: ['-0.1', '0', '0.5', '1', '1.01'],
  };
  const h = fixture(t, form({
    email: { type: 'string', format: 'email' }, uri: { type: 'string', format: 'uri' }, date: { type: 'string', format: 'date' }, stamp: { type: 'string', format: 'date-time' },
    short: { type: 'string', minLength: 2, maxLength: 4 }, count: { type: 'integer', minimum: 1, maximum: 5 }, ratio: { type: 'number', minimum: 0, maximum: 1 },
    tags: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'string', enum: ['a', 'b', 'c'] } },
  }));
  const submit = () => h.elements().find(node => node.props.type === 'submit'), accepted = values => { try { validateValues(h.record.question, values); return true; } catch { return false; } };
  const input = id => h.elements().find(node => node.props.id?.endsWith(`-${Object.keys(cases).indexOf(id)}`));
  for (const [id, raws] of Object.entries(cases)) for (const raw of raws) {
    input(id).props.onChange({ target: { value: raw } });
    assert.equal(!submit().props.disabled, accepted({ [id]: ['count', 'ratio'].includes(id) ? Number(raw) : raw }), `${id}=${JSON.stringify(raw)}`);
    input(id).props.onChange({ target: { value: '' } });
    assert.equal(submit().props.disabled, false, `${id} cleared is an omission`);
  }
  const pick = value => h.elements().find(node => node.props.type === 'checkbox' && node.props.value === value).props.onChange();
  for (const [picks, valid] of [[['a'], false], [['a', 'b'], true], [['a', 'b', 'c'], false]]) {
    for (const value of picks) pick(value);
    assert.equal(accepted({ tags: picks }), valid, picks.join()); assert.equal(!submit().props.disabled, valid, picks.join());
    for (const value of picks) pick(value);
  }
});

test('a refused value leaves the request live: inline error, every action usable, then it can be sent again', async t => {
  const h = fixture(t, form({ size: { type: 'integer', minimum: 1, maximum: 5 } }, ['size']), 'codex', { fail: 'Invalid native question fields', once: true });
  h.elements().find(node => node.props.type === 'number').props.onChange({ target: { value: '3' } });
  h.submit(); await Promise.resolve();
  const buttons = () => h.elements().filter(node => node.type === 'button' || node.props.type === 'submit');
  assert.deepEqual(h.errors, []); assert.ok(buttons().every(node => !node.props.disabled)); assert.equal(h.elements().filter(node => node.props.role === 'status').length, 0);
  const alert = () => h.elements().filter(node => node.props.role === 'alert');
  assert.equal(alert().length, 1); assert.match(h.text(alert()[0]), /回答未被接受/); assert.doesNotMatch(h.text(alert()[0]), /Invalid native question/);
  h.elements().find(node => node.props.type === 'number').props.onChange({ target: { value: '4' } }); assert.equal(alert().length, 0);
  h.submit(); await Promise.resolve();
  assert.equal(h.calls.length, 2); assert.deepEqual(h.writes[0].result, { action: 'accept', content: { size: 4 } });
  const decline = buttons().find(node => node.props.children === '拒绝'); assert.ok(decline);
});

test('a refusal of the values keeps decline and cancel working; any other error is the dead state', async t => {
  const refused = fixture(t, form({ note: { type: 'string' } }), 'codex', { fail: 'Invalid native question fields' });
  refused.submit(); await Promise.resolve();
  refused.elements().find(node => node.type === 'button' && node.props.children === '取消').props.onClick(); await Promise.resolve();
  assert.deepEqual(refused.calls.map(([, answer]) => answer.decision), ['submit', 'cancel']);
  const gone = fixture(t, form({ note: { type: 'string' } }), 'codex', { fail: 'Native request is no longer available' });
  gone.submit(); await Promise.resolve();
  assert.deepEqual(gone.errors, ['Native request is no longer available']); assert.ok(gone.elements().filter(node => node.type === 'button').every(node => node.props.disabled));
  assert.equal(gone.elements().filter(node => node.props.role === 'alert').length, 0); assert.equal(gone.elements().filter(node => node.props.role === 'status').length, 1);
  gone.submit(); await Promise.resolve(); assert.equal(gone.calls.length, 1);
});
