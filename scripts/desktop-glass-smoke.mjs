import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
async function capture(name) {
  if (await page.locator('dialog[open]').count()) { await page.screenshot({ path: path.join(output, name), timeout: 15000 }); return; }
  await page.evaluate(() => { const marker = document.createElement('i'); marker.id = 'native-capture-marker'; marker.style.cssText = 'position:fixed;left:12px;top:40px;width:12px;height:12px;background:rgb(29,255,145);z-index:2147483647;pointer-events:none'; document.body.append(marker); });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const bounds = await app.evaluate(() => { globalThis.desktopGlassMain.show(); globalThis.desktopGlassMain.moveTop(); globalThis.desktopGlassMain.focus(); return globalThis.desktopGlassMain.getBounds(); });
      await page.waitForTimeout(600);
      if (process.platform === 'win32') execFileSync('powershell.exe', ['-NoProfile', '-File', path.join(output, 'capture.ps1'), path.join(output, name), String(bounds.x), String(bounds.y), String(bounds.width), String(bounds.height)], { windowsHide: true });
      else await page.screenshot({ path: path.join(output, name) });
      const marker = await app.evaluate(({ nativeImage }, filename) => { const image = nativeImage.createFromPath(filename), { width } = image.getSize(), pixels = image.toBitmap(), offset = (46 * width + 18) * 4; return [pixels[offset + 2], pixels[offset + 1], pixels[offset]]; }, path.join(output, name));
      if (marker.every((value, index) => Math.abs(value - [29, 255, 145][index]) < 5)) return;
    }
    throw new Error('Native capture was obscured: did not capture the owned test window');
  } finally { await page.evaluate(() => document.getElementById('native-capture-marker')?.remove()); }
}
try {
  await launch(); assert.ok((await state()).desktopGlass.active); assert.equal((await state()).desktopGlass.restart, false);
  await page.waitForFunction(() => document.documentElement.dataset.surface === 'desktop-glass');
  await app.evaluate(async ({ BrowserWindow }) => {
    const back = new BrowserWindow({ x: 190, y: 110, width: 1520, height: 960, frame: false, backgroundColor: '#ffffff', webPreferences: { sandbox: true } });
    await back.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0;background:repeating-linear-gradient(90deg,#ffd6b3 0 8px,#a1cee6 8px 16px,#ffffff 16px 24px);font:700 72px monospace"><p>REAL BACKGROUND WINDOW</p><p>底层文字，由系统模糊</p><p>0123456789 ABCDEFG</p></body>'));
    back.setAlwaysOnTop(true); back.show(); globalThis.desktopGlassMain.setAlwaysOnTop(true); globalThis.desktopGlassMain.show(); globalThis.desktopGlassMain.focus();
  });
  await fs.writeFile(path.join(output, 'capture.ps1'), 'param([string]$Output,[int]$X,[int]$Y,[int]$Width,[int]$Height)\nAdd-Type -AssemblyName System.Drawing\n$bitmap=New-Object System.Drawing.Bitmap $Width,$Height\n$graphics=[System.Drawing.Graphics]::FromImage($bitmap)\ntry { $graphics.CopyFromScreen($X,$Y,0,0,$bitmap.Size); $bitmap.Save($Output,[System.Drawing.Imaging.ImageFormat]::Png) } finally { $graphics.Dispose(); $bitmap.Dispose() }\n');
  await page.locator('[data-project-id="' + projects[0].id + '"]').getByRole('button', { name: '只打开终端', exact: true }).click();
  await waitFor(async () => (await state()).projects[0].shellReady, 'shell ready'); const session = (await state()).projects[0].sessionId;
  await write("Clear-Host; Write-Host 'AGENTRIX / DESKTOP GLASS'; Write-Host ''; Write-Host '真正背景 → 系统模糊 → 透明面板 → 清晰文字'; Write-Host ''; Write-Host 'Clear text over the desktop background.'\r");
  await waitFor(() => page.locator('.xterm-rows').innerText().then(text => text.includes('Clear text over the desktop background.')), 'terminal text');
  await capture('native-glass.png');
  if (backend === 'windows-compat') {
    const handle = await app.evaluate(() => globalThis.desktopGlassMain.getNativeWindowHandle().readBigUInt64LE().toString());
    execFileSync('powershell.exe', ['-NoProfile', '-File', path.join(root, 'electron', 'desktop-glass.ps1'), handle, '0'], { windowsHide: true }); await capture('native-off-control.png');
    execFileSync('powershell.exe', ['-NoProfile', '-File', path.join(root, 'electron', 'desktop-glass.ps1'), handle, '3'], { windowsHide: true });
    const sharpness = await app.evaluate(({ nativeImage }, output) => {
      return ['native-glass.png', 'native-off-control.png'].map(name => {
        const image = nativeImage.createFromPath(output + '/' + name), { width } = image.getSize(), pixels = image.toBitmap(); let total = 0, count = 0;
        for (let y = 700; y < 800; y += 2) for (let x = 900; x < 1300; x++) { const offset = (y * width + x) * 4; for (let c = 0; c < 3; c++) { total += Math.abs(pixels[offset + c] - pixels[offset + 4 + c]); count++; } }
        return total / count;
      });
    }, output);
    assert.ok(sharpness[0] < sharpness[1] * .6, 'native blur must soften actual background pixels: ' + JSON.stringify(sharpness)); results.sharpness = sharpness;
    results.checks.push('real behind-window content is blurred; compositor pixels differ from blur-off control');
  }
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
  assert.equal(pane.opacity, '1'); assert.equal(pane.backdrop, 'none'); assert.ok(pane.fill.includes('0.25')); await capture('native-more-transparent.png');
  await page.evaluate(() => window.agentrix.settings({ terminalRenderer: 'gpu' })); await waitFor(() => page.locator('canvas').count().then(count => count > 0), 'GPU terminal'); assert.equal((await state()).projects[0].sessionId, session);
  await page.getByRole('button', { name: '工作台设置', exact: true }).click(); assert.equal(await page.getByRole('combobox', { name: '界面材质', exact: true }).inputValue(), 'glass'); assert.equal(await page.getByRole('combobox', { name: '玻璃背景', exact: true }).inputValue(), 'desktop'); await capture('settings.png'); await page.getByRole('button', { name: '完成', exact: true }).click();
  const before = await app.evaluate(() => globalThis.desktopGlassMain.getBounds());
  await app.evaluate(() => globalThis.desktopGlassMain.setSize(1300, 820)); await page.waitForTimeout(100); assert.equal(await app.evaluate(() => globalThis.desktopGlassMain.getBounds().width), 1300); await app.evaluate((_electron, bounds) => globalThis.desktopGlassMain.setBounds(bounds), before);
  await app.evaluate(() => globalThis.desktopGlassMain.maximize()); await page.waitForTimeout(300); results.maximized = await app.evaluate(() => globalThis.desktopGlassMain.isMaximized()); await app.evaluate(() => globalThis.desktopGlassMain.unmaximize());
  await page.getByRole('button', { name: '全屏查看 清晰文字', exact: true }).click(); await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]')); await page.waitForTimeout(100); results.fullScreen = await app.evaluate(() => globalThis.desktopGlassMain.isFullScreen());
  await app.evaluate(() => { globalThis.desktopGlassMain.setFullScreen(false); globalThis.desktopGlassMain.setBounds({ x: 200, y: 120, width: 1500, height: 940 }); });
  await page.getByRole('treeitem', { name: 'README.md', exact: true }).click(); await page.locator('.file-preview').waitFor();
  const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
  assert.equal(await page.locator('.app-shell').evaluate(node => getComputedStyle(node, '::after').backgroundColor), 'rgb(38, 40, 63)'); await cdp.send('Emulation.setEmulatedMedia', { features: [] }); await cdp.detach();
  results.checks.push('material switches preserve terminal and draft; panel alpha changes without another blur; GPU, settings, resizing, expanded file view and reduced transparency work');
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
