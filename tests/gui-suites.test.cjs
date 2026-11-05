const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');

// Every clipboard suite runs only in GitHub Actions, including directly named entrypoints.
const script = path.join(__dirname, '..', 'scripts', 'windows-gui-smoke.mjs');
const load = () => import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'gui-suites.mjs')).href);
const CLIPBOARD = ['session', 'workspace', 'editor-terminals', 'clipboard', 'composer', 'gpu-terminal'];

test('only GitHub Actions keeps clipboard suites in the default list; local CI=true is insufficient', async () => {
  const { selectSuites, suites, clipboardSuites } = await load();
  assert.deepEqual([...clipboardSuites].sort(), [...CLIPBOARD].sort());
  const local = selectSuites(['node', 'windows-gui-smoke.mjs'], {});
  assert.deepEqual(local.skipped, suites.filter(name => CLIPBOARD.includes(name)));
  assert.deepEqual(local.selected, suites.filter(name => !CLIPBOARD.includes(name)));
  const remote = selectSuites(['node', 'windows-gui-smoke.mjs'], { GITHUB_ACTIONS: 'true' });
  assert.deepEqual([remote.selected, remote.skipped], [suites, []]);
  assert.deepEqual(selectSuites(['node', 'x', '--only', 'git,reading'], {}).selected, ['git', 'reading'], 'the others can be named anywhere');
  assert.throws(() => selectSuites(['node', 'x', '--only', 'clipboard,git'], { CI: 'true' }), /system clipboard/);
  assert.throws(() => selectSuites(['node', 'x', '--only', 'clipboard'], { GITHUB_ACTIONS: '1' }), /system clipboard/);
});

test('naming a clipboard suite with --only is refused outside Actions before it starts anything', async () => {
  const { selectSuites } = await load();
  for (const name of CLIPBOARD) {
    assert.throws(() => selectSuites(['node', 'x', '--only', `git,${name}`], {}), /system clipboard/, name);
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'GITHUB_ACTIONS')), CI: 'true' };
    const run = spawnSync(process.execPath, ['--require', path.join(__dirname, 'fixtures/no-gui.cjs'), script, '--only', name], { env, encoding: 'utf8', timeout: 20000 });
    assert.notEqual(run.status, 0, name);
    assert.match(run.stderr, /system clipboard/, `${name}: the reason is printed`);
    assert.doesNotMatch(run.stdout, /GUI evidence/, `${name}: nothing was started`);
  }
  assert.throws(() => selectSuites(['node', 'x', '--only', 'nonsense'], { CI: 'true' }), /Unknown GUI suite/);
});

test('clipboard entrypoints refuse CI=true before importing any launch dependency', () => {
  const root = path.resolve(__dirname, '..');
  for (const name of [...CLIPBOARD, 'mac', 'linux']) {
    const entry = path.join(root, 'scripts', `${name}-smoke.mjs`);
    assert.equal(fs.readFileSync(entry, 'utf8').split(/\r?\n/)[0], "import './clipboard-guard.mjs';", name);
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'GITHUB_ACTIONS')), CI: 'true', GIT_CEILING_DIRECTORIES: root };
    const run = spawnSync(process.execPath, ['--require', path.join(__dirname, 'fixtures/no-gui.cjs'), entry], { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(run.status, 1, name);
    assert.match(run.stderr, /system clipboard.*GITHUB_ACTIONS=true/, name);
    assert.doesNotMatch(run.stderr + run.stdout, /GUI_LAUNCH_ATTEMPT/, name);
  }
});

test('scripts and tests cannot add an unguarded system clipboard or browser path', () => {
  const root = path.resolve(__dirname, '..');
  function visit(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? visit(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
  }
  const clipboard = /(?:\bclipboard\s*\.\s*(?:read\w*|write\w*|clear)\s*\(|\b(?:readClipboard|writeClipboard)\s*\(|navigator\.clipboard|System\.Windows\.Forms\.Clipboard|\b(?:pbcopy|pbpaste|wl-copy|wl-paste|xclip|Get-Clipboard|Set-Clipboard)\b)/;
  const key = /keyboard\.press\([^\n]*(?:Control|Meta)\+(?:Shift\+)?[cCvV]/;
  for (const file of ['scripts', 'tests'].flatMap(name => visit(path.join(root, name)))) {
    if (!/\.(?:mjs|cjs|ps1)$/.test(file) || file === __filename) continue;
    const relative = path.relative(root, file).replaceAll('\\', '/'), text = fs.readFileSync(file, 'utf8');
    // Linux unit tests inject both the clipboard and the command runner; they never invoke a desktop tool.
    if (relative === 'tests/linux-integration.test.cjs') continue;
    // This sole Ctrl+C dismisses /side without a selection. It is a terminal interrupt, not a copy.
    const reviewed = relative === 'scripts/slash-live.mjs' ? text.replace("await page.keyboard.press(command === '/side' ? 'Control+c' : command === '/diff' ? 'q' : 'Escape');", '') : text;
    if (clipboard.test(reviewed) || key.test(reviewed)) {
      if (file.endsWith('.mjs')) assert.equal(text.split(/\r?\n/)[0], "import './clipboard-guard.mjs';", relative);
      else if (file.endsWith('.ps1')) assert.match(text.split(/\r?\n/)[1], /GITHUB_ACTIONS -cne 'true'.*exit 1/, relative);
      else assert.fail('New clipboard path requires a guard or an audited in-memory fixture: ' + relative);
    }
    if (/\b(?:chromium|electron)\.launch\s*\(/.test(text) && relative.startsWith('tests/')) {
      assert.match(text, /skip: !githubActions\(process.env\)/, relative);
    }
  }
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/build-windows.yml'), 'utf8');
  for (const name of ['sessions', 'workspace', 'editor-terminals', 'clipboard', 'composer', 'gpu-terminal']) {
    assert.match(workflow, new RegExp('run: node scripts/retry\\.mjs npm run test:' + name + ' -- --packaged'), name);
  }
  assert.doesNotMatch(workflow, /GITHUB_ACTIONS\s*[:=]/, 'Actions supplies its own true value; no step masks it');
});
