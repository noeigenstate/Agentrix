import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { _electron as electron } from 'playwright-core';
import { testRun } from './test-output.mjs';
import { waitFor } from './wait.mjs';
import { chooseFromAppMenu } from './app-menu-helper.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url);
const output = await testRun('project-image-candidates'), profile = path.join(output, 'profile'), home = path.join(output, 'home');
const projects = ['图标与效果图', '文档与素材', '纯代码项目', '多图素材', '构建图标', '远程项目', 'SVG 应用图标'].map((name, i) => ({ id: randomUUID(), name,
  path: i === 5 ? '/srv/fixture' : path.join(output, 'project-' + i),
  ...(i === 5 ? { kind: 'ssh', ssh: { host: 'fixture', configFile: null } } : { kind: 'local' }), restore: { terminal: false, codex: false }
}));
for (const dir of [profile, home, ...projects.filter(project => project.kind === 'local').map(project => project.path)]) await fs.mkdir(dir, { recursive: true });
const svgIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 24"><path fill="currentColor" d="M0 0h48v24H0z"/></svg>';
await fs.mkdir(path.join(projects[6].path, 'icons'));
await fs.writeFile(path.join(projects[6].path, 'icons/app.svg'), svgIcon);
for (const project of projects.slice(0, 2)) {
  for (const dir of ['public', 'docs/images', 'assets']) await fs.mkdir(path.join(project.path, dir), { recursive: true });
  await fs.copyFile(path.join(root, 'assets/icon.png'), path.join(project.path, 'public/app-icon.png'));
  await fs.copyFile(path.join(root, 'docs/images/reading-view.jpg'), path.join(project.path, 'docs/images/overview.jpg'));
  await fs.copyFile(path.join(root, 'assets/icon-mac.png'), path.join(project.path, 'assets/product.png'));
}
await fs.mkdir(path.join(projects[3].path, 'assets'));
for (const filename of ['decisions.jpg', 'git-review.jpg', 'overview.jpg', 'reading-view.jpg', 'voice.jpg', 'appearance-dark-overview.png', 'appearance-light-git.png', 'appearance-light-reading.png']) {
  await fs.copyFile(path.join(root, 'docs/images', filename), path.join(projects[3].path, 'assets', filename));
}
await fs.mkdir(path.join(projects[4].path, 'build'));
await fs.copyFile(path.join(root, 'assets/icon.png'), path.join(projects[4].path, 'build/app.png'));
await fs.writeFile(path.join(projects[4].path, 'package.json'), JSON.stringify({ build: { icon: 'build/app.png' } }));
await fs.writeFile(path.join(projects[0].path, 'package.json'), JSON.stringify({ name: 'candidate-demo', build: { icon: 'public/app-icon.png' } }));
let networkRequests = 0;
const server = http.createServer((_request, response) => { networkRequests++; response.end('remote image must not be fetched'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await fs.writeFile(path.join(projects[0].path, 'README.md'), `# 应用示例\n\n![实际界面](docs/images/overview.jpg)\n\n![外链图](http://127.0.0.1:${server.address().port}/remote.png)\n`);
await fs.writeFile(path.join(projects[1].path, 'README.md'), '# 文档示例\n\n![效果图][overview]\n\n[overview]: docs/images/overview.jpg\n');
await fs.writeFile(path.join(projects[2].path, 'README.md'), '# 纯代码项目\n\n没有图片也可以正常使用原有编号。\n');
const legacyCustom = 'data:image/png;base64,' + (await fs.readFile(path.join(root, 'assets/icon-mac.png'))).toString('base64');
projects[1].image = legacyCustom;
await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects, settings: { startView: 'workspace', language: 'zh', surface: 'solid',
  terminalRenderer: 'dom', restoreSessions: false, closeToTray: false, notifications: false, sound: false, focusAnimation: 'off', guideVersion: '9.9.9' } }));
const env = { ...process.env, AGENTRIX_DATA_DIR: profile, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, 'codex'), CLAUDE_CONFIG_DIR: path.join(home, 'claude') };
delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
const report = { output, checks: [], errors: [], fixtures: [], screenshots: [] };
let app, page;
const panel = i => page.locator(`[data-project-id="${projects[i].id}"]`), dialog = () => page.locator('.project-image-dialog');
const workspace = async () => (await page.evaluate(() => window.agentrix.getState())).value;
const state = async i => (await workspace()).projects.find(project => project.id === projects[i].id);
const saved = async i => JSON.parse(await fs.readFile(path.join(profile, 'workspace.json'), 'utf8')).projects.find(project => project.id === projects[i].id);
const list = async i => { const result = await page.evaluate(id => window.agentrix.listProjectImageCandidates(id), projects[i].id); assert.ok(result.ok, result.error); return result.value; };
const scanDone = async () => waitFor(() => dialog().getByRole('button', { name: '重新查找', exact: true }).isEnabled(), 'candidate scan finished');
const open = async i => {
  await panel(i).getByRole('button', { name: `${projects[i].name} 的更多操作`, exact: true }).click();
  await panel(i).getByRole('menuitem', { name: /项目图片/ }).click(); await dialog().waitFor(); await scanDone();
};
const cancel = async () => { await dialog().getByRole('button', { name: '取消', exact: true }).click(); await dialog().waitFor({ state: 'detached' }); };
const save = async () => { const button = dialog().getByRole('button', { name: '保存', exact: true }); await button.scrollIntoViewIfNeeded(); await button.click(); await dialog().waitFor({ state: 'detached' }); };
const screenshot = async name => { await dialog().screenshot({ path: path.join(output, name) }); report.screenshots.push(name); };
const svgPixels = async (image, name, size) => {
  const box = await image.boundingBox(); assert.equal(box.width, size); assert.equal(box.height, size);
  assert.equal(await image.evaluate(node => getComputedStyle(node).objectFit), 'contain');
  const png = await image.screenshot({ path: path.join(output, name) }); report.screenshots.push(name);
  const pixels = await app.evaluate(({ nativeImage }, base64) => {
    const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64')), { width, height } = image.getSize(), bitmap = image.toBitmap();
    const rgb = (x, y) => [...bitmap.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)];
    let light = 0;
    for (let at = 0; at < bitmap.length; at += 4) if (bitmap[at] >= 225 && bitmap[at + 1] >= 225 && bitmap[at + 2] >= 225) light++;
    return { width, height, light, centre: rgb(Math.floor(width / 2), Math.floor(height / 2)), top: rgb(Math.floor(width / 2), 2) };
  }, png.toString('base64'));
  assert.ok(pixels.light >= size * size * 0.4, JSON.stringify(pixels));
  assert.ok(pixels.centre.every(channel => channel >= 235 && channel <= 245), JSON.stringify(pixels));
  assert.ok(pixels.top.every(channel => channel < 100), 'a non-square viewBox is contained, with dark space above');
  return { slot: { width: box.width, height: box.height }, ...pixels };
};
const preferences = () => page.locator('.settings-paned');
const row = i => preferences().locator(`[data-project-image-id="${projects[i].id}"]`);
const thumbnailSettings = async () => {
  assert.equal(await preferences().locator('[data-settings-tab="project-images"]').count(), 0);
  await preferences().locator('[data-project-images-open]').click();
  assert.equal(await preferences().locator('[data-settings-tab="appearance"]').getAttribute('aria-current'), 'page');
  await preferences().locator('[data-project-images-back]').waitFor();
};
const openSettings = async () => { await chooseFromAppMenu(page, '设置'); await preferences().locator('[data-settings-tab="appearance"]').click(); await thumbnailSettings(); };
const closeSettings = async () => { await preferences().getByRole('button', { name: '关闭设置', exact: true }).click(); await preferences().waitFor({ state: 'detached' }); };
const launch = async () => {
  app = await electron.launch({ executablePath: require('electron'), args: [root, '--force-device-scale-factor=1'], cwd: root, env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => report.errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 960));
  await panel(0).waitFor();
};
const stop = async () => { if (!app) return; await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); app = null; };
try {
  await launch();
  for (const i of [0, 4, 6]) await waitFor(async () => (await state(i)).image && (await state(i)).imageMode === 'auto', 'default project thumbnail assigned');
  const available = await list(0); assert.ok(available.candidates.length >= 2 && available.candidates.length <= 6);
  assert.ok(available.candidates.some(candidate => candidate.source === 'icon') && available.candidates.some(candidate => candidate.source === 'readme'));
  const automatic = available.candidates[0].image;
  assert.equal(await page.locator('.project-image-dialog, .settings-paned').count(), 0);
  assert.equal((await state(1)).image, legacyCustom);
  assert.equal((await state(0)).image, automatic); assert.equal((await saved(0)).imageMode, 'auto');
  assert.ok(!(await state(2)).image && !(await state(3)).image && !(await state(5)).image); assert.equal(networkRequests, 0);
  report.checks.push('startup automatically picks only logos; code-only, generic asset and SSH projects retain numbers without network fetches');
  const svgCandidates = await list(6);
  assert.equal(svgCandidates.candidates[0].path, 'icons/app.svg'); assert.equal(svgCandidates.candidates[0].source, 'icon');
  assert.match((await state(6)).image, /^data:image\/svg\+xml;base64,/);
  assert.equal(Buffer.from((await state(6)).image.split(',')[1], 'base64').toString('utf8'), svgIcon.replace('currentColor', 'var(--agentrix-project-ink, #f2f2f2)'));
  report.svgHeader = await svgPixels(panel(6).locator('.panel-header .project-image'), 'svg-header-24.png', 24);
  await panel(6).screenshot({ path: path.join(output, 'svg-card.png') }); report.screenshots.push('svg-card.png');

  await panel(0).getByRole('button', { name: '只打开终端', exact: true }).click();
  await waitFor(async () => (await state(0)).shellReady, 'isolated shell ready');
  const session = (await state(0)).sessionId;
  await panel(0).locator('.xterm').evaluate(node => { globalThis.candidatesOriginalTerminal = node; });
  await page.evaluate(id => window.agentrix.writeTerminal(id, 'echo CANDIDATES_UNSENT_DRAFT'), projects[0].id);
  await waitFor(() => panel(0).locator('.xterm-rows').innerText().then(text => text.replace(/\s/g, '').includes('CANDIDATES_UNSENT_DRAFT')), 'unsent input ready');
  const unchanged = async () => {
    assert.equal((await state(0)).sessionId, session);
    assert.ok(await panel(0).locator('.xterm').evaluate(node => node === globalThis.candidatesOriginalTerminal));
    const data = await page.evaluate(async id => (await window.agentrix.attachTerminal(id)).value.data, projects[0].id);
    assert.ok(stripVTControlCharacters(data).replace(/\s/g, '').includes('CANDIDATES_UNSENT_DRAFT'));
  };
  await panel(0).locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+Shift+ArrowLeft');
  const svgSwitch = panel(6).locator('.panel-nav-hud .project-image'); await svgSwitch.waitFor();
  report.svgSwitch = await svgPixels(svgSwitch, 'svg-switch-48.png', 48);
  await panel(6).screenshot({ path: path.join(output, 'svg-switch-card.png') }); report.screenshots.push('svg-switch-card.png');
  await unchanged();
  report.checks.push('viewBox-only currentColor SVG becomes the automatic vector snapshot; 24px header and 48px switch pixels are light #f2f2f2 with contained proportions');
  await open(0);
  // The dialog looks for candidates after it opens.
  await waitFor(async () => await dialog().locator('.project-image-candidate').count() === available.candidates.length, 'candidates listed');
  assert.ok(await dialog().getByRole('button', { name: '保存', exact: true }).isDisabled());
  await screenshot('candidates-automatic.png');
  const chosen = available.candidates.find(candidate => candidate.source === 'readme');
  await dialog().getByRole('button', { name: `使用项目图片：${chosen.path}`, exact: true }).click();
  assert.equal(await dialog().locator('.project-image-preview img').getAttribute('src'), chosen.image);
  assert.equal((await state(0)).image, automatic); await cancel();
  assert.equal((await saved(0)).image, automatic); assert.equal((await state(0)).imageMode, 'auto'); await unchanged();
  report.checks.push('manual candidate selection is staged; cancel preserves the automatic image and mode');
  await open(0); await dialog().getByRole('button', { name: `使用项目图片：${chosen.path}`, exact: true }).click();
  await dialog().getByRole('button', { name: '重新查找', exact: true }).click(); await scanDone();
  assert.equal(await dialog().locator('.project-image-preview img').getAttribute('src'), chosen.image);
  await screenshot('candidates-selected.png'); await save();
  assert.equal((await state(0)).image, chosen.image); assert.equal((await saved(0)).imageMode, 'custom'); await unchanged();
  await fs.copyFile(path.join(root, 'assets/icon.png'), path.join(projects[0].path, chosen.path));
  await list(0); assert.equal((await state(0)).image, chosen.image);
  await fs.unlink(path.join(projects[0].path, chosen.path)); await list(0);
  assert.equal((await saved(0)).image, chosen.image); await unchanged();
  report.checks.push('refresh preserves the custom preview; saving and later source changes preserve the snapshot, terminal DOM, session and draft');

  for (const i of [3, 4]) {
    const start = performance.now(), result = await list(i);
    report.fixtures.push({ project: projects[i].name, milliseconds: Math.round(performance.now() - start), candidates: result.candidates.map(({ path, source, image }) => ({ path, source, bytes: image.length })) });
    assert.equal(result.candidates.length, i === 3 ? 6 : 1);
    assert.ok(result.candidates.every(candidate => !path.isAbsolute(candidate.path) && !candidate.path.split('/').includes('..')));
    if (i === 4) assert.equal(result.candidates[0].source, 'icon');
    await open(i); await screenshot(i === 3 ? 'bounded-asset-candidates.png' : 'build-icon-candidates.png'); await cancel();
    if (i === 4) { assert.equal((await state(i)).image, result.candidates[0].image); assert.equal((await state(i)).imageMode, 'auto'); }
    else { assert.ok(!(await state(i)).image); assert.equal(await panel(i).locator('.panel-index:visible').count(), 1); }
  }
  await open(2); await dialog().getByText(/没有找到/).waitFor(); await screenshot('code-only-empty.png'); await cancel();
  await open(2);
  await dialog().locator('input[type=file]').setInputFiles({ name: 'manual.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svgIcon) });
  await waitFor(async () => (await dialog().locator('.project-image-preview img').getAttribute('src').catch(() => ''))?.startsWith('data:image/svg+xml;base64,'), 'manual SVG preview');
  await save(); assert.equal((await state(2)).image, (await state(6)).image); assert.equal((await state(2)).imageMode, 'custom');
  await open(2); await screenshot('manual-svg-dialog.png');
  await dialog().locator('input[type=file]').setInputFiles({ name: 'hostile.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg onload="alert(1)"/>') });
  await waitFor(async () => (await dialog().locator('.project-image-preview img').getAttribute('src')) !== (await state(2)).image, 'hostile SVG staged');
  await dialog().getByRole('button', { name: '保存', exact: true }).click();
  await dialog().getByRole('alert').filter({ hasText: /静态 SVG/ }).waitFor();
  assert.equal((await state(2)).image, (await state(6)).image); await cancel();
  await open(2); await dialog().getByRole('button', { name: '恢复原样', exact: true }).click(); await save();
  assert.ok(!(await state(2)).image);
  report.checks.push('manual SVG stays SVG through main sanitization and persistence; hostile SVG is refused in the existing error area without replacing the saved image');
  assert.equal((await list(5)).unavailable, 'ssh');
  await open(5); await dialog().getByText(/远程项目暂不/).waitFor(); await cancel();
  report.checks.push('portable asset and build-icon fixtures use bounded relative candidates; legacy custom images remain fixed and SSH remains manual-only');

  await openSettings();
  assert.equal(await preferences().locator('.project-image-setting-row').count(), projects.length);
  for (const i of [0, 2, 5]) assert.ok((await row(i).innerText()).includes(projects[i].name));
  assert.ok(await row(0).locator('.project-image-setting-thumb img').isVisible());
  for (const i of [2, 5]) {
    await row(i).locator('.project-image-setting-change').click(); await dialog().waitFor(); await scanDone();
    if (i === 5) await dialog().getByText(/远程项目暂不/).waitFor();
    await dialog().locator('input[type=file]').setInputFiles(path.join(root, 'assets/icon-mac.png'));
    await dialog().locator('.project-image-preview img').waitFor();
    assert.ok(!(await state(i)).image); await cancel(); assert.ok(await preferences().isVisible());
  }
  await row(0).locator('.project-image-setting-change').click(); await dialog().waitFor(); await scanDone();
  await dialog().getByRole('button', { name: '恢复原样', exact: true }).click();
  assert.equal((await saved(0)).image, chosen.image);
  await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'detached' });
  assert.ok(await preferences().isVisible() && await preferences().locator('[data-project-images-back]').isVisible()); assert.equal((await state(0)).imageMode, 'custom');
  await row(0).locator('.project-image-setting-change').click(); await dialog().waitFor();
  await dialog().getByRole('button', { name: '恢复原样', exact: true }).click(); await save();
  assert.equal((await saved(0)).imageMode, 'number'); assert.ok(!(await state(0)).image);
  await list(0); assert.ok(!(await state(0)).image, 'discovery must not re-enable numbered projects');
  assert.equal(await row(0).locator('.project-image-setting-thumb').innerText(), '01');
  assert.equal(await row(0).locator('.project-image-setting-thumb img').count(), 0);
  assert.equal(await preferences().locator('[data-settings-tab="appearance"]').getAttribute('aria-current'), 'page');
  await preferences().locator('[data-project-images-back]').click();
  assert.ok(await preferences().locator('[data-project-images-open]').isVisible());
  await thumbnailSettings();
  assert.equal(await preferences().locator('.project-image-setting-row').count(), projects.length);
  await preferences().locator('[data-settings-tab="notifications"]').click();
  await preferences().locator('[data-settings-tab="appearance"]').click();
  assert.equal(await preferences().locator('[data-project-images-back]').isVisible(), false);
  await thumbnailSettings();
  assert.equal(await preferences().locator('.project-image-setting-row').count(), projects.length);
  await closeSettings(); await unchanged();
  report.checks.push('Appearance thumbnail manager includes local, code-only and SSH projects; child Escape preserves the list; Back and category switching restore Appearance; numbered opt-out persists');

  await open(1);
  for (const zoom of [1, 1.5, 2]) {
    await app.evaluate(({ BrowserWindow }, zoom) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(960, 720); window.webContents.setZoomFactor(zoom); }, zoom);
    const box = await dialog().boundingBox(), viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1);
    assert.ok(await dialog().evaluate(node => node.scrollWidth <= node.clientWidth));
    await screenshot(`candidates-${zoom * 100}.png`);
  }
  await cancel();
  await stop(); await launch();
  assert.equal((await state(0)).imageMode, 'number'); assert.ok(!(await state(0)).image);
  assert.equal((await state(1)).image, legacyCustom);
  assert.equal((await state(1)).imageMode || 'custom', 'custom');
  await openSettings(); await row(0).locator('.project-image-setting-change').click(); await dialog().waitFor(); await scanDone();
  await dialog().getByRole('button', { name: '重新自动选择', exact: true }).click(); await scanDone();
  await waitFor(async () => (await dialog().locator('.project-image-preview img').getAttribute('src').catch(() => null)) === automatic, 'automatic preview selected');
  assert.equal((await saved(0)).imageMode, 'number'); await cancel();
  assert.equal((await state(0)).imageMode, 'number');
  await row(0).locator('.project-image-setting-change').click(); await dialog().waitFor(); await scanDone();
  await dialog().getByRole('button', { name: '重新自动选择', exact: true }).click(); await scanDone(); await save();
  assert.equal((await saved(0)).imageMode, 'auto'); assert.equal((await state(0)).image, automatic); await closeSettings();
  await fs.copyFile(path.join(root, 'assets/icon-mac.png'), path.join(projects[0].path, 'public/app-icon.png'));
  await stop(); await launch();
  assert.equal((await state(0)).imageMode, 'auto'); assert.equal((await state(0)).image, automatic);
  assert.ok(!(await state(2)).image && !(await state(5)).image);
  assert.equal((await state(1)).image, legacyCustom);
  assert.ok((await workspace()).projects.every(project => !project.shellReady));
  report.checks.push('explicit number survives restart; automatic reselection is staged until Save; fixed automatic snapshots survive source updates and restart without restoring terminals');

  const addedFolder = path.join(output, 'new-local-project'); await fs.mkdir(addedFolder);
  await fs.copyFile(path.join(root, 'assets/icon.png'), path.join(addedFolder, 'icon.png'));
  await app.evaluate(({ dialog }, folder) => { globalThis.imageOriginalFolderPicker = dialog.showOpenDialog; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, addedFolder);
  let added;
  try { added = await page.evaluate(() => window.agentrix.addProjects()); }
  finally { await app.evaluate(({ dialog }) => { dialog.showOpenDialog = globalThis.imageOriginalFolderPicker; delete globalThis.imageOriginalFolderPicker; }); }
  assert.ok(added.ok); const addedId = added.value[0];
  await waitFor(async () => (await workspace()).projects.some(project => project.id === addedId && project.image && project.imageMode === 'auto'), 'new local project automatically receives image');
  assert.ok(!(await workspace()).projects.find(project => project.id === addedId).shellReady);
  report.checks.push('adding a local folder assigns its thumbnail without confirmation or starting a terminal');
  assert.deepEqual(report.errors, []); assert.equal(networkRequests, 0);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  await stop(); await new Promise(resolve => server.close(resolve));
}
