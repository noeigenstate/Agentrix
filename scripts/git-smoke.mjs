import { testRun } from './test-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright-core';
import { waitFor } from './wait.mjs';

const require = createRequire(import.meta.url), exec = promisify(execFile), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createSSHFixture } = require('../tests/helpers/ssh-fixture.cjs');
const { gitEnvironment } = require('../electron/project-git.cjs');
const output = await testRun('git'), profile = path.join(output, 'profile'), home = path.join(output, 'codex-home');
const ssh = await createSSHFixture({ nativeWorker: false });
const project = { id: randomUUID(), name: 'Git 工作区', path: path.join(output, 'project'), restore: { terminal: false, codex: false } };
const plain = { id: randomUUID(), name: '普通文件夹', path: ssh.home, restore: { terminal: false, codex: false } };
for (const dir of [profile, home, path.join(project.path, 'src')]) await fs.mkdir(dir, { recursive: true });
const git = async (dir, ...args) => (await exec('git', ['-C', dir, ...args], { env: gitEnvironment(), windowsHide: true, encoding: 'utf8' })).stdout.trim();
for (const dir of [project.path, ssh.project]) {
  await git(dir, 'init', '-b', 'main'); await git(dir, 'config', 'user.name', 'Agentrix'); await git(dir, 'config', 'user.email', 'test@example.invalid');
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src/app.ts'), 'export const value = 1;\n');
  await fs.writeFile(path.join(dir, 'README.md'), '# Git workspace'); await fs.writeFile(path.join(dir, 'obsolete.txt'), 'old');
  await git(dir, 'add', '.'); await git(dir, 'commit', '-m', '初始化项目');
  await git(dir, 'checkout', '-b', 'feature/toolbar'); await fs.writeFile(path.join(dir, 'feature.txt'), 'feature'); await git(dir, 'add', '.'); await git(dir, 'commit', '-m', '添加工具栏');
  await git(dir, 'checkout', 'main'); await fs.writeFile(path.join(dir, 'main.txt'), 'main'); await git(dir, 'add', '.'); await git(dir, 'commit', '-m', '完善主界面');
  await git(dir, 'merge', '--no-ff', 'feature/toolbar', '-m', '合并工具栏功能');
  await fs.writeFile(path.join(dir, 'src/app.ts'), 'export const value = 2;\n'); await git(dir, 'add', 'src/app.ts');
  await fs.writeFile(path.join(dir, 'src/app.ts'), 'export const value = 3;\n');
  await fs.unlink(path.join(dir, 'obsolete.txt')); await fs.writeFile(path.join(dir, '待提交.txt'), '新的未提交文件');
}
await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects: [project, plain], settings: { language: 'zh', autoSave: false, restoreSessions: false, closeToTray: false, notifications: false } }));
const env = { ...process.env, AGENTRIX_DATA_DIR: profile, CODEX_HOME: home, AGENTRIX_TEST_SSH_CONFIG: ssh.configFile }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
const packaged = process.argv.includes('--packaged'), errors = [];
let app, page;
const state = async () => (await page.evaluate(() => window.agentrix.getState())).value;
async function openGit(name) {
  await page.getByRole('button', { name: `全屏查看 ${name}`, exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  await page.getByRole('button', { name: 'Git 历史', exact: true }).click();
  await page.getByRole('region', { name: '未提交更改', exact: true }).waitFor();
}
try {
  app = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Agentrix.exe') : require('electron'), args: packaged ? [] : [root], cwd: root, env });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ app, dialog }) => {
    const require = process.getBuiltinModule('module').createRequire(process.getBuiltinModule('path').join(app.getAppPath(), 'package.json'));
    const reader = require('./electron/project-git.cjs').ProjectGit;
    const read = reader.prototype.read;
    globalThis.gitReads = { status: 0, history: 0 };
    reader.prototype.read = function(project, action, value) { if (action in globalThis.gitReads) globalThis.gitReads[action]++; if (action === 'status' && globalThis.gitFail) return Promise.reject(new Error('Git 读取失败（测试）')); return read.call(this, project, action, value); };
    dialog.showMessageBox = async () => ({ response: 2 }); // Cancel navigation away from dirty edits.
  });
  await page.waitForSelector('.project-panel');
  const card = page.locator(`[data-project-id="${project.id}"]`);
  await card.getByRole('button', { name: '只打开终端', exact: true }).click();
  await waitFor(async () => (await state()).projects[0].shellReady, 'terminal ready');
  await page.evaluate(id => window.agentrix.writeTerminal(id, "Write-Output 'GIT_DRAFT_STAYS'"), project.id);
  const session = (await state()).projects[0].sessionId;
  await card.getByRole('button', { name: `全屏查看 ${project.name}`, exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  await page.getByRole('treeitem', { name: 'src', exact: true }).click();
  const appFile = page.getByRole('treeitem', { name: 'app.ts', exact: true });
  await waitFor(async () => (await appFile.getAttribute('data-git-tone')) === 'modified', 'file tree Git decorations');
  assert.equal(await page.getByRole('treeitem', { name: '待提交.txt', exact: true }).getAttribute('data-git-tone'), 'added');
  assert.equal(await page.locator('.focus-sidebar').getByRole('button', { name: /设置/ }).count(), 0);
  assert.ok(await page.locator('.titlebar').getByRole('button', { name: 'Agentrix', exact: true }).isVisible());
  await page.screenshot({ path: path.join(output, 'explorer-status.png') });
  // The editor marks the lines changed but not staged, as the working-tree list has them: app.ts has one.
  await appFile.click();
  await page.locator('.editor-gutter span.git-modified').first().waitFor();
  assert.equal(await page.locator('.editor-gutter span.git-modified').count(), 1, 'the changed line of app.ts is marked');
  await page.screenshot({ path: path.join(output, 'editor-git.png') });
  await page.getByRole('button', { name: '返回终端', exact: true }).click();
  await page.getByRole('button', { name: 'Git 历史', exact: true }).click();
  const panel = page.getByLabel('Git 历史与更改', { exact: true });
  await panel.getByRole('button', { name: /查看提交.*合并工具栏功能/ }).waitFor();
  assert.equal(await page.getByRole('tree', { name: `${project.name} 的文件目录` }).isVisible(), false, 'Git mode collapses the file explorer');
  assert.equal(await panel.locator('.git-working h3').textContent(), '未提交更改3');
  assert.equal(await panel.getByRole('button', { name: '已修改 src/app.ts', exact: true }).count(), 2, 'staged and unstaged edits are distinct');
  // A deleted file opens as its changes too (every line removed), so it can be put back.
  await panel.getByRole('button', { name: '已删除 obsolete.txt', exact: true }).click();
  await page.locator('.git-diff-view').waitFor(); assert.equal(await page.locator('.git-diff-view .git-line-removed pre').first().textContent(), 'old');
  assert.equal(await page.locator('.git-diff-view .git-line-added').count(), 0);
  await page.locator('.git-diff-view').getByRole('button', { name: '返回终端', exact: true }).first().click();
  await panel.getByRole('button', { name: /查看提交.*合并工具栏功能/ }).click();
  await panel.locator('.git-commit-detail').getByText('feature.txt', { exact: true }).waitFor();
  assert.ok(await panel.locator('.git-graph path').count() > 4, 'history includes actual merge edges');
  await page.screenshot({ path: path.join(output, 'git-history.png') });
  const reads = await app.evaluate(() => globalThis.gitReads.history);
  await fs.writeFile(path.join(project.path, '自动刷新.txt'), 'auto');
  await waitFor(async () => panel.getByRole('button', { name: '未跟踪 自动刷新.txt', exact: true }).isVisible(), 'Git status automatically refreshes');
  assert.equal(await app.evaluate(() => globalThis.gitReads.history), reads, 'worktree polling does not repeatedly reload unchanged history');
  await app.evaluate(() => { globalThis.gitFail = true; });
  await panel.getByRole('button', { name: '刷新 Git 状态和历史', exact: true }).click();
  await panel.getByText('Git 读取失败（测试）', { exact: true }).waitFor();
  const failedReads = await app.evaluate(() => globalThis.gitReads.status);
  await new Promise(resolve => setTimeout(resolve, 3400));
  assert.equal(await app.evaluate(() => globalThis.gitReads.status), failedReads, 'failed background reads back off');
  await app.evaluate(() => { globalThis.gitFail = false; });
  await panel.getByRole('button', { name: '刷新 Git 状态和历史', exact: true }).click();
  await panel.getByRole('button', { name: '未跟踪 待提交.txt', exact: true }).waitFor();
  await panel.getByRole('button', { name: '未跟踪 待提交.txt', exact: true }).click();
  // A changed file opens as its changes first; the editor is one click away.
  const changes = page.locator('.git-diff-view'); await changes.waitFor();
  assert.equal(await changes.locator('.git-line-added pre').first().textContent(), '新的未提交文件');
  await changes.getByRole('button', { name: '打开文件', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '文件编辑器', exact: true }); await editor.waitFor();
  assert.equal(await editor.inputValue(), '新的未提交文件'); await editor.fill('未保存草稿');
  await panel.getByRole('button', { name: '已修改 src/app.ts', exact: true }).first().click();
  assert.equal(await editor.inputValue(), '未保存草稿', 'Git file navigation honors the unsaved-edit guard');
  await editor.focus(); await page.keyboard.press('Control+s');
  await waitFor(async () => (await fs.readFile(path.join(project.path, '待提交.txt'), 'utf8')) === '未保存草稿', 'editor saves before leaving the project');
  await page.getByRole('button', { name: '关闭文件预览', exact: true }).click();
  await waitFor(async () => !await editor.count(), 'file preview closed');
  // Changes view: keeping a working-tree hunk stages it, so the file leaves that group; unstaging brings it back.
  await panel.getByRole('button', { name: '已修改 src/app.ts', exact: true }).nth(1).click();
  await changes.waitFor();
  assert.equal(await changes.locator('.git-line-removed pre').first().textContent(), 'export const value = 2;');
  assert.equal(await changes.locator('.git-line-added pre').first().textContent(), 'export const value = 3;');
  await page.screenshot({ path: path.join(output, 'git-changes.png') });
  await changes.getByRole('button', { name: '保留 第 1 处', exact: true }).click();
  await waitFor(async () => !(await git(project.path, 'diff', '--name-only')).includes('src/app.ts'), 'kept hunk is staged');
  await changes.getByText('这个文件没有待处理的更改了。').waitFor();
  await waitFor(async () => await panel.getByRole('button', { name: '已修改 src/app.ts', exact: true }).count() === 1, 'file leaves the working tree group');
  await panel.getByRole('button', { name: '已修改 src/app.ts', exact: true }).click();
  await changes.getByRole('button', { name: '取消暂存 第 1 处', exact: true }).click();
  await waitFor(async () => !(await git(project.path, 'diff', '--cached', '--name-only')).includes('src/app.ts'), 'unstaged hunk returns to the working tree');
  await changes.getByRole('button', { name: '返回终端', exact: true }).first().click();
  await waitFor(async () => !await changes.count(), 'changes view closed');
  await page.getByRole('button', { name: '收起目录栏', exact: true }).click();
  await page.waitForSelector('.focus-sidebar.is-collapsed');
  const count = await app.evaluate(() => globalThis.gitReads.status);
  await new Promise(resolve => setTimeout(resolve, 3400));
  assert.equal(await app.evaluate(() => globalThis.gitReads.status), count, 'collapsed sidebar stops Git polling');
  await page.getByRole('button', { name: 'Git 历史', exact: true }).click(); await panel.waitFor();
  await page.getByRole('button', { name: '资源管理器', exact: true }).click();
  assert.ok(await appFile.isVisible(), 'returning to files preserves expanded folders');
  await page.getByRole('button', { name: 'Git 历史', exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setFullScreen(false); win.unmaximize(); });
  await waitFor(async () => app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isFullScreen() && !BrowserWindow.getAllWindows()[0].isMaximized()), 'leave native fullscreen for narrow-window check');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 620));
  // Windows DPI scaling can round the client size by one CSS pixel (as in the visual test).
  await waitFor(async () => page.evaluate(() => Math.abs(innerWidth - 900) <= 1 && Math.abs(innerHeight - 620) <= 1), `narrow window ${JSON.stringify(await page.evaluate(() => [innerWidth, innerHeight]))}`);
  await panel.getByRole('button', { name: /查看提交.*合并工具栏功能/ }).waitFor();
  const narrowViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.screenshot({ path: path.join(output, 'git-narrow.png') });
  assert.ok(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'narrow Git panel has no horizontal overflow');
  assert.equal((await state()).projects[0].sessionId, session);
  assert.ok((await page.evaluate(id => window.agentrix.attachTerminal(id), project.id)).value.data.includes('GIT_DRAFT_STAYS'));
  await page.getByRole('button', { name: '返回总览', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  const remoteId = (await page.evaluate(() => window.agentrix.addSSHProject({ host: 'fixture', path: '/srv/fixture', name: 'SSH Git' }))).value;
  await waitFor(async () => (await state()).projects.find(item => item.id === remoteId).shellReady, 'SSH ready');
  await openGit('SSH Git');
  await panel.getByRole('button', { name: /查看提交.*合并工具栏功能/ }).waitFor();
  assert.equal(await panel.locator('.git-working h3').textContent(), '未提交更改3');
  await panel.getByRole('button', { name: /查看提交.*合并工具栏功能/ }).click(); await panel.locator('.git-commit-detail').getByText('feature.txt', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'ssh-git.png') });
  await page.getByRole('button', { name: '返回总览', exact: true }).click();
  await page.getByRole('button', { name: `全屏查看 ${plain.name}`, exact: true }).click();
  await page.getByRole('button', { name: 'Git 历史', exact: true }).click();
  await panel.getByText('此项目不是 Git 工作区', { exact: true }).waitFor();
  // Merge conflicts in the editor: each region offers the user's choices and the text changes only when one
  // is picked. The choice is an ordinary edit: Ctrl+Z undoes it, and it is saved like any other edit.
  const conflicted = 'top\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\nbottom\n', resolved = 'top\ntheirs\nbottom\n', conflictFile = path.join(plain.path, '冲突.txt');
  await fs.writeFile(conflictFile, conflicted);
  await page.locator('.explorer-tabs').getByRole('button', { name: '资源管理器', exact: true }).click();
  await page.getByRole('button', { name: '刷新项目目录', exact: true }).click();
  await page.getByRole('treeitem', { name: '冲突.txt', exact: true }).click();
  const conflictEditor = page.getByRole('textbox', { name: '文件编辑器', exact: true });
  await page.getByRole('group', { name: '合并冲突（第 2 行）', exact: true }).waitFor();
  assert.match(await page.locator('.preview-readonly').innerText(), /1 处冲突/);
  await page.screenshot({ path: path.join(output, 'editor-conflict.png') });
  await page.getByRole('button', { name: '保留传入的更改', exact: true }).click();
  await waitFor(async () => (await conflictEditor.inputValue()) === resolved, 'keeping the incoming side replaces only that region');
  await page.keyboard.press('Control+z');
  await waitFor(async () => (await conflictEditor.inputValue()) === conflicted, 'Ctrl+Z undoes the choice');
  await page.getByRole('button', { name: '保留传入的更改', exact: true }).click(); await page.keyboard.press('Control+s');
  await waitFor(async () => (await fs.readFile(conflictFile, 'utf8')) === resolved, 'saving writes the resolved file');
  assert.equal(await page.getByRole('group', { name: '合并冲突（第 2 行）', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ packaged, sessionPreserved: true, localAndSSH: true, narrowViewport, errors }, null, 2));
  console.log(`PASS: editor change bars and user-chosen conflict resolution, explorer Git badges, sidebar switch, staged/worktree/history/merge files, automatic refresh, paused polling, guarded navigation and local/SSH. Evidence: ${output}`);
} catch (error) { console.error(error); if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
finally {
  try {
    if (app) {
      try {
        if (page && !page.isClosed()) {
          await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
          // A slow runner can drop what is typed right after Ctrl+C: exit is sent again until the shell has gone.
          const write = data => page.evaluate(({ id, data }) => window.agentrix.writeTerminal(id, data), { id: project.id, data }).catch(() => {});
          await write('\x03'); let sent = 0;
          await waitFor(async () => {
            if (['exited', 'stopped'].includes((await state()).projects[0].status)) return true;
            if (Date.now() - sent > 3000) { sent = Date.now(); await write('exit\r'); }
            return false;
          }, 'isolated shell exit');
        }
      }
      finally { await app.close(); }
    }
  } finally { await ssh.close(); }
}
