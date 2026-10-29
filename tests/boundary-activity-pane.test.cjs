// Guards for electron/features/agents/BOUNDARY.md (Activity pane) that no behaviour test covers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

// Using a plan reset is costly and the owner decides it in Codex itself; completion belongs to the rounds, not to a button.
test('the pane never acts on its own: one /usage after the countdown, read-only account calls, no completion or editor controls', () => {
  const pane = read('src/features/agents/ActivityPane.tsx');
  assert.equal(pane.match(/\bsendToAgent\(/g).length, 1, 'one place types into the agent');
  assert.equal(pane.match(/new CustomEvent\('agentrix:command'/g).length, 1, 'one command event');
  assert.match(pane, /const command = '\/usage';/, 'and what it types is /usage');
  assert.deepEqual(pane.match(/\brun\(\)/g), ['run()'], 'which only the countdown starts');
  assert.match(pane, /if \(count === 0\) \{[^}]*void run\(\);/, 'when it reaches zero');
  assert.doesNotMatch(pane, /window\.agentrix\b|\bipcRenderer\b/, 'the pane calls no main-process action');
  for (const file of ['src/features/agents/ActivityPane.tsx', 'src/features/agents/ResetCountdown.tsx'])
    assert.doesNotMatch(read(file), /vs ?code|code\.cmd|openInEditor|markComplete|mark-complete|完成项目|标记完成/i, `${file} has no manual completion or editor launch control`);
  // Codex's stdio client sends only the handshake and the rate-limit read; Claude's usage is one GET.
  const codex = read('electron/features/agents/codex-account-usage.cjs');
  assert.deepEqual([...new Set([...codex.matchAll(/method: '([^']+)'/g)].map(match => match[1]))].sort(), ['account/rateLimits/read', 'initialize', 'initialized']);
  const claude = read('electron/features/agents/claude-account-usage.cjs');
  assert.deepEqual([...claude.matchAll(/\bfetch\(([^,]+), \{ method: '([A-Z]+)'/g)].map(match => match.slice(1)), [['USAGE_URL', 'GET']]);
  assert.doesNotMatch(claude, /writeFile|oauth\/token|refresh_token/, 'never renews or writes credentials');
});
