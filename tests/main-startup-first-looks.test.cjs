const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { createCodexLocator } = require('../electron/features/codex-runtime/locator.cjs');
const { fakeFiles } = require('./helpers/claude-files.cjs');

// Runs main.cjs's own firstLooksSettled and the lines that tell a terminal where Codex is, against fake first looks.
const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const ast = ts.createSourceFile('main.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const gate = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'firstLooksSettled').getText(ast);
const start = source.indexOf('const codexPath ='), end = source.indexOf('env.AGENTRIX_CODEX_EXECUTABLE = codexPath;');
assert.ok(start > 0 && end > start, 'the injection in startTerminal is found');
const injection = source.slice(start, source.indexOf('\n', end));

function fixture() {
  let found = null;
  // The promises belong to the context's realm, as main's own do, so Promise.all asks them directly.
  const context = vm.createContext({ project: { kind: 'local' }, codexLocator: { peek: () => found } });
  const defer = vm.runInContext('() => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }', context);
  const claude = defer(), codex = defer(), timeout = defer(), subscribed = new Set();
  // Promise.all asks each first look, synchronously, to say when it is done: the spy records who was asked.
  for (const [name, look] of [['claude', claude], ['codex', codex]]) {
    const then = look.promise.then;
    look.promise.then = function (...handlers) { subscribed.add(name); return then.apply(this, handlers); };
  }
  Object.assign(context, { claudeFirst: claude.promise, codexFirst: codex.promise });
  vm.runInContext(gate, context);
  return {
    claude, codex, timeout, subscribed,
    // The Codex search ends: the locator then answers peek().
    codexFound: file => { found = { file, path: file }; codex.resolve(); },
    // What a terminal restored once the gate opens is told.
    restored: async () => { await context.firstLooksSettled(() => timeout.promise); const env = {}; context.env = env; vm.runInContext(injection, context); return env; },
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
  const context = vm.createContext({ project: { kind: 'local' }, codexLocator, claudeFirst: Promise.resolve(), codexFirst });
  vm.runInContext(gate, context);
  const answer = await checking;
  await context.firstLooksSettled(() => Promise.resolve());
  context.env = {};
  vm.runInContext(injection, context);
  assert.equal(context.env.AGENTRIX_CODEX_EXECUTABLE, exe);
  answer(null, 'codex-cli 0.170.0');
  assert.equal((await codexFirst).version, '0.170.0');
});

test('main starts both first looks and the restore waits through firstLooksSettled', () => {
  assert.match(source, /codexFirst = checkCodex\('refresh'\)/);
  assert.match(source, /Promise\.all\(\[claudeFirst, codexFirst\]\)/);
  assert.match(source, /await firstLooksSettled\(\);\s*restoreTerminals\(/);
});
