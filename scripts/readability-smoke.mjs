import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { waitFor } from './wait.mjs';
import { testRun } from './test-output.mjs';
import { pick, picked } from './select-helper.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url);
const { desktopGlassKind } = require('../electron/desktop-glass.cjs');
const backend = desktopGlassKind(), output = await testRun('readability'), profile = path.join(output, 'profile'), project = path.join(output, 'project');
await fs.mkdir(profile); await fs.mkdir(project);
await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects: [{ id: 'readability', name: '字体对照', path: project, kind: 'local', restore: { terminal: false, codex: false } }], settings: { language: 'zh', surface: 'glass', glassBackground: backend ? 'desktop' : 'theme', glassTransparency: 0, fontSize: 16, terminalFontWeight: 400, terminalRenderer: 'gpu', restoreSessions: false, closeToTray: false, notifications: false, sound: false, announce: false } }));
const env = { ...process.env, AGENTRIX_DATA_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
let app, page; const errors = [], results = { backend, fonts: [], checks: [] };
const state = async () => (await page.evaluate(() => window.agentrix.getState())).value;
const write = data => page.evaluate(data => window.agentrix.writeTerminal('readability', data), data);
async function launch() {
  app = await electron.launch({ executablePath: require('electron'), args: [root], cwd: root, env }); page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow, dialog }) => {
    globalThis.readabilityWindow = BrowserWindow.getAllWindows()[0]; globalThis.readabilityCursors = [];
    readabilityWindow.setBounds({ x: 200, y: 120, width: 1500, height: 940 }); readabilityWindow.show(); readabilityWindow.webContents.setBackgroundThrottling(false);
    readabilityWindow.webContents.on('cursor-changed', (_event, type, image) => {
      const cursor = { type };
      if (image && !image.isEmpty()) {
        cursor.size = image.getSize(); const pixels = image.toBitmap(); cursor.dark = 0; cursor.light = 0;
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] === 255) {
          if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) < 40) cursor.dark++;
          if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) > 230) cursor.light++;
        }
      }
      readabilityCursors.push(cursor);
    });
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  page.setDefaultTimeout(30000); await page.waitForSelector('.project-panel'); console.log('test window ready');
}
async function capture(name) {
  const result = await app.evaluate(async () => {
    const image = await readabilityWindow.capturePage({ x: 10, y: 86, width: 1150, height: 235 }, { stayAwake: true });
    const pixels = image.toBitmap(); let ink = 0;
    for (let i = 0; i < pixels.length; i += 4) if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) > 180) ink++;
    return { png: image.toPNG().toString('base64'), ink };
  });
  await fs.writeFile(path.join(output, name), Buffer.from(result.png, 'base64')); return result.ink;
}
try {
  await launch();
  await page.getByRole('button', { name: '只打开终端', exact: true }).click(); await waitFor(async () => (await state()).projects[0].shellReady, 'real shell');
  const session = (await state()).projects[0].sessionId;
  const marker = path.join(output, 'sample.done').replaceAll("'", "''");
  await write("Clear-Host; Write-Host 'AGENTRIX / Readability'; Write-Host ''; Write-Host '这是正文与代码：清晰、明显、稳定。中文字体和 English 0123456789'; Write-Host 'const needsAttention = unread || waitingForInput;'; Write-Host 'ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz'; Write-Host ''; Write-Host '普通文字保持不透明，背景透明度独立调节。'; [System.IO.File]::WriteAllText('" + marker + "', 'done')\r");
  await waitFor(() => fs.access(path.join(output, 'sample.done')).then(() => true, () => false), 'sample completed'); await page.waitForTimeout(300);
  console.log('sample ready'); await page.mouse.move(100, 200); await page.waitForTimeout(150);
  const cursor = await page.locator('.xterm').evaluate(node => getComputedStyle(node).cursor);
  assert.notEqual(cursor, 'none');
  if (backend === 'windows-compat') {
    assert.ok(cursor.includes('data:image/svg+xml')); results.cursors = await app.evaluate(() => readabilityCursors);
    assert.ok(results.cursors.some(item => item.type === 'custom' && item.size.width === 24 && item.size.height === 32 && item.dark > 10 && item.light > 10), 'Chromium must create an opaque dark/white cursor bitmap');
    await page.locator('.xterm').evaluate(node => node.classList.add('enable-mouse-events')); assert.equal(await page.locator('.xterm').evaluate(node => getComputedStyle(node).cursor), 'default');
    await page.locator('.xterm').evaluate(node => { node.classList.remove('enable-mouse-events'); node.classList.add('xterm-cursor-pointer'); }); assert.equal(await page.locator('.xterm').evaluate(node => getComputedStyle(node).cursor), 'pointer');
    await page.locator('.xterm').evaluate(node => node.classList.remove('xterm-cursor-pointer'));
    await page.evaluate(() => window.agentrix.settings({ surface: 'solid' })); await page.waitForFunction(() => document.documentElement.dataset.surface === 'solid');
    assert.ok((await page.locator('.xterm').evaluate(node => getComputedStyle(node).cursor)).includes('data:image/svg+xml'), 'native window keeps its color cursor while showing solid surfaces');
    await page.evaluate(() => window.agentrix.settings({ surface: 'glass', glassBackground: 'desktop' })); await page.waitForFunction(() => document.documentElement.dataset.surface === 'desktop-glass');
    results.checks.push('opaque outlined cursor bitmap retained through surface changes; terminal mouse protocol and links retain original cursors');
  }
  console.log('cursor verified'); await app.evaluate(() => { readabilityWindow.setAlwaysOnTop(true); readabilityWindow.showInactive(); });
  for (const renderer of ['gpu', 'dom']) {
    const counts = [];
    for (const weight of [400, 500, 600]) {
      await page.evaluate(patch => window.agentrix.settings(patch), { terminalRenderer: renderer, terminalFontWeight: weight });
      await page.waitForFunction(weight => document.documentElement.dataset.terminalWeight === String(weight), weight); await page.waitForTimeout(300);
      if (renderer === 'dom') {
        await page.waitForFunction(weight => [...document.querySelectorAll('.xterm-rows span')].some(node => getComputedStyle(node).fontWeight === String(weight) && node.textContent.includes('Readability')), weight);
      } else assert.ok(await page.locator('.xterm canvas').count());
      console.log(renderer + ' weight ' + weight); const ink = await capture(renderer + '-' + weight + '.png'); counts.push(ink); results.fonts.push({ renderer, weight, ink }); assert.equal((await state()).projects[0].sessionId, session);
    }
    assert.ok(counts[2] > counts[0] * 1.15, renderer + ' heavier text must cover more pixels');
    await page.evaluate(() => window.agentrix.settings({ terminalFontWeight: 400 })); await page.waitForTimeout(300); // The cards are opaque now, so Windows draws their text with ClearType and a re-rasterised line can differ by a few sub-pixels: the same raster within 2%.
    const restored = await capture(renderer + '-restored.png'); assert.ok(Math.abs(restored - counts[0]) <= counts[0] * .02, `standard weight restores the same raster: ${restored} vs ${counts[0]}`);
  }
  const cdp = await page.context().newCDPSession(page); await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  async function platformFonts() {
    await page.evaluate(() => {
      document.getElementById('font-probe')?.remove();
      const probe = document.createElement('div'); probe.id = 'font-probe'; probe.style.cssText = 'position:fixed;left:20px;top:100px;opacity:0;pointer-events:none';
      probe.style.fontFamily = document.documentElement.dataset.terminalFontFamily || ''; probe.style.fontSize = '16px'; probe.style.fontWeight = '400';
      probe.innerHTML = '<span id="latin-font-probe">English 0123456789</span><span id="chinese-font-probe">清晰饱满中文字体</span>'; document.body.append(probe);
    });
    const { root } = await cdp.send('DOM.getDocument'), fonts = {};
    for (const [key, selector] of [['latin', '#latin-font-probe'], ['chinese', '#chinese-font-probe']]) {
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      fonts[key] = (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
    }
    await page.evaluate(() => document.getElementById('font-probe')?.remove()); return fonts;
  }
  results.originalFamilies = await platformFonts(); console.log('Original platform fonts: ' + JSON.stringify(results.originalFamilies));
  results.familyComparisons = [];
  for (const renderer of ['gpu', 'dom']) for (const [latin, chinese] of [['Cascadia Code', 'Microsoft YaHei UI'], ['Consolas', 'Microsoft YaHei UI'], ['Cascadia Code', 'Noto Sans SC']]) {
    await page.evaluate(patch => window.agentrix.settings(patch), { terminalRenderer: renderer, terminalFontFamily: latin, terminalCjkFontFamily: chinese, terminalFontWeight: 400 });
    await page.waitForFunction(latin => document.documentElement.dataset.terminalFontFamily?.startsWith("'" + latin + "'"), latin); await page.waitForTimeout(350);
    if (renderer === 'dom') {
      const first = await page.locator('.xterm-rows').evaluate(node => getComputedStyle(node).fontFamily.split(',')[0].trim().replace(/^['"]|['"]$/g, ''));
      assert.equal(first, latin, 'DOM renderer must receive the selected family');
    }
    const actual = await platformFonts(), name = renderer + '-' + latin.replaceAll(' ', '-') + '-' + chinese.replaceAll(' ', '-') + '.png';
    await capture(name); results.familyComparisons.push({ renderer, latin, chinese, actual, screenshot: name });
    assert.equal((await state()).projects[0].sessionId, session);
  }
  await page.evaluate(() => window.agentrix.settings({ terminalFontFamily: '__AgentrixMissingLatin__', terminalCjkFontFamily: '__AgentrixMissingChinese__' })); await page.waitForTimeout(300);
  assert.deepEqual(await platformFonts(), results.originalFamilies, 'unavailable fonts must use the original fallback');
  await page.evaluate(() => window.agentrix.settings({ terminalFontFamily: '', terminalCjkFontFamily: '' })); await page.waitForTimeout(300);
  assert.deepEqual(await platformFonts(), results.originalFamilies, 'empty fields must restore exact original families');
  await cdp.detach();
  results.checks.push('actual Latin/CJK platform families recorded; GPU and DOM live changes; missing and empty families fall back to original fonts');
  await write("Write-Output 'READABILITY_UNSENT_DRAFT'");
  await page.getByRole('button', { name: '工作台设置', exact: true }).click();
  await pick(page, page.getByRole('combobox', { name: '终端字重', exact: true }), '600');
  const latinInput = page.getByLabel('终端西文字体', { exact: true }), chineseInput = page.getByLabel('终端中文字体', { exact: true });
  await latinInput.fill('Consolas'); await latinInput.press('Enter'); await chineseInput.fill('Noto Sans SC'); await chineseInput.press('Enter');
  await page.waitForFunction(() => document.documentElement.dataset.terminalFontFamily.startsWith("'Consolas'") && document.documentElement.dataset.terminalFontFamily.includes("'Noto Sans SC'"));
  await page.getByText('0% 不透明 · 100% 最透明', { exact: true }).waitFor();
  for (const value of [0, 100, 25]) {
    await page.getByRole('slider', { name: '背景透明度', exact: true }).fill(String(value));
    await page.waitForFunction(value => document.documentElement.style.getPropertyValue('--glass-alpha') === String(1 - value / 100), value);
    assert.equal(await page.locator('.project-panel').evaluate(node => getComputedStyle(node).opacity), '1');
  }
  await page.getByRole('button', { name: '完成', exact: true }).click(); assert.equal((await state()).projects[0].sessionId, session);
  assert.ok((await page.evaluate(() => window.agentrix.attachTerminal('readability'))).value.data.includes('READABILITY_UNSENT_DRAFT'));
  const host = await page.locator('.xterm').elementHandle(); await page.evaluate(() => window.agentrix.settings({ terminalFontWeight: 500 })); await page.waitForFunction(() => document.documentElement.dataset.terminalWeight === '500');
  assert.ok(await host.evaluate(node => node.isConnected), 'weight change must preserve the terminal host');
  await page.evaluate(() => window.agentrix.settings({ terminalFontWeight: 600 })); await write('\x03');
  results.checks.push('GPU/DOM weight 400/500/600 actual raster and standard restoration; live setting preserves session, host and unsent draft; 0 opaque/100 transparent; content opacity stays 1');
  await app.close(); app = null; await launch();
  assert.equal((await state()).settings.terminalFontFamily, 'Consolas'); assert.equal((await state()).settings.terminalCjkFontFamily, 'Noto Sans SC'); assert.equal((await state()).settings.terminalFontWeight, 600); assert.equal((await state()).settings.glassTransparency, 25); await page.waitForFunction(() => document.documentElement.dataset.terminalWeight === '600');
  results.checks.push('font families, weight and transparency persist on restart');
  if (backend === 'windows-compat') {
    await page.evaluate(() => window.agentrix.settings({ surface: 'glass', glassBackground: 'theme' })); await app.close(); app = null; await launch();
    assert.equal((await state()).desktopGlass.active, false);
    await page.getByRole('button', { name: '只打开终端', exact: true }).click(); await waitFor(async () => (await state()).projects[0].shellReady, 'ordinary window shell');
    assert.equal(await page.locator('.xterm').evaluate(node => getComputedStyle(node).cursor), 'text');
    results.checks.push('ordinary windows keep the stock system text cursor');
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2)); console.log('PASS ' + output);
} finally { if (app) await app.close(); }
