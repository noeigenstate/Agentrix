import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright-core';
import { waitFor } from './wait.mjs';
import { testRun } from './test-output.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url);
const { desktopGlassKind } = require('../electron/desktop-glass.cjs'), backend = desktopGlassKind();
if (!backend) { console.log('SKIP: no desktop glass backend on this system'); process.exit(0); }
const output = await testRun('desktop-glass'), profile = path.join(output, 'profile');
await fs.mkdir(profile, { recursive: true });
const projects = ['清晰文字', '等待查看'].map((name, index) => ({ id: randomUUID(), name, path: path.join(output, 'project-' + index), kind: 'local', unread: index, lastCompletedAt: index ? Date.now() : null, restore: { terminal: false, codex: false } }));
for (const project of projects) { await fs.mkdir(project.path); await fs.writeFile(path.join(project.path, 'README.md'), '# Native glass\n\nThe operating system blurs the real background.\n'); }
await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects, settings: { language: 'zh', surface: 'glass', glassBackground: 'desktop', glassTransparency: 37, terminalRenderer: 'dom', columns: 2, notifications: false, sound: false, announce: false, restoreSessions: false, closeToTray: false, fontSize: 15 } }));
const env = { ...process.env, AGENTRIX_DATA_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
let app, page; const errors = [], results = { backend, checks: [] };
const state = async () => (await page.evaluate(() => window.agentrix.getState())).value;
const write = data => page.evaluate(({ id, data }) => window.agentrix.writeTerminal(id, data), { id: projects[0].id, data });
async function launch() {
  app = await electron.launch({ executablePath: require('electron'), args: [root], cwd: root, env }); page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow, dialog }) => { globalThis.desktopGlassMain = BrowserWindow.getAllWindows()[0]; dialog.showMessageBox = async () => ({ response: 1 }); globalThis.desktopGlassMain.setBounds({ x: 200, y: 120, width: 1500, height: 940 }); });
  await page.waitForSelector('.project-panel');
}
// The grey design paints every surface opaque, so the window is captured from its own page (never the desktop behind it).
async function capture(name) { await page.screenshot({ path: path.join(output, name), timeout: 15000 }); }
try {
  await launch(); assert.ok((await state()).desktopGlass.active); assert.equal((await state()).desktopGlass.restart, false);
  await page.waitForFunction(() => document.documentElement.dataset.surface === 'desktop-glass');
  await page.locator('[data-project-id="' + projects[0].id + '"]').getByRole('button', { name: '只打开终端', exact: true }).click();
  await waitFor(async () => (await state()).projects[0].shellReady, 'shell ready'); const session = (await state()).projects[0].sessionId;
  await write("Clear-Host; Write-Host 'AGENTRIX / DESKTOP GLASS'; Write-Host ''; Write-Host '真正背景 → 系统模糊 → 透明面板 → 清晰文字'; Write-Host ''; Write-Host 'Clear text over the desktop background.'\r");
  await waitFor(() => page.locator('.xterm-rows').innerText().then(text => text.includes('Clear text over the desktop background.')), 'terminal text');
  await capture('native-glass.png');
  await write("Write-Output 'DESKTOP_GLASS_DRAFT'");
  for (const surface of ['glass', 'solid', 'desktop-glass']) {
    await page.evaluate(surface => window.agentrix.settings({ surface: surface === 'desktop-glass' ? 'glass' : surface, glassBackground: surface === 'desktop-glass' ? 'desktop' : 'theme' }), surface);
    await page.waitForFunction(surface => document.documentElement.dataset.surface === surface, surface);
    assert.equal((await state()).projects[0].sessionId, session);
  }
  assert.ok((await page.evaluate(id => window.agentrix.attachTerminal(id), projects[0].id)).value.data.includes('DESKTOP_GLASS_DRAFT')); await write('\x03');
  await page.evaluate(() => window.agentrix.settings({ glassTransparency: 75 }));
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--glass-alpha') === '0.25');
  const pane = await page.locator('.project-panel').first().evaluate(node => ({ opacity: getComputedStyle(node).opacity, backdrop: getComputedStyle(node).backdropFilter, fill: getComputedStyle(node).backgroundColor }));
  assert.equal(pane.opacity, '1'); assert.equal(pane.backdrop, 'none'); assert.equal(pane.fill, 'rgb(36, 36, 36)', 'the card stays the opaque grey at any transparency'); await capture('native-more-transparent.png');
  await page.evaluate(() => window.agentrix.settings({ terminalRenderer: 'gpu' })); await waitFor(() => page.locator('canvas').count().then(count => count > 0), 'GPU terminal'); assert.equal((await state()).projects[0].sessionId, session);
  await page.getByRole('button', { name: '工作台设置', exact: true }).click(); assert.equal(await page.getByRole('combobox', { name: '界面材质', exact: true }).getAttribute('data-value'), 'glass'); assert.equal(await page.getByRole('combobox', { name: '玻璃背景', exact: true }).getAttribute('data-value'), 'desktop'); await capture('settings.png'); await page.getByRole('button', { name: '完成', exact: true }).click();
  const before = await app.evaluate(() => globalThis.desktopGlassMain.getBounds());
  await app.evaluate(() => globalThis.desktopGlassMain.setSize(1300, 820)); await page.waitForTimeout(100); assert.equal(await app.evaluate(() => globalThis.desktopGlassMain.getBounds().width), 1300); await app.evaluate((_electron, bounds) => globalThis.desktopGlassMain.setBounds(bounds), before);
  await app.evaluate(() => globalThis.desktopGlassMain.maximize()); await page.waitForTimeout(300); results.maximized = await app.evaluate(() => globalThis.desktopGlassMain.isMaximized()); await app.evaluate(() => globalThis.desktopGlassMain.unmaximize());
  await page.getByRole('button', { name: '全屏查看 清晰文字', exact: true }).click(); await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]')); await page.waitForTimeout(100); results.fullScreen = await app.evaluate(() => globalThis.desktopGlassMain.isFullScreen());
  await app.evaluate(() => { globalThis.desktopGlassMain.setFullScreen(false); globalThis.desktopGlassMain.setBounds({ x: 200, y: 120, width: 1500, height: 940 }); });
  await page.getByRole('treeitem', { name: 'README.md', exact: true }).click(); await page.locator('.file-preview').waitFor();
  const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
  assert.equal(await page.locator('.app-shell').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(25, 25, 25)'); await cdp.send('Emulation.setEmulatedMedia', { features: [] }); await cdp.detach();
  results.checks.push('material switches preserve terminal and draft; the opaque grey cards ignore the transparency setting; GPU, settings, resizing, expanded file view and reduced transparency work');
  assert.deepEqual(errors, []);
  await app.close(); app = null; await launch(); assert.ok((await state()).desktopGlass.active); assert.equal((await state()).settings.glassTransparency, 75);
  results.checks.push('desktop glass and panel transparency survive restart');
  await page.evaluate(() => window.agentrix.settings({ surface: 'glass', glassBackground: 'theme' }));
  await app.close(); app = null; await launch(); assert.equal((await state()).desktopGlass.active, false);
  await page.evaluate(() => window.agentrix.settings({ surface: 'glass', glassBackground: 'desktop' }));
  await waitFor(async () => (await state()).desktopGlass.restart, 'restart requirement');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.surface), 'glass');
  await page.getByRole('button', { name: '工作台设置', exact: true }).click();
  await page.getByText('重新打开应用后启用桌面磨玻璃；切换设置不会中断当前会话。', { exact: false }).waitFor();
  results.checks.push('ordinary windows retain the original material until the user reopens the app');
  console.log('PASS:', JSON.stringify(results));
} catch (error) { if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
finally { if (app) await app.close(); await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2)); console.log('Desktop glass artifacts:', output); }
