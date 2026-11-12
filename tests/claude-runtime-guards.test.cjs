const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { VIAS } = require('../electron/features/claude-runtime/locator.cjs');

// Two guards on the Claude Code locator that no behaviour test would notice breaking: the list of ways it was found must
// be the same in main, the shared types and the words the settings show, and an SSH project's terminal is never told a
// file of this computer.
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('every way Claude Code can be found is in the locator, the shared type and the words, and nowhere else', () => {
  const type = /export type ClaudeVia = ([^;]+);/.exec(read('src/shared/types.ts'));
  assert.ok(type, 'ClaudeVia is a union of string literals');
  const typed = [...type[1].matchAll(/'([a-z-]+)'/g)].map(match => match[1]);
  const block = /const VIA_WORDS: Record<string, string> = \{([\s\S]*?)\n\};/.exec(read('src/features/native-session/native-words.ts'));
  assert.ok(block, 'VIA_WORDS is an object literal');
  const worded = [...block[1].matchAll(/(?:^|[\s,{])(?:'([a-z-]+)'|([a-z]+)):\s*'/g)].map(match => match[1] ?? match[2]);
  const sorted = list => [...list].sort();
  assert.deepEqual(sorted(typed), sorted(VIAS), 'types.ts ClaudeVia and the locator VIAS');
  assert.deepEqual(sorted(worded), sorted(VIAS), 'native-words VIA_WORDS and the locator VIAS');
  assert.equal(new Set(VIAS).size, VIAS.length, 'no way is listed twice');
});

test("an SSH project's terminal is never told the Claude Code file of this computer, and a local one is told the terminal's", () => {
  const source = read('electron/main.cjs');
  assert.equal((source.match(/AGENTRIX_CLAUDE_EXECUTABLE\s*=/g) ?? []).length, 1, 'one place sets it');
  const start = source.indexOf('const claudeFile ='), end = source.indexOf('env.AGENTRIX_CLAUDE_EXECUTABLE = claudeFile;');
  assert.ok(start > 0 && end > start, 'the injection in startTerminal is found');
  const code = source.slice(start, source.indexOf('\n', end));
  const run = project => {
    // The terminal is told the path it was found at (a link stays a link, so an update behind it is followed).
    const env = {}, context = vm.createContext({ project, env, claudeLocator: { peek: () => ({
      terminal: { path: '/usr/local/bin/claude', file: '/opt/claude' }, native: { path: '/opt/other', file: '/opt/other' } }) } });
    vm.runInContext(code, context);
    return env.AGENTRIX_CLAUDE_EXECUTABLE;
  };
  assert.equal(run({ kind: 'ssh' }), undefined, 'an SSH project runs the server’s own');
  assert.equal(run({ kind: 'local' }), '/usr/local/bin/claude', 'a local one runs the terminal’s file, not the native path’s');
  const none = vm.createContext({ project: { kind: 'local' }, env: {}, claudeLocator: { peek: () => null } });
  vm.runInContext(code, none);
  assert.equal(none.env.AGENTRIX_CLAUDE_EXECUTABLE, undefined, 'nothing found, nothing told');
});
