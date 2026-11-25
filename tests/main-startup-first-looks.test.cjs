const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { createCodexLocator } = require('../electron/features/codex-runtime/locator.cjs');
const { fakeFiles } = require('./helpers/claude-files.cjs');
const { createTerminalLifecycle } = require('../electron/app/terminal-lifecycle.cjs');

const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const ast = ts.createSourceFile('main.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

function fixture() {
  let found = null;
  const defer = Promise.withResolvers.bind(Promise);
  const claude = defer(), codex = defer(), timeout = defer(), subscribed = new Set();
  // Promise.all asks each first look, synchronously, to say when it is done: the spy records who was asked.
  for (const [name, look] of [['claude', claude], ['codex', codex]]) {
    const then = look.promise.then;
    look.promise.then = function (...handlers) { subscribed.add(name); return then.apply(this, handlers); };
  }
  const lifecycle = createTerminalLifecycle({ claudeFirst: claude.promise, codexFirst: codex.promise,
    claudeLocator: { peek: () => null }, codexLocator: { peek: () => found } });
  return {
    claude, codex, timeout, subscribed,
    // The Codex search ends: the locator then answers peek().
    codexFound: file => { found = { file, path: file }; codex.resolve(); },
    // What a terminal restored once the gate opens is told.
    restored: async () => { await lifecycle.firstLooksSettled(() => timeout.promise); const env = {}; lifecycle.setTerminalExecutables({ kind: 'local' }, env); return env; },
  };
}

test('a restored terminal waits for the Codex first look as well as the Claude Code one', async () => {
  const h = fixture(), restored = h.restored();
  assert.deepEqual([...h.subscribed].sort(), ['claude', 'codex'], 'the restore is held for both first looks, not the Claude Code one alone');
  h.claude.resolve();
  h.codexFound('D:\npm\codex.ps1');
  assert.equal((await restored).AGENTRIX_CODEX_EXECUTABLE, 'D:\npm\codex.ps1');
});

test('a first look that outlasts the three seconds does not hold the restore back', async () => {
  const h = fixture(), restored = h.restored();
  h.claude.resolve(); h.timeout.resolve();
  assert.equal((await restored).AGENTRIX_CODEX_EXECUTABLE, undefined, 'nothing found yet, nothing told');
});

test("a restored terminal is told the Codex found when its --version check outlasts the three seconds", async () => {
  // Main's own gate and injection over a real locator whose check is still running when the three seconds are up.
  const exe = 'D:\\Tools\\codex.exe';
  let started;
  const checking = new Promise(resolve => { started = resolve; });
  const codexLocator = createCodexLocator({ files: fakeFiles({ [exe]: { size: 1000 } }), probe: (_file, _args, _options, done) => started(done), storedPath: async () => null });
  const codexFirst = codexLocator.refresh({ env: { PATH: 'D:\\Tools' }, platform: 'win32', arch: 'x64' });
  const lifecycle = createTerminalLifecycle({ claudeFirst: Promise.resolve(), codexFirst, codexLocator, claudeLocator: { peek: () => null } });
  const answer = await checking;
  await lifecycle.firstLooksSettled(() => Promise.resolve());
  const env = {};
  lifecycle.setTerminalExecutables({ kind: 'local' }, env);
  assert.equal(env.AGENTRIX_CODEX_EXECUTABLE, exe);
  answer(null, 'codex-cli 0.170.0');
  assert.equal((await codexFirst).version, '0.170.0');
});

test('main starts both first looks and the restore waits through firstLooksSettled', () => {
  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.push(node.expression.text);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const restoreAt = calls.indexOf('restoreTerminals');
  assert.ok(calls.includes('checkCodex') && calls.indexOf('checkCodex') < restoreAt);
  assert.equal(calls[restoreAt - 1], 'firstLooksSettled');
});
