import { testRun } from './test-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright-core';
import { waitFor } from './wait.mjs';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { fileClipboard } = require('../electron/file-clipboard.cjs');
const output = await testRun('clipboard'), profile = path.join(output, 'profile');
const project = { id: randomUUID(), name: '图片路径复制', path: path.join(output, 'project'), restore: { terminal: false, codex: false } };
await fs.mkdir(profile, { recursive: true }); await fs.mkdir(project.path);
const filename = '图片.png', absolute = path.join(project.path, filename);
await fs.copyFile(path.join(root, 'assets/icon.png'), absolute);
await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects: [project], settings: { language: 'zh', notifications: false, restoreSessions: false, closeToTray: false } }));
const env = { ...process.env, AGENTRIX_DATA_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
const packaged = process.argv.includes('--packaged'); let app, page;
const ownClipboard = () => app.evaluate(async ({ clipboard }) => { globalThis.pathClipboardOwner = await clipboard.readText(); });
const formats = () => app.evaluate(async ({ clipboard }) => (await clipboard.read()).flatMap(item => item.types));
async function assertText(expected) {
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), expected);
  assert.deepEqual(await fileClipboard(path.join(root, 'integration'), 'read'), [], 'a copied path must not carry a Windows FileDrop payload');
  assert.ok((await formats()).every(type => type.startsWith('text/')), 'a copied path must not carry image data');
  await ownClipboard();
}
async function copyPath(format) {
  await page.getByRole('treeitem', { name: filename, exact: true }).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '文件操作', exact: true });
  await menu.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))); });
  await menu.getByRole('menuitem', { name: format === 'absolute' ? /^复制绝对路径/ : '复制相对路径' }).click();
}
try {
  app = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Agentrix.exe') : require('electron'), args: packaged ? [] : [root], cwd: root, env });
  page = await app.firstWindow();
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    globalThis.pathClipboardBackup = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
    globalThis.originalWriteText = clipboard.writeText.bind(clipboard);
    clipboard.writeText = async text => {
      if (globalThis.holdPathText) await new Promise(resolve => { globalThis.releasePathText = resolve; });
      await globalThis.originalWriteText(text); globalThis.pathClipboardOwner = text;
    };
  });
  await page.getByRole('button', { name: `进入 ${project.name}`, exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  for (const format of ['absolute', 'absolute', 'relative']) {
    await page.evaluate(({ id, filename }) => window.agentrix.copyEntries(id, [filename]), { id: project.id, filename });
    await ownClipboard();
    assert.deepEqual(await fileClipboard(path.join(root, 'integration'), 'read'), [absolute], 'ordinary Copy still copies the real image file');
    await app.evaluate(() => { globalThis.holdPathText = true; globalThis.releasePathText = null; });
    await copyPath(format);
    await waitFor(async () => app.evaluate(() => !!globalThis.releasePathText), 'path text write starts');
    const notice = format === 'absolute' ? '已复制绝对路径' : '已复制相对路径';
    assert.equal(await page.getByText(notice, { exact: true }).count(), 0, 'success must wait for the async native clipboard write');
    await app.evaluate(() => { globalThis.holdPathText = false; globalThis.releasePathText(); globalThis.releasePathText = null; });
    await page.getByText(notice, { exact: true }).waitFor();
    await assertText(format === 'absolute' ? absolute : filename);
  }
  // An actual bitmap on the system clipboard must also be replaced by plain text.
  const png = Array.from(await fs.readFile(absolute));
  await app.evaluate(async ({ clipboard, ClipboardItem }, png) => { await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]); }, png);
  await ownClipboard(); assert.ok((await formats()).includes('image/png'));
  await copyPath('absolute'); await page.getByText('已复制绝对路径', { exact: true }).waitFor(); await assertText(absolute);
  // Both writes use the real native clipboard; the later path request wins even
  // if the earlier file helper is still preparing or committing FileDrop data.
  await page.evaluate(async ({ id, filename }) => {
    const file = window.agentrix.copyEntries(id, [filename]);
    const text = window.agentrix.copyPaths(id, [filename], 'relative');
    const results = await Promise.all([file, text]);
    if (results.some(result => !result.ok)) throw new Error('Concurrent clipboard operation failed');
  }, { id: project.id, filename });
  await assertText(filename);
  await page.screenshot({ path: path.join(output, 'path-copied.png') });
  await app.evaluate(({ clipboard }) => { clipboard.writeText = async () => { throw new Error('剪贴板写入失败（测试）'); }; });
  await copyPath('relative'); await page.getByText('剪贴板写入失败（测试）', { exact: true }).waitFor();
  assert.equal(await page.getByText('已复制相对路径', { exact: true }).count(), 0);
  await app.evaluate(({ clipboard }) => { clipboard.writeText = globalThis.originalWriteText; });
  await copyPath('absolute'); await page.getByText('已复制绝对路径', { exact: true }).waitFor(); await assertText(absolute);
  console.log(`PASS: image path menus await real clipboard writes; absolute/relative paths replace image/FileDrop formats; newer paths win races; failures surface and copying recovers. Screenshots: ${output}`);
} catch (error) { if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
finally {
  if (app) {
    await app.evaluate(async ({ clipboard }) => {
      globalThis.holdPathText = false; globalThis.releasePathText?.(); clipboard.writeText = globalThis.originalWriteText;
      if (globalThis.pathClipboardOwner !== undefined && await clipboard.readText() === globalThis.pathClipboardOwner) {
        if (globalThis.pathClipboardBackup?.length) await clipboard.write(globalThis.pathClipboardBackup); else await clipboard.clear();
      }
    }).catch(() => {});
    await app.close();
  }
}
