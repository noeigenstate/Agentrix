const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');
const modules = {
  'electron/features/terminal-events/claude-activity.cjs': 'createClaudeActivity',
  'electron/features/terminal-events/bootstrap-file.cjs': 'writeBootstrap',
  'electron/features/terminal/switch-host.cjs': 'createSwitchHost',
  'electron/features/native-session/host-inputs.cjs': 'createHostInputs',
  'electron/features/agents/dispatch-intake.cjs': 'createDispatchIntake',
};

test('main.cjs only wires the terminal activity, bootstrap, switch host, host inputs and dispatch intake modules', () => {
  for (const [file, name] of Object.entries(modules)) {
    const specifier = `./${path.posix.relative('electron', file)}`;
    assert.match(main, new RegExp(`const \\{ ${name} \\} = require\\('${specifier.replaceAll('.', '\\.')}'\\);`), `main requires ${file}`);
  }
  assert.match(main, /Object\.assign\(host, createClaudeActivity\(host\), createSwitchHost\(host\), createHostInputs\(host\), createDispatchIntake\(host\)\);/,
    'each factory gets the app shell and its functions join it');

  // No function, of any nesting, is declared in main under a name the modules define, and none of their state is.
  const carved = new Set(['observeDispatchAccount', 'dispatchAccounts']);
  for (const [file, name] of Object.entries(modules)) {
    const exports = require(path.join(root, file));
    for (const key of Object.keys(name === 'writeBootstrap' ? exports : exports[name]({}))) carved.add(key);
  }
  const declared = [], tree = ts.createSourceFile('main.cjs', main, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  (function visit(node) {
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name && ts.isIdentifier(node.name) && carved.has(node.name.text)) declared.push(node.name.text);
    if (ts.isPropertyAssignment(node) && carved.has(node.name.getText(tree)) && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) declared.push(node.name.getText(tree));
    ts.forEachChild(node, visit);
  })(tree);
  assert.deepEqual(declared, [], 'the carved functions live only in their modules');

  // What the carved regions did is nowhere else in main: writing a bootstrap file, the dispatch-* intake and its account
  // reports, and the native environment's Codex home.
  assert.doesNotMatch(main, /pipeName|0o600/, 'only writeBootstrap writes a bootstrap file');
  assert.doesNotMatch(main, /'dispatch-(?:account|start|routing|rate|end|receipt)'|agents:usage-changed|acceptDispatch\(/, 'only the dispatch intake takes dispatch events');
  assert.doesNotMatch(main, /CODEX_HOME = launch/, 'only nativeEnvironment sets a native session\'s Codex home');
});
