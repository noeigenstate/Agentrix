import { testRun } from './test-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright-core';
import { waitFor, terminalsSettled } from './wait.mjs';
import { chooseFromAppMenu } from './app-menu-helper.mjs';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createSSHFixture } = require('../tests/helpers/ssh-fixture.cjs');
const ssh = await createSSHFixture({ nativeWorker: false });
const output = await testRun('navigation'), profile = path.join(output, 'profile');
const local = { id: randomUUID(), name: '本地项目', path: path.join(output, 'local'), restore: { terminal: true, codex: false } };
const remote = { id: randomUUID(), name: '远程项目', kind: 'ssh', path: '/srv/fixture', ssh: { host: 'fixture', configFile: ssh.configFile }, restore: { terminal: false, codex: false } };
const legacy = { id: randomUUID(), name: '已停止项目', path: path.join(output, 'legacy'), restore: { terminal: false, codex: false }, terminals: [{ id: randomUUID(), restore: { terminal: false, codex: false } }] };
const closed = { id: randomUUID(), name: '已关闭主终端', path: path.join(output, 'closed'), primaryTerminalClosed: true, restore: { terminal: false, codex: false }, terminals: [{ id: randomUUID(), restore: { terminal: false, codex: false } }] };
await fs.mkdir(profile, { recursive: true }); await fs.mkdir(local.path);
await fs.mkdir(legacy.path); await fs.mkdir(closed.path);
await fs.writeFile(path.join(local.path, 'unsupported.txt'), Buffer.from([0xff, 0xff, 0xff]));
await fs.mkdir(path.join(ssh.project, 'docs/nested'), { recursive: true });
await fs.writeFile(path.join(ssh.project, 'docs/nested/note.txt'), 'REMOTE_DIRECTORY_READY');
await fs.symlink(path.join(ssh.project, 'docs/nested'), path.join(ssh.project, 'docs-alias'), 'junction');
await fs.writeFile(path.join(ssh.project, 'README.md'), '# 远程文件\n\n[查看文档目录](docs/nested/)\n');
// A regular shell at the end proves startup restoration actually ran after any legacy entries.
// These checks read the terminal's rows as HTML, so the compatible (DOM) renderer draws them; gpu-terminal-smoke covers the GPU one.
await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects: [legacy, closed, remote, local], settings: { language: 'zh', terminalRenderer: 'dom', autoSave: false, notifications: false, restoreSessions: true, closeToTray: false } }));
const env = { ...process.env, AGENTRIX_DATA_DIR: profile, AGENTRIX_TEST_SSH_CONFIG: ssh.configFile, AGENTRIX_TEST_RESTORE: '1', CODEX_HOME: path.join(output, 'codex-home') }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
const packaged = process.argv.includes('--packaged'); let app, page;
const state = async () => (await page.evaluate(() => window.agentrix.getState())).value;
const settled = focused => page.waitForFunction(focused => !!document.querySelector('.focus-mode') === focused && !document.querySelector('[data-focus-motion]'), focused);
const errors = [];
try {
  app = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Agentrix.exe') : require('electron'), args: packaged ? [] : [root], cwd: root, env });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ shell, dialog }) => {
    globalThis.navigationOpened = []; globalThis.editorCloseReply = 2;
    shell.openPath = async target => { globalThis.navigationOpened.push(target); return ''; };
    shell.openExternal = async target => { globalThis.navigationOpened.push(target); };
    dialog.showMessageBox = async (_window, options) => ({ response: options.title === '未保存的修改' ? globalThis.editorCloseReply : 1 });
  });
  await page.waitForSelector('.project-panel');
  await waitFor(async () => (await state()).projects.find(project => project.id === local.id).shellReady, 'ordinary shell restores while legacy-finished terminals remain stopped');
  const migrated = (await state()).projects.find(project => project.id === legacy.id);
  assert.deepEqual(migrated.terminals.map(terminal => terminal.id), [legacy.id, legacy.terminals[0].id]);
  assert.ok(migrated.terminals.every(terminal => !terminal.sessionId && terminal.status === 'stopped'));
  assert.deepEqual((await state()).projects.find(project => project.id === closed.id).terminals.map(terminal => terminal.id), [closed.terminals[0].id], 'previously closed primary does not reappear');
  const legacyPanel = page.locator(`[data-project-id="${legacy.id}"]`);
  await legacyPanel.getByRole('button', { name: `全屏查看 ${legacy.name}`, exact: true }).click(); await settled(true);
  await page.screenshot({ path: path.join(output, 'legacy-stopped-splits.png') });
  await legacyPanel.locator(`[data-terminal-id="${legacy.id}"]`).getByRole('button', { name: '只打开终端', exact: true }).click();
  await waitFor(async () => (await state()).projects.find(project => project.id === legacy.id).terminals[0].shellReady, 'migrated primary can start manually');
  const started = (await state()).projects.find(project => project.id === legacy.id);
  assert.equal(started.terminals.length, 2); assert.equal(started.terminals[0].codexActive, false); assert.equal(started.terminals[1].sessionId, null);
  assert.deepEqual(await page.evaluate(id => window.agentrix.closeTerminal(id), legacy.id), { ok: true, value: true });
  await waitFor(async () => (await state()).projects.find(project => project.id === legacy.id).terminals.length === 1, 'explicitly closing a primary still removes its pane');
  await page.getByRole('button', { name: '返回总览', exact: true }).click(); await settled(false);
  assert.deepEqual(await page.evaluate(() => ['openInCode', 'markDone'].filter(key => key in window.agentrix)), []);
  const first = page.locator(`[data-project-id="${local.id}"]`), second = page.locator(`[data-project-id="${remote.id}"]`);
  await first.getByRole('button', { name: `${local.name} 的更多操作`, exact: true }).click();
  assert.equal(await page.getByRole('menuitem', { name: /VS Code|标记开发完成|继续开发/ }).count(), 0);
  await page.getByRole('menuitem', { name: '打开项目目录', exact: true }).click();
  assert.deepEqual(await app.evaluate(() => globalThis.navigationOpened), [local.path]);
  await first.getByRole('button', { name: `全屏查看 ${local.name}`, exact: true }).click(); await settled(true);
  const sidebar = page.getByRole('complementary', { name: '项目侧边栏' });
  // The project is the sidebar title; files and Git share one switch, with no separate settings entry.
  assert.equal(await sidebar.getByRole('heading', { name: local.name, exact: true }).count(), 1);
  assert.deepEqual(await sidebar.locator('.explorer-tabs button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), ['资源管理器', 'Git 历史']);
  assert.equal(await sidebar.getByRole('treeitem', { name: local.name, exact: true }).count(), 0, 'the project root is the title, not a tree row');
  await page.screenshot({ path: path.join(output, 'sidebar.png') });
  await page.keyboard.press('Control+b'); await page.waitForSelector('.focus-sidebar.is-collapsed'); assert.equal(await sidebar.locator('.sidebar-toggle').count(), 0, 'a collapsed sidebar shows no collapse control, only its two panes');
  assert.deepEqual(await sidebar.locator('.explorer-rail button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), ['资源管理器', 'Git 历史']);
  await page.screenshot({ path: path.join(output, 'sidebar-collapsed.png') });
  await page.keyboard.press('Control+b');
  await page.getByRole('treeitem', { name: 'unsupported.txt', exact: true }).click();
  await page.getByText('暂不支持此文件的文本编码。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /VS Code|标记开发完成/ }).count(), 0);
  await page.screenshot({ path: path.join(output, 'unsupported.png') });
  await page.getByRole('button', { name: '返回总览', exact: true }).click(); await settled(false);
  await second.getByRole('button', { name: '启动终端', exact: true }).click();
  await waitFor(async () => (await state()).projects.find(project => project.id === remote.id).shellReady, 'real SSH transport ready');
  const sessionId = (await state()).projects.find(project => project.id === remote.id).sessionId;
  // Cycle all four cards, including a live reading view whose hidden xterm cannot take focus.
  for (const project of [legacy, closed]) {
    await page.locator(`[data-project-id="${project.id}"]`).getByRole('button', { name: '只打开终端', exact: true }).click();
    await waitFor(async () => (await state()).projects.find(item => item.id === project.id).shellReady, 'navigation shell ready');
  }
  await page.evaluate(id => window.agentrix.writeTerminal(id, "Send-AgentrixEvent 'codex-started'; Start-Sleep 3600\r"), local.id);
  await waitFor(async () => (await state()).projects.find(project => project.id === local.id).codexActive, 'navigation fake agent session');
  await first.locator('.reading-composer textarea').waitFor();
  const order = [legacy, closed, remote, local], hud = page.locator('.project-switch-hud');
  assert.equal(await hud.getAttribute('aria-live'), 'polite');
  const assertSwitch = async (project, overview = true, input = project === local ? '.reading-composer textarea' : '.xterm-helper-textarea') => {
    const panel = page.locator(`[data-project-id="${project.id}"]`), position = order.indexOf(project) + 1;
    await page.waitForFunction(({ id, overview, input }) => {
      const panel = document.querySelector(`[data-project-id="${id}"]`);
      return panel?.classList.contains('is-nav-target') && (!overview || (input ? document.activeElement?.matches(input) && panel.contains(document.activeElement) : document.activeElement === panel));
    }, { id: project.id, overview, input });
    assert.equal(await page.locator('.project-panel.is-nav-target').count(), 1);
    assert.equal(await hud.locator('.project-switch-name').textContent(), project.name);
    assert.equal(await hud.locator('.project-switch-index').textContent(), String(position).padStart(2, '0'));
    assert.equal(await hud.locator('.project-switch-position').textContent(), `${position} / ${order.length}`);
    // What people see: a label over the target card itself with its number, name and position.
    const label = panel.locator('.panel-nav-hud');
    assert.equal(await label.isVisible(), true);
    assert.equal(await label.locator('b').textContent(), project.name);
    assert.equal(await label.locator('small').textContent(), `${position} / ${order.length}`);
    assert.equal(await page.locator('.panel-nav-hud').count(), 1, 'only the target card carries the label');
    if (overview) assert.equal(await page.locator('.focus-mode').count(), 0, 'shortcut focus never expands a small card');
    else assert.equal(await panel.isVisible(), true);
  };
  await second.locator('.xterm-helper-textarea').focus();
  for (const project of [local, legacy, closed, remote]) { await page.keyboard.press('Control+Shift+ArrowRight'); await assertSwitch(project); }
  for (const project of [closed, legacy, local, remote]) { await page.keyboard.press('Control+Shift+ArrowLeft'); await assertSwitch(project); }
  await page.keyboard.press('Control+Shift+ArrowRight'); await page.waitForTimeout(350); await page.screenshot({ path: path.join(output, 'project-switch-overview.png') }); await page.keyboard.press('Control+Shift+ArrowLeft'); await assertSwitch(remote);
  // If the composer refuses focus, the hidden xterm also fails and the card is the final fallback.
  await first.locator('.reading-composer textarea').evaluate(node => { node.focus = () => {}; });
  try { await page.keyboard.press('Control+Shift+ArrowRight'); await assertSwitch(local, true, null); }
  finally { await first.locator('.reading-composer textarea').evaluate(node => { delete node.focus; }); }
  await page.keyboard.press('Control+Shift+ArrowRight'); await assertSwitch(legacy);
  await page.keyboard.press('Control+Shift+ArrowLeft'); await assertSwitch(local);
  await page.keyboard.press('Control+Shift+ArrowLeft'); await assertSwitch(remote);
  // Stopped cards fall back to the card itself. Even a failed card focus must advance the cursor.
  const closedTerminal = (await state()).projects.find(project => project.id === closed.id).terminals[0].id;
  assert.deepEqual(await page.evaluate(id => window.agentrix.closeTerminal(id), closedTerminal), { ok: true, value: true });
  await page.locator(`[data-project-id="${closed.id}"] .xterm-helper-textarea`).waitFor({ state: 'detached' });
  await page.keyboard.press('Control+Shift+ArrowLeft'); await assertSwitch(closed, true, null);
  await second.locator('.xterm-helper-textarea').focus();
  await page.evaluate(id => { document.querySelector(`[data-project-id="${id}"]`).focus = () => {}; }, closed.id);
  try {
    await page.keyboard.press('Control+Shift+ArrowLeft');
    await assertSwitch(closed, false);
    assert.equal(await second.locator('.xterm-helper-textarea').evaluate(node => document.activeElement === node), true);
    await page.keyboard.press('Control+Shift+ArrowLeft'); await assertSwitch(legacy);
  } finally { await page.evaluate(id => { delete document.querySelector(`[data-project-id="${id}"]`).focus; }, closed.id); }
  // Turning off motion leaves a static blue ring, and repeated presses renew the feedback timer.
  const motion = await page.evaluate(() => document.documentElement.dataset.motion);
  await page.evaluate(() => { document.documentElement.dataset.motion = 'off'; });
  await page.keyboard.press('Control+Shift+ArrowLeft'); await assertSwitch(local);
  assert.equal(await first.locator('.panel-nav-ring').evaluate(node => getComputedStyle(node).animationName), 'none');
  await page.waitForTimeout(700);
  await page.keyboard.press('Control+Shift+ArrowRight'); await assertSwitch(legacy);
  await page.waitForTimeout(700);
  assert.equal(await legacyPanel.evaluate(node => node.classList.contains('is-nav-target')), true, 'feedback timer restarts after each switch');
  await page.waitForFunction(() => !document.querySelector('.project-panel.is-nav-target, .panel-nav-hud, .project-switch-hud-content'));
  await page.evaluate(motion => { if (motion) document.documentElement.dataset.motion = motion; else delete document.documentElement.dataset.motion; }, motion);
  await first.getByRole('button', { name: `全屏查看 ${local.name}`, exact: true }).click(); await settled(true);
  await page.keyboard.press('Control+Shift+ArrowRight'); await settled(true); await assertSwitch(legacy, false);
  await page.keyboard.press('Control+Shift+ArrowLeft'); await settled(true); await assertSwitch(local, false);
  await page.screenshot({ path: path.join(output, 'project-switch-expanded.png') });
  await page.getByRole('button', { name: '返回总览', exact: true }).click(); await settled(false);
  await second.getByRole('button', { name: `${remote.name} 的更多操作`, exact: true }).click();
  await page.getByRole('menuitem', { name: '打开项目目录', exact: true }).click(); await settled(true);
  await page.getByRole('treeitem', { name: 'README.md', exact: true }).waitFor();
  await page.getByRole('button', { name: '返回总览', exact: true }).click(); await settled(false);
  for (const target of ['/srv/fixture/docs/nested', '/srv/fixture/docs-alias']) {
    // The SSH fixture echoes through the real transport, including this OSC-8 link.
    await page.evaluate(({ id, target }) => window.agentrix.writeTerminal(id, `\x1b[2J\x1b[H\x1b]8;;${target}\x07REMOTE_DOCS_LINK\x1b]8;;\x07\r\n`), { id: remote.id, target });
    const link = second.locator('.xterm-rows').getByText('REMOTE_DOCS_LINK', { exact: true });
    await link.waitFor();
    await terminalsSettled(page);
    const screen = second.locator('.xterm-screen');
    // Fitting can clear the DOM rows before xterm's next render; even a resolved locator can lose its span.
    // Re-resolve both boxes until two polls agree, rather than measuring a transient row just once.
    let measured, previous;
    await waitFor(async () => {
      const box = await link.boundingBox(), screenBox = await screen.boundingBox();
      if (!box || !screenBox) { previous = null; return false; }
      const geometry = JSON.stringify({ box, screenBox });
      if (geometry !== previous) { previous = geometry; return false; }
      measured = { box, screenBox };
      return true;
    }, 'SSH terminal link geometry stable', 5000);
    const { box, screenBox } = measured;
    const position = { x: box.x - screenBox.x + 20, y: box.y - screenBox.y + box.height / 2 };
    await screen.hover({ position: { x: position.x + 30, y: position.y + 25 } });
    await screen.hover({ position });
    await waitFor(async () => second.locator('.terminal-host').getAttribute('title').then(title => title?.includes(target)), 'terminal link hover ready');
    await screen.click({ position, modifiers: ['Control'] });
    // The folder opens in a popup over the overview: only a project's header or a shortcut opens its page.
    const popup = page.locator('.file-popup');
    await popup.getByRole('listitem').filter({ hasText: 'note.txt' }).waitFor();
    assert.equal(await page.locator('.focus-mode').count(), 0, 'a folder link never opens the project page');
    await page.waitForTimeout(400); // past the popup's fade-in
    await page.screenshot({ path: path.join(output, target.endsWith('docs-alias') ? 'ssh-link-alias.png' : 'ssh-link-directory.png') });
    await page.keyboard.press('Escape'); await popup.waitFor({ state: 'detached' });
  }
  await second.getByRole('button', { name: `全屏查看 ${remote.name}`, exact: true }).click(); await settled(true);
  await page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '文件编辑器', exact: true });
  await editor.fill('# 未保存草稿\n\n[查看文档目录](docs/nested/)\n');
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await page.getByRole('link', { name: '查看文档目录', exact: true }).click();
  assert.ok(await page.getByRole('heading', { name: '未保存草稿', exact: true }).isVisible(), 'cancel keeps the unsaved Markdown draft');
  await app.evaluate(() => { globalThis.editorCloseReply = 1; });
  await page.getByRole('link', { name: '查看文档目录', exact: true }).click();
  await page.locator('.file-preview').waitFor({ state: 'detached' });
  await page.getByRole('treeitem', { name: 'note.txt', exact: true }).waitFor();
  assert.equal((await state()).projects.find(project => project.id === remote.id).sessionId, sessionId);
  assert.deepEqual(await app.evaluate(() => globalThis.navigationOpened), [local.path], 'remote navigation never opens an external app');
  const rejected = await page.evaluate(id => window.agentrix.openLink(id, 'vscode://file/example'), remote.id); assert.equal(rejected.ok, false);
  await page.evaluate(id => window.agentrix.openLink(id, 'https://example.com/docs'), local.id);
  assert.deepEqual(await app.evaluate(() => globalThis.navigationOpened), [local.path, 'https://example.com/docs']);
  const fullScreen = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen());
  assert.equal(await fullScreen(), false, 'project navigation stays windowed until the user chooses fullscreen');
  for (const enabled of [true, false]) {
    await page.keyboard.press('F11'); await waitFor(async () => await fullScreen() === enabled, 'F11 toggles full screen');
    await page.getByRole('button', { name: '返回总览', exact: true }).click(); await settled(false);
    assert.equal(await fullScreen(), enabled, 'returning to the overview preserves the user fullscreen choice');
    await second.getByRole('button', { name: `全屏查看 ${remote.name}`, exact: true }).click(); await settled(true);
    assert.equal(await fullScreen(), enabled, 'opening a project preserves the user fullscreen choice');
  }
  for (const [label, enabled] of [['全屏', true], ['退出全屏', false]]) {
    await page.mouse.move(80, 1);
    await chooseFromAppMenu(page, label);
    await waitFor(async () => await fullScreen() === enabled, 'app menu toggles full screen');
  }
  assert.deepEqual(errors, []);
  console.log('PASS: project entry and return preserve F11 fullscreen; the app menu still enters and exits fullscreen');
  console.log(`PASS: project shortcuts cycle reading/terminal/card focus with renewed ring and HUD in both views; removed sidebar/manual-finish/VS Code actions, local folder/browser retained, SSH root/nested/symlink/Markdown directories stay internal (terminal links in a popup, never the project page) and protect drafts. Screenshots: ${output}`);
} catch (error) { if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
finally { if (app) await app.close(); await ssh.close(); }
