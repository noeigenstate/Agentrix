import { testRun } from './test-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright-core';
import { waitFor } from './wait.mjs';
import { closeMaterialApp } from './material-teardown.mjs';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = await testRun('material'), profile = path.join(output, 'profile');
await fs.mkdir(profile, { recursive: true });
const projects = Array.from({ length: 16 }, (_, index) => ({ id: randomUUID(), name: `${index < 6 ? '运行样例' : '附加项目'} ${String(index + 1).padStart(2, '0')}`, path: path.join(output, `project-${index}`), restore: { terminal: false, codex: false } }));
for (const project of projects) await fs.mkdir(project.path);
// These checks read the terminal's rows as HTML, so the compatible (DOM) renderer draws them; gpu-terminal-smoke covers the GPU one.
await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects, settings: { language: 'zh', terminalRenderer: 'dom', restoreSessions: false, closeToTray: false, notifications: false, fontSize: 13 } }));
const env = { ...process.env, AGENTRIX_DATA_DIR: profile, CODEX_HOME: await fs.mkdtemp(path.join(path.dirname(profile), 'codex-home-')) }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
const packaged = process.argv.includes('--packaged'); let app, page;
const state = async () => (await page.evaluate(() => window.agentrix.getState())).value;
const theme = 'grey';
const errors = [], performanceSamples = [], materials = [], typography = [], edges = [];
const layoutGap = 12;
// Every card keeps the same gap to its neighbours, the title bar and the bottom of the window. In an expanded project the explorer and the project are bands flush with the window's edges
// (the activity pane docks to the right one); the project's own content keeps the gap inside it.
async function checkGaps(mode) {
  const { gaps, ...layout } = await page.evaluate(() => {
    const rect = selector => document.querySelector(selector)?.getBoundingClientRect();
    const slots = [...document.querySelectorAll('.project-slot')].filter(node => node.offsetParent).map(node => node.getBoundingClientRect());
    const bar = rect('.titlebar'), foot = { top: innerHeight }, side = rect('.focus-sidebar'), header = rect('.project-panel.is-focused .panel-header'), area = [...document.querySelectorAll('.panel-terminal-area')].find(node => node.offsetParent)?.getBoundingClientRect();
    const left = Math.min(...slots.map(box => box.left));
    const measured = { top: Math.min(...slots.map(box => box.top)) - bar.bottom, bottom: foot.top - Math.max(...slots.map(box => box.bottom)), right: innerWidth - Math.max(...slots.map(box => box.right)) };
    if (side) Object.assign(measured, { sideLeft: side.left, sideTop: side.top - bar.bottom, sideBottom: foot.top - side.bottom, sideToPanel: left - side.right, headerTop: header.top - bar.bottom, headerToContent: area.top - header.bottom, contentLeft: area.left - side.right });
    else measured.left = left;
    return { gaps: measured, headerTop: header?.top, headerBottom: header?.bottom, contentTop: area?.top };
  });
  const focused = 'sideLeft' in gaps;
  for (const [name, value] of Object.entries(gaps)) {
    const expected = !focused || name === 'headerTop' || name === 'contentLeft' ? layoutGap : 0;
    assert.ok(Math.abs(value - expected) <= 1, `${mode}: ${name} gap is ${value}px, expected ${expected}px`);
  }
  edges.push({ mode, gaps, ...layout });
  return layout;
}
async function checkEdges(mode) {
  const rects = await page.evaluate(() => {
    const bounds = selector => { const box = document.querySelector(selector).getBoundingClientRect(); return { left: box.left, top: box.top, right: box.right, bottom: box.bottom }; };
    return { top: bounds('.titlebar'), width: innerWidth, height: innerHeight, statusbars: document.querySelectorAll('.workspace-statusbar').length };
  });
  assert.ok(Math.abs(rects.top.left) < 1 && Math.abs(rects.top.top) < 1 && Math.abs(rects.top.right - rects.width) < 1, `${mode}: titlebar meets top/left/right edges`);
  assert.equal(rects.statusbars, 0, `${mode}: the workspace summary lives in the title bar, not a bottom bar`);
  edges.push({ mode, ...rects });
}
async function readCells(rows) {
  return rows.evaluate(rows => {
    const context = document.createElement('canvas').getContext('2d');
    const rgba = value => { context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data]; };
    return ['PLAIN', 'BOLD', 'DIM_DEFAULT', 'DIM_RED', 'DIM_GREEN', 'DIM_256', 'DIM_RGB', 'INVERSE', 'DIM_INVERSE'].map(label => {
      const node = [...rows.querySelectorAll('span')].find(node => node.textContent.trim().startsWith(label));
      if (!node) throw new Error(`Missing native terminal sample ${label}`);
      const style = getComputedStyle(node);
      return { label, weight: style.fontWeight, size: style.fontSize, color: rgba(style.color), fill: rgba(style.webkitTextFillColor), filter: style.filter, opacity: style.opacity, selected: node.classList.contains('xterm-decoration-top') };
    });
  });
}
try {
  app = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Agentrix.exe') : require('electron'), args: packaged ? [] : [root], cwd: root, env });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 900));
  await page.waitForSelector('.project-panel');
  await page.keyboard.press('Control+Shift+F');
  const search = page.getByRole('textbox', { name: '搜索项目', exact: true }); await search.fill('运行样例');
  await checkEdges('overview');
  await checkGaps('overview');
  const geometry = await page.locator('.agentrix').evaluate(grid => ({ gap: getComputedStyle(grid).gap, radius: getComputedStyle(grid.querySelector('.project-panel')).borderTopLeftRadius, header: getComputedStyle(grid.querySelector('.panel-header')).borderTopLeftRadius }));
  assert.deepEqual(geometry, { gap: `${layoutGap}px`, radius: '16px', header: '16px' });
  for (const project of projects.slice(0, 6)) await page.evaluate(id => window.agentrix.startTerminal(id), project.id);
  await waitFor(async () => (await state()).projects.slice(0, 6).every(project => project.shellReady), 'six real shells ready');
  for (const count of [6, 16]) {
    await search.fill(count === 6 ? '运行样例' : '');
    await waitFor(async () => (await state()).projects.slice(0, 6).every(project => project.shellReady), 'shells ready for next output stream');
    for (const project of projects.slice(0, 6)) await page.evaluate(id => window.agentrix.writeTerminal(id, "for ($pgGlassFrame=0; $pgGlassFrame -lt 120; $pgGlassFrame++) { [Console]::WriteLine(('LIVE OUTPUT {0:D3}  中文与 ANSI 字体保持清晰' -f $pgGlassFrame)); Start-Sleep -Milliseconds 50 }\r"), project.id);
    for (const mode of ['flat']) {
      await app.evaluate(({ app }) => { app.getAppMetrics(); }); // Start this group's CPU sampling interval.
      const frames = await page.evaluate(async () => {
        await new Promise(resolve => setTimeout(resolve, 200));
        return new Promise(resolve => { const intervals = []; let start, previous; const frame = now => {
          start ??= now; if (previous !== undefined) intervals.push(now - previous); previous = now;
          if (now - start < 1800) requestAnimationFrame(frame);
          else { intervals.sort((a, b) => a - b); resolve({ frames: intervals.length, median: intervals[Math.floor(intervals.length * .5)], p95: intervals[Math.floor(intervals.length * .95)], max: intervals.at(-1) }); }
        }; requestAnimationFrame(frame); });
      });
      const processes = await app.evaluate(({ app }) => app.getAppMetrics().map(process => ({ type: process.type, cpu: process.cpu.percentCPUUsage, workingSetKB: process.memory.workingSetSize })));
      performanceSamples.push({ cards: count, streamingTerminals: 6, mode, ...frames, processes });
      assert.ok(frames.frames > 15, 'the UI remains responsive during real terminal output');
    }
    await page.screenshot({ path: path.join(output, `liquid-${count}-cards.png`) });
  }
  const first = page.locator(`[data-project-id="${projects[0].id}"]`);
  await first.getByRole('button', { name: `进入 ${projects[0].name}`, exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  await checkEdges('focused');
  const focusedLayout = await checkGaps('focused');
  await first.getByRole('button', { name: `${projects[0].name} 的更多操作`, exact: true }).click();
  await first.getByRole('menu').waitFor();
  await page.getByRole('button', { name: '隐藏活动栏', exact: true }).click();
  await first.locator('.activity-pane').waitFor({ state: 'detached' });
  assert.equal(await first.locator('.status-badge, .panel-header > .icon-button, .panel-menu-anchor').count(), 0, 'the focused header actions disappear with the activity pane');
  assert.deepEqual(await checkGaps('focused without activity'), focusedLayout, 'hiding the activity pane leaves the header and content at the same height');
  await page.getByRole('button', { name: '显示活动栏：它正在做什么', exact: true }).click();
  await first.locator('.activity-pane').waitFor();
  assert.equal(await first.locator('.status-badge, .panel-menu-anchor').count(), 2, 'the focused header actions return with the activity pane');
  assert.equal(await first.getByRole('menu').count(), 0, 'the more menu stays closed when the activity pane returns');
  assert.deepEqual(await checkGaps('focused with activity'), focusedLayout, 'opening the activity pane leaves the header and content at the same height');
  await first.getByRole('button', { name: `${projects[0].name} 的更多操作`, exact: true }).click(); await first.getByRole('menuitem', { name: '新建终端并分屏', exact: true }).click();
  await waitFor(async () => (await state()).projects[0].terminals.length === 2 && (await state()).projects[0].terminals.every(terminal => terminal.shellReady), 'split terminals ready');
  const sample = 'PLAIN  中文字体更亮更清晰\r\n\x1b[1mBOLD   重点文字\x1b[0m\r\n\x1b[2mDIM_DEFAULT  Working / background task\x1b[0m\r\n\x1b[2;31mDIM_RED\x1b[0m\r\n\x1b[2;32mDIM_GREEN\x1b[0m\r\n\x1b[2;38;5;45mDIM_256\x1b[0m\r\n\x1b[2;38;2;130;180;220mDIM_RGB\x1b[0m\r\n\x1b[7mINVERSE\x1b[0m\r\n\x1b[2;7mDIM_INVERSE\x1b[0m\r\n';
  const encoded = Buffer.from(sample).toString('base64');
  for (const terminal of (await state()).projects[0].terminals) await page.evaluate(({ id, encoded }) => window.agentrix.writeTerminal(id, `Clear-Host; [Console]::Write([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))\r`), { id: terminal.id, encoded });
  await waitFor(async () => first.locator('.xterm-rows').first().innerText().then(value => value.includes('DIM_INVERSE')), 'readability sample rendered');
  const sessions = (await state()).projects[0].terminals.map(terminal => terminal.sessionId);
  const cells = await readCells(first.locator('.xterm-rows').first());
  for (const cell of cells) {
    // Terminal text is regular, and bold is 700 (terminal-theme.ts).
    assert.equal(cell.weight, cell.label === 'BOLD' ? '700' : '400');
    assert.equal(cell.size, '13px', 'user font size stays unchanged');
    assert.equal(cell.filter, 'none'); assert.equal(cell.opacity, '1');
    if (cell.label.startsWith('DIM_')) {
      assert.equal(cell.fill[3], 255, `${cell.label} glyphs use full brightness`);
      assert.ok(cell.fill.slice(0, 3).every((value, index) => Math.abs(value - cell.color[index]) <= 2), 'DIM keeps the resolved RGB channels');
    }
  }
  assert.ok(cells.find(cell => cell.label === 'DIM_RED').fill[0] > cells.find(cell => cell.label === 'DIM_RED').fill[1]);
  assert.ok(cells.find(cell => cell.label === 'DIM_GREEN').fill[1] > cells.find(cell => cell.label === 'DIM_GREEN').fill[0]);
  await page.screenshot({ path: path.join(output, `${theme}-bright-text.png`) });
  await first.locator('textarea.xterm-helper-textarea').first().focus(); await page.keyboard.press('Control+Shift+a');
  await waitFor(async () => (await readCells(first.locator('.xterm-rows').first())).every(cell => cell.selected), 'selection rendered');
  const selected = await readCells(first.locator('.xterm-rows').first());
  for (const cell of selected) {
    if (['INVERSE', 'DIM_INVERSE'].includes(cell.label)) {
      assert.ok(cell.fill.every(value => value >= 240), `${theme}: selected default inverse stays readable`);
    }
    else {
      // xterm may brighten RGB against the selection background to meet its
      // contrast setting. The glyph must keep that resolved color, not turn white.
      assert.ok(cell.fill.slice(0, 3).every((value, index) => Math.abs(value - cell.color[index]) <= 2), `${theme}: selection keeps ${cell.label} resolved RGB`);
      if (['DIM_RED', 'DIM_GREEN', 'DIM_256', 'DIM_RGB'].includes(cell.label)) {
        const original = cells.find(original => original.label === cell.label).fill;
        assert.ok(Math.max(...cell.fill.slice(0, 3)) - Math.min(...cell.fill.slice(0, 3)) > 50, `${cell.label} remains colored`);
        for (let channel = 0; channel < 2; channel++) assert.equal(Math.sign(cell.fill[channel] - cell.fill[channel + 1]), Math.sign(original[channel] - original[channel + 1]), `${cell.label} preserves hue ordering`);
      }
    }
  }
  await page.screenshot({ path: path.join(output, `${theme}-split-selection.png`) });
  await page.keyboard.press('Escape');
  await waitFor(async () => (await readCells(first.locator('.xterm-rows').first())).every(cell => !cell.selected), 'selection cleared');
  // xterm may repaint dim cells a frame after the selection flag clears; wait for the colours to settle.
  await waitFor(async () => JSON.stringify(await readCells(first.locator('.xterm-rows').first())) === JSON.stringify(cells), 'colours restored after selection').catch(() => {});
  const cleared = await readCells(first.locator('.xterm-rows').first());
  assert.deepEqual(cleared, cells, 'clearing selection restores original inverse and ANSI colors');
  typography.push({ theme, cells, selected, cleared });
  assert.deepEqual((await state()).projects[0].terminals.map(terminal => terminal.sessionId), sessions);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
  const surfaces = await page.locator('.titlebar, .focus-sidebar, .project-panel:visible').evaluateAll(nodes => nodes.map(node => {
    const style = getComputedStyle(node), values = style.backgroundColor.match(/[\d.]+/g).map(Number);
    return { className: node.className, backdrop: style.backdropFilter, alpha: values.length === 4 ? values[3] : 1 };
  }));
  assert.ok(surfaces.every(surface => surface.backdrop === 'none' && surface.alpha === 1), JSON.stringify(surfaces));
  materials.push({ theme, surfaces });
  await page.screenshot({ path: path.join(output, `${theme}-reduced-transparency.png`) });
  await cdp.send('Emulation.setEmulatedMedia', { features: [] }); await cdp.detach();
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ packaged, performanceSamples, materials, typography, edges, errors }, null, 2));
  console.log(`Material assertions passed; closing isolated Electron PID ${app.process().pid}. Evidence: ${output}`);
} catch (error) { if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
finally { if (app) await closeMaterialApp(app); }
console.log(`PASS: 6/16 flat grey cards with six streaming PTYs, split ANSI/selection/cursor, opaque surfaces under reduced transparency. Evidence: ${output}`);
