const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { rendererLoader } = require('./helpers/hook-harness.cjs');
const { stringUnion } = require('./helpers/source-structure.cjs');
const { createTerminalLifecycle } = require('../electron/app/terminal-lifecycle.cjs');
const { VIAS } = require('../electron/features/claude-runtime/locator.cjs');

// Two guards on the Claude Code locator that no behaviour test would notice breaking: the list of ways it was found must
// be the same in main, the shared types and the words the settings show, and an SSH project's terminal is never told a
// file of this computer.
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('every way Claude Code can be found is in the locator, the shared type and the words, and nowhere else', () => {
  const typed = stringUnion('src/shared/types.ts', 'ClaudeVia');
  const { VIA_WORDS } = rendererLoader({ './i18n': { t: text => text } })('src/features/native-session/native-words.ts');
  const worded = Object.keys(VIA_WORDS);
  const sorted = list => [...list].sort();
  assert.deepEqual(sorted(typed), sorted(VIAS), 'types.ts ClaudeVia and the locator VIAS');
  assert.deepEqual(sorted(worded), sorted(VIAS), 'native-words VIA_WORDS and the locator VIAS');
  assert.equal(new Set(VIAS).size, VIAS.length, 'no way is listed twice');
});

test("an SSH project's terminal is never told the Claude Code file of this computer, and a local one is told the terminal's", () => {
  const run = (project, peek = () => ({ terminal: { path: '/usr/local/bin/claude', file: '/opt/claude' },
    native: { path: '/opt/other', file: '/opt/other' } })) => {
    const env = {};
    createTerminalLifecycle({ claudeLocator: { peek }, codexLocator: { peek: () => null } }).setTerminalExecutables(project, env);
    return env.AGENTRIX_CLAUDE_EXECUTABLE;
  };
  assert.equal(run({ kind: 'ssh' }), undefined, 'an SSH project runs the server’s own');
  assert.equal(run({ kind: 'local' }), '/usr/local/bin/claude', 'a local one runs the terminal’s file, not the native path’s');
  assert.equal(run({ kind: 'local' }, () => null), undefined, 'nothing found, nothing told');
});
