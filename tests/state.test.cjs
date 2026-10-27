const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkspaceStore, cleanSettings } = require('../electron/state.cjs');
const { THEMES } = require('../src/shared/themes.ts');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const projectDir = path.join(directory, "中文项目 & 空格 [a] 'b' $c");
  fs.mkdirSync(projectDir);
  const file = path.join(directory, 'workspace.json');
  const store = new WorkspaceStore(file);
  const { project } = store.add(projectDir);
  return { directory, projectDir, file, store, project };
}

test('adding the same real folder twice keeps one project', t => {
  const { store, projectDir, project } = fixture(t);
  const second = store.add(path.join(projectDir, '.'));
  assert.equal(second.added, false);
  assert.equal(second.project.id, project.id);
  assert.equal(store.projects.length, 1);
});

test('Windows transient save locks retry atomically and persistent failures remain explicit', { skip: process.platform !== 'win32' }, t => {
  const { file, store, project } = fixture(t);
  const rename = fs.renameSync; let attempts = 0, locked = 2;
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === file && attempts++ < locked) { const error = new Error('file temporarily locked'); error.code = 'EBUSY'; throw error; }
    return rename(source, target);
  });
  store.setRestore(project.id, { terminal: true, threadId: '00000000-0000-4000-8000-000000000003' });
  assert.equal(attempts, 3);
  assert.equal(new WorkspaceStore(file).projects[0].restore.threadId, '00000000-0000-4000-8000-000000000003');
  assert.equal(fs.existsSync(file + '.tmp'), false);
  const previous = fs.readFileSync(file, 'utf8'); attempts = 0; locked = Infinity;
  assert.throws(() => store.save(), /temporarily locked/);
  assert.equal(attempts, 5); assert.equal(fs.readFileSync(file, 'utf8'), previous);
});

test('extra terminals keep independent recovery identities and closing one preserves the others', t => {
  const { store, project, file } = fixture(t);
  const first = store.addTerminal(project.id), second = store.addTerminal(project.id);
  const thread = '00000000-0000-4000-8000-000000000001';
  store.setRestore(first, { codex: true, threadId: thread });
  const reopened = new WorkspaceStore(file);
  assert.equal(reopened.findTerminal(first).record.restore.threadId, thread);
  assert.equal(reopened.findTerminal(second).record.restore.codex, false);
  reopened.removeTerminal(first);
  assert.equal(reopened.findTerminal(first), null);
  assert.equal(reopened.findTerminal(second).project.id, project.id);
  reopened.removeTerminal(project.id);
  assert.equal(reopened.findTerminal(second).record.restore.terminal, true);
  assert.equal(reopened.projects[0].primaryTerminalClosed, true);
  reopened.setRestore(project.id, { terminal: true });
  assert.equal(new WorkspaceStore(file).projects[0].primaryTerminalClosed, false);
});

test('turn completion is unread, deduplicated, and survives restarting the app', t => {
  const { store, project, file } = fixture(t);
  store.expectCompletion(project.id);
  assert.equal(store.complete(project.id, 'thread:turn1', 1700000000000), true);
  assert.equal(store.complete(project.id, 'thread:turn1'), false);
  store.expectCompletion(project.id);
  assert.equal(store.complete(project.id, 'thread:turn2', 1700000001000), true);
  const restored = new WorkspaceStore(file);
  assert.equal(restored.projects[0].unread, 2);
  assert.equal(restored.projects[0].lastCompletedAt, 1700000001000);
  assert.equal(restored.complete(project.id, 'thread:turn2'), false);
});

test('viewing a round clears unread without introducing a manual completion flag', t => {
  const { store, project, file } = fixture(t);
  store.expectCompletion(project.id);
  store.complete(project.id, 'thread:turn1');
  store.acknowledge(project.id);
  assert.equal(project.unread, 0);
  assert.equal('done' in project, false);
  assert.equal('done' in new WorkspaceStore(file).projects[0], false);
});

test('a genuinely new round can make a previously viewed round need attention', t => {
  const { store, project } = fixture(t);
  store.expectCompletion(project.id); store.complete(project.id, 'previous-turn'); store.acknowledge(project.id);
  store.expectCompletion(project.id);
  store.complete(project.id, 'thread:turn-new');
  assert.equal(project.unread, 1);
});

test('unknown projects and invalid event identifiers do not create completion', t => {
  const { store, project } = fixture(t);
  assert.equal(store.complete('other', 'turn'), false);
  assert.equal(store.complete(project.id, ''), false);
  assert.equal(store.complete(project.id, {}), false);
  assert.equal(project.unread, 0);
});

test('idle callbacks with different IDs never repeat an alert, even after viewing or restarting', t => {
  const { store, project, file } = fixture(t);
  assert.equal(store.complete(project.id, 'background-before-input'), false);
  store.expectCompletion(project.id);
  assert.equal(store.complete(project.id, 'main:first', 1000), true);
  assert.equal(store.complete(project.id, 'background:second', 60000), false);
  assert.equal(store.complete(project.id, 'different-thread:third', 3600000), false);
  assert.equal(project.unread, 1); assert.equal(project.lastCompletedAt, 1000);
  store.acknowledge(project.id);
  assert.equal(store.complete(project.id, 'after-viewing', 7200000), false);
  const restored = new WorkspaceStore(file);
  assert.equal(restored.complete(project.id, 'after-restart', 86400000), false);
  assert.equal(restored.projects[0].unread, 0);
  assert.equal(restored.projects[0].lastCompletedAt, 1000);
  restored.expectCompletion(project.id);
  assert.equal(restored.complete(project.id, 'background:second'), false, 'previously ignored events cannot consume a fresh submission');
  assert.equal(restored.complete(project.id, 'main:new-input', 86401000), true);
  assert.equal(restored.complete(project.id, 'background:new-ID', 86402000), false);
  assert.equal(restored.projects[0].unread, 1);
});

test('pending input survives restart; cancelling it closes the alert until another submission', t => {
  const { store, project, file } = fixture(t);
  store.expectCompletion(project.id);
  const restored = new WorkspaceStore(file);
  assert.equal(restored.complete(project.id, 'pending-work'), true);
  restored.expectCompletion(project.id);
  restored.expectCompletion(project.id, false);
  assert.equal(restored.complete(project.id, 'late-background-work'), false);
  restored.expectCompletion(project.id);
  assert.equal(restored.complete(project.id, 'new-instruction'), true);
});

test('migrating a previous workspace does not rearm idle completion notifications', t => {
  const { file, projectDir } = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ version: 2, projects: [{ id: 'legacy', name: 'Idle project', path: projectDir, unread: 1, lastCompletedAt: 1000, seenEvents: ['old-turn'] }], settings: {} }));
  const restored = new WorkspaceStore(file);
  assert.equal(restored.complete('legacy', 'fresh-background-id', 9000000), false);
  assert.equal(restored.projects[0].unread, 1);
  assert.equal(restored.projects[0].lastCompletedAt, 1000);
});

test('removing a project preserves all project files', t => {
  const { store, project, projectDir } = fixture(t);
  const source = path.join(projectDir, 'keep.txt');
  fs.writeFileSync(source, 'keep this');
  store.remove(project.id);
  assert.equal(store.projects.length, 0);
  assert.equal(fs.readFileSync(source, 'utf8'), 'keep this');
});

test('corrupt workspace is copied aside before a new workspace can be saved', t => {
  const { file, directory } = fixture(t);
  fs.writeFileSync(file, '{ invalid');
  const store = new WorkspaceStore(file);
  assert.ok(store.warning);
  const backups = fs.readdirSync(directory).filter(x => x.includes('.unreadable-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(directory, backups[0]), 'utf8'), '{ invalid');
});

test('new workspaces and settings start on the first theme', t => {
  const { store, file } = fixture(t);
  assert.equal(store.settings.theme, 'mono');
  assert.equal(cleanSettings().theme, 'mono');
  assert.equal(new WorkspaceStore(file).settings.theme, 'mono');
});

test('every theme offered in Settings survives saving, loading and switching', t => {
  const { store, file } = fixture(t);
  for (const { id } of [...THEMES, THEMES[0]]) {
    assert.equal(cleanSettings({ theme: id }).theme, id);
    store.updateSettings({ theme: id });
    assert.equal(new WorkspaceStore(file).settings.theme, id);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).settings.theme, id);
  }
});

test('legacy theme values fall back to the first theme on load and on settings updates', t => {
  const { file } = fixture(t);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const theme of ['retired', 'catalina', 'mono-amber', '', null, 42, { id: 'retired' }]) {
    fs.writeFileSync(file, JSON.stringify({ ...saved, settings: { ...saved.settings, theme, fontSize: 16 } }));
    const restored = new WorkspaceStore(file);
    assert.equal(restored.warning, null);
    assert.equal(restored.settings.theme, 'mono');
    assert.equal(restored.settings.fontSize, 16);
    assert.deepEqual(restored.projects.map(project => project.id), saved.projects.map(project => project.id));
    restored.updateSettings({ theme, fontSize: 14 });
    assert.equal(new WorkspaceStore(file).settings.theme, 'mono');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).settings.theme, 'mono');
    assert.equal(restored.settings.fontSize, 14);
  }
});

test('settings reject invalid layout and font values', () => {
  assert.deepEqual(cleanSettings({ columns: 999, fontSize: -2, notifications: 'yes', sound: false }), { startView: 'decisions', fontSize: 12, terminalFontWeight: 400, terminalFontFamily: '', terminalCjkFontFamily: '', userAvatar: '', focusAnimation: 'smooth', language: 'en', theme: 'mono', surface: 'glass', glassBackground: 'theme', glassTransparency: null, terminalRenderer: 'gpu', shortcuts: {}, guideVersion: '', shell: 'powershell', notifications: true, sound: false, closeToTray: true, explorerCollapsed: false, hideTreeNoise: false, restoreSessions: true, autoSave: true, activityPane: true, voiceModel: 'sensevoice' });
  // The spoken notice is gone: its old settings are dropped.
  const old = cleanSettings({ announce: true, announcePhrase: '{项目}', summary: { mode: 'local' } });
  assert.equal('announce' in old || 'announcePhrase' in old || 'summary' in old, false);
  assert.equal(cleanSettings({ autoSave: false }).autoSave, false);
  assert.equal(cleanSettings({ voiceModel: 'toString' }).voiceModel, 'sensevoice', 'only a listed recognizer can be chosen');
  assert.equal(cleanSettings({ surface: 'solid' }).surface, 'solid'); assert.equal(cleanSettings({ surface: 'paper' }).surface, 'glass');
  assert.equal(cleanSettings({ terminalRenderer: 'dom' }).terminalRenderer, 'dom'); assert.equal(cleanSettings({ terminalRenderer: 'canvas' }).terminalRenderer, 'gpu');
  assert.equal(cleanSettings({ language: 'fr' }).language, 'en');
  assert.equal(cleanSettings({ shell: 'cmd' }).shell, 'cmd');
  assert.equal(cleanSettings({ shell: 'zsh' }).shell, 'zsh'); assert.equal(cleanSettings({ shell: 'bash' }).shell, 'bash');
  assert.equal(cleanSettings({ shell: 'bash -c evil' }).shell, 'powershell', 'only a known shell name');
  assert.equal(cleanSettings({ guideVersion: '0.5.16' }).guideVersion, '0.5.16');
  assert.equal(cleanSettings({ guideVersion: '<script>' }).guideVersion, '', 'only a version number marks the guide as seen');
  assert.deepEqual(cleanSettings({ shortcuts: { search: 'Ctrl+Shift+K', addProject: 'A', voice: 'Alt+V', overview: 'F6', settings: 'Ctrl+rm', nextProject: 'Ctrl+Tab', unknown: 'Ctrl+Q' } }).shortcuts, { search: 'Ctrl+Shift+K', voice: 'Alt+V', overview: 'F6', nextProject: 'Ctrl+Tab' }, 'only valid combinations for known actions are kept');
  assert.deepEqual(cleanSettings({ shortcuts: { projectAbove: 'Ctrl+Shift+Up', projectBelow: 'Shift+Down', previousProject: 'Alt+Left' } }).shortcuts, { projectAbove: 'Ctrl+Shift+Up', previousProject: 'Alt+Left' }, 'an arrow needs Ctrl or Alt with it');
  assert.equal(cleanSettings({ language: 'en' }).language, 'en');
  for (const theme of [undefined, 'catalina', 'mono-amber', 7]) assert.equal(cleanSettings({ theme }).theme, 'mono');
  assert.equal(cleanSettings({ theme: 'mono' }).theme, 'mono');
  assert.equal(cleanSettings({ focusAnimation: 'invalid' }).focusAnimation, 'smooth');
  assert.equal(cleanSettings({ focusAnimation: 'system' }).focusAnimation, 'system');
  assert.equal(cleanSettings({ focusAnimation: 'off' }).focusAnimation, 'off');
});

test('SSH projects retain their host, remote path and recovery state without becoming local folders', t => {
  const { store, file } = fixture(t);
  const { project } = store.addSSH({ host: 'linux-dev', path: '~/apps/demo', name: '远程项目' });
  store.setRestore(project.id, { terminal: true, codex: true, cwd: '/home/dev/apps/demo/subdir' });
  const restored = new WorkspaceStore(file).projects.find(item => item.id === project.id);
  assert.equal(restored.kind, 'ssh');
  assert.equal(restored.path, '~/apps/demo');
  assert.equal(restored.ssh.host, 'linux-dev');
  assert.deepEqual(restored.restore, { terminal: true, codex: true, cwd: '/home/dev/apps/demo/subdir' });
  assert.equal(store.addSSH({ host: 'linux-dev', path: '~/apps/demo' }).added, false);
  assert.equal(store.addSSH({ host: 'other-host', path: '~/apps/demo' }).added, true);
});

test('insertion reorder preserves all records and rejects stale or duplicated project lists', t => {
  const { store, project, file } = fixture(t);
  const second = store.addSSH({ host: 'two', path: '/srv/two' }).project;
  const third = store.addSSH({ host: 'three', path: '/srv/three' }).project;
  store.expectCompletion(project.id); store.complete(project.id, 'pending-turn');
  store.reorderProjects([second.id, third.id, project.id]);
  assert.deepEqual(new WorkspaceStore(file).projects.map(item => item.id), [second.id, third.id, project.id]);
  assert.equal(store.projects[2], project); assert.equal(project.unread, 1);
  for (const order of [[second.id, project.id], [second.id, project.id, project.id], [second.id, third.id, 'missing'], null]) assert.throws(() => store.reorderProjects(order), /项目列表已变化/);
});

test('removed local projects stay in a bounded recent list that can be pruned or cleared', t => {
  const { directory, projectDir, file, store, project } = fixture(t);
  assert.deepEqual(store.recentProjects(), [], 'open projects are not offered again');
  store.remove(project.id);
  const [recent] = new WorkspaceStore(file).recentProjects();
  assert.equal(recent.path, fs.realpathSync(projectDir));
  assert.equal(recent.name, project.name);
  const reopened = new WorkspaceStore(file);
  assert.equal(reopened.isRecent(projectDir.toUpperCase()), process.platform === 'win32');
  assert.equal(reopened.add(projectDir, recent.name).project.name, project.name, 're-adding keeps the remembered name');
  assert.deepEqual(reopened.recentProjects(), [], 're-adding hides it again');
  const folders = Array.from({ length: 35 }, (_, index) => { const folder = path.join(directory, `p${index}`); fs.mkdirSync(folder); return folder; });
  for (const folder of folders) reopened.remove(reopened.add(folder).project.id);
  const listed = new WorkspaceStore(file).recentProjects();
  assert.equal(listed.length, 30, 'thirty entries at most');
  assert.equal(listed[0].path, fs.realpathSync(folders.at(-1)), 'newest first');
  reopened.forget(listed[0].path);
  assert.equal(new WorkspaceStore(file).isRecent(listed[0].path), false);
  reopened.clearHistory();
  assert.deepEqual(new WorkspaceStore(file).history, []);
});

test('SSH projects go to their own history, and malformed history entries are not remembered', t => {
  const { file, store } = fixture(t);
  store.remember({ kind: 'ssh', path: '/srv/app', name: 'app', ssh: { host: 'app-host' } });
  assert.equal(store.history.length, 1, 'only the local fixture project');
  assert.deepEqual(store.sshHistory.map(item => [item.host, item.path]), [['app-host', '/srv/app']]);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.history = [{ path: 'relative/folder' }, { path: 42 }, null, { path: path.resolve('/abs/one'), name: 'one', lastOpenedAt: 5 }, { path: path.resolve('/abs/one') }];
  fs.writeFileSync(file, JSON.stringify(saved));
  assert.deepEqual(new WorkspaceStore(file).history, [{ path: path.resolve('/abs/one'), name: 'one', lastOpenedAt: 5 }]);
});

test('SSH connections once opened are listed again when not open, newest first, and can be forgotten or cleared', t => {
  const { file, store } = fixture(t);
  const demo = store.addSSH({ host: 'linux-dev', path: '~/apps/demo', name: '远程项目' }).project;
  store.addSSH({ host: 'user@10.0.0.2', path: '/srv/api' });
  assert.deepEqual(store.recentSSH(), [], 'open connections are not offered again');
  store.remove(demo.id);
  assert.deepEqual(new WorkspaceStore(file).recentSSH().map(item => [item.host, item.path, item.name]), [['linux-dev', '~/apps/demo', '远程项目']], 'kept after removal, with its name');
  const reopened = new WorkspaceStore(file);
  reopened.addSSH({ host: 'linux-dev', path: '~/apps/demo', name: '远程项目' });
  assert.deepEqual(reopened.recentSSH(), [], 're-adding hides it again');
  for (let index = 0; index < 35; index++) reopened.remove(reopened.addSSH({ host: `h${index}`, path: '/srv/x' }).project.id);
  const listed = new WorkspaceStore(file).recentSSH();
  assert.equal(listed.length, 30, 'thirty entries at most');
  assert.equal(listed[0].host, 'h34', 'newest first');
  reopened.forgetSSH('h34', '/srv/x');
  assert.equal(new WorkspaceStore(file).recentSSH().some(item => item.host === 'h34'), false);
  reopened.clearSSHHistory();
  assert.deepEqual(new WorkspaceStore(file).sshHistory, []);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.sshHistory = [{ host: '-oProxyCommand=x', path: '/srv' }, { host: 'ok', path: 'relative' }, null, { host: 'ok', path: '/srv/ok', name: 'ok', lastOpenedAt: 7 }, { host: 'ok', path: '/srv/ok' }];
  fs.writeFileSync(file, JSON.stringify(saved));
  assert.deepEqual(new WorkspaceStore(file).sshHistory, [{ host: 'ok', path: '/srv/ok', name: 'ok', lastOpenedAt: 7 }], 'unsafe or malformed entries are dropped');
});

test('each terminal remembers whether Claude Code or Codex ran, and an unfinished Claude turn', t => {
  const { file, store, project } = fixture(t);
  const split = store.addTerminal(project.id), thread = '00000000-0000-4000-8000-000000000009';
  store.setRestore(split, { codex: true, agent: 'claude', threadId: thread, interrupted: true });
  let reopened = new WorkspaceStore(file);
  assert.deepEqual(reopened.findTerminal(split).record.restore, { terminal: true, codex: true, cwd: project.path, threadId: thread, agent: 'claude', interrupted: true });
  assert.equal(reopened.findTerminal(project.id).record.restore.agent, undefined, 'the other terminal still restores Codex');
  reopened.setRestore(split, { interrupted: false });
  assert.equal(new WorkspaceStore(file).findTerminal(split).record.restore.interrupted, undefined, 'a finished turn is not continued');
  reopened.setRestore(split, { agent: 'codex', threadId: null, interrupted: false });
  reopened = new WorkspaceStore(file);
  assert.deepEqual(reopened.findTerminal(split).record.restore, { terminal: true, codex: true, cwd: project.path });
  reopened.setRestore(split, { agent: 'other', interrupted: 'yes' });
  assert.equal(new WorkspaceStore(file).findTerminal(split).record.restore.agent, undefined, 'unknown agents are ignored');
});

test('glass transparency is optional, validated and preserved across material changes and restart', t => {
  const { store, file } = fixture(t);
  assert.equal(store.settings.glassTransparency, null);
  for (const value of [0, 37, 100]) {
    store.updateSettings({ glassTransparency: value });
    assert.equal(new WorkspaceStore(file).settings.glassTransparency, value);
  }
  store.updateSettings({ surface: 'solid', glassTransparency: 72 });
  store.updateSettings({ surface: 'glass' });
  assert.equal(new WorkspaceStore(file).settings.glassTransparency, 72);
  store.updateSettings({ glassTransparency: null });
  assert.equal(new WorkspaceStore(file).settings.glassTransparency, null);
  for (const value of [-1, 101, 0.5, '50', true, NaN, Infinity, undefined]) {
    assert.equal(cleanSettings({ glassTransparency: value }).glassTransparency, null);
  }
});

test('desktop glass is opt-in and persisted across surface changes', t => {
  const { store, file } = fixture(t);
  assert.equal(store.settings.surface, 'glass');
  store.updateSettings({ glassBackground: 'desktop' });
  const saved = new WorkspaceStore(file);
  assert.equal(saved.settings.surface, 'glass'); assert.equal(saved.settings.glassBackground, 'desktop');
  saved.updateSettings({ surface: 'solid' }); assert.equal(new WorkspaceStore(file).settings.glassBackground, 'desktop');
  saved.updateSettings({ surface: 'glass' }); assert.equal(saved.settings.glassBackground, 'desktop');
  saved.updateSettings({ glassBackground: 'theme' }); assert.equal(new WorkspaceStore(file).settings.glassBackground, 'theme');
  assert.equal(cleanSettings({ glassBackground: 'unknown' }).glassBackground, 'theme');
});

test('terminal weight is optional, validated and persisted without changing font size', t => {
  const { store, file } = fixture(t);
  assert.equal(store.settings.terminalFontWeight, 400);
  for (const value of [400, 500, 600]) { store.updateSettings({ terminalFontWeight: value }); assert.equal(new WorkspaceStore(file).settings.terminalFontWeight, value); }
  assert.equal(store.settings.fontSize, 12);
  for (const value of [0, 700, '600', NaN, undefined]) assert.equal(cleanSettings({ terminalFontWeight: value }).terminalFontWeight, 400);
});


test('terminal families are optional, sanitized and persisted independently', t => {
  const { store, file } = fixture(t);
  assert.equal(store.settings.terminalFontFamily, ''); assert.equal(store.settings.terminalCjkFontFamily, '');
  store.updateSettings({ terminalFontFamily: ' Consolas ', terminalCjkFontFamily: ' Noto Sans SC ' });
  const saved = new WorkspaceStore(file);
  assert.equal(saved.settings.terminalFontFamily, 'Consolas'); assert.equal(saved.settings.terminalCjkFontFamily, 'Noto Sans SC');
  saved.updateSettings({ terminalFontFamily: '' }); assert.equal(saved.settings.terminalCjkFontFamily, 'Noto Sans SC');
  for (const value of [true, 42, null, undefined, 'x'.repeat(81), 'bad\nfont', 'bad\0font']) {
    for (const key of ['terminalFontFamily', 'terminalCjkFontFamily']) assert.equal(cleanSettings({ [key]: value })[key], '');
  }
});

test('the user avatar keeps only a small WebP, PNG or JPEG data URL', t => {
  const { store, file } = fixture(t);
  assert.equal(store.settings.userAvatar, '');
  const picture = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
  store.updateSettings({ userAvatar: picture });
  assert.equal(new WorkspaceStore(file).settings.userAvatar, picture);
  for (const value of ['data:image/svg+xml;base64,PHN2Zz4=', 'data:image/webp;base64,', 'data:image/png,abc', 'https://example.com/a.png', `data:image/png;base64,${'A'.repeat(200_000)}`, 42, null]) {
    assert.equal(cleanSettings({ userAvatar: value }).userAvatar, '', String(value).slice(0, 40));
  }
  store.updateSettings({ userAvatar: '' }); assert.equal(store.settings.userAvatar, '');
});
