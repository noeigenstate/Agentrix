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

const require = createRequire(import.meta.url), exec = promisify(execFile);
const { createSSHFixture } = require('../tests/helpers/ssh-fixture.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = await testRun('editor-terminals');
const dataDir = path.join(output, 'profile'), codexHome = path.join(output, 'codex-home'), bin = path.join(output, 'bin');
const project = { id: randomUUID(), name: '编辑与分屏验证', path: path.join(output, 'project'), kind: 'local', restore: { terminal: false, codex: false } };
const ssh = await createSSHFixture({ nativeWorker: false });
await fs.writeFile(path.join(ssh.project, 'remote.txt'), 'remote original');
for (const folder of [dataDir, bin, codexHome, path.join(project.path, 'src')]) await fs.mkdir(folder, { recursive: true });
await fs.writeFile(path.join(project.path, 'src', 'main.txt'), 'original\r\n中文\r\n');
await fs.writeFile(path.join(project.path, 'other.txt'), 'other');
await fs.writeFile(path.join(project.path, 'page.html'), '<h1>Original page</h1>');
// These checks read the terminal's rows as HTML, so the compatible (DOM) renderer draws them; gpu-terminal-smoke covers the GPU one.
await fs.writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify({ version: 2, projects: [project], settings: { language: 'zh', terminalRenderer: 'dom', autoSave: false, notifications: false, restoreSessions: true, closeToTray: false } }));
await exec(path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/reference:System.Web.Extensions.dll', `/out:${path.join(bin, 'codex.exe')}`, path.join(root, 'tests/fixtures/multi-codex.cs')], { windowsHide: true });
const env = { ...process.env, AGENTRIX_DATA_DIR: dataDir, AGENTRIX_TEST_RESTORE: '1', AGENTRIX_TEST_SSH_CONFIG: ssh.configFile, CODEX_HOME: codexHome };
delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path'); env[pathKey] = bin + path.delimiter + env[pathKey];
const packaged = process.argv.includes('--packaged');
let application, page, clipboardOwner = null;
const state = async () => (await page.evaluate(() => window.agentrix.getState())).value.projects[0];
const record = (type, turn) => JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type, turn_id: turn } }) + '\n';
async function launch() {
  application = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Agentrix.exe') : require('electron'), args: packaged ? [] : [root], cwd: root, env });
  page = await application.firstWindow();
  await application.evaluate(async ({ clipboard, ClipboardItem }) => { globalThis.clipboardBackup = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)])))))); });
  await application.evaluate(({ dialog }) => { globalThis.editorResponses = []; dialog.showMessageBox = async (_window, options) => ({ response: options.title === '未保存的修改' ? globalThis.editorResponses.shift() ?? 2 : 1 }); });
  await page.waitForSelector('.project-panel');
}
async function answer(value) { await application.evaluate((_electron, value) => globalThis.editorResponses.push(value), value); }
async function readSaved() { return JSON.parse(await fs.readFile(path.join(dataDir, 'workspace.json'), 'utf8')).projects[0]; }
async function restoreClipboard() {
  if (!application || clipboardOwner === null) return;
  await application.evaluate(async ({ clipboard }, owner) => { if (await clipboard.readText() === owner) { if (globalThis.clipboardBackup?.length) await clipboard.write(globalThis.clipboardBackup); else clipboard.clear(); } }, clipboardOwner).catch(() => {});
  clipboardOwner = null;
}
try {
  await launch();
  await page.getByRole('button', { name: '只打开终端', exact: true }).click();
  await waitFor(async () => (await state()).shellReady, 'first terminal');
  const primarySession = (await state()).sessionId;
  // Ctrl+Shift+T adds a split to the project being typed in and focuses it (the SSH project below uses the menu).
  await page.locator('.xterm-helper-textarea').first().focus(); await page.keyboard.press('Control+Shift+T');
  await waitFor(async () => (await state()).terminals.length === 2 && (await state()).terminals.every(item => item.shellReady), 'two ready terminals');
  const ids = (await state()).terminals.map(item => item.id);
  await waitFor(async () => page.evaluate(id => document.activeElement?.closest('[data-terminal-id]')?.dataset.terminalId === id, ids[1]), 'the new split has keyboard focus');
  assert.equal((await state()).terminals[0].sessionId, primarySession);
  for (const [index, id] of ids.entries()) {
    await page.locator(`[data-terminal-id="${id}"] .terminal-split-body`).click({ position: { x: 30, y: 60 } });
    await page.keyboard.type(`[IO.File]::WriteAllText('terminal-${index}.json', (@{Process=$PID;Value='INDEPENDENT_${index}'} | ConvertTo-Json -Compress))`);
    await page.keyboard.press('Enter');
  }
  await waitFor(async () => fs.access(path.join(project.path, 'terminal-1.json')).then(() => true, () => false), 'independent commands');
  await waitFor(async () => (await state()).terminals.every(item => item.shellReady), 'both commands return to their own prompts');
  const proofs = await Promise.all(ids.map((_id, index) => fs.readFile(path.join(project.path, `terminal-${index}.json`), 'utf8').then(JSON.parse)));
  assert.equal(proofs[0].Value, 'INDEPENDENT_0'); assert.equal(proofs[1].Value, 'INDEPENDENT_1');
  assert.ok(proofs.every(proof => Number.isInteger(proof.Process) && proof.Process > 0));
  assert.notEqual(proofs[0].Process, proofs[1].Process, 'each split must own a distinct native shell process');
  for (const [index, id] of ids.entries()) {
    const snapshot = await page.evaluate(id => window.agentrix.attachTerminal(id), id);
    assert.equal(snapshot.value.sessionId, (await state()).terminals[index].sessionId);
    // Raw VT history may contain a prediction from shared PSReadLine history
    // that was erased before submission. Assert the final screen instead.
    const visible = (await page.locator(`[data-terminal-id="${id}"] .xterm-rows`).innerText()).replace(/\s/g, '');
    assert.ok(visible.includes(`INDEPENDENT_${index}`));
    assert.ok(!visible.includes(`INDEPENDENT_${1 - index}`));
  }
  await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  assert.equal(await page.locator('.terminal-split').count(), 2);
  const boxes = await page.locator('.terminal-split').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }));
  assert.ok(boxes.every(box => box.width > 200 && box.height > 150));
  assert.ok(boxes[0].x + boxes[0].width <= boxes[1].x + 2 || boxes[0].y + boxes[0].height <= boxes[1].y + 2);
  await page.screenshot({ path: path.join(output, 'split-terminals.png') });

  await page.getByRole('treeitem', { name: 'src', exact: true }).click();
  await page.getByRole('treeitem', { name: 'main.txt', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^复制绝对路径/ }).click();
  clipboardOwner = path.join(project.path, 'src', 'main.txt');
  assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), path.join(project.path, 'src', 'main.txt'));
  await page.getByRole('treeitem', { name: 'main.txt', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '复制相对路径', exact: true }).click();
  clipboardOwner = 'src/main.txt';
  assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), 'src/main.txt');
  await page.getByRole('treeitem', { name: 'main.txt', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '文件编辑器', exact: true });
  await editor.waitFor();
  assert.equal(await page.getByRole('button', { name: '编辑', exact: true }).count(), 0, 'text files start editable without an edit-button step');
  await editor.fill('saved\n保留中文');
  assert.equal(await page.locator('.preview-readonly').innerText(), '编辑模式 · 未保存，Ctrl+S 保存', 'one edit-mode label hints at Ctrl+S instead of offering buttons');
  assert.equal(await page.locator('.file-preview-toolbar button').count(), 0, 'no save, stop-editing, refresh or copy buttons while editing');
  await page.keyboard.press('Control+s');
  await waitFor(async () => (await fs.readFile(path.join(project.path, 'src', 'main.txt'), 'utf8')) === 'saved\r\n保留中文', 'Ctrl+S saves with original CRLF');
  // Auto save (the default): a pause in typing writes the file, with no shortcut and without taking focus.
  await page.evaluate(() => window.agentrix.settings({ autoSave: true }));
  await editor.fill('auto\n自动保存');
  await waitFor(async () => (await fs.readFile(path.join(project.path, 'src', 'main.txt'), 'utf8')) === 'auto\r\n自动保存', 'a pause in typing saves the file');
  assert.equal(await editor.evaluate(node => document.activeElement === node), true, 'saving does not take focus from the editor');
  assert.equal(await page.locator('.preview-readonly').innerText(), '编辑模式 · 自动保存');
  await page.evaluate(() => window.agentrix.settings({ autoSave: false }));
  await editor.fill('saved\n保留中文'); await page.keyboard.press('Control+s');
  await waitFor(async () => (await fs.readFile(path.join(project.path, 'src', 'main.txt'), 'utf8')) === 'saved\r\n保留中文', 'manual saving again');
  await waitFor(async () => (await page.locator('.preview-readonly').innerText()) === '编辑模式', 'saved state shows plain edit mode');
  // Line numbers: one per line, the caret's line highlighted, and still level with their text after scrolling.
  const gutter = page.locator('.editor-gutter span');
  await waitFor(async () => (await gutter.allInnerTexts()).join(',') === '1,2', 'the editor numbers each line');
  await editor.press('Control+End');
  await waitFor(async () => (await page.locator('.editor-gutter .is-current').innerText()) === '2', 'the caret line number is highlighted');
  await editor.fill(Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join('\n'));
  await editor.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await waitFor(async () => (await gutter.last().innerText()) === '400', 'numbers follow the editor scroll to the last line');
  assert.ok(await gutter.count() < 120, 'only the visible line numbers are drawn');
  const offset = await editor.evaluate(node => {
    const style = getComputedStyle(node), line = parseFloat(style.lineHeight), top = node.getBoundingClientRect().top + parseFloat(style.paddingTop) - node.scrollTop;
    const number = [...document.querySelectorAll('.editor-gutter span')].find(span => span.textContent === '380');
    return Math.abs(number.getBoundingClientRect().top - (top + 379 * line));
  });
  assert.ok(offset < 1, `line numbers stay level with their text (off by ${offset}px)`);
  await page.screenshot({ path: path.join(output, 'file-editor-lines.png') });
  await editor.fill('unsaved draft');
  await answer(2); await page.getByRole('treeitem', { name: 'other.txt', exact: true }).click();
  assert.equal(await editor.inputValue(), 'unsaved draft');
  await answer(0); await page.getByRole('treeitem', { name: 'other.txt', exact: true }).click();
  await waitFor(async () => (await editor.inputValue()) === 'other', 'next file is loaded in the editor');
  assert.equal(await fs.readFile(path.join(project.path, 'src', 'main.txt'), 'utf8'), 'unsaved draft');
  await editor.fill('conflicting draft');
  await fs.writeFile(path.join(project.path, 'other.txt'), 'external update');
  await page.keyboard.press('Control+s');
  await page.getByText(/文件已被其他程序修改/).waitFor();
  assert.equal(await fs.readFile(path.join(project.path, 'other.txt'), 'utf8'), 'external update');
  await answer(1); await page.getByRole('treeitem', { name: 'page.html', exact: true }).click();
  await page.getByRole('button', { name: '源码', exact: true }).click();
  await editor.fill('<h1>Edited HTML</h1>'); await page.keyboard.press('Control+s');
  await waitFor(async () => (await fs.readFile(path.join(project.path, 'page.html'), 'utf8')).includes('Edited HTML'), 'HTML source save');
  await page.getByRole('button', { name: '页面', exact: true }).click();
  await page.frameLocator('iframe.html-preview-frame').getByText('Edited HTML').waitFor();
  await page.getByRole('button', { name: '源码', exact: true }).click();
  // VS Code's editing keys, in the file's language: Ctrl+/ comments the selected lines (one HTML comment around them)
  // and a single Ctrl+Z undoes that; Alt+Up moves a line; Enter keeps the indentation.
  const list = '<ul>\n  <li>one</li>\n  <li>two</li>\n</ul>';
  await editor.fill(list);
  await editor.evaluate(node => node.setSelectionRange(7, 30));
  await editor.press('Control+/');
  assert.equal(await editor.inputValue(), '<ul>\n  <!-- <li>one</li>\n  <li>two</li> -->\n</ul>', 'Ctrl+/ comments the selected lines');
  await page.screenshot({ path: path.join(output, 'file-editor-comment.png') });
  await editor.press('Control+/');
  assert.equal(await editor.inputValue(), list, 'Ctrl+/ again uncomments them');
  await editor.press('Control+z');
  assert.equal(await editor.inputValue(), '<ul>\n  <!-- <li>one</li>\n  <li>two</li> -->\n</ul>', 'one Ctrl+Z undoes one command');
  await editor.press('Control+z');
  assert.equal(await editor.inputValue(), list);
  await editor.evaluate(node => node.setSelectionRange(25, 25));
  await editor.press('Alt+ArrowUp');
  assert.equal(await editor.inputValue(), '<ul>\n  <li>two</li>\n  <li>one</li>\n</ul>', 'Alt+Up moves the line up');
  await editor.evaluate(node => node.setSelectionRange(19, 19));
  await editor.press('Enter'); await editor.pressSequentially('<li>new</li>');
  assert.equal(await editor.inputValue(), '<ul>\n  <li>two</li>\n  <li>new</li>\n  <li>one</li>\n</ul>', 'Enter keeps the indentation');
  // Ctrl+F finds in the file: every match marked, Enter goes to the next, Escape returns to the text with it selected.
  await editor.fill('<p>one</p>\n<p>two</p>\n<p>one more</p>');
  await editor.evaluate(node => node.setSelectionRange(0, 0));
  await editor.press('Control+f');
  const find = page.getByRole('search', { name: '查找', exact: true }), query = find.getByRole('textbox', { name: '查找', exact: true });
  await query.waitFor();
  await waitFor(async () => query.evaluate(node => document.activeElement === node), 'the find box takes the keyboard');
  await query.pressSequentially('one');
  await waitFor(async () => (await find.locator('.editor-find-count').innerText()) === '1/2', 'two matches, the first shown');
  assert.equal(await page.locator('.find-bands i').count(), 2, 'both marked');
  await page.screenshot({ path: path.join(output, 'file-editor-find.png') });
  await query.press('Enter');
  await waitFor(async () => (await find.locator('.editor-find-count').innerText()) === '2/2', 'Enter shows the next');
  await query.press('Escape');
  await find.waitFor({ state: 'detached' });
  assert.deepEqual(await editor.evaluate(node => [document.activeElement === node, node.selectionStart, node.selectionEnd]), [true, 25, 28], 'back in the text, the match selected');
  await editor.fill('<h1>Draft</h1>');
  await page.screenshot({ path: path.join(output, 'file-editor.png') });
  await answer(2); const canceled = await page.evaluate(() => window.agentrix.quit()); assert.equal(canceled.value, false);
  await answer(1); await page.getByRole('button', { name: '返回终端', exact: true }).click();
  await waitFor(async () => (await state()).terminals.every(item => item.shellReady), 'shells still ready after editing');
  console.log('PASS: path copy, text/HTML edits, Ctrl+S, unsaved navigation/quit and save-conflict protection');

  for (const id of ids) await page.evaluate(id => window.agentrix.writeTerminal(id, 'codex\r'), id);
  assert.equal(await page.getByRole('button', { name: '启动 Codex', exact: true }).count(), 0, 'no launch button: agents start from the prompt');
  await waitFor(async () => { const saved = await readSaved(); return !!saved.restore.threadId && !!saved.terminals[0].restore.threadId; }, 'distinct native terminal titles');
  const saved = await readSaved(), threads = [saved.restore.threadId, saved.terminals[0].restore.threadId];
  assert.notEqual(threads[0], threads[1]);
  await fs.appendFile(path.join(codexHome, 'sessions', `rollout-${threads[0]}.jsonl`), record('task_started', 'left-working'));
  await fs.appendFile(path.join(codexHome, 'sessions', `rollout-${threads[1]}.jsonl`), record('task_started', 'right-done') + record('task_complete', 'right-done'));
  await waitFor(async () => { const value = await state(); return value.terminals[0].codexActivity === 'working' && value.terminals[1].codexActivity === 'complete'; }, 'independent Codex status');
  assert.equal((await state()).codexActivity, 'working');
  await restoreClipboard(); await application.close(); application = null;
  await launch();
  await waitFor(async () => (await state()).terminals.length === 2 && (await state()).terminals.every(item => item.codexActive), 'both terminals restored');
  for (const thread of threads) {
    await waitFor(async () => { const receipt = JSON.parse(await fs.readFile(path.join(codexHome, 'sessions', `${thread}-receipt.json`), 'utf8')); return receipt.args.includes('resume') && receipt.args.includes(thread); }, 'exact conversation resumed');
  }
  const secondSession = (await state()).terminals[1].sessionId;
  await page.getByRole('button', { name: `关闭 ${project.name} 终端 1`, exact: true }).click();
  await waitFor(async () => (await state()).terminals.length === 1, 'close one split');
  assert.equal((await state()).terminals[0].sessionId, secondSession);
  assert.equal((await state()).terminals[0].codexActive, true);
  console.log('PASS: independent terminals, automatic splits, exact Codex recovery and closing one without restarting its neighbor');
  const remoteId = (await page.evaluate(() => window.agentrix.addSSHProject({ host: 'fixture', path: '/srv/fixture', name: 'SSH 分屏验证' }))).value;
  const remoteState = async () => (await page.evaluate(() => window.agentrix.getState())).value.projects.find(item => item.id === remoteId);
  await waitFor(async () => (await remoteState()).shellReady, 'SSH terminal ready');
  await page.getByRole('button', { name: 'SSH 分屏验证 的更多操作', exact: true }).click(); await page.getByRole('menuitem', { name: '新建终端并分屏', exact: true }).click();
  await waitFor(async () => (await remoteState()).terminals.length === 2 && (await remoteState()).terminals.every(item => item.shellReady), 'two independent SSH terminals');
  const remoteSecond = (await remoteState()).terminals[1].sessionId;
  await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  await page.getByRole('treeitem', { name: 'remote.txt', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^复制绝对路径/ }).click(); clipboardOwner = '/srv/fixture/remote.txt';
  assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), clipboardOwner);
  await page.getByRole('treeitem', { name: 'remote.txt', exact: true }).click();
  await page.getByRole('textbox', { name: '文件编辑器', exact: true }).fill('saved over SSH\n远程编辑'); await page.keyboard.press('Control+s');
  await waitFor(async () => (await fs.readFile(path.join(ssh.project, 'remote.txt'), 'utf8')).includes('远程编辑'), 'SSH editor save');
  await page.getByRole('button', { name: '返回终端', exact: true }).click();
  await page.getByRole('button', { name: '关闭 SSH 分屏验证 终端 1', exact: true }).click();
  await waitFor(async () => (await remoteState()).terminals.length === 1, 'one SSH terminal closes');
  assert.equal((await remoteState()).terminals[0].sessionId, remoteSecond);
  assert.equal((await page.evaluate(id => window.agentrix.readFile(id, 'remote.txt'), remoteId)).value.content, 'saved over SSH\n远程编辑');
  console.log('PASS: SSH split terminals, Linux absolute paths, editing and file access after closing the first connection');
  console.log(`Screenshots: ${output}`);
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); console.error(`Failure screenshot: ${output}`); }
  throw error;
} finally { if (application) { await restoreClipboard(); await application.close(); } await ssh.close(); }
