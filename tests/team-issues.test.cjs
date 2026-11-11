require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { projectTeam, minutesMarkdown } = require('../electron/features/team/team.cjs');
const { minutesPage } = require('../electron/features/team/minutes-page.cjs');

function lab(t) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'team-issues-')));
  execFileSync('git', ['init', '-q'], { cwd: directory, windowsHide: true, stdio: 'ignore' });
  const team = projectTeam(directory, true);
  team.append({ type: 'meeting', meeting: 'r', id: 'task', session: 's', agent: 'codex', model: 'gpt-6.1-sol', status: 'understood',
    title: 'Task', understanding: { goal: 'a', files: 'b', provides: 'c', uses: 'd', doneWhen: 'e', questions: 'none' } });
  t.after(async () => { await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
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
  for (const [language, heading, column, answer] of [
    ['zh', '澄清与纠正', '歧义、误读或阻碍', '规划师的答复'],
    ['en', 'Clarifications and corrections', 'Ambiguity, misreading or blocker', "Planner's answer"],
  ]) {
    const data = team.minutes('r', undefined, language);
    assert.deepEqual(data.issues, [issue]);
    const md = minutesMarkdown(data), html = minutesPage(data);
    assert.ok(html.includes(heading));
    assert.ok(md.includes('| ' + column + ' |')); assert.ok(html.includes('<th>' + column + '</th>'));
    assert.ok(md.includes('| ' + answer + ' |'));
    assert.doesNotMatch(md, /分歧|Disagreement/); assert.doesNotMatch(html, /分歧|Disagreement/);
  }
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
