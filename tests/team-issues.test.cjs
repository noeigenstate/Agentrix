const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { projectTeam } = require('../electron/features/team/team.cjs');

function lab(t) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'team-issues-')));
  execFileSync('git', ['init', '-q'], { cwd: directory, windowsHide: true, stdio: 'ignore' });
  const team = projectTeam(directory, true);
  team.append({ type: 'meeting', meeting: 'r', id: 'task', session: 's', agent: 'codex', model: 'gpt-6.1-sol', status: 'understood',
    title: 'Task', understanding: { goal: 'a', files: 'b', provides: 'c', uses: 'd', doneWhen: 'e', questions: 'none' } });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return team;
}
const issue = { issue: 'scope', raisedBy: 'Sol', answer: 'split module', result: 'changed the plan' };

test('minutes persist bounded latest issues snapshots and distinguish explicit zero from no snapshot', async t => {
  const team = lab(t);
  await team.locked(() => team.minutes('r'));
  assert.equal(team.entries().filter(entry => entry.type === 'issues').length, 0);
  const first = await team.locked(() => team.minutes('r', [{ ...issue, secret: 'discarded' }]));
  assert.deepEqual(first.issues, [issue]);
  assert.deepEqual(team.entries().findLast(entry => entry.type === 'issues').issues, [issue]);
  assert.deepEqual(team.minutes('r').issues, [issue]);
  assert.equal(team.entries().filter(entry => entry.type === 'issues').length, 1);
  await team.locked(() => team.minutes('r', []));
  assert.deepEqual(team.minutes('r').issues, []);
  assert.equal(team.entries().filter(entry => entry.type === 'issues').length, 2);
});

test('oversized invalid and unknown-meeting issues never append a journal snapshot', t => {
  const team = lab(t), before = fs.readFileSync(team.journal, 'utf8');
  for (const issues of [Array.from({ length: 101 }, () => issue), [{ ...issue, issue: 'x'.repeat(2001) }],
    Array.from({ length: 10 }, () => ({ ...issue, answer: '中'.repeat(1000) })), [{ ...issue, result: null }], {}]) {
    assert.throws(() => team.minutes('r', issues));
  }
  assert.throws(() => team.minutes('missing', [issue]), /No roundtable records/);
  assert.equal(fs.readFileSync(team.journal, 'utf8'), before);
});
