// G8: a test proves order and causality with events, injected clocks and fake processes. It never counts event-loop
// turns, spins on the clock, sleeps a fixed time, or asserts an elapsed-time bound. Violations that existed when this
// guard was written are frozen in tests/fixtures/test-hygiene-allow.json: the list can only shrink.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const allowFile = 'tests/fixtures/test-hygiene-allow.json';
const CLOCK = String.raw`(?:Date\.now|performance\.now|process\.hrtime)`;
// A sleep inside a polling loop (for or while on the same line) waits for a condition with a bound; it is not a stand-in.
const SLEEP = new RegExp(String.raw`\bsetTimeout\(\s*(?:resolve|res|r|done|ok|\(\)\s*=>\s*\w+\(\))\s*,\s*\d|\b(?:sleep|delay|pause)\(\s*\d|\bawait\s+(?:timers\.)?setTimeout\(\s*\d|\bAtomics\.wait\(`);
const RULES = {
  // A turn of the event loop is not a unit of causality: wait for the event itself.
  setImmediate: line => /\bsetImmediate\b/.test(line),
  // A loop that spins until the clock passes a time holds the thread for that long.
  'busy-loop': line => new RegExp(String.raw`\bwhile\s*\((?:[^()]|\(\))*${CLOCK}(?:[^()]|\(\))*\)\s*(?:;|\{\s*\})`).test(line),
  'fixed-sleep': line => SLEEP.test(line) && !/\b(?:for|while)\s*\(/.test(line),
  // Elapsed time depends on the machine; inject the clock and compare what it was told.
  'elapsed-bound': line => new RegExp(String.raw`\belapsed\w*\s*[<>]=?|\.elapsedMs\s*[<>]=?|\bassert\w*(?:\.\w+)?\([^\n]*${CLOCK}\(\)\s*-`).test(line),
};

const violationsIn = source => {
  const counts = {};
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
    for (const [rule, matches] of Object.entries(RULES)) if (matches(line)) counts[rule] = (counts[rule] || 0) + 1;
  }
  return counts;
};
const scanTests = () => fs.readdirSync(__dirname).filter(name => name.endsWith('.test.cjs') && name !== path.basename(__filename)).sort()
  .flatMap(name => Object.entries(violationsIn(fs.readFileSync(path.join(__dirname, name), 'utf8'))).map(([rule, count]) => ({ file: `tests/${name}`, rule, count })));
const key = ({ file, rule }) => `${file} ${rule}`;

test('the rules see each kind of violation and none of the allowed waits', () => {
  assert.deepEqual(violationsIn('await new Promise(resolve => setImmediate(resolve));'), { setImmediate: 1 });
  assert.deepEqual(violationsIn('const end = Date.now() + 60; while (Date.now() < end);'), { 'busy-loop': 1 });
  assert.deepEqual(violationsIn('await new Promise(resolve => setTimeout(resolve, 50)); await sleep(300);'), { 'fixed-sleep': 1 });
  assert.deepEqual(violationsIn('assert.ok(timedOut.elapsedMs >= 20); assert.ok(Date.now() - started < 500);'), { 'elapsed-bound': 1 });
  assert.deepEqual(violationsIn('for (let n = 0; n < 100 && !done(); n++) await new Promise(resolve => setTimeout(resolve, 2));'), {});
  assert.deepEqual(violationsIn('// await sleep(100)\nconst wait = ms => new Promise(resolve => setTimeout(resolve, ms));\nt.mock.timers.tick(3000);'), {});
});

// The most each file may have been allowed when this guard was written (1.5.0). The allowlist file holds the live counts
// and may only go down from here; raising an entry, or adding a file or rule, takes a visible change to this table.
const CEILING = {
  'about-channel.test.cjs': { setImmediate: 1 },
  'activity-usage-observation.test.cjs': { setImmediate: 1 },
  'agent-calls-liveness.test.cjs': { 'fixed-sleep': 2, setImmediate: 1 },
  'agent-runtime-settings.test.cjs': { setImmediate: 1 },
  'backend-activity.test.cjs': { 'fixed-sleep': 1 },
  'boundary-terminal.test.cjs': { setImmediate: 1 },
  'builtin-skills.test.cjs': { 'fixed-sleep': 1 },
  'claude-account-usage.test.cjs': { setImmediate: 1 },
  'claude-parity-real-cli.test.cjs': { 'fixed-sleep': 6 },
  'claude-sdk-connection.test.cjs': { 'busy-loop': 1, setImmediate: 2 },
  'claude-sdk-real-cli.test.cjs': { 'fixed-sleep': 5 },
  'claude-sdk-replay-tools.test.cjs': { setImmediate: 1 },
  'claude-sdk-rereview2.test.cjs': { setImmediate: 2 },
  'claude-sdk-review3.test.cjs': { setImmediate: 1 },
  'claude-sdk-review4.test.cjs': { setImmediate: 1 },
  'claude-sdk-runtime.test.cjs': { setImmediate: 2 },
  'claude-sdk-switch.test.cjs': { setImmediate: 7 },
  'claude-sdk-wire.test.cjs': { 'fixed-sleep': 1 },
  'claude-sessions.test.cjs': { setImmediate: 5 },
  'codex-account-usage-native.test.cjs': { setImmediate: 1 },
  'codex-account-usage.test.cjs': { setImmediate: 2 },
  'codex-activity.test.cjs': { 'elapsed-bound': 1, setImmediate: 1 },
  'codex-auto-reset-runtime.test.cjs': { 'fixed-sleep': 3 },
  'codex-only-main.test.cjs': { setImmediate: 1 },
  'codex-slash.test.cjs': { setImmediate: 2 },
  'completion-history.test.cjs': { setImmediate: 2 },
  'dashboard-ui.test.cjs': { 'fixed-sleep': 1, setImmediate: 1 },
  'dashboard-window.test.cjs': { setImmediate: 1 },
  'dispatch-codex-usage.test.cjs': { 'elapsed-bound': 1, 'fixed-sleep': 1 },
  'dispatch-control.test.cjs': { 'fixed-sleep': 1 },
  'dispatch-interventions.test.cjs': { 'fixed-sleep': 2 },
  'dispatch-team.test.cjs': { 'fixed-sleep': 2 },
  'dispatch.test.cjs': { 'elapsed-bound': 2, 'fixed-sleep': 1 },
  'file-cards.test.cjs': { 'fixed-sleep': 2 },
  'generated-images.test.cjs': { setImmediate: 1 },
  'lab-engine-window.test.cjs': { setImmediate: 5 },
  'lab-engine.test.cjs': { 'fixed-sleep': 1 },
  'lab-oss.test.cjs': { setImmediate: 2 },
  'lab-sandbox-win32.test.cjs': { 'fixed-sleep': 3, setImmediate: 1 },
  'lab-session.test.cjs': { 'elapsed-bound': 2 },
  'lab-ui.test.cjs': { 'fixed-sleep': 2 },
  'linux-integration.test.cjs': { 'fixed-sleep': 1 },
  'native-approvals.test.cjs': { 'fixed-sleep': 2 },
  'native-autocompact-claude.test.cjs': { 'fixed-sleep': 1 },
  'native-autocompact-codex.test.cjs': { 'fixed-sleep': 1 },
  'native-claude-panel.test.cjs': { setImmediate: 1 },
  'native-codex-status.test.cjs': { 'fixed-sleep': 1 },
  'native-commands-codex.test.cjs': { 'fixed-sleep': 1 },
  'native-commands-real-cli.test.cjs': { 'fixed-sleep': 1 },
  'native-commands.test.cjs': { setImmediate: 1 },
  'native-parity-backend.test.cjs': { setImmediate: 1 },
  'native-parity-review.test.cjs': { 'elapsed-bound': 1, 'fixed-sleep': 4 },
  'native-project-accounts.test.cjs': { setImmediate: 1 },
  'native-rate-real-cli.test.cjs': { 'fixed-sleep': 1 },
  'native-router-runtime.test.cjs': { setImmediate: 1 },
  'native-router-worker.test.cjs': { setImmediate: 1 },
  'native-session-ui.test.cjs': { 'fixed-sleep': 9, setImmediate: 2 },
  'native-switch-ipc.test.cjs': { setImmediate: 1 },
  'native-switch-long-thread.test.cjs': { setImmediate: 1 },
  'native-switch-main.test.cjs': { setImmediate: 2 },
  'native-switch-review.test.cjs': { 'fixed-sleep': 1, setImmediate: 1 },
  'native-switch-router.test.cjs': { setImmediate: 1 },
  'native-switch-runtime.test.cjs': { setImmediate: 1 },
  'native-switch-structured.test.cjs': { setImmediate: 1 },
  'native-worker-claude.test.cjs': { 'fixed-sleep': 1 },
  'native-worker-finish.test.cjs': { 'fixed-sleep': 1, setImmediate: 1 },
  'project-image-ui.test.cjs': { setImmediate: 1 },
  'project-reorder-release.test.cjs': { setImmediate: 1 },
  'r13-review2.test.cjs': { 'fixed-sleep': 1 },
  'reading-paths.test.cjs': { setImmediate: 4 },
  'reading-smoke-fixture.test.cjs': { 'fixed-sleep': 3 },
  'reading-ui.test.cjs': { setImmediate: 2 },
  'send-to-agent.test.cjs': { 'fixed-sleep': 1, setImmediate: 1 },
  'session-files.test.cjs': { 'fixed-sleep': 1 },
  'skills-settings.test.cjs': { setImmediate: 1 },
  'skills.test.cjs': { 'fixed-sleep': 3, setImmediate: 1 },
  'ssh-connection.test.cjs': { 'fixed-sleep': 1, setImmediate: 2 },
  'subagent-pane.test.cjs': { setImmediate: 1 },
  'team-locate.test.cjs': { setImmediate: 3 },
  'terminal-cleanup.test.cjs': { setImmediate: 3 },
  'terminal-theme.test.cjs': { 'fixed-sleep': 1 },
  'terminal-visibility.test.cjs': { setImmediate: 3 },
  'token-rate.test.cjs': { 'elapsed-bound': 1 },
  'undeclared-names.test.cjs': { setImmediate: 1 },
  'updates.test.cjs': { setImmediate: 2 },
  'usage-observation.test.cjs': { setImmediate: 1 },
  'usage-refresh.test.cjs': { 'fixed-sleep': 1, setImmediate: 1 },
  'voice-motion.test.cjs': { setImmediate: 1 },
  'voice.test.cjs': { setImmediate: 1 },
  'watch-folder-windows.test.cjs': { 'fixed-sleep': 1 },
  'watch-folder.test.cjs': { setImmediate: 1 },
  'windows-integration.test.cjs': { setImmediate: 2 },
  'zsh-integration.test.cjs': { 'fixed-sleep': 1 },
};
const raised = allowed => allowed.flatMap(({ file, rule, count }) => {
  const most = CEILING[file.replace('tests/', '')]?.[rule] || 0;
  return count > most ? [`${file} ${rule}: ${count} allowed, at most ${most} was ever frozen. The allowlist can only shrink.`] : [];
});

test('the allowlist can be lowered but never raised or extended past the frozen ceiling', () => {
  const frozen = Object.entries(CEILING).flatMap(([file, rules]) => Object.entries(rules).map(([rule, count]) => ({ file: `tests/${file}`, rule, count })));
  assert.deepEqual(raised(frozen), []);
  assert.deepEqual(raised(frozen.map(entry => ({ ...entry, count: entry.count - 1 }))), []);
  assert.equal(raised([{ ...frozen[0], count: frozen[0].count + 1 }]).length, 1, 'a raised count is refused');
  assert.equal(raised([{ file: 'tests/new-thing.test.cjs', rule: 'setImmediate', count: 1 }]).length, 1, 'a new file is refused');
  const [file] = Object.entries(CEILING).find(([, rules]) => !rules['busy-loop']);
  assert.equal(raised([{ file: `tests/${file}`, rule: 'busy-loop', count: 1 }]).length, 1, 'a new rule on a listed file is refused');
});

test('no test waits on setImmediate chains, busy loops, fixed sleeps or elapsed-time bounds outside the frozen allowlist, which can only shrink', () => {
  const allowed = JSON.parse(fs.readFileSync(path.join(root, allowFile), 'utf8')).entries;
  assert.deepEqual(allowed.map(key), [...allowed.map(key)].sort(), 'the allowlist is sorted by file, then rule');
  assert.equal(new Set(allowed.map(key)).size, allowed.length, 'every file and rule appears once');
  assert.deepEqual(raised(allowed), []);
  const found = new Map(scanTests().map(entry => [key(entry), entry.count]));
  const problems = [];
  for (const [name, count] of found) {
    const was = allowed.find(entry => key(entry) === name)?.count || 0;
    if (count > was) problems.push(`${name}: ${count} violation(s), ${was} allowed. Wait for the event or inject the clock; do not add to the allowlist.`);
  }
  for (const entry of allowed) {
    const count = found.get(key(entry)) || 0;
    if (count < entry.count) problems.push(`${key(entry)}: ${count} left, ${entry.count} listed. Lower the allowlist entry to ${count}${count ? '' : ' (remove it)'}.`);
  }
  assert.deepEqual(problems, []);
});
