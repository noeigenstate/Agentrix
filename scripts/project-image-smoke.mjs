import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { _electron as electron } from 'playwright-core';
import { testRun } from './test-output.mjs';
import { waitFor, terminalsSettled } from './wait.mjs';
import { openSettings } from './app-menu-helper.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url);
const output = await testRun('project-image'), profile = path.join(output, 'profile'), home = path.join(output, 'home');
const projects = ['应用项目', '文档项目', '界面与素材', '原样保留'].map(name => ({ id: randomUUID(), name, path: path.join(output, name), restore: { terminal: false, codex: false } }));
for (const dir of [profile, home, ...projects.map(project => project.path)]) await fs.mkdir(dir, { recursive: true });
await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects, settings: {
  language: 'zh', surface: 'solid', startView: 'workspace', terminalRenderer: 'dom',
  restoreSessions: false, closeToTray: false, notifications: false, sound: false, focusAnimation: 'off', guideVersion: '9.9.9'
} }));
const env = { ...process.env, AGENTRIX_DATA_DIR: profile, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, 'codex'), CLAUDE_CONFIG_DIR: path.join(home, 'claude') };
delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
const report = { output, checks: [], errors: [], images: [], imageIdentityChecks: [] };
let app, page;
const launch = async () => {
  app = await electron.launch({ executablePath: require('electron'), args: [root, '--force-device-scale-factor=1'], cwd: root, env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', error => report.errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setFullScreen(false); window.unmaximize(); window.setContentSize(1440, 960); });
  await page.locator('.project-panel').first().waitFor();
};
const stop = async () => { if (!app) return; await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); app = null; };
const state = async () => (await page.evaluate(() => window.agentrix.getState())).value;
const panel = i => page.locator(`[data-project-id="${projects[i].id}"]`);
const projectState = async i => (await state()).projects.find(project => project.id === projects[i].id);
const capture = async filename => { await page.mouse.move(10, 10); await page.screenshot({ path: path.join(output, filename) }); report.images.push(filename); };
const headerIdentities = async () => {
  const expected = (await state()).projects.map((project, index) => ({ id: project.id, image: !!project.image, number: String(index + 1).padStart(2, '0') }));
  const rows = await page.evaluate(projects => {
    const sidebarHidden = !!document.querySelector('.focus-mode .focus-sidebar:not(.is-collapsed)');
    return projects.flatMap(project => {
      const header = document.querySelector('[data-project-id="' + project.id + '"] .panel-header');
      if (!header) return [];
      const bounds = header.getBoundingClientRect();
      if (!bounds.width || !bounds.height || bounds.top < 0 || bounds.bottom > innerHeight + 1 || bounds.right <= 0 || bounds.left >= innerWidth) return [];
      const visible = node => {
        if (!node) return false;
        const style = getComputedStyle(node), box = node.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && box.width > 0 && box.height > 0
          && box.left >= bounds.left - 1 && box.right <= bounds.right + 1 && box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1
          && box.right > 0 && box.left < innerWidth;
      };
      const picture = header.querySelector('.panel-project-image'), fallback = header.querySelector('.panel-project-image-fallback');
      const originals = [...header.querySelectorAll('.panel-index:not(.panel-project-image-fallback)')];
      const container = header.closest('.project-panel'), style = getComputedStyle(container);
      const width = container.getBoundingClientRect().width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth) - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return [{ ...project, width, sidebarHidden, picture: visible(picture), fallback: visible(fallback), numberText: fallback?.textContent, originalCount: originals.length, originalsVisible: originals.filter(visible).length }];
    });
  }, expected);
  assert.ok(rows.length, 'at least one complete project header is visible');
  for (const row of rows) {
    const count = Number(row.picture) + Number(row.fallback) + row.originalsVisible;
    if (row.sidebarHidden) { assert.equal(count, 0, row.id + ' keeps the existing focus-sidebar title suppression'); continue; }
    if (!row.image) { assert.equal(row.originalCount, 1, row.id + ' keeps its original numbered branch'); assert.ok(count <= 1); continue; }
    assert.equal(count, 1, row.id + ' has exactly one visible image or fallback number');
    assert.equal(row.picture, row.width > 300, row.id + ' wide cards show the image');
    assert.equal(row.fallback, row.width <= 300, row.id + ' compact cards show the original number');
    assert.equal(row.numberText, row.number);
  }
  return rows;
};
const dialog = () => page.locator('.project-image-dialog');
const open = async i => {
  await panel(i).getByRole('button', { name: `${projects[i].name} 的更多操作`, exact: true }).click();
  await panel(i).getByRole('menuitem', { name: /项目图片/ }).click();
  await dialog().waitFor();
};
const upload = async filename => {
  const preview = dialog().locator('.project-image-preview img');
  const previous = await preview.count() ? await preview.getAttribute('src') : null;
  await dialog().locator('input[type=file]').setInputFiles(filename);
  await waitFor(async () => { const image = await preview.getAttribute('src').catch(() => null); return image?.startsWith('data:image/') && image !== previous; }, 'manual image decoded');
};
const save = async () => { await dialog().getByRole('button', { name: '保存', exact: true }).click(); await dialog().waitFor({ state: 'detached' }); };
try {
  await launch();
  assert.equal(await page.locator('.panel-header .project-image').count(), 0);
  assert.equal(await page.locator('.panel-header .panel-index:visible').count(), 4);
  assert.ok((await state()).projects.every(project => !project.image && (project.imageMode || 'auto') === 'auto'));
  await capture('original.png');
  await panel(0).getByRole('button', { name: '只打开终端', exact: true }).click();
  await waitFor(async () => (await projectState(0)).shellReady, 'isolated shell ready');
  const session = (await projectState(0)).sessionId;
  await panel(0).locator('.xterm').evaluate(node => { globalThis.projectImageOriginalTerminal = node; });
  await page.evaluate(id => window.agentrix.writeTerminal(id, "echo PROJECT_IMAGE_KEEP_SESSION\r"), projects[0].id);
  await waitFor(() => panel(0).locator('.xterm-rows').innerText().then(text => text.replace(/\s/g, '').includes('PROJECT_IMAGE_KEEP_SESSION')), 'terminal receives real output');
  await page.evaluate(id => window.agentrix.writeTerminal(id, "echo PROJECT_IMAGE_UNSENT_DRAFT"), projects[0].id);
  await waitFor(() => panel(0).locator('.xterm-rows').innerText().then(text => text.replace(/\s/g, '').includes('PROJECT_IMAGE_UNSENT_DRAFT')), 'terminal keeps unsent draft');
  const unchanged = async () => {
    assert.equal((await projectState(0)).sessionId, session);
    assert.equal(await panel(0).locator(`[data-terminal-id="${projects[0].id}"] .xterm`).evaluate(node => node === globalThis.projectImageOriginalTerminal), true);
    const buffer = await page.evaluate(async id => (await window.agentrix.attachTerminal(id)).value.data, projects[0].id);
    assert.ok(stripVTControlCharacters(buffer).replace(/\s/g, '').includes('PROJECT_IMAGE_UNSENT_DRAFT'));
  };
  await open(0); await upload(path.join(root, 'assets/icon.png'));
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  assert.ok(!(await projectState(0)).image); await unchanged();
  assert.equal(await page.locator('.focus-mode').count(), 0);
  report.checks.push('opening, selecting and canceling leave persisted state, small card and terminal draft untouched');
  for (const i of [0, 1, 2]) {
    await open(i);
    const image = path.join(root, ['assets/icon.png', 'assets/icon-mac.png', 'docs/images/reading-view.jpg'][i]);
    await upload(image);
    if (i === 0) {
      await capture('image-dialog.png');
      await dialog().screenshot({ path: path.join(output, 'image-dialog-detail.png') });
    }
    await save();
    assert.ok((await projectState(i)).image.startsWith('data:image/webp;base64,'));
    assert.equal((await projectState(i)).imageMode, 'custom');
    await panel(i).locator('.panel-header .project-image').waitFor();
  }
  await unchanged();
  assert.equal(await panel(3).locator('.panel-index:visible').count(), 1);
  report.checks.push('local images save per project as bounded raster data, while an unconfigured project keeps its original number');
  await openSettings(page);
  const preferences = page.locator('.settings-paned');
  assert.equal(await preferences.locator('[data-settings-tab="project-images"]').count(), 0);
  await preferences.locator('[data-project-images-open]').click();
  const rows = preferences.locator('.project-image-setting-row');
  assert.equal(await rows.count(), projects.length);
  const row = preferences.locator(`[data-project-image-id="${projects[0].id}"]`);
  assert.ok(await row.locator('.project-image-setting-thumb img').isVisible());
  assert.ok((await row.innerText()).includes(projects[0].name));
  await row.locator('.project-image-setting-change').click();
  await dialog().waitFor(); await upload(path.join(root, 'docs/images/voice.jpg'));
  const original = (await projectState(0)).image;
  await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'detached' });
  assert.ok(await preferences.isVisible()); assert.equal((await projectState(0)).image, original);
  assert.equal(await preferences.locator('[data-settings-tab="appearance"]').getAttribute('aria-current'), 'page');
  assert.ok(await preferences.locator('[data-project-images-back]').isVisible());
  await preferences.locator('[data-project-images-back]').click();
  assert.ok(await preferences.locator('[data-project-images-open]').isVisible());
  await preferences.locator('[data-project-images-open]').click();
  assert.equal(await rows.count(), projects.length);
  await preferences.locator('[data-settings-tab="terminal"]').click();
  await preferences.locator('[data-settings-tab="appearance"]').click();
  assert.equal(await preferences.locator('[data-project-images-back]').isVisible(), false);
  await preferences.locator('[data-project-images-open]').click();
  assert.equal(await rows.count(), projects.length);
  await preferences.getByRole('button', { name: '关闭设置', exact: true }).click();
  await preferences.waitFor({ state: 'detached' }); await unchanged();
  report.checks.push('Appearance thumbnail manager lists all projects; child cancellation, Back to appearance and category switching preserve settings and terminal');
  await open(0);
  await dialog().locator('input[type=file]').setInputFiles({ name: 'invalid.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
  await dialog().getByText(/无法读取/).waitFor();
  await page.keyboard.press('Escape');
  await dialog().waitFor({ state: 'detached' }); await unchanged();
  report.checks.push('malformed image is reported; Escape only dismisses the image dialog');
  await capture('grey.png');
  await panel(0).locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+Shift+ArrowRight');
  const target = page.locator('.project-panel.is-nav-target');
  await target.locator('.panel-nav-hud .project-image').waitFor();
  const mark = await target.locator('.panel-nav-hud .project-image').boundingBox();
  assert.equal(mark.width, 48); assert.equal(mark.height, 48);
  report.switchContrast = await target.locator('.panel-nav-hud').evaluate(node => {
    const context = document.createElement('canvas').getContext('2d');
    const rgba = value => { context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data]; };
    const luminance = value => rgba(value).slice(0, 3).map(channel => channel / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
    const background = luminance(getComputedStyle(node).backgroundColor);
    const contrast = element => { const foreground = luminance(getComputedStyle(element).color); return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05); };
    return { name: contrast(node.querySelector('b')), position: contrast(node.querySelector('small')) };
  });
  assert.ok(report.switchContrast.name >= 4.5); assert.ok(report.switchContrast.position >= 4.5);
  await capture('switch-image.png'); await unchanged();
  report.checks.push('keyboard project navigation preserves the terminal; visible switch HUD shows a 48px image');
  await panel(1).locator('.panel-header .project-image').click();
  await page.locator('.focus-mode').waitFor();
  await page.getByRole('button', { name: '返回总览', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.focus-mode'));
  await panel(0).locator('.xterm-helper-textarea').click();
  await page.keyboard.type(' ');
  assert.equal(await page.locator('.focus-mode').count(), 0); await unchanged();
  const text = panel(0).locator('.xterm-rows > div').filter({ hasText: /^PROJECT_IMAGE_KEEP_SESSION$/ });
  const textBox = await text.boundingBox();
  assert.ok(textBox);
  await page.mouse.move(textBox.x + 2, textBox.y + textBox.height / 2);
  await page.mouse.down(); await page.mouse.move(textBox.x + 180, textBox.y + textBox.height / 2, { steps: 12 }); await page.mouse.up();
  assert.ok(await panel(0).locator('.xterm-selection div').count());
  assert.equal(await page.locator('.focus-mode').count(), 0); await unchanged();
  report.checks.push('image/header click still expands; terminal typing and text selection stay in the small card');
  const dragFrom = await panel(0).locator('.panel-header .project-image').boundingBox(), dragTo = await panel(1).locator('.panel-header').boundingBox();
  await page.mouse.move(dragFrom.x + dragFrom.width / 2, dragFrom.y + dragFrom.height / 2);
  await page.mouse.down(); await page.mouse.move(dragFrom.x + 15, dragFrom.y + 12, { steps: 4 });
  await page.mouse.move(dragTo.x + dragTo.width / 2, dragTo.y + dragTo.height / 2, { steps: 20 }); await page.mouse.up();
  await waitFor(async () => (await state()).projects[0].id === projects[1].id, 'dragging an image reorders its project');
  assert.equal(await page.locator('.focus-mode').count(), 0); await unchanged();
  report.checks.push('dragging the non-draggable image handle reorders the card without expanding it or recreating its terminal');
  await open(0); await dialog().getByRole('button', { name: '恢复原样', exact: true }).click();
  assert.ok((await projectState(0)).image, 'restoring is staged until Save, just like replacing a picture');
  await save();
  await dialog().waitFor({ state: 'detached' });
  assert.ok(!(await projectState(0)).image); assert.equal(await panel(0).locator('.panel-index:visible').count(), 1); await unchanged();
  assert.equal((await projectState(0)).imageMode, 'number');
  report.checks.push('restore original removes only the picture and returns the original number, without restarting the terminal');
  const added = await page.evaluate(id => window.agentrix.addTerminal(id), projects[0].id);
  assert.ok(added.ok);
  await waitFor(() => panel(0).locator('.terminal-split-tools').count().then(count => count === 2), 'two terminal splits');
  await open(0); await dialog().getByRole('button', { name: '取消', exact: true }).click(); await unchanged();
  report.checks.push('editing project identity also preserves the first terminal when the card has multiple splits');
  for (const zoom of [1, 1.5, 2]) {
    await app.evaluate(({ BrowserWindow }, zoom) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(960, 720); window.webContents.setZoomFactor(zoom); }, zoom);
    await terminalsSettled(page);
    report.imageIdentityChecks.push({ zoom, headers: await headerIdentities() });
    await open(0);
    const bounds = await dialog().boundingBox(), viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1);
    assert.equal(await dialog().evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await capture(`dialog-${zoom * 100}.png`);
    await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'detached' });
  }
  report.checks.push('at 960px and 100%/150%/200% zoom, the dialog fits and cards retain exactly one image or original-number identity');
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.webContents.setZoomFactor(1); window.setContentSize(1440, 960); });
  const expected = (await state()).projects.map(project => [project.id, project.image || '', project.imageMode || 'auto']);
  await stop(); await launch();
  assert.deepEqual((await state()).projects.map(project => [project.id, project.image || '', project.imageMode || 'auto']), expected);
  assert.equal((await projectState(0)).imageMode, 'number');
  report.checks.push('custom images, explicit numbered opt-out and automatic fallback survive application restart');
  assert.deepEqual(report.errors, []);
  await capture('preview.png');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  await stop();
}
