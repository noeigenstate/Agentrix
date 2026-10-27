import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright-core';
import { waitFor } from './wait.mjs';
import { testRun } from './test-output.mjs';
import { pick, picked } from './select-helper.mjs';
import { openSettings } from './app-menu-helper.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url), output = await testRun('glass-transparency');
const profile = path.join(output, 'profile'), projectPath = path.join(output, 'project');
await fs.mkdir(profile, { recursive: true }); await fs.mkdir(projectPath, { recursive: true });
await fs.writeFile(path.join(projectPath, 'README.md'), '# Transparency preview\n\nBackground changes; text stays clear.\n');
const project = { id: randomUUID(), name: '透明度预览', path: projectPath, kind: 'local', restore: { terminal: false, codex: false } };
await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects: [project], settings: { language: 'zh', surface: 'glass', terminalRenderer: 'dom', notifications: false, sound: false, announce: false, restoreSessions: false, closeToTray: false } }));
const env = { ...process.env, AGENTRIX_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
const theme = 'grey';
let app, page; const errors = [], samples = [];
const state = async () => (await page.evaluate(() => window.agentrix.getState())).value;
async function launch() {
  app = await electron.launch({ executablePath: require('electron'), args: [root], cwd: root, env });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ dialog, BrowserWindow }) => { dialog.showMessageBox = async () => ({ response: 1 }); BrowserWindow.getAllWindows()[0].setContentSize(1500, 920); });
  await page.waitForSelector('.project-panel');
}
async function settings(patch) {
  await page.evaluate(patch => window.agentrix.settings(patch), patch);
  await waitFor(() => page.evaluate(patch => {
    const root = document.documentElement;
    return (!('surface' in patch) || root.dataset.surface === patch.surface) && (!('glassTransparency' in patch) || root.style.getPropertyValue('--glass-alpha') === (patch.glassTransparency === null ? '' : String(1 - patch.glassTransparency / 100)));
  }, patch), 'appearance updates');
}
async function material() {
  return page.locator('.project-panel').evaluate(node => {
    const panel = getComputedStyle(node), before = getComputedStyle(node, '::before'), well = getComputedStyle(node.querySelector('.panel-terminal-area'));
    return { tint: panel.backgroundColor, lensTint: before.backgroundImage, backing: before.backgroundColor, backingDisplay: before.display, wellTint: well.backgroundColor, wellImage: well.backgroundImage, ink: panel.color, opacity: panel.opacity, backdrop: panel.backdropFilter };
  });
}
const alpha = color => { const numbers = color.match(/[\d.]+/g).map(Number); return numbers.length === 4 ? numbers[3] : 1; };
try {
  await launch();
  await page.getByRole('button', { name: '只打开终端', exact: true }).click();
  await waitFor(async () => (await state()).projects[0].shellReady, 'PowerShell ready');
  const session = (await state()).projects[0].sessionId;
  await page.locator('.terminal-host').evaluate(node => { globalThis.transparencyTerminal = node; });
  // shellReady is reported just before PowerShell draws its prompt; keys sent before that are dropped.
  await waitFor(async () => /PS .+> *$/.test(await page.locator('.xterm-rows').innerText()), 'PowerShell prompt drawn');
  await page.evaluate(id => window.agentrix.writeTerminal(id, "Write-Output 'TRANSPARENCY_DRAFT_PRESERVED'"), project.id);
  await waitFor(async () => (await page.locator('.xterm-rows').innerText()).includes('TRANSPARENCY_DRAFT_PRESERVED'), 'draft echoed');
  await settings({ glassTransparency: null }); const original = await material();
  for (const value of [0, 75, 100]) {
    await settings({ glassTransparency: value }); const sample = await material();
    assert.equal(sample.ink, original.ink); assert.equal(sample.opacity, '1');
    // The grey design is opaque: the transparency setting is kept and stored, but no surface follows it.
    assert.deepEqual(sample, original, `transparency ${value}% leaves the flat grey surfaces unchanged`); assert.equal(sample.tint, 'rgb(36, 36, 36)');
    assert.equal((await state()).projects[0].sessionId, session);
    assert.ok(await page.locator('.terminal-host').evaluate(node => node === globalThis.transparencyTerminal));
    samples.push({ theme, value, sample });
  }
  await settings({ glassTransparency: null }); assert.deepEqual(await material(), original, 'Follow theme restores all original material values');
  assert.ok((await page.evaluate(id => window.agentrix.attachTerminal(id), project.id)).value.data.includes('TRANSPARENCY_DRAFT_PRESERVED'));
  await page.evaluate(id => window.agentrix.writeTerminal(id, '\x03'), project.id);
  await settings({ glassTransparency: null });
  await openSettings(page);
  await pick(page, page.getByRole('combobox', { name: '玻璃透明度模式', exact: true }), 'custom');
  await page.getByRole('slider', { name: '背景透明度', exact: true }).fill('63');
  await waitFor(async () => (await state()).settings.glassTransparency === 63, 'slider saved');
  await page.screenshot({ path: path.join(output, 'settings.png') });
  await pick(page, page.getByRole('combobox', { name: '界面材质', exact: true }), 'solid');
  assert.ok(await page.getByRole('slider', { name: '背景透明度', exact: true }).isDisabled());
  assert.ok(await page.getByRole('combobox', { name: '玻璃透明度模式', exact: true }).isDisabled());
  assert.equal((await state()).settings.glassTransparency, 63);
  await pick(page, page.getByRole('combobox', { name: '界面材质', exact: true }), 'glass');
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.getByRole('button', { name: '全屏查看 透明度预览', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.focus-motion-panel'));
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setFullScreen(false); window.setContentSize(1500, 920); });
  await page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
  await page.locator('.file-preview').waitFor();
  const cdp = await page.context().newCDPSession(page);
  await settings({ glassTransparency: 75 });
  const preview = await page.locator('.file-preview').evaluate(node => ({ tint: getComputedStyle(node).backgroundColor, backing: getComputedStyle(node, '::before').backgroundColor, backingDisplay: getComputedStyle(node, '::before').display }));
  assert.equal(preview.tint, 'rgb(25, 25, 25)', theme + ': the file view stays the opaque canvas grey at any transparency: ' + JSON.stringify(preview));
  for (const surface of ['solid', 'glass']) {
    if (surface === 'solid') await page.evaluate(() => window.agentrix.settings({ surface: 'solid' }));
    else { await page.evaluate(() => window.agentrix.settings({ surface: 'glass' })); await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] }); }
    await page.waitForTimeout(100);
    const panes = await page.locator('.focus-sidebar, .project-panel, .file-preview').evaluateAll(nodes => nodes.map(node => { const style = getComputedStyle(node); return { background: style.backgroundColor, backdrop: style.backdropFilter }; }));
    assert.ok(panes.every(pane => alpha(pane.background) === 1 && pane.backdrop === 'none'), theme + ': ' + JSON.stringify(panes));
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
  }
  await page.screenshot({ path: path.join(output, theme + '-expanded.png') });
  await cdp.detach();
  await settings({ glassTransparency: 63 });
  await app.close(); app = null; await launch();
  assert.equal((await state()).settings.glassTransparency, 63);
  await waitFor(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--glass-alpha') === '0.37'), 'transparency restores');
  await settings({ glassTransparency: null }); assert.deepEqual(errors, []);
  console.log('PASS: the transparency setting still stores and restores, while the flat grey surfaces ignore it; terminal identity and draft, slider persistence, opaque expanded panes');
} catch (error) { if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
finally { if (app) await app.close(); await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ samples, errors }, null, 2)); console.log('Transparency artifacts:', output); }
