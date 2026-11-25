const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');
const tree = ts.createSourceFile('main.cjs', main, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
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
    if (name === 'writeBootstrap') assert.deepEqual(imports.get(specifier), Object.keys(exports));
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
