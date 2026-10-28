import { testRun } from './test-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { waitFor } from './wait.mjs';
import { setMode } from './mode-switch.mjs';

const require = createRequire(import.meta.url);
const { createSSHFixture } = require('../tests/helpers/ssh-fixture.cjs');
const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = await testRun('sessions');
const dataDir = path.join(output, 'user-data');
const codexHome = path.join(output, 'codex-home');
const bin = path.join(output, 'bin');
await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(path.join(codexHome, 'sessions'), { recursive: true });
await fs.mkdir(bin);
await exec(path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/reference:System.Web.Extensions.dll', `/out:${path.join(bin, 'codex.exe')}`, path.join(root, 'tests/fixtures/restore-codex.cs')], { windowsHide: true });
// The same offline fixture stands in for Claude Code: it records the arguments it was resumed with.
await fs.copyFile(path.join(bin, 'codex.exe'), path.join(bin, 'claude.exe'));
const projects = [];
for (const [index, name] of ['中断的项目', '已结束这一轮', '主动关闭终端', '旧版完成项目'].entries()) {
  const directory = path.join(output, name);
  await fs.mkdir(directory);
  const id = randomUUID(); const sessionId = randomUUID();
  projects.push({ id, name, path: directory, kind: 'local', unread: index === 0 ? 1 : 0, seenEvents: [], restore: { terminal: index !== 2 && index !== 3, codex: index !== 3, cwd: directory }, sessionId });
  await fs.writeFile(path.join(codexHome, 'sessions', `rollout-${sessionId}.jsonl`), [
    { type: 'session_meta', payload: { id: sessionId, cwd: directory, source: 'cli' } },
    { type: 'event_msg', payload: { type: 'task_started' } },
    ...(index === 1 ? [{ type: 'event_msg', payload: { type: 'task_complete' } }] : []),
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
}
// Claude Code sessions: one stopped mid-turn, one whose last turn finished.
const claudeProjects = [];
for (const [index, name] of ['Claude 中断', 'Claude 已完成'].entries()) {
  const directory = path.join(output, name); await fs.mkdir(directory);
  const sessionId = randomUUID();
  claudeProjects.push({ id: randomUUID(), name, path: directory, kind: 'local', seenEvents: [], restore: { terminal: true, codex: true, cwd: directory, agent: 'claude', threadId: sessionId, ...(index === 0 ? { interrupted: true } : {}) }, sessionId });
}
// These checks read the terminal's rows as HTML, so the compatible (DOM) renderer draws them; gpu-terminal-smoke covers the GPU one.
await fs.writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify({ version: 2, projects: [...projects, ...claudeProjects], settings: { language: 'zh', terminalRenderer: 'dom', autoSave: false, notifications: false, sound: false, closeToTray: false, restoreSessions: true } }));
const fixture = await createSSHFixture({ password: true, unknownHost: true, nativeWorker: false });
await fs.writeFile(path.join(fixture.project, 'README.md'), 'REMOTE_TEXT_PREVIEW 中文');
await fs.copyFile(path.join(root, 'assets/icon.png'), path.join(fixture.project, '图片.png'));
await fs.writeFile(path.join(fixture.project, 'page.html'), '<h1>REMOTE_HTML_READY</h1><img src="./图片.png">');
await fs.copyFile(path.join(root, 'tests/fixtures/preview.webm'), path.join(fixture.project, 'preview.webm'));
const env = { ...process.env, AGENTRIX_DATA_DIR: dataDir, AGENTRIX_TEST_RESTORE: '1', AGENTRIX_TEST_SSH_CONFIG: fixture.configFile, CODEX_HOME: codexHome };
const originalPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
env.Path = bin + path.delimiter + originalPath;
delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
const packaged = process.argv.includes('--packaged');
let application; let page;
const errors = [];
async function launch() {
  application = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Agentrix.exe') : require('electron'), args: [...(packaged ? [] : [root]), '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], cwd: root, env, timeout: 30000 });
  page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await application.evaluate(({ BrowserWindow, ipcMain }) => {
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
    globalThis.testInputs = [];
    ipcMain.on('terminal:write', (_event, id, data) => globalThis.testInputs.push({ id, data }));
  });
  await page.waitForSelector('.project-panel');
}
async function receipt(project) { try { return JSON.parse(await fs.readFile(path.join(project.path, 'resume-receipt.json'), 'utf8')); } catch { return null; } }
async function verifyResume() {
  await waitFor(async () => (await receipt(projects[0])) && (await receipt(projects[1])), 'restored Codex processes');
  assert.deepEqual((await receipt(projects[0])).args.slice(2, 4), ['-c', 'tui.terminal_title=["session-id"]']);
  // Then what the reading view can show (electron/features/agents/reading-note.cjs), before the user's own arguments.
  assert.equal((await receipt(projects[0])).args[4], '-c');
  assert.match((await receipt(projects[0])).args[5], /^developer_instructions="You run inside Agentrix[^"]*"$/);
  assert.deepEqual((await receipt(projects[0])).args.slice(6), ['resume', projects[0].sessionId, '继续']);
  assert.deepEqual((await receipt(projects[1])).args.slice(6), ['resume', projects[1].sessionId]);
  assert.equal(await receipt(projects[2]), null);
  assert.equal(await receipt(projects[3]), null);
  // Claude Code resumes its own session through the wrapper (hooks passed with --settings first).
  await waitFor(async () => (await receipt(claudeProjects[0])) && (await receipt(claudeProjects[1])), 'restored Claude Code processes');
  assert.equal((await receipt(claudeProjects[0])).args[0], '--settings');
  assert.equal((await receipt(claudeProjects[0])).args[2], '--append-system-prompt');
  assert.match((await receipt(claudeProjects[0])).args[3], /^You run inside Agentrix/);
  assert.deepEqual((await receipt(claudeProjects[0])).args.slice(4), ['--resume', claudeProjects[0].sessionId, '继续']);
  assert.deepEqual((await receipt(claudeProjects[1])).args.slice(4), ['--resume', claudeProjects[1].sessionId]);
  await waitFor(async () => (await page.evaluate(() => window.agentrix.getState())).value.projects.filter(p => p.codexActive).length === 4, 'four active restored conversations');
  assert.deepEqual((await page.evaluate(() => window.agentrix.getState())).value.projects.filter(p => p.agent === 'claude').map(p => p.id).sort(), claudeProjects.map(p => p.id).sort());
  const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'workspace.json'), 'utf8'));
  assert.equal(stored.projects.find(project => project.id === projects[0].id).completionArmed, true, 'automatic continuation arms a completion alert');
  assert.equal(stored.projects.find(project => project.id === projects[1].id).completionArmed, false, 'opening completed history stays quiet');
  assert.equal(stored.projects.find(project => project.id === claudeProjects[0].id).completionArmed, true, 'continuing an unfinished Claude turn arms a completion alert');
  assert.equal(stored.projects.find(project => project.id === claudeProjects[1].id).completionArmed, false, 'reopening a finished Claude session stays quiet');
  assert.equal(stored.projects.find(project => project.id === claudeProjects[0].id).restore.agent, 'claude', 'the terminal keeps restoring Claude Code');
}
const clipboardText = () => application.evaluate(({ clipboard }) => clipboard.readText());
const setClipboard = text => application.evaluate(async ({ clipboard }, text) => { globalThis.testClipboardLast = text; await clipboard.writeText(text); }, text);
async function backupClipboard() {
  await application.evaluate(async ({ clipboard, ClipboardItem }) => {
    globalThis.testClipboardBackup = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
  });
}
async function restoreClipboard() {
  if (!application) return;
  await application.evaluate(async ({ clipboard }) => {
    if (!globalThis.testClipboardBackup) return;
    if (await clipboard.readText() === globalThis.testClipboardLast) {
      if (globalThis.testClipboardBackup.length) await clipboard.write(globalThis.testClipboardBackup);
      else clipboard.clear();
    }
    globalThis.testClipboardBackup = null;
  }).catch(() => {});
}
try {
  await launch(); await verifyResume();
  assert.ok((await page.evaluate(() => window.agentrix.getState())).value.projects.every(project => !('done' in project)));
  console.log('PASS: interrupted session resumes with 继续; completed round resumes without a prompt; closed and legacy-finished projects stay stopped after migration');
  await application.close(); application = null;
  for (const project of [...projects.slice(0, 2), ...claudeProjects]) await fs.unlink(path.join(project.path, 'resume-receipt.json'));
  await launch(); await verifyResume();
  console.log('PASS: real application restart retains and restores coding state');
  const panel = page.locator(`[data-project-id="${projects[0].id}"]`);
  // A running agent's conversation shows as a document by default; the title-bar switch shows the terminal itself.
  await panel.locator('.reading-view').waitFor();
  await setMode(page, projects[0].name, 'terminal');
  assert.equal(await page.locator('.focus-mode').count(), 0, 'switching to the terminal keeps the small card');
  await waitFor(async () => panel.locator('.xterm-rows').innerText().then(text => text.includes('RESTORE_FIXTURE_READY')), 'rendered terminal text');

  // Keep the user's clipboard formats in this process only; never log them.
  await backupClipboard();
  await panel.locator('textarea').focus();
  await page.keyboard.press('Control+Shift+a');
  await page.keyboard.press('Control+c');
  await waitFor(async () => (await clipboardText()).includes('COPY_SAMPLE_END 中文可复制'), 'selected text copied');
  await application.evaluate(async ({ clipboard }) => { globalThis.testClipboardLast = await clipboard.readText(); });
  assert.ok((await clipboardText()).includes('COPY_SAMPLE_START'), 'selection includes scrollback');
  assert.equal(await page.locator('.focus-mode').count(), 0, 'selection in red card leaves overview visible');
  assert.equal((await page.evaluate(() => window.agentrix.getState())).value.projects[0].codexActive, true, 'Ctrl+C with selection did not interrupt');
  const selectionRect = await panel.locator('.xterm-rows > div').filter({ hasText: 'COPY_SAMPLE_END' }).evaluate(row => {
    const node = row.querySelector('span').firstChild;
    const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 15);
    const box = range.getBoundingClientRect(); return { x: box.x, y: box.y + box.height / 2, end: box.right };
  });
  await page.mouse.move(selectionRect.x + 1, selectionRect.y); await page.mouse.down();
  await page.mouse.move(selectionRect.end + 1, selectionRect.y, { steps: 8 }); await page.mouse.up();
  assert.equal(await panel.locator('.terminal-host').getAttribute('data-has-selection'), 'true');
  assert.equal(await page.locator('.focus-mode').count(), 0, 'mouse selection in a red card does not open fullscreen');
  await page.keyboard.press('Control+c');
  await waitFor(async () => (await clipboardText()) === 'COPY_SAMPLE_END', 'mouse-selected terminal text copied exactly');
  await application.evaluate(async ({ clipboard }) => { globalThis.testClipboardLast = await clipboard.readText(); });
  const host = panel.locator('.terminal-host');
  await host.click({ button: 'right', position: { x: 40, y: 45 } });
  await page.screenshot({ path: path.join(output, 'terminal-copy-menu.png') });
  await page.getByRole('menuitem', { name: '复制全部终端文字', exact: true }).click();
  await waitFor(async () => (await clipboardText()).includes('COPY_SAMPLE_START'), 'copy all retains history');
  await application.evaluate(async ({ clipboard }) => { globalThis.testClipboardLast = await clipboard.readText(); });
  assert.ok((await clipboardText()).includes('COPY_SAMPLE_END 中文可复制'));

  await panel.locator('.panel-terminal-area').click({ position: { x: 42, y: 80 } });
  await page.keyboard.press('Shift+Enter');
  const keyReceipt = path.join(projects[0].path, 'key-receipt.jsonl');
  const receivedKeys = async () => { try { return (await fs.readFile(keyReceipt, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  await waitFor(async () => (await receivedKeys()).some(key => key.key === 'Enter' && key.modifiers === 'Shift'), 'native CLI receives Shift+Enter with the Shift modifier intact');
  assert.equal((await receivedKeys()).some(key => key.key === 'Enter' && key.modifiers === '0'), false, 'Shift+Enter never also sends an ordinary Enter');
  assert.equal(await page.locator('.focus-mode').count(), 0, 'newline entry keeps the small window');
  await page.keyboard.press('Enter');
  await waitFor(async () => (await receivedKeys()).some(key => key.key === 'Enter' && key.modifiers === '0'), 'ordinary Enter remains a submission key');
  console.log('PASS: native Windows CLI receives a real Shift+Enter, ordinary Enter stays distinct, and input stays in the small card');

  await page.keyboard.press('Control+Shift+F');
  const search = page.getByRole('textbox', { name: '搜索项目', exact: true });
  await setClipboard('输入框粘贴 中文🙂');
  await search.focus(); await page.keyboard.press('Control+v');
  await waitFor(async () => (await search.inputValue()) === '输入框粘贴 中文🙂', 'native input paste');
  await search.fill(''); await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Control+Shift+N');
  await page.getByRole('button', { name: /SSH 远程项目/ }).click();
  const sshHost = page.getByLabel('SSH 主机', { exact: true });
  await setClipboard('fixture'); await sshHost.focus(); await page.keyboard.press('Control+v');
  await waitFor(async () => (await sshHost.inputValue()) === 'fixture', 'SSH host field paste');
  await page.getByRole('textbox', { name: '远程项目目录', exact: true }).fill('/srv/fixture');
  await page.getByRole('textbox', { name: '项目名称', exact: true }).fill('远程测试项目');
  await restoreClipboard();
  await page.screenshot({ path: path.join(output, 'add-ssh.png') });
  await page.getByRole('button', { name: '连接并添加', exact: true }).click();
  await page.getByRole('button', { name: '信任并连接', exact: true }).click({ timeout: 15000 });
  await page.getByLabel('SSH 密码或口令', { exact: true }).fill(fixture.secret);
  await page.getByRole('button', { name: '继续连接', exact: true }).click();
  await waitFor(async () => (await page.evaluate(() => window.agentrix.getState())).value.projects.some(p => p.kind === 'ssh' && p.shellReady), 'remote terminal ready after UI authentication');
  const remote = (await page.evaluate(() => window.agentrix.getState())).value.projects.find(p => p.kind === 'ssh');
  for (const target of ['page.html', './page.html', '/srv/fixture/page.html']) {
    const resolved = await page.evaluate(({ id, target }) => window.agentrix.openLink(id, target), { id: remote.id, target });
    assert.deepEqual(resolved, { ok: true, value: { kind: 'file', path: 'page.html' } }, 'SSH relative links use the remote project root');
  }
  const remotePanel = page.locator(`[data-project-id="${remote.id}"]`);
  await remotePanel.getByRole('button', { name: '全屏查看 远程测试项目', exact: true }).click();
  await page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
  await waitFor(async () => (await page.getByLabel('文件编辑器', { exact: true }).inputValue()).includes('REMOTE_TEXT_PREVIEW 中文'), 'remote text opens directly in the editor');
  await page.getByRole('treeitem', { name: '图片.png', exact: true }).click();
  await waitFor(async () => page.locator('img.preview-image').evaluate(image => image.complete && image.naturalWidth === 256), 'SSH PNG streamed');
  await page.getByRole('treeitem', { name: 'page.html', exact: true }).click();
  const html = page.frameLocator('iframe[title="HTML 页面预览"]');
  await html.getByRole('heading', { name: 'REMOTE_HTML_READY', exact: true }).waitFor();
  await waitFor(async () => html.locator('img').evaluate(image => image.complete && image.naturalWidth === 256), 'remote HTML relative image');
  await page.screenshot({ path: path.join(output, 'ssh-preview.png') });
  await page.getByRole('treeitem', { name: 'preview.webm', exact: true }).click();
  const video = page.locator('video');
  await waitFor(async () => video.evaluate(video => video.readyState >= 2), 'remote video loaded');
  await video.evaluate(video => { video.currentTime = 0.5; });
  await waitFor(async () => video.evaluate(video => !video.seeking && video.currentTime >= 0.4), 'remote video byte range seek');
  console.log('PASS: SSH add/authentication UI and remote text, PNG, HTML, video previews with seeking');
  await page.getByRole('button', { name: '关闭文件预览', exact: true }).click();

  await backupClipboard();
  await application.evaluate(() => { globalThis.testInputs = []; });
  const pasted = '终端粘贴 中文🙂';
  await setClipboard(pasted);
  await remotePanel.locator('textarea').focus(); await page.keyboard.press('Control+v');
  await waitFor(async () => application.evaluate((_, text) => globalThis.testInputs.some(item => item.data.includes(text)), pasted), 'terminal Ctrl+V reaches transport');
  await page.keyboard.press('Control+Shift+v'); await page.keyboard.press('Shift+Insert');
  await waitFor(async () => application.evaluate((_, text) => globalThis.testInputs.filter(item => item.data.includes(text)).length === 3, pasted), 'all paste shortcuts send once');
  await page.keyboard.press('Shift+Enter');
  await waitFor(async () => application.evaluate(() => globalThis.testInputs.some(item => item.data === '\x1b[13;2u')), 'SSH receives modified Enter without an ordinary carriage return');
  await page.keyboard.press('Control+c');
  await waitFor(async () => application.evaluate(() => globalThis.testInputs.some(item => item.data === '\x03')), 'Ctrl+C without selection still interrupts');
  // App shortcuts avoid the shell's own keys: Ctrl+A (line start) and Ctrl+F (forward a character) reach the terminal.
  await page.keyboard.press('Control+a'); await page.keyboard.press('Control+f');
  await waitFor(async () => application.evaluate(() => ['\x01', '\x06'].every(key => globalThis.testInputs.some(item => item.data === key))), 'terminal Ctrl+A and Ctrl+F reach the shell');
  assert.equal(await page.locator('dialog[open]').count(), 0, 'Ctrl+A in a terminal does not open add project');
  await restoreClipboard();
  assert.equal((await fs.readFile(path.join(dataDir, 'workspace.json'), 'utf8')).includes(fixture.secret), false);
  assert.deepEqual(errors, []);
  console.log('PASS: native input paste; terminal selection, copy all and paste shortcuts; Ctrl+C interrupt, Ctrl+A and Ctrl+F reach the shell');
  console.log('PASS: SSH add/authentication UI, text/PNG/HTML/video previews and seeking through native SSH');
  console.log(`Screenshots: ${output}`);
} catch (error) {
  console.error(error); process.exitCode = 1;
  if (application) console.error('Input diagnostic:', await application.evaluate(() => globalThis.testInputs));
  if (page) console.error('Focus diagnostic:', await page.evaluate(() => ({ tag: document.activeElement?.tagName, className: document.activeElement?.className })), errors);
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
} finally {
  await restoreClipboard();
  if (application) await application.close();
  await fixture.close();
}
