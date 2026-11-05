const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

// The five desktop suites that use the system clipboard run only on the remote CI: never by default on a developer's computer, and never when named there.
const script = path.join(__dirname, '..', 'scripts', 'windows-gui-smoke.mjs');
const load = () => import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'gui-suites.mjs')).href);
const CLIPBOARD = ['session', 'workspace', 'editor-terminals', 'clipboard', 'composer'];

test('without CI the default list leaves the clipboard suites out and says so; with CI it keeps them', async () => {
  const { selectSuites, suites, clipboardSuites } = await load();
  assert.deepEqual([...clipboardSuites].sort(), [...CLIPBOARD].sort());
  const local = selectSuites(['node', 'windows-gui-smoke.mjs'], {});
  assert.deepEqual(local.skipped, suites.filter(name => CLIPBOARD.includes(name)));
  assert.deepEqual(local.selected, suites.filter(name => !CLIPBOARD.includes(name)));
  const remote = selectSuites(['node', 'windows-gui-smoke.mjs'], { CI: 'true' });
  assert.deepEqual([remote.selected, remote.skipped], [suites, []]);
  assert.deepEqual(selectSuites(['node', 'x', '--only', 'git,reading'], {}).selected, ['git', 'reading'], 'the others can be named anywhere');
  assert.deepEqual(selectSuites(['node', 'x', '--only', 'clipboard,git'], { CI: '1' }).selected, ['clipboard', 'git']);
});

test('naming a clipboard suite with --only is refused outside CI, and the script exits non-zero before it starts anything', async () => {
  const { selectSuites } = await load();
  for (const name of CLIPBOARD) {
    assert.throws(() => selectSuites(['node', 'x', '--only', `git,${name}`], {}), /system clipboard/, name);
    const env = { ...process.env }; delete env.CI;
    const run = spawnSync(process.execPath, [script, '--only', name], { env, encoding: 'utf8', timeout: 20000 });
    assert.notEqual(run.status, 0, name);
    assert.match(run.stderr, /system clipboard/, `${name}: the reason is printed`);
    assert.doesNotMatch(run.stdout, /GUI evidence/, `${name}: nothing was started`);
  }
  assert.throws(() => selectSuites(['node', 'x', '--only', 'nonsense'], { CI: 'true' }), /Unknown GUI suite/);
});
