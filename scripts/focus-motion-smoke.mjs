import { testRun } from './test-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright-core';
import { waitFor, terminalsSettled } from './wait.mjs';
import { pick, picked } from './select-helper.mjs';
import { openSettings } from './app-menu-helper.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = await testRun('focus-motion');
const dataDir = path.join(output, 'profile');
await fs.mkdir(dataDir, { recursive: true });
const projects = [];
for (const name of ['界面开发', '服务接口', '数据处理', '工具项目', '文档整理', '动画验证']) {
  const project = { id: randomUUID(), name, path: path.join(output, name), restore: { terminal: false, codex: false } };
  await fs.mkdir(project.path); await fs.writeFile(path.join(project.path, 'README.md'), '# Animation fixture');
  projects.push(project);
}
// These checks read the terminal's rows as HTML, so the compatible (DOM) renderer draws them; gpu-terminal-smoke covers the GPU one.
await fs.writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify({ version: 2, projects, settings: { language: 'zh', terminalRenderer: 'dom', autoSave: false, notifications: false, closeToTray: false, restoreSessions: false } }));
const env = { ...process.env, AGENTRIX_DATA_DIR: dataDir }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
const packaged = process.argv.includes('--packaged');
const executableIndex = process.argv.indexOf('--executable');
const actualExecutable = executableIndex >= 0 ? path.resolve(process.argv[executableIndex + 1]) : null;
let application, page;
const errors = [];
async function settled(focused) {
  await page.waitForFunction(expected => !document.querySelector('.focus-motion-panel') && !!document.querySelector('.focus-mode') === expected, focused);
  await page.waitForFunction(() => !document.querySelector('[data-focus-motion]'));
}
async function landed(id) {
  const gap = await page.locator(`[data-project-id="${id}"]`).evaluate(panel => {
    const actual = panel.getBoundingClientRect(), slot = panel.parentElement.getBoundingClientRect();
    // A card under the pointer in the overview is raised a few pixels by the hover lift; that is its own
    // pure vertical move, not where the animation put it. Anything else (scale, sideways, size) still counts.
    const lift = new DOMMatrix(getComputedStyle(panel).transform);
    const raised = lift.is2D && lift.a === 1 && lift.d === 1 && lift.b === 0 && lift.c === 0 && lift.e === 0 && lift.f <= 0 && lift.f >= -4 ? lift.f : 0;
    return Math.abs(actual.left - slot.left) + Math.abs(actual.top - raised - slot.top) + Math.abs(actual.width - slot.width) + Math.abs(actual.height - slot.height);
  });
  assert.ok(gap < 2, `panel must land in its layout slot, gap=${gap}`);
}
// Hold the two sampled flights as they start; a busy runner can otherwise miss the transition before polling.
async function holdMotion(panel) {
  await panel.evaluate(panel => {
    panel.animate = function(keyframes, options) {
      const animation = Element.prototype.animate.call(this, keyframes, options);
      animation.pause();
      return animation;
    };
  });
}
async function playMotion(panel) {
  await panel.evaluate(panel => { delete panel.animate; panel.getAnimations().forEach(animation => animation.play()); });
}
try {
  application = await electron.launch({ executablePath: actualExecutable || (packaged ? path.join(root, 'release/win-unpacked/Agentrix.exe') : require('electron')), args: actualExecutable || packaged ? [] : [root], cwd: root, env, timeout: 30000 });
  page = await application.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  // Playwright defaults to no-preference even without an explicit override.
  // null restores the real Windows setting used by the installed application.
  await page.emulateMedia({ reducedMotion: null });
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setBounds({ x: 40, y: 40, width: 1180, height: 780 }); window.focus();
  });
  await page.waitForSelector('.project-panel');
  console.log('System reduced motion:', await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches));
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getBackgroundThrottling()), false, 'the installed app itself keeps visible animations rendering');
  const id = projects.at(-1).id, panel = page.locator(`[data-project-id="${id}"]`);
  await panel.getByRole('button', { name: '只打开终端', exact: true }).click();
  await waitFor(async () => (await page.evaluate(() => window.agentrix.getState())).value.projects.find(project => project.id === id).shellReady, 'initial PowerShell prompt');
  // Keep the real PowerShell editor active as an offline agent terminal, including after each submitted command.
  await page.evaluate(id => window.agentrix.writeTerminal(id, "function global:prompt { 'PS ' + (Get-Location).Path + '> ' }; Send-AgentrixEvent 'codex-started' -Agent 'claude'\r"), id);
  await waitFor(async () => (await page.evaluate(() => window.agentrix.getState())).value.projects.find(project => project.id === id).codexActive, 'authenticated agent fixture');
  await panel.locator('.reading-view').waitFor();
  await page.locator('.titlebar-tools').getByRole('button', { name: '切换到终端', exact: true }).click();
  await panel.locator('.reading-view').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '返回总览', exact: true }).click();
  await settled(false); await terminalsSettled(page);
  assert.equal(await panel.locator('.terminal-split').isVisible(), true, 'the agent terminal is visible before the small-card input checks');
  await panel.locator('.panel-terminal-area').click({ position: { x: 36, y: 95 } });
  await page.keyboard.type("[IO.File]::WriteAllText('first-line.txt', 'FIRST')");
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type("[IO.File]::WriteAllText('second-line.txt', 'SECOND')");
  assert.equal(await fs.access(path.join(projects.at(-1).path, 'first-line.txt')).then(() => true, () => false), false, 'Shift+Enter inserts a line without executing a complete PowerShell command');
  assert.equal(await page.locator('.focus-mode').count(), 0);
  await page.keyboard.press('Enter');
  await waitFor(async () => fs.access(path.join(projects.at(-1).path, 'second-line.txt')).then(() => true, () => false), 'both submitted PowerShell lines execute');
  await waitFor(async () => panel.locator('.xterm-rows > div').allTextContents().then(rows => rows.join('').replace(/\s/g, '').endsWith(`PS${projects.at(-1).path}>`.replace(/\s/g, ''))), 'PowerShell prompt after multiline input');
  assert.equal((await page.evaluate(() => window.agentrix.getState())).value.projects.find(project => project.id === id).codexActive, true, 'the fixture remains an agent after multiline execution');
  assert.equal(await fs.readFile(path.join(projects.at(-1).path, 'first-line.txt'), 'utf8'), 'FIRST');
  assert.equal(await fs.readFile(path.join(projects.at(-1).path, 'second-line.txt'), 'utf8'), 'SECOND');
  console.log('PASS: real PowerShell edits two lines with Shift+Enter and executes both only after Enter');
  const sessionId = (await page.evaluate(() => window.agentrix.getState())).value.projects.find(project => project.id === id).sessionId;
  await panel.locator('.panel-terminal-area').click({ position: { x: 36, y: 95 } });
  await page.keyboard.type("Write-Output 'PENDING_INPUT'");
  assert.equal(await page.locator('.focus-mode').count(), 0, 'clicking the terminal input and typing stays in the small card');
  assert.equal(await panel.locator('textarea').evaluate(element => element === document.activeElement), true);
  const area = panel.locator('.panel-terminal-area'), areaBox = await area.boundingBox();
  await area.click({ position: { x: areaBox.width - 20, y: areaBox.height - 12 } });
  assert.equal(await page.locator('.focus-mode').count(), 0, 'clicking the bottom of the card body does not expand it');
  await panel.evaluate(panel => { globalThis.motionTerminal = panel.querySelector('.terminal-host'); });
  // The welcome banner can legitimately scroll out of a small terminal after
  // multiline input. Select the current prompt, which remains on screen.
  const outputRow = panel.locator('.xterm-rows > div').filter({ hasText: /^PS / }).last();
  const rowBox = await outputRow.boundingBox();
  await page.mouse.move(rowBox.x + 12, rowBox.y + rowBox.height / 2); await page.mouse.down();
  await page.mouse.move(rowBox.x + 108, rowBox.y + rowBox.height / 2, { steps: 6 }); await page.mouse.up();
  assert.equal(await page.locator('.focus-mode').count(), 0, 'dragging text in an ordinary card keeps it in the overview');
  assert.equal(await panel.locator('.terminal-host').getAttribute('data-has-selection'), 'true');
  const original = await panel.boundingBox();
  const overviewViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.screenshot({ path: path.join(output, 'overview.png') });
  await holdMotion(panel);
  await panel.locator('.panel-header').click({ position: { x: 8, y: 8 } });
  await page.waitForSelector('[data-focus-motion="opening"] .focus-motion-panel');
  const mid = await panel.evaluate(panel => {
    const animation = panel.getAnimations().find(animation => animation.effect.getKeyframes().some(frame => frame.transform));
    animation.currentTime = Number(animation.effect.getTiming().duration) * .35;
    const box = panel.getBoundingClientRect();
    return { width: box.width, height: box.height, targetWidth: panel.offsetWidth, targetHeight: panel.offsetHeight };
  });
  assert.ok(mid.width > original.width + 5 && mid.width < mid.targetWidth - 5, 'opening has intermediate widths between the card and expanded project');
  assert.ok(mid.height > original.height + 5 && mid.height < mid.targetHeight - 5, 'opening has intermediate heights');
  await page.screenshot({ path: path.join(output, 'expanding.png') });
  await playMotion(panel);
  await settled(true); await landed(id);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), false, 'project expansion keeps the native window windowed');
  assert.deepEqual(await page.evaluate(() => ({ width: innerWidth, height: innerHeight })), overviewViewport, 'expansion preserves the window viewport');
  await page.screenshot({ path: path.join(output, 'focused.png') });
  assert.ok(await panel.evaluate(panel => panel.querySelector('.terminal-host') === globalThis.motionTerminal));
  const full = await panel.boundingBox();
  await holdMotion(panel);
  await page.getByRole('button', { name: '返回总览', exact: true }).click();
  await page.waitForSelector('[data-focus-motion="closing"] .focus-motion-panel');
  await page.waitForFunction(({ id, viewport }) => {
    const panel = document.querySelector(`[data-project-id="${id}"]`);
    return innerWidth === viewport.width && innerHeight === viewport.height && panel.classList.contains('focus-motion-panel') && Math.abs(panel.offsetWidth - panel.parentElement.offsetWidth) < 2;
  }, { id, viewport: overviewViewport });
  const shrinking = await panel.evaluate(panel => {
    const animation = panel.getAnimations().find(animation => animation.effect.getKeyframes().some(frame => frame.transform));
    animation.currentTime = Number(animation.effect.getTiming().duration) * .35;
    const box = panel.getBoundingClientRect();
    return { width: box.width, targetWidth: panel.offsetWidth, right: box.right, bottom: box.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight };
  });
  assert.ok(shrinking.width > shrinking.targetWidth + 5 && shrinking.width < full.width - 5, 'return shrinks continuously into the grid');
  assert.ok(shrinking.right <= shrinking.viewportWidth + 1 && shrinking.bottom <= shrinking.viewportHeight + 1, 'the whole shrinking card remains inside the native window');
  await page.screenshot({ path: path.join(output, 'returning.png') });
  await playMotion(panel);
  await settled(false); await landed(id);
  assert.ok(await panel.evaluate(panel => panel.querySelector('.terminal-host') === globalThis.motionTerminal));
  assert.equal((await page.evaluate(() => window.agentrix.getState())).value.projects.find(project => project.id === id).sessionId, sessionId);
  // A narrow card wraps the line, so the rows are joined before looking for the draft.
  assert.ok((await panel.innerText()).replace(/\s+/g, '').includes("Write-Output'PENDING_INPUT'"), 'unsubmitted terminal input survives both transitions');
  console.log('PASS: last card expands and shrinks through intermediate bounds, with the same live terminal and pending input');

  // Observe natural playback as well as the paused screenshots above. The old
  // fast easing completed almost all visible growth in its first 150 ms.
  await panel.evaluate(panel => {
    globalThis.focusMotionSamples = [];
    const started = performance.now();
    const sample = () => {
      // clock: the animation's own time, which a slow or busy machine cannot compress the way it bunches frames.
      const animation = panel.getAnimations().find(item => item.effect?.getKeyframes().some(frame => frame.transform));
      globalThis.focusMotionSamples.push({ time: performance.now() - started, clock: animation ? Number(animation.currentTime) : null, width: panel.getBoundingClientRect().width, moving: panel.classList.contains('focus-motion-panel') });
      if (performance.now() - started < 1600) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const naturalStart = (await panel.boundingBox()).width;
  await panel.getByRole('button', { name: `全屏查看 ${projects.at(-1).name}`, exact: true }).click();
  await settled(true);
  const naturalEnd = (await panel.boundingBox()).width;
  const samples = await page.evaluate(() => globalThis.focusMotionSamples);
  const growing = samples.filter(sample => sample.moving && sample.width > naturalStart + (naturalEnd - naturalStart) * .05 && sample.width < naturalStart + (naturalEnd - naturalStart) * .92);
  assert.ok(growing.length >= 4, 'natural playback must render several visibly different intermediate sizes');
  // When the card passes 5% and 92% of its growth, on the animation's own clock, between the frames either side.
  // A slow build machine drops frames during the zoom; the last frame that happens to fall inside the range then
  // says nothing about when the growth ended, but the frames either side of each crossing still do.
  const timed = samples.filter(sample => sample.moving && sample.clock !== null);
  const crossing = level => {
    const target = naturalStart + (naturalEnd - naturalStart) * level;
    for (let index = 1; index < timed.length; index++) {
      const before = timed[index - 1], after = timed[index];
      if (before.width < target && after.width >= target) return before.clock + (after.clock - before.clock) * (target - before.width) / (after.width - before.width);
    }
    return null;
  };
  const first = crossing(.05), last = crossing(.92);
  const span = first !== null && last !== null ? last - first : growing.at(-1).time - growing[0].time;
  assert.ok(span >= 200, `visible enlargement must be gradual, not concentrated into the first few frames (${Math.round(span)} ms)`);
  await fs.writeFile(path.join(output, 'natural-motion.json'), JSON.stringify(samples));
  await page.keyboard.press('Control+Shift+g'); await settled(false);
  console.log('PASS: only the header/expand button opens the card; unpaused animation works without test-only rendering flags');

  await panel.locator('.panel-name').click();
  await page.waitForSelector('.focus-motion-panel');
  await page.keyboard.press('Control+Shift+g');
  await settled(false); await landed(id);
  assert.equal(await page.locator('.project-panel:visible').count(), projects.length);
  await page.locator(`[data-project-id="${projects[0].id}"] .panel-name`).click();
  await settled(true); await landed(projects[0].id);
  await page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
  await page.getByLabel('文件编辑器', { exact: true }).waitFor();
  await page.getByRole('button', { name: '返回总览', exact: true }).click();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
  await settled(false); await landed(projects[0].id);
  assert.equal(await page.locator('.file-preview').count(), 0);
  console.log('PASS: quick reversal, another card, file preview return and window resize leave no floating or hidden cards');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await panel.locator('.panel-name').click();
  await page.waitForSelector('.focus-motion-panel');
  await settled(true); await landed(id);
  await page.getByRole('button', { name: '返回总览', exact: true }).click(); await settled(false);
  console.log('PASS: default smooth zoom remains enabled when Windows reduces system animations');

  await openSettings(page);
  await page.getByLabel('界面动画', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'motion-settings.png') });
  await pick(page, page.getByLabel('界面动画', { exact: true }), 'system');
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await panel.locator('.panel-name').click(); await settled(true);
  assert.equal(await page.locator('.focus-motion-panel').count(), 0);
  await page.getByRole('button', { name: '返回总览', exact: true }).click(); await settled(false);
  await landed(id); assert.deepEqual(errors, []);
  console.log('PASS: choosing follow-system respects reduced motion');

  await openSettings(page);
  await pick(page, page.getByLabel('界面动画', { exact: true }), 'off');
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await panel.locator('.panel-name').click(); await settled(true);
  assert.equal(await page.locator('.focus-motion-panel').count(), 0);
  await page.getByRole('button', { name: '返回总览', exact: true }).click(); await settled(false);
  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'workspace.json'), 'utf8'));
  assert.equal(persisted.settings.focusAnimation, 'off');
  console.log('PASS: animation can be disabled and the preference persists');
  console.log(`Screenshots: ${output}`);
} catch (error) {
  console.error(error); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
} finally { if (application) await application.close(); }
