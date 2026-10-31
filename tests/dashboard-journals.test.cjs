const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { DashboardJournals } = require('../electron/features/dashboard/journals.cjs');
const { READ_LIMIT, LINE_LIMIT } = require('../electron/features/dashboard/jsonl.cjs');

function lab(t, withJournal = true) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-journals-')));
  const common = path.join(directory, '.git'); fs.mkdirSync(common);
  const journalDirectory = path.join(common, 'agentrix'); if (withJournal) fs.mkdirSync(journalDirectory);
  const file = path.join(journalDirectory, 'journal.jsonl');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, common, journalDirectory, file };
}

test('journal reads are bounded and watchers always use native real paths, including shared worktree journals', async t => {
  const { directory, common, file } = lab(t);
  fs.writeFileSync(file, Array.from({ length: READ_LIMIT + 5 }, (_, i) => JSON.stringify({ type: 'consolidate', meeting: `r-${i}`, time: i }) + '\n').join('') +
    '{bad}\n' + JSON.stringify({ type: 'end', time: 10, extra: 'x'.repeat(LINE_LIMIT) }) + '\n' + JSON.stringify({ type: 'consolidate', time: 999999 }));
  const watched = []; let changes = 0, resolved = 0;
  const source = new DashboardJournals({ getProjects: () => [{ id: 'a', name: 'A', path: directory }, { id: 'b', name: 'B', path: directory }, { id: 'remote', kind: 'ssh', path: '/remote' }],
    resolveCommon: async () => { resolved++; return common; }, changed: () => changes++, watch: (filename, options, callback) => {
      const watcher = new EventEmitter(); watcher.close = () => { watcher.closed = true; };
      watched.push({ filename, options, callback, watcher }); return watcher;
    } });
  t.after(() => source.stop());
  await source.start(); const histories = await source.read();
  assert.equal(histories.length, 2); assert.equal(histories[0].entries.length, READ_LIMIT);
  assert.equal(histories[0].entries[0].meeting, 'r-5'); assert.equal(histories[0].entries.at(-1).meeting, `r-${READ_LIMIT + 4}`);
  assert.equal(histories[0].key, histories[1].key); assert.equal(histories[0].entries, histories[1].entries);
  assert.equal(watched.length, 2);
  for (const entry of watched) {
    assert.equal(entry.filename, fs.realpathSync.native(entry.filename)); assert.equal(entry.options.persistent, false);
  }
  const journal = watched.find(entry => entry.filename.endsWith('agentrix'));
  journal.callback('rename', 'journal.jsonl'); assert.equal(changes, 1);
  journal.callback('change', 'memory.md'); assert.equal(changes, 1);
  assert.ok(resolved <= 2, 'subsequent reads reuse successful Git resolution');
  source.stop(); assert.ok(watched.every(entry => entry.watcher.closed));
});

test('opening a dashboard before Team exists observes creation and begins watching its journal', async t => {
  const { directory, common, journalDirectory, file } = lab(t, false);
  const watched = []; let changes = 0;
  const source = new DashboardJournals({ getProjects: () => [{ id: 'a', path: directory }], resolveCommon: async () => common,
    changed: () => changes++, watch: (filename, _options, callback) => {
      const watcher = new EventEmitter(); watcher.close = () => {}; watched.push({ filename, callback }); return watcher;
    } });
  t.after(() => source.stop());
  await source.start(); assert.equal(watched.length, 1);
  fs.mkdirSync(journalDirectory); fs.writeFileSync(file, JSON.stringify({ type: 'consolidate', meeting: 'r', time: 1 }) + '\n');
  watched[0].callback('rename', 'agentrix'); await source.sync();
  assert.equal(changes, 1); assert.equal(watched.length, 2); assert.equal((await source.read())[0].entries[0].meeting, 'r');
});

test('journal source probes only local repositories and drops watchers when projects disappear', async t => {
  const { directory, common } = lab(t);
  let projects = [{ id: 'local', path: directory }, { id: 'remote', kind: 'ssh', path: '/must-not-query' }];
  const paths = [], watchers = [];
  const source = new DashboardJournals({ getProjects: () => projects, changed() {}, resolveCommon: async filename => { paths.push(filename); return common; },
    watch: () => { const watcher = new EventEmitter(); watcher.close = () => { watcher.closed = true; }; watchers.push(watcher); return watcher; } });
  t.after(() => source.stop());
  await source.start(); assert.deepEqual(paths, [directory]);
  projects = []; await source.sync(); assert.equal(source.watchers.size, 0); assert.ok(watchers.every(watcher => watcher.closed));
});

test('the default journal resolver reads an isolated real Git common directory without creating evaluation files', async t => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-git-')));
  execFileSync('git', ['init', '-q'], { cwd: directory, windowsHide: true, stdio: 'ignore' });
  const journal = path.join(directory, '.git', 'agentrix', 'journal.jsonl'); fs.mkdirSync(path.dirname(journal));
  fs.writeFileSync(journal, JSON.stringify({ type: 'consolidate', time: 100, meeting: 'real-common' }) + '\n');
  const source = new DashboardJournals({ getProjects: () => [{ id: 'p', name: 'P', kind: 'local', path: directory }], changed() {} });
  t.after(() => { source.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  const result = await source.read();
  assert.equal(result.length, 1); assert.equal(result[0].entries[0].meeting, 'real-common');
  assert.equal(result[0].key, fs.realpathSync.native(path.join(directory, '.git')));
  assert.deepEqual(fs.readdirSync(path.dirname(journal)), ['journal.jsonl']);
});
