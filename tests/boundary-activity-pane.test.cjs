const { syntax, nodes } = require('./helpers/source-syntax.cjs');
// Guards for electron/features/agents/BOUNDARY.md (Activity pane) that no behaviour test covers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { elements } = require('./helpers/renderer-fixtures.cjs');
const { hookHarness } = require('./helpers/hook-harness.cjs');
const { appView } = require('./helpers/app-view.cjs');
const { explorerView } = require('./helpers/explorer-view.cjs');
const { quotaView } = require('./helpers/quota-view.cjs');
const { identifiers, sourceNodes } = require('./helpers/source-structure.cjs');

const splitControls = ['openSplit', 'toggleSplit'];
const terminalWrites = ['writeTerminal', 'writeApproval', 'answerTerminal', 'resizeTerminal', 'startTerminal', 'closeTerminal', 'restartTerminal', 'sendToAgent'];
const filesIn = folder => fs.readdirSync(path.join(__dirname, '..', folder), { recursive: true })
  .map(name => path.posix.join(folder, name.replaceAll('\\', '/')))
  .filter(name => name.endsWith('.ts') || name.endsWith('.tsx'));
const member = (node, receiver) => ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === receiver;
const bridgeMembers = (file, receiver) => sourceNodes(file, node => member(node, receiver)).map(node => node.name.text);

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

// The pane only observes. Owner-authorized automatic resets are admitted by a
// separate main-process action, never by rendering a quota bar.
test('the pane never acts on its own: one /usage after the countdown, read-only account calls, no completion or editor controls', t => {
  const view = quotaView(t);
  view.render();
  assert.deepEqual(view.commands, []);
  view.row().props.onClick();
  view.render();
  for (let seconds = 0; seconds < 9; seconds++) view.tick();
  assert.deepEqual(view.commands, []);
  view.countdown().props.onCancel();
  view.render();
  view.tick();
  assert.deepEqual(view.sends, []);
  view.row().props.onClick();
  view.render();
  for (let seconds = 0; seconds < 10; seconds++) view.tick();
  assert.deepEqual(view.commands.map(event => [event.type, event.detail, event.cancelable]), [
    ['agentrix:command', { terminalId: 'terminal', text: '/usage' }, true],
  ]);
  assert.deepEqual(view.sends, [['terminal', 'session', 'codex', '/usage']]);
  for (const name of ['ActivityPane', 'ResetQuota', 'ResetCountdown']) {
    const file = 'src/features/agents/' + name + '.tsx';
    assert.deepEqual(identifiers(file, ['openInEditor', 'markComplete', 'agentrix', 'ipcRenderer']), []);
    const forbidden = ['vs code', 'vscode', 'code.cmd', 'mark-complete', '完成项目', '标记完成'];
    const labels = sourceNodes(file, node => ts.isStringLiteralLike(node) || ts.isJsxText(node)).map(node => node.text.toLowerCase());
    assert.ok(labels.every(label => forbidden.every(word => !label.includes(word))), file);
  }
});

test('account modules read usage without changing credentials, and only the owner action can consume a reset', () => {
  const codex = syntax('electron/features/agents/codex-account-usage.cjs');
  const [readAccount] = nodes(codex, node => ts.isFunctionDeclaration(node) && node.name?.text === 'readCodexAccount');
  const calls = (root, name) => nodes(root, node => ts.isCallExpression(node) && node.expression.getText() === name);
  const records = calls(readAccount, 'write').map(({ arguments: [input] }) =>
    Object.fromEntries(input.properties.map(prop => [prop.name.text, prop.initializer])));
  assert.deepEqual(records.map(value => value.method.text).sort(), ['account/rateLimits/read', 'account/read', 'initialize', 'initialized']);
  const read = records.find(value => value.method.text === 'account/read');
  const [refresh] = read.params.properties.filter(prop => prop.name.text === 'refreshToken');
  assert.equal(refresh.initializer.kind, ts.SyntaxKind.FalseKeyword);
  const [consume] = nodes(codex, node => ts.isFunctionDeclaration(node) && node.name?.text === 'consumeCodexResetCredit');
  const requests = calls(codex, 'rpc.request').filter(node => node.arguments[0]?.text === 'account/rateLimitResetCredit/consume');
  assert.equal(requests.length, 1);
  assert.ok(calls(consume, 'rpc.request').includes(requests[0]));
  const claude = syntax('electron/features/agents/claude-account-usage.cjs');
  assert.deepEqual(calls(claude, 'fetch').map(({ arguments: [url, request] }) =>
    [url.text, request.properties.find(prop => prop.name.text === 'method').initializer.text]), [['USAGE_URL', 'GET']]);
  const credentialWriters = nodes(claude, node =>
    (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && /writeFile|oauth\/token|refresh_token/.test(node.text));
  assert.deepEqual(credentialWriters.map(node => node.text), []);
});

// A sub-agent's view is the owner's to open and its conversation only reads: nothing opens one by itself, nothing in it writes to a terminal,
// and the owner's word for the agent leaves through two main-process calls only.
test('a sub-agent view opens only on the owner’s click on a row, reads the sub-agent’s record and speaks to it through the main process only', () => {
  const callers = filesIn('src').filter(file => sourceNodes(file, node =>
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) && splitControls.includes(node.expression.text)).length).sort();
  assert.deepEqual(callers, ['src/features/agents/AgentCalls.tsx', 'src/features/agents/subagent-splits.ts']);
  const pane = 'src/features/agents/AgentCalls.tsx';
  const calls = sourceNodes(pane, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'toggleSplit');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(node => ts.isArrowFunction(node.parent) && ts.isJsxExpression(node.parent.parent)
    && node.parent.parent.parent.name.text === 'onClick'));

  const files = ['SubagentPane.tsx', 'SubagentInput.tsx', 'subagent-splits.ts', 'BackgroundPane.tsx'].map(name => 'src/features/agents/' + name);
  for (const file of files) assert.deepEqual(identifiers(file, [...terminalWrites, 'readClipboard', 'workerTerminalKeys', 'copy']), []);
  assert.deepEqual([...new Set(files.flatMap(file => bridgeMembers(file, 'bridge')))].sort(), ['onSubagentFeed', 'subagentFeed']);
  assert.deepEqual(files.flatMap(file => sourceNodes(file, node => ts.isPropertyAccessExpression(node)
    && member(node.expression, 'window') && node.expression.name.text === 'agentrix').map(node => node.name.text)).sort(), ['interveneAgent', 'stopAgent']);

  const worker = 'src/features/agents/WorkerTerminal.tsx';
  assert.deepEqual([...new Set(bridgeMembers(worker, 'bridge'))].sort(),
    ['attachWorkerTerminal', 'copy', 'detachWorkerTerminal', 'onWorkerTerminalData', 'resizeWorkerTerminal', 'workerTerminalKeys']);
  assert.deepEqual(identifiers(worker, [...terminalWrites, 'readClipboard', 'interveneAgent', 'stopAgent', 'paste']), []);
  for (const [index, tags] of [[0, []], [1, ['textarea']], [3, []]]) {
    const fields = sourceNodes(files[index], node => (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      && ['textarea', 'input'].includes(node.tagName.text));
    assert.deepEqual(fields.map(node => node.tagName.text), tags);
    assert.deepEqual(identifiers(files[index], ['contentEditable']), []);
  }
});

// The API card shows state and changes nothing; a word for a sub-agent goes to the worker, so the relay into the planner's input is gone.
test('the API usage card only reads the main process, and the parent relay can no longer type into a terminal', () => {
  const card = 'src/features/agents/ApiUsage.tsx';
  assert.deepEqual([...new Set(bridgeMembers(card, 'bridge'))], ['usage']);
  assert.deepEqual(identifiers(card, [...terminalWrites, 'setSettings', 'keySave', 'keyClear', 'answer', 'interrupt', 'send', 'start']), []);
  assert.equal(fs.existsSync(path.join(__dirname, '../src/features/agents/parent-relay.ts')), false);
  const ApiUsage = () => null;
  const view = hookHarness('src/features/agents/ActivityPane.tsx', {
    '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './i18n': { t: text => text },
    './terminal-screen.ts': { useScreen: () => null, cliStateFor: () => ({ working: false }) }, './ApiUsage': { ApiUsage }, './RoutingKeyCard': { RoutingKeyCard: () => null }, './SeatsHost': {},
  });
  const terminal = { id: 'terminal', cliActive: true, agent: 'codex' };
  const installations = { agy: { installed: false } };
  const nodes = elements(view.render('ActivityPane', { terminal, projectId: 'project', installations }).result);
  assert.deepEqual(nodes.find(node => node.type === ApiUsage).props, { terminal, projectId: 'project', installations });
});

// The left bar's Agent tab shows the called models without the files module knowing the agents module: the node and the running count come from the agents module and the app only passes them.
test('the files module imports nothing from the agents module: the Agent tab gets its list as a node and a count from the app', t => {
  const imports = file => sourceNodes(file, ts.isImportDeclaration).map(node => node.moduleSpecifier.text);
  assert.deepEqual(filesIn('src/features/files').flatMap(imports).filter(name => name.startsWith('../agents/')), []);
  assert.deepEqual(identifiers('src/features/agents/AgentSidebar.tsx', ['agentrix', ...splitControls, 'writeTerminal']), []);
  const app = appView(t);
  const sidebar = app.render().find(node => node.type === app.AgentSidebar);
  const panel = require('react').createElement('div', { id: 'agent-panel' });
  const explorer = sidebar.props.children({ panel, running: 3, background: 2 });
  assert.equal(explorer.type, app.ProjectExplorer);
  assert.deepEqual([explorer.props.project, explorer.props.agentPanel, explorer.props.agentRunning, explorer.props.agentBackground],
    [app.project, panel, 3, 2]);
  const view = explorerView(t);
  const rows = () => view.render({ agentPanel: panel, agentRunning: 3, agentBackground: 2 });
  const button = label => rows().find(node => node.type === 'button' && node.props['aria-label'] === label);
  const treeEnabled = () => rows().find(node => node.props.projectId === 'p' && 'enabled' in node.props).props.enabled;
  assert.equal(button('Agent').props['aria-pressed'], true);
  assert.equal(rows().find(node => node.props.className === 'explorer-agent').props.children, panel);
  assert.equal(treeEnabled(), false);
  button('资源管理器').props.onClick();
  assert.equal(treeEnabled(), true);
  button('Agent').props.onClick();
  assert.deepEqual(view.focus, [['p', false], ['p', false]]);
  assert.equal(treeEnabled(), false);
});
