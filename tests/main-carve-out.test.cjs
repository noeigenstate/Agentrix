const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ts, syntax, nodes } = require('./helpers/source-syntax.cjs');

const root = path.join(__dirname, '..');
const tree = syntax('electron/main.cjs');
const modules = {
  'electron/app/terminal-lifecycle.cjs': 'createTerminalLifecycle',
  'electron/features/terminal-events/shell-events.cjs': 'createShellEvents',
  'electron/features/terminal-events/claude-activity.cjs': 'createClaudeActivity',
  'electron/features/terminal-events/bootstrap-file.cjs': 'writeBootstrap',
  'electron/features/terminal/switch-host.cjs': 'createSwitchHost',
  'electron/features/native-session/host.cjs': 'createNativeHost',
  'electron/features/native-session/host-inputs.cjs': 'createHostInputs',
  'electron/features/agents/dispatch-intake.cjs': 'createDispatchIntake',
};

function hostFactories() {
  const imports = new Map(), factories = new Set();
  for (const statement of tree.statements) {
    if (ts.isVariableStatement(statement)) for (const { name, initializer } of statement.declarationList.declarations) {
      if (!ts.isObjectBindingPattern(name) || !initializer || !ts.isCallExpression(initializer)) continue;
      const [specifier] = initializer.arguments;
      if (ts.isIdentifier(initializer.expression) && initializer.expression.text === 'require' && specifier && ts.isStringLiteral(specifier)) {
        imports.set(specifier.text, name.elements.map(({ name, propertyName }) => (propertyName || name).text));
      }
    }
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const { expression, arguments: [target, ...values] } = statement.expression;
    if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== 'assign' ||
        !ts.isIdentifier(expression.expression) || expression.expression.text !== 'Object' ||
        !target || !ts.isIdentifier(target) || target.text !== 'host') continue;
    for (const value of values) if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) &&
        value.arguments.length === 1 && ts.isIdentifier(value.arguments[0]) && value.arguments[0].text === 'host') {
      factories.add(value.expression.text);
    }
  }
  return { imports, factories };
}

test('main.cjs only wires the terminal activity, bootstrap, switch host, host inputs and dispatch intake modules', () => {
  const { imports, factories } = hostFactories();
  const carved = new Set(['observeDispatchAccount', 'dispatchAccounts']);
  for (const [file, name] of Object.entries(modules)) {
    const specifier = './' + path.posix.relative('electron', file), exports = require(path.join(root, file));
    if (name === 'writeBootstrap') {
      assert.deepEqual(imports.get(specifier), Object.keys(exports).filter(key => key !== 'readBootstrap'));
    }
    else {
      assert.ok(imports.get(specifier)?.includes(name), 'main requires ' + file);
      assert.ok(factories.has(name), 'main gives the host to ' + name);
    }
    for (const key of Object.keys(name === 'writeBootstrap' ? exports : exports[name]({}))) carved.add(key);
  }

  const declared = [], misplaced = [];
  const dispatch = new Set(['dispatch-account', 'dispatch-start', 'dispatch-routing', 'dispatch-rate', 'dispatch-end', 'dispatch-receipt', 'agents:usage-changed']);
  (function visit(node) {
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name && ts.isIdentifier(node.name) && carved.has(node.name.text)) declared.push(node.name.text);
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && carved.has(node.name.text)) {
      const fn = node.initializer;
      const forward = ts.isArrowFunction(fn) && ts.isCallExpression(fn.body) && ts.isIdentifier(fn.body.expression) &&
        fn.body.expression.text === node.name.text && fn.parameters.length === fn.body.arguments.length &&
        fn.parameters.every(({ name }, i) => ts.isIdentifier(name) && ts.isIdentifier(fn.body.arguments[i]) && name.text === fn.body.arguments[i].text);
      if (!forward && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) declared.push(node.name.text);
    }
    if (ts.isIdentifier(node) && (node.text === 'pipeName' || node.text === 'acceptDispatch') ||
        ts.isNumericLiteral(node) && node.getText(tree) === '0o600' ||
        ts.isStringLiteral(node) && dispatch.has(node.text)) misplaced.push(node.getText(tree));
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'CODEX_HOME' &&
        ts.isPropertyAccessExpression(node.right) && ts.isIdentifier(node.right.expression) && node.right.expression.text === 'launch') {
      misplaced.push('native Codex home');
    }
    ts.forEachChild(node, visit);
  })(tree);
  assert.deepEqual(declared, [], 'the carved functions live only in their modules');
  assert.deepEqual(misplaced, [], 'bootstrap, dispatch intake and native environment stay in their own modules');
});

test('main wires workspace creation before overriding the native theme', () => {
  const workspace = nodes(tree, node => ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'WorkspaceStore')[0];
  const [location, options] = workspace.arguments;
  assert.ok(location);
  assert.ok(options.properties.some(property => ts.isPropertyAssignment(property) && property.name.text === 'systemTheme' &&
    ts.isCallExpression(property.initializer) && property.initializer.expression.text === 'systemTheme'));
  const [open] = nodes(tree, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'openMainWindow');
  assert.ok(open && workspace.pos < open.pos);
});

test('main assembly has no sender for intervention relay messages', () => {
  for (const file of ['electron/main.cjs', 'electron/app/application-ipc.cjs']) {
    const forbidden = nodes(syntax(file), node => ts.isIdentifier(node) && node.text === 'sendParentPrompt' ||
      ts.isStringLiteral(node) && node.text === 'agents:relay');
    assert.deepEqual(forbidden, [], file);
  }
});

test('window startup hands the application indicator callback to the lifecycle registrar', () => {
  const [registration] = nodes(syntax('electron/app/window-startup.cjs'),
    node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'registerWindowLifecycle');
  assert.ok(registration.arguments[0].properties.some(property =>
    ts.isShorthandPropertyAssignment(property) && property.name.text === 'updateIndicators'));
});

test('main starts both first looks and the restore waits through firstLooksSettled', () => {
  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.push(node.expression.text);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  const restoreAt = calls.indexOf('restoreTerminals');
  assert.ok(calls.includes('checkCodex') && calls.indexOf('checkCodex') < restoreAt);
  assert.equal(calls[restoreAt - 1], 'firstLooksSettled');
});

test('startup and restoration do not request an account read for background projects', () => {
  const ready = nodes(tree, node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'whenReady')[0];
  assert.ok(ready, 'main registers the ready callback');
  const callback = ready.parent.parent.arguments[0];
  const accountRequests = new Set(['openProject', 'checkProjectAccount']);
  assert.deepEqual(nodes(callback, node => ts.isIdentifier(node) && accountRequests.has(node.text)), []);
});

test('main lets the skills store own the model catalog and its provider probes', () => {
  const directLoads = nodes(tree, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
    node.expression.text === 'require' && ts.isStringLiteral(node.arguments[0]));
  const internal = new Set(['./features/skills/model-catalog.cjs', './features/skills/model-probe.cjs']);
  assert.deepEqual(directLoads.filter(node => internal.has(node.arguments[0].text)), []);
});

test('main supplies the workspace registrar to the application IPC assembly', () => {
  const [registration] = nodes(tree, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
    node.expression.text === 'registerApplicationIpc');
  assert.ok(registration.arguments[0].properties.some(property =>
    ts.isShorthandPropertyAssignment(property) && property.name.text === 'registerWorkspaceIpc'));
});
