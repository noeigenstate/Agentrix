import { testRun } from './test-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright-core';
import { waitFor, terminalsSettled } from './wait.mjs';
import { pick, picked } from './select-helper.mjs';
import { chooseFromAppMenu, openSettings } from './app-menu-helper.mjs';
const require = createRequire(import.meta.url), exec = promisify(execFile);
const { fileClipboard } = require('../electron/file-clipboard.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = await testRun('workspace'), dataDir = path.join(output, 'profile');
const project = { id: randomUUID(), name: '文件与语音', path: path.join(output, 'project'), kind: 'local', restore: { terminal: false, codex: false } };
await fs.mkdir(project.path, { recursive: true }); await fs.mkdir(dataDir); await fs.mkdir(path.join(output, 'external'));
await fs.writeFile(path.join(project.path, 'source.txt'), 'FILE_CLIPBOARD_CONTENT');
await fs.writeFile(path.join(project.path, 'microphone-check.html'), '<button id="check">Check microphone</button><output id="result"></output><script>document.querySelector("#check").onclick=async()=>{document.querySelector("#result").textContent="CHECKING";try{const stream=await navigator.mediaDevices.getUserMedia({audio:true});stream.getTracks().forEach(track=>track.stop());document.querySelector("#result").textContent="ALLOWED"}catch{document.querySelector("#result").textContent="BLOCKED"}}</script>');
await fs.writeFile(path.join(output, 'external', 'external.txt'), 'PASTE_IN_CONTENT');
await fs.mkdir(path.join(output, 'external', '外部文件夹'));
await fs.writeFile(path.join(output, 'external', '外部文件夹', 'nested.txt'), 'NESTED_PASTE_CONTENT');
await fs.mkdir(path.join(project.path, '目标目录'));
await fs.writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify({ version: 2, projects: [project], settings: { language: 'zh', terminalRenderer: 'dom', fontSize: 12, notifications: false, closeToTray: false, guideVersion: '0.5.0' } }));
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const bin = path.join(output, 'bin'), codexHome = path.join(output, 'codex-home'), claudeHome = path.join(output, 'claude-home');
for (const directory of [bin, codexHome, claudeHome]) await fs.mkdir(directory);
await exec(path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
  ['/nologo', '/target:exe', '/reference:System.Web.Extensions.dll', `/out:${path.join(bin, 'codex.exe')}`, path.join(root, 'tests/fixtures/restore-codex.cs')], { windowsHide: true });
const speech = path.join(output, 'speech.wav');
try { await exec(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/voice-fixture.ps1'), '-Destination', speech], { windowsHide: true }); }
catch (error) {
  if (process.argv.includes('--voice-assets')) throw error;
  const { wavFromSamples } = require('../src/features/voice/voice-audio.ts');
  const tone = Float32Array.from({ length: 16000 * 5 }, (_, index) => Math.sin(index * Math.PI * 880 / 16000) * .08);
  await fs.writeFile(speech, Buffer.from(wavFromSamples(tone)));
  console.log('UI-only test uses a generated tone because system speech synthesis is unavailable.');
}
const assetIndex = process.argv.indexOf('--voice-assets');
const assets = assetIndex >= 0 ? path.resolve(process.argv[assetIndex + 1]) : null;
if (assets) {
  // A folder holding the downloaded SenseVoice files, so the real recognizer runs without a download.
  const { MODELS: { sensevoice } } = require('../electron/voice.cjs');
  await fs.mkdir(path.join(dataDir, 'voice', sensevoice.directory), { recursive: true });
  for (const file of sensevoice.files) await fs.copyFile(path.join(assets, file.name), path.join(dataDir, 'voice', sensevoice.directory, file.name));
}
const packaged = process.argv.includes('--packaged');
const env = { ...process.env, AGENTRIX_DATA_DIR: dataDir, AGENTRIX_TEST_GUIDE: '1', CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path'); env[pathKey] = bin + path.delimiter + env[pathKey];
let application, page;
async function filesFinished() { await waitFor(async () => { const result = await page.evaluate(() => window.agentrix.getFileProgress()); return result.ok && result.value === null; }, 'all files in the paste operation finish'); }
async function backupClipboard() { await application.evaluate(async ({ clipboard, ClipboardItem }) => { globalThis.clipboardBackup = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)])))))); }); }
async function ownClipboard() { await application.evaluate(async ({ clipboard }) => { globalThis.clipboardOwnedText = await clipboard.readText(); }); }
async function restoreClipboard() { if (!application) return; await application.evaluate(async ({ clipboard }) => { if (globalThis.clipboardBackup && await clipboard.readText() === globalThis.clipboardOwnedText) { if (globalThis.clipboardBackup.length) await clipboard.write(globalThis.clipboardBackup); else clipboard.clear(); } globalThis.clipboardBackup = null; }).catch(() => {}); }
try {
  application = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Agentrix.exe') : require('electron'), args: [...(packaged ? [] : [root]), '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${speech}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], cwd: root, env, timeout: 30000 });
  page = await application.firstWindow();
  if (process.argv.includes('--slow-copy')) await application.evaluate(({ ipcMain }) => {
    const handler = ipcMain._invokeHandlers.get('project:directory');
    let delayed = false, active = 0;
    globalThis.directoryPeakRequests = 0;
    ipcMain.removeHandler('project:directory');
    ipcMain.handle('project:directory', async (event, ...args) => {
      active++; globalThis.directoryPeakRequests = Math.max(globalThis.directoryPeakRequests, active);
      try {
        if (!delayed) { delayed = true; await new Promise(resolve => setTimeout(resolve, 4200)); }
        return await handler(event, ...args);
      } finally { active--; }
    });
  });
  await application.evaluate(({ dialog, ipcMain, BrowserWindow }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
    globalThis.voicePastes = [];
    ipcMain.on('terminal:write', (_event, id, data) => globalThis.voicePastes.push({ id, data }));
  });
  if (process.argv.includes('--slow-copy')) await application.evaluate((_, fixtureRoot) => {
    const filesystem = process.mainModule.require('node:fs/promises');
    const copy = filesystem.cp;
    filesystem.cp = async (source, ...rest) => {
      if (String(source).startsWith(fixtureRoot) && String(source).endsWith('外部文件夹')) await new Promise(resolve => setTimeout(resolve, 700));
      return copy(source, ...rest);
    };
  }, output);
  if (!assets) await application.evaluate(({ ipcMain }) => {
    const model = { id: 'sensevoice', label: 'test stub', downloadBytes: 0, phase: 'ready', percent: 100, error: null };
    ipcMain.removeHandler('voice:state'); ipcMain.handle('voice:state', () => ({ ok: true, value: { phase: 'ready', ready: true, percent: 100, model: model.label, error: null, downloadBytes: 0, choice: model.id, active: model.id, models: [model] } }));
    ipcMain.removeHandler('voice:transcribe'); ipcMain.handle('voice:transcribe', (_event, audio) => { if (audio.byteLength < 16000) return { ok: false, error: 'Missing recorded microphone samples' }; return { ok: true, value: 'Please open the project folder and continue the task.' }; });
  });
  // Updating from an older version opens the usage guide on what is new; it can be paged and is shown once.
  const guide = page.locator('dialog.guide-dialog[open]');
  await guide.waitFor();
  const version = (await page.evaluate(() => window.agentrix.getState())).value.version;
  await guide.getByRole('heading', { name: `本次更新 v${version}`, exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'guide-whats-new.png') });
  await guide.getByRole('button', { name: '上一步', exact: true }).click();
  await guide.getByRole('heading', { name: '常用快捷键', exact: true }).waitFor();
  assert.equal(await guide.locator('.guide-keys div', { hasText: '添加项目' }).locator('kbd').innerText(), 'Ctrl+Shift+N', 'the guide shows the shortcuts in use');
  assert.equal(await guide.locator('.guide-keys div', { hasText: '下一个项目' }).locator('kbd').innerText(), 'Ctrl+Shift+→', 'an arrow key reads as an arrow');
  await page.screenshot({ path: path.join(output, 'guide-shortcuts.png') });
  await guide.getByRole('button', { name: '跳过', exact: true }).click();
  await guide.waitFor({ state: 'detached' });
  await waitFor(async () => (await page.evaluate(() => window.agentrix.getState())).value.settings.guideVersion === version, 'the guide is marked as seen for this version');
  assert.equal((await page.evaluate(() => window.agentrix.getState())).value.guide, false);
  await page.keyboard.press('Control+,');
  await page.getByRole('button', { name: '使用指南', exact: true }).click();
  // From Settings the tutorial runs in the window itself: a bubble at the place to act, the rest blocked.
  const tour = page.locator('.tour-bubble'); await tour.waitFor();
  await tour.getByRole('heading', { name: '启动编码助手', exact: true }).waitFor();
  await tour.getByText('在方框里选择 Claude Code 或 Codex：有开发记录时可以接着上次继续，也可以开始新开发。').waitFor();
  assert.equal(await page.locator('.tour-shade').count(), 4, 'everything but the step\'s target is shaded');
  await page.screenshot({ path: path.join(output, 'guide-step.png') });
  const brand = await page.locator('.titlebar-brand').boundingBox();
  await page.mouse.click(brand.x + brand.width / 2, brand.y + brand.height / 2);
  assert.equal(await page.locator('dialog.settings-dialog[open], [role="menu"]').count(), 0, 'the rest of the window cannot be used during a step');
  for (const title of ['下达指令', '放大查看', '设置与更多']) { await tour.getByRole('button', { name: '下一步', exact: true }).click(); await tour.getByRole('heading', { name: title, exact: true }).waitFor(); }
  const ring = await page.locator('.tour-ring').boundingBox();
  assert.ok(ring.width < brand.width + 20 && Math.abs(ring.x + ring.width / 2 - (brand.x + brand.width / 2)) < 4, 'the last step points at the app menu button');
  await page.screenshot({ path: path.join(output, 'guide-last-step.png') });
  await tour.getByRole('button', { name: '完成', exact: true }).click(); await tour.waitFor({ state: 'detached' });
  await openSettings(page); await page.getByRole('button', { name: '使用指南', exact: true }).click();
  await tour.waitFor(); await page.keyboard.press('Escape'); await tour.waitFor({ state: 'detached' });
  console.log('PASS: the usage guide opens on what is new after an update, pages through the steps and shortcuts, and reopens from settings');
  await page.getByRole('button', { name: '只打开终端', exact: true }).click();
  await waitFor(async () => (await page.evaluate(() => window.agentrix.getState())).value.projects[0].shellReady, 'terminal ready');
  await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  const panel = page.locator(`[data-project-id="${project.id}"]`), shell = panel.locator(`[data-terminal-id="${project.id}"]`);
  const projectState = async () => (await page.evaluate(() => window.agentrix.getState())).value.projects[0];
  const write = (id, data) => page.evaluate(({ id, data }) => window.agentrix.writeTerminal(id, data), { id, data });
  const grid = async () => { await page.getByRole('button', { name: '返回总览', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('[data-focus-motion]')); };
  const expand = async () => { await panel.getByRole('button', { name: `全屏查看 ${project.name}`, exact: true }).click(); await page.waitForFunction(() => !document.querySelector('[data-focus-motion]')); await terminalsSettled(page); };
  const shellSession = (await projectState()).terminals[0].sessionId;
  await write(project.id, "Write-Output 'GRID_HIDDEN_SHELL_BUFFER'\r");
  await waitFor(async () => shell.locator('.xterm-rows > div').evaluateAll(rows => rows.some(row => row.textContent.trim() === 'GRID_HIDDEN_SHELL_BUFFER')), 'shell buffer marker renders');
  await terminalsSettled(page);
  await shell.locator('.terminal-host').evaluate(host => {
    // Read the existing TerminalPane ref so the probe can verify the actual xterm and buffer, without test APIs.
    const key = Object.keys(host).find(key => key.startsWith('__reactFiber$'));
    let terminal;
    for (let fiber = host[key]; fiber && !terminal; fiber = fiber.return) {
      for (let hook = fiber.memoizedState; hook; hook = hook.next) {
        const ref = hook.memoizedState?.current;
        if (ref?.buffer?.active && typeof ref.resize === 'function') { terminal = ref; break; }
      }
    }
    if (!terminal) throw new Error('TerminalPane xterm ref was not found');
    window.gridShellIdentity = { host, xterm: host.querySelector('.xterm'), terminal, buffer: terminal.buffer.active, cols: terminal.cols, rows: terminal.rows };
  });
  const identity = () => shell.locator('.terminal-host').evaluate(host => {
    const saved = window.gridShellIdentity;
    return { sameHost: host === saved.host, sameXterm: host.querySelector('.xterm') === saved.xterm, sameBuffer: saved.terminal.buffer.active === saved.buffer,
      cols: saved.terminal.cols, rows: saved.terminal.rows, visible: !!host.getClientRects().length, initialCols: saved.cols, initialRows: saved.rows };
  });
  await grid();
  assert.equal(await shell.isVisible(), false);
  await panel.getByRole('button', { name: '1 个终端运行中 · 点击展开', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  assert.equal(await shell.isVisible(), true, 'the running count expands to show the shell');
  await grid();
  await panel.getByRole('button', { name: '只打开终端', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  assert.equal((await projectState()).terminals[0].sessionId, shellSession, 'plain-launch reuses the existing shell and expands');
  assert.equal((await projectState()).terminals.length, 1);
  await grid();
  await panel.getByRole('button', { name: /^Codex/ }).click();
  await waitFor(async () => (await projectState()).terminals.some(terminal => terminal.codexActive), 'launcher starts the fixture agent in a new dedicated terminal');
  const agentId = (await projectState()).terminals.find(terminal => terminal.codexActive).id;
  const agent = panel.locator(`[data-terminal-id="${agentId}"]`);
  assert.equal((await projectState()).terminals[0].sessionId, shellSession, 'starting an agent never restarts the existing shell');
  assert.equal(await panel.locator('.terminal-split:visible').count(), 1);
  assert.equal(await shell.isVisible(), false); assert.equal(await agent.isVisible(), true);
  assert.equal(await panel.locator('.terminal-grid.has-splits').count(), 0, 'the only visible agent fills the card');
  assert.equal(await panel.locator('.agent-launcher:visible').count(), 0);
  await panel.getByRole('button', { name: '切换到终端', exact: true }).click();
  await waitFor(async () => (await agent.locator('.xterm-rows').innerText()).includes('RESTORE_FIXTURE_READY'), 'fixture CLI is rendered');
  const agentHost = await agent.locator('.terminal-host .xterm').elementHandle();
  await agent.locator('.terminal-split-body').click({ position: { x: 30, y: 40 } });
  await page.keyboard.type('x');
  await backupClipboard();
  await page.keyboard.press('Control+Shift+a'); await page.keyboard.press('Control+Shift+c');
  await waitFor(async () => (await application.evaluate(({ clipboard }) => clipboard.readText())).includes('RESTORE_FIXTURE_READY'), 'grid terminal selection copies its real buffer');
  await ownClipboard(); await restoreClipboard();
  assert.equal(await page.locator('.focus-mode').count(), 0, 'typing, selecting and copying leave the project small');
  await page.keyboard.press('Control+Shift+ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-terminal-id]')?.dataset.terminalId), agentId, 'grid navigation skips the hidden plain terminal');
  assert.equal(await shell.evaluate(node => node.classList.contains('is-active-terminal')), false);
  const hiddenBefore = await identity();
  await page.evaluate(() => window.agentrix.settings({ fontSize: 14 })); await terminalsSettled(page);
  const hiddenAfter = await identity();
  assert.ok(hiddenAfter.sameHost && hiddenAfter.sameXterm && hiddenAfter.sameBuffer);
  assert.deepEqual([hiddenAfter.cols, hiddenAfter.rows], [hiddenBefore.cols, hiddenBefore.rows], 'hidden terminals retain their dimensions during font changes');
  await page.screenshot({ path: path.join(output, 'grid-agent-terminals.png') });
  await expand();
  assert.equal(await panel.locator('.terminal-split:visible').count(), 2, 'expansion restores both the agent and the shell');
  await page.screenshot({ path: path.join(output, 'expanded-agent-terminals.png') });
  const expandedIdentity = await identity();
  assert.ok(expandedIdentity.sameHost && expandedIdentity.sameXterm && expandedIdentity.sameBuffer && expandedIdentity.visible);
  assert.ok(expandedIdentity.cols > 2 && expandedIdentity.rows > 1 && expandedIdentity.cols !== hiddenAfter.cols, 'the retained xterm refits when visible again');
  assert.equal(await agentHost.evaluate(node => node === document.querySelector(`[data-terminal-id="${node.closest('[data-terminal-id]').dataset.terminalId}"] .xterm`)), true, 'the agent DOM also survives expansion');
  assert.equal((await projectState()).terminals[0].sessionId, shellSession);
  assert.ok((await page.evaluate(id => window.agentrix.attachTerminal(id), project.id)).value.data.includes('GRID_HIDDEN_SHELL_BUFFER'));
  await waitFor(async () => (await shell.locator('.xterm-rows').innerText()).includes('GRID_HIDDEN_SHELL_BUFFER'), 'the original shell buffer renders after refit');
  await write(agentId, '\x03');
  await waitFor(async () => (await projectState()).terminals.every(terminal => !terminal.codexActive && terminal.shellReady), 'agent exits back to its shell');
  await grid();
  assert.equal(await panel.locator('.terminal-split:visible').count(), 0, 'an agent exit hides its shell');
  await panel.getByRole('button', { name: '2 个终端运行中 · 点击展开', exact: true }).waitFor();
  await expand();
  await agent.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('codex'); await page.keyboard.press('Enter');
  await waitFor(async () => (await projectState()).terminals.find(terminal => terminal.id === agentId).codexActive, 'typing codex uses the existing wrapper detection');
  await grid();
  assert.equal(await panel.locator('.terminal-split:visible').count(), 1);
  assert.equal(await agent.isVisible(), true);
  await expand(); await write(agentId, '\x03');
  await waitFor(async () => (await projectState()).terminals.every(terminal => !terminal.codexActive && terminal.shellReady), 'typed fixture exits');
  await agent.getByRole('button', { name: `关闭 ${project.name} ${(await projectState()).terminals.find(terminal => terminal.id === agentId).title}`, exact: true }).click();
  await waitFor(async () => (await projectState()).terminals.length === 1, 'only the original shell remains');
  await page.evaluate(() => window.agentrix.settings({ fontSize: 12 })); await terminalsSettled(page);
  assert.equal((await projectState()).terminals[0].sessionId, shellSession);
  console.log('PASS: grid shows only live agents; shell DOM, session, xterm buffer and size survive hiding and refit on expansion');
  console.log('PASS: shell-only launcher, running-count expansion, safe agent allocation, plain-launch expansion, typed detection, agent exit and grid copy/navigation');
  await page.getByRole('treeitem', { name: 'source.txt', exact: true }).waitFor();
  if (process.argv.includes('--slow-copy')) {
    assert.equal(await application.evaluate(() => globalThis.directoryPeakRequests), 1, 'automatic refresh must not overlap or discard a slow directory read');
    console.log('PASS: a directory read slower than the refresh interval still renders, with one request in flight');
  }
  // The project name appears once, as the sidebar title, never again as a root row of the tree.
  assert.equal(await page.locator('.explorer-title h2').innerText(), project.name);
  assert.equal(await page.getByRole('treeitem', { name: project.name, exact: true }).count(), 0);
  assert.equal(await page.locator('.explorer-path').getAttribute('title'), project.path);
  await page.getByRole('button', { name: '新建文件', exact: true }).click();
  await page.getByLabel('文件或文件夹名称', { exact: true }).fill('新文件.txt'); await page.getByRole('button', { name: '创建', exact: true }).click();
  await page.getByRole('treeitem', { name: '新文件.txt', exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(project.path, '新文件.txt'), 'utf8'), '');
  await page.getByRole('treeitem', { name: '新文件.txt', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^重命名/ }).click();
  const renameDialog = page.locator('dialog.file-edit-dialog[open]');
  await renameDialog.getByLabel('文件或文件夹名称', { exact: true }).fill('renamed.txt'); await renameDialog.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('treeitem', { name: 'renamed.txt', exact: true }).waitFor();
  // "打开文件位置" shows the item selected in this computer's file manager (stubbed here: no window opens).
  await application.evaluate(({ shell }) => { globalThis.revealed = []; shell.showItemInFolder = target => globalThis.revealed.push(target); });
  await page.getByRole('treeitem', { name: 'renamed.txt', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '打开文件位置', exact: true }).click();
  await waitFor(async () => (await application.evaluate(() => globalThis.revealed)).length === 1, 'open file location');
  assert.equal((await application.evaluate(() => globalThis.revealed))[0], await fs.realpath(path.join(project.path, 'renamed.txt')));
  await backupClipboard();
  await page.getByRole('treeitem', { name: 'source.txt', exact: true }).click(); await page.keyboard.press('Control+c');
  const copied = await fs.realpath(path.join(project.path, 'source.txt'));
  await waitFor(async () => { const entries = await fileClipboard(path.join(root, 'integration'), 'read'); return entries.length === 1 && entries[0] === copied; }, 'native Windows file clipboard');
  await ownClipboard();
  await exec(powershell, ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/paste-files-fixture.ps1'), '-Destination', path.join(output, 'external'), '-Expected', copied], { windowsHide: true });
  await waitFor(async () => { try { return await fs.readFile(path.join(output, 'external/source.txt'), 'utf8') === 'FILE_CLIPBOARD_CONTENT'; } catch { return false; } }, 'Explorer pastes the copied file outside the project');
  await fileClipboard(path.join(root, 'integration'), 'copy', [path.join(output, 'external/external.txt')]); await ownClipboard();
  // Blank space below the files selects the project root, the destination for a root paste.
  const rootArea = page.getByRole('tree', { name: `${project.name} 的文件目录`, exact: true }), rootBox = await rootArea.boundingBox();
  await rootArea.click({ position: { x: 30, y: rootBox.height - 12 } }); await page.keyboard.press('Control+v');
  await page.getByRole('treeitem', { name: 'external.txt', exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(project.path, 'external.txt'), 'utf8'), 'PASTE_IN_CONTENT');
  await fileClipboard(path.join(root, 'integration'), 'copy', [path.join(output, 'external/external.txt'), path.join(output, 'external/外部文件夹')]); await ownClipboard();
  const tree = page.getByRole('tree', { name: `${project.name} 的文件目录`, exact: true });
  const blank = { x: 35, y: (await tree.boundingBox()).height - 12 };
  await tree.click({ position: blank }); await page.keyboard.press('Control+v');
  await page.getByRole('treeitem', { name: '外部文件夹', exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(project.path, '外部文件夹/nested.txt'), 'utf8'), 'NESTED_PASTE_CONTENT');
  assert.equal(await fs.readFile(path.join(project.path, 'external - 副本.txt'), 'utf8'), 'PASTE_IN_CONTENT');
  assert.equal(await fs.readFile(path.join(project.path, 'external.txt'), 'utf8'), 'PASTE_IN_CONTENT', 'paste preserves the existing file');
  await page.getByRole('treeitem', { name: '目标目录', exact: true }).click();
  await page.getByRole('button', { name: '更多文件操作', exact: true }).click(); await page.getByRole('menuitem', { name: '粘贴文件', exact: true }).click();
  await waitFor(async () => { try { return await fs.readFile(path.join(project.path, '目标目录/外部文件夹/nested.txt'), 'utf8') === 'NESTED_PASTE_CONTENT'; } catch { return false; } }, 'toolbar pastes into the selected directory');
  await filesFinished();
  await tree.click({ position: blank, button: 'right' });
  await page.getByRole('menuitem', { name: /^粘贴/ }).click();
  await waitFor(async () => { try { return await fs.readFile(path.join(project.path, 'external - 副本 (2).txt'), 'utf8') === 'PASTE_IN_CONTENT'; } catch { return false; } }, 'blank-area menu pastes into project root');
  await filesFinished();
  await tree.click({ position: blank }); await page.keyboard.press('Shift+Insert');
  await waitFor(async () => { try { return await fs.readFile(path.join(project.path, 'external - 副本 (3).txt'), 'utf8') === 'PASTE_IN_CONTENT'; } catch { return false; } }, 'Shift+Insert pastes files into the focused explorer');
  await filesFinished();
  console.log('PASS: blank-area Ctrl+V and context menu, toolbar folder destination, multi-file/directory paste and safe duplicate names');
  await restoreClipboard();
  await page.getByRole('treeitem', { name: 'renamed.txt', exact: true }).click(); await page.keyboard.press('Delete');
  await waitFor(async () => { try { await fs.stat(path.join(project.path, 'renamed.txt')); return false; } catch { return true; } }, 'delete moves file out of project');
  await page.locator('[data-node-path="external.txt"]').click({ button: 'right' });
  await page.screenshot({ path: path.join(output, 'file-actions.png') });
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Escape');
  await page.getByRole('menu', { name: '文件操作', exact: true }).waitFor({ state: 'detached', timeout: 5000 });
  assert.equal(await tree.evaluate(element => element === document.activeElement), true, 'Escape closes the menu even without tree focus, then returns keyboard focus');
  await page.getByRole('treeitem', { name: 'microphone-check.html', exact: true }).click();
  const isolated = page.frameLocator('iframe[title="HTML 页面预览"]');
  try {
    await isolated.getByRole('button', { name: 'Check microphone' }).click(); await isolated.getByText('BLOCKED', { exact: true }).waitFor();
  } catch (error) {
    const frame = page.frames().find(frame => frame.url().startsWith('project-preview://'));
    console.error('HTML permission check:', frame ? await frame.evaluate(() => ({ ready: document.readyState, handler: typeof document.querySelector('#check')?.onclick, result: document.querySelector('#result')?.textContent })).catch(() => 'frame unavailable') : 'frame not found');
    throw error;
  }
  console.log('PASS: compact explorer, create/rename/delete, native Explorer copy-out and clipboard paste-in');
  if (await page.getByRole('button', { name: '返回终端', exact: true }).count()) await page.getByRole('button', { name: '返回终端', exact: true }).click();
  // Voice input is in the card's ⋯ menu; while it records, the microphone over the card shows it.
  const showActivity = page.getByRole('button', { name: '显示活动栏：它正在做什么', exact: true });
  if (await showActivity.count()) await showActivity.click();
  assert.equal(await page.locator('.panel-header .voice-button').count(), 0, 'the card header has no microphone of its own');
  const voiceItem = async name => { await page.locator('.project-panel.is-focused').getByRole('button', { name: `${project.name} 的更多操作`, exact: true }).click(); await page.getByRole('menuitem', { name, exact: false }).click(); };
  const recording = () => page.locator('.voice-overlay .voice-stage.is-recording');
  assert.equal(await page.locator('dialog.voice-dialog').count(), 0);
  await voiceItem('语音输入');
  await recording().waitFor();
  await page.waitForTimeout(5500);
  await page.screenshot({ path: path.join(output, 'voice-recording.png') });
  await application.evaluate(() => { globalThis.voicePastes = []; });
  await voiceItem('结束录音并插入');
  await waitFor(async () => application.evaluate(() => globalThis.voicePastes.some(item => /project folder/i.test(item.data))), 'second click inserts the text into the same terminal', 60000);
  assert.equal(await application.evaluate(() => globalThis.voicePastes.some(item => item.data === '\r')), false, 'dictation does not press Enter');
  await page.locator('.voice-overlay').waitFor({ state: 'detached' });
  await page.screenshot({ path: path.join(output, 'voice-input.png') });
  await voiceItem('语音输入'); await recording().waitFor(); await page.keyboard.press('Escape');
  await page.locator('.voice-overlay').waitFor({ state: 'detached' });
  console.log(`PASS: voice input from the card menu, choose it to talk and again to insert ${assets ? 'real SenseVoice recognition' : 'stubbed recognition'} into the terminal without submitting; Escape cancels`);
  // Ctrl+T: a microphone appears in the middle of the project card; Enter inserts the text and then sends it.
  await page.locator('.project-panel.is-focused .xterm-helper-textarea').first().focus();
  await application.evaluate(() => { globalThis.voicePastes = []; });
  await page.keyboard.press('Control+t');
  const overlay = page.locator('.voice-overlay');
  await overlay.waitFor();
  await recording().waitFor();
  await overlay.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  // Centred on the project card it types into, not on the window (the sidebar shifts the card right).
  const box = await overlay.boundingBox(), card = await page.locator('.project-panel.is-focused').boundingBox();
  assert.ok(Math.abs(box.x + box.width / 2 - (card.x + card.width / 2)) < 2 && Math.abs(box.y + box.height / 2 - (card.y + card.height / 2)) < 2, `the microphone sits in the middle of the project card ${JSON.stringify({ box, card })}`);
  assert.equal(await application.evaluate(() => globalThis.voicePastes.some(item => item.data === '\x14')), false, 'Ctrl+T never reaches the terminal');
  await page.waitForTimeout(5500);
  await page.screenshot({ path: path.join(output, 'voice-shortcut.png') });
  await page.keyboard.press('Enter');
  await waitFor(async () => application.evaluate(() => { const pasted = globalThis.voicePastes.findIndex(item => /project folder/i.test(item.data)); return pasted >= 0 && globalThis.voicePastes.findIndex(item => item.data === '\r') > pasted; }), 'Enter inserts the text, then submits it', 60000);
  assert.equal(await application.evaluate(() => globalThis.voicePastes.filter(item => item.data === '\r').length), 1, 'the Enter that stops recording is not also typed into the terminal');
  await overlay.waitFor({ state: 'detached' });
  await application.evaluate(() => { globalThis.voicePastes = []; });
  await page.keyboard.press('Control+t'); await overlay.waitFor(); await page.keyboard.press('Escape'); await overlay.waitFor({ state: 'detached' });
  await page.waitForTimeout(500);
  assert.equal(await application.evaluate(() => globalThis.voicePastes.some(item => item.data === '\r' || item.data === '\x1b' || /project folder/i.test(item.data))), false, 'Escape cancels without inserting, submitting or reaching the terminal');
  console.log('PASS: Ctrl+T shows a microphone centred on the project card; Enter inserts and sends, Escape cancels');
  // Recent projects: a removed local project is offered again in the add dialog and comes back in one click.
  await page.getByRole('button', { name: `${project.name} 的更多操作`, exact: true }).click();
  await page.getByRole('menuitem', { name: '移除项目', exact: true }).click();
  await waitFor(async () => !(await page.evaluate(() => window.agentrix.getState())).value.projects.length, 'project removed');
  await page.getByRole('button', { name: '添加第一个项目', exact: true }).click();
  const recent = page.getByRole('region', { name: '最近的项目', exact: true });
  const entry = recent.getByRole('button', { name: new RegExp(`^${project.name}`) });
  await entry.waitFor();
  assert.equal(await entry.getAttribute('title'), `添加 ${await fs.realpath(project.path)}`);
  await page.screenshot({ path: path.join(output, 'recent-projects.png') });
  await entry.click();
  await page.locator('dialog.project-dialog').waitFor({ state: 'detached' });
  await waitFor(async () => { const state = (await page.evaluate(() => window.agentrix.getState())).value; return state.projects.length === 1 && state.projects[0].name === project.name; }, 'recent project is added again');
  // A project added again waits for an agent to be chosen; no terminal starts by itself.
  await page.locator('.agent-launcher').waitFor();
  assert.equal((await page.evaluate(() => window.agentrix.getState())).value.projects[0].terminals[0].sessionId, null, 'no terminal before an agent is chosen');
  await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('Control+Shift+N');
  await page.locator('dialog.project-dialog').waitFor();
  assert.deepEqual((await page.evaluate(() => window.agentrix.getRecentProjects())).value, [], 'an open project is not listed as recent');
  assert.equal(await recent.count(), 0);
  await page.keyboard.press('Escape');
  console.log('PASS: a removed project is listed under recent projects and one click adds it back, ready to pick an agent');
  // Shortcuts are the user's to change: record a new key for search in settings, use it, then restore defaults.
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Control+,');
  await page.getByRole('heading', { name: '工作台设置', exact: true }).waitFor();
  // One category shows at a time; the others are not even rendered.
  assert.equal(await page.getByRole('button', { name: '搜索项目的快捷键', exact: true }).count(), 0);
  await page.locator('.settings-nav').getByRole('button', { name: '键盘快捷键', exact: true }).click();
  const searchKey = page.getByRole('button', { name: '搜索项目的快捷键', exact: true });
  assert.equal(await searchKey.innerText(), 'Ctrl+Shift+F');
  await searchKey.click(); await page.keyboard.press('Control+Shift+K');
  await waitFor(async () => (await searchKey.innerText()) === 'Ctrl+Shift+K', 'a new key is recorded');
  await searchKey.click(); await page.keyboard.press('Control+t');
  await page.getByText('Ctrl+T 已用于「语音输入」', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('dialog[open]').count(), 1, 'Escape while recording cancels the recording, not the dialog');
  assert.deepEqual((await page.evaluate(() => window.agentrix.getState())).value.settings.shortcuts, { search: 'Ctrl+Shift+K' });
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.keyboard.press('Control+Shift+F');
  assert.equal(await page.getByRole('textbox', { name: '搜索项目', exact: true }).count(), 0, 'the old key no longer searches');
  await page.keyboard.press('Control+Shift+K');
  await page.getByRole('textbox', { name: '搜索项目', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+,');
  await page.locator('.settings-nav').getByRole('button', { name: '键盘快捷键', exact: true }).click();
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  await waitFor(async () => (await searchKey.innerText()) === 'Ctrl+Shift+F', 'restore defaults');
  assert.deepEqual((await page.evaluate(() => window.agentrix.getState())).value.settings.shortcuts, {});
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  console.log('PASS: shortcuts are recorded in settings, conflicts are refused, the new key works and defaults come back');
  // English mode: the window, settings, main-process messages and titles switch together, and back again.
  await page.evaluate(() => window.agentrix.settings({ language: 'en' }));
  await page.locator('.titlebar').getByRole('button', { name: 'Agentrix', exact: true }).click();
  for (const name of ['New project', 'Back to projects', 'Full screen', 'Settings']) await page.getByRole('menuitem', { name, exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
  assert.equal(await page.locator('.status-badge').first().innerText(), 'Not started');
  assert.equal(await page.locator('.agent-launcher-title').innerText(), 'Pick an agent and start');
  await chooseFromAppMenu(page, 'Settings');
  await page.getByRole('heading', { name: 'Workspace settings', exact: true }).waitFor();
  assert.equal(await picked(page.getByRole('combobox', { name: 'Language', exact: true })), 'en');
  await page.screenshot({ path: path.join(output, 'settings-english.png') });
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  assert.equal((await page.evaluate(() => window.agentrix.addRecentProject('C:\\missing-folder'))).error, 'This project is not in the recent list. Choose the folder again.', 'main-process errors arrive in English');
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()), 'Agentrix');
  await page.screenshot({ path: path.join(output, 'grid-english.png') });
  await page.evaluate(() => window.agentrix.settings({ language: 'zh' }));
  await page.locator('.titlebar').getByRole('button', { name: 'Agentrix', exact: true }).click();
  await page.getByRole('menuitem', { name: '新建项目', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.status-badge').first().innerText(), '尚未启动');
  console.log('PASS: English mode translates the window, settings, main-process errors and titles, and switches back');
  console.log(`Screenshots: ${output}`);
} catch (error) {
  console.error(error); process.exitCode = 1;
  if (page) { console.error('UI error:', await page.locator('.form-error, .error-toast, .explorer-file-status').allTextContents().catch(() => [])); await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); }
} finally { await restoreClipboard(); if (application) await application.close(); }
