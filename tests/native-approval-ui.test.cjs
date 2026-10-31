const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { NativeApprovals } = require('../electron/features/terminal/native-approvals.cjs');
const { CodexProtocol, ClaudeProtocol } = require('../electron/features/terminal/native-protocol.cjs');
const { renderToStaticMarkup } = require('react-dom/server');

const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : React.isValidElement(node) ? [node, ...nodes(node.props.children)] : [];
function loadComponent(filename) {
  const slots = []; let cursor = 0;
  const hooks = {
    useState(value) { const index = cursor++; if (!(index in slots)) slots[index] = value; return [slots[index], next => slots[index] = next]; },
    useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; },
  };
  const file = path.join(__dirname, '..', filename), mod = new Module(file, module);
  mod.filename = file; mod.paths = Module._nodeModulePaths(path.dirname(file));
  const original = mod.require.bind(mod); mod.require = name => name === 'react' ? hooks : name === './NativeQuestionCard' ? { NativeQuestionCard: () => null } : original(name);
  mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, file);
  return props => { cursor = 0; return mod.exports.NativeApprovalCard(props); };
}
function fixture(t, provider = 'codex') {
  const before = global.window, writes = [], errors = [], calls = [];
  const binding = { provider, terminalId: 'terminal', sessionId: 'generation', projectId: 'project' };
  const registry = new NativeApprovals(binding), protocol = provider === 'codex' ? new CodexProtocol(registry) : new ClaudeProtocol(registry);
  const add = (id, params = {}) => {
    protocol.server(provider === 'codex'
      ? { id, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId: 'same-item', command: 'same text', ...params } }
      : { type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'same-tool', input: { command: 'same text' }, ...params } });
    return registry.list().at(-1);
  };
  global.window = { agentrix: { writeTerminal: () => assert.fail('native UI attempted PTY fallback'), writeApproval: () => assert.fail('legacy approval fallback'),
    async answerNativeApproval(id, answer) { calls.push([id, answer]); try { return { ok: true, value: registry.answer(binding, answer, value => writes.push(value)) }; } catch (error) { return { ok: false, error: error.message }; } },
  } };
  t.after(() => { global.window = before; registry.close(); });
  const render = loadComponent('src/features/reading/NativeApprovalCard.tsx');
  return { registry, protocol, add, writes, errors, calls, render: request => render({ request, onError: message => errors.push(message) }) };
}

test('native UI sends exact backend token and supported decision once, without parser or PTY', async t => {
  const h = fixture(t), request = h.add(1), root = h.render(request), click = nodes(root).find(node => node.type === 'button').props.onClick;
  assert.equal(root.props['data-approval-mode'], 'native'); await Promise.all([click(), click()]);
  assert.deepEqual(h.calls, [['terminal', { token: request.token, decision: 'accept' }]]);
  assert.deepEqual(h.writes, [{ id: 1, result: { decision: 'accept' } }]);
  assert.ok(nodes(h.render(request)).filter(node => node.type === 'button').every(node => node.props.disabled));
});

test('held native UI callback cannot answer a visually identical newer native request', async t => {
  const h = fixture(t), a = h.add('A'), click = nodes(h.render(a)).find(node => node.type === 'button').props.onClick;
  h.protocol.server({ method: 'serverRequest/resolved', params: { requestId: 'A', threadId: 'thread' } }); h.add('A-prime');
  await click(); await click(); assert.equal(h.calls.length, 1); assert.deepEqual(h.writes, []); assert.equal(h.errors.length, 1);
  assert.equal(h.registry.list()[0].requestId, 'A-prime');
});

test('native card renders canonical tool data as text and never sends replacement tool input', async t => {
  const h = fixture(t), a = h.add('typed-id'); a.params.command = '<img src=x onerror=attack()>\nquoted';
  const root = h.render(a), evidence = nodes(root).find(node => node.type === 'pre');
  assert.ok(evidence.props.children.includes('<img')); assert.equal(evidence.props.dangerouslySetInnerHTML, undefined);
  await nodes(root).find(node => node.type === 'button').props.onClick();
  assert.deepEqual(Object.keys(h.calls[0][1]).sort(), ['decision', 'token']);
});

for (const provider of ['codex', 'claude']) {
  test(`${provider} canonical command, complete input, reason and cwd precede collapsed transport details`, async t => {
    const h = fixture(t, provider), command = 'printf "<img src=x onerror=attack()> & quoted"', cwd = '/isolated/probe';
    const input = { command, nested: { exact: ['keep', 1, false] }, cwd };
    const params = provider === 'codex' ? { command, cwd, reason: 'Review this exact command' }
      : { input, cwd, decision_reason: 'Review this exact command' };
    const request = h.add('native-id', params), before = JSON.stringify(request.params), root = h.render(request), all = nodes(root);
    const details = all.find(node => node.type === 'details'), firstPre = all.find(node => node.type === 'pre');
    assert.equal(firstPre.props.children, command);
    assert.equal(details.props.open, undefined);
    const html = renderToStaticMarkup(root), detailsAt = html.indexOf('<details>');
    for (const text of ['&lt;img', cwd, 'Review this exact command']) assert.ok(html.indexOf(text) < detailsAt && html.includes(text));
    assert.ok(!html.includes('<img'));
    assert.ok(html.indexOf('native-id') > detailsAt);
    const click = all.find(node => node.type === 'button').props.onClick;
    click(); click(); await Promise.resolve();
    assert.equal(h.calls.length, 1); assert.equal(h.writes.length, 1);
    assert.deepEqual(Object.keys(h.calls[0][1]).sort(), ['decision', 'token']);
    if (provider === 'claude') assert.deepEqual(h.writes[0].response.response.updatedInput, input);
    else assert.deepEqual(h.writes[0], { id: 'native-id', result: { decision: 'accept' } });
    assert.equal(JSON.stringify(request.params), before);
  });

  test(`${provider} held callback leaves fresh identical request pending, fresh callback answers exactly once`, async t => {
    const h = fixture(t, provider), old = h.add('A');
    const held = nodes(h.render(old)).find(node => node.type === 'button').props.onClick;
    h.protocol.server(provider === 'codex' ? { method: 'serverRequest/resolved', params: { requestId: 'A', threadId: 'thread' } }
      : { type: 'control_cancel_request', request_id: 'A' });
    const fresh = h.add('A-prime'); held(); held(); await Promise.resolve();
    assert.equal(h.calls.length, 1); assert.deepEqual(h.writes, []);
    assert.equal(h.registry.list()[0].requestId, 'A-prime');
    const renderFresh = loadComponent('src/features/reading/NativeApprovalCard.tsx');
    const click = nodes(renderFresh({ request: fresh, onError: message => h.errors.push(message) })).find(node => node.type === 'button').props.onClick;
    click(); click(); await Promise.resolve();
    assert.equal(h.writes.length, 1); assert.equal(h.registry.list().length, 0);
    assert.equal(provider === 'codex' ? h.writes[0].id : h.writes[0].response.request_id, 'A-prime');
  });
}

test('canonical permission grant and file-change evidence are visible before transport details', t => {
  const h = fixture(t), permissions = { network: { enabled: true }, fileSystem: { write: ['/isolated/output'] } };
  h.protocol.server({ id: 12, method: 'item/permissions/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId: 'permission', permissions, reason: 'Write output', cwd: '/isolated' } });
  const root = h.render(h.registry.list()[0]), all = nodes(root);
  assert.equal(all.find(node => node.type === 'pre').props.children, JSON.stringify(permissions, null, 2));
  const html = renderToStaticMarkup(root); assert.ok(html.indexOf('/isolated/output') < html.indexOf('<details>'));
  const file = { ...h.registry.list()[0], method: 'item/fileChange/requestApproval', params: { threadId: 'thread', changes: { '/isolated/file': { diff: '+new text' } }, grantRoot: '/isolated' } };
  const fileHtml = renderToStaticMarkup(h.render(file)); assert.ok(fileHtml.indexOf('+new text') < fileHtml.indexOf('<details>'));
});
