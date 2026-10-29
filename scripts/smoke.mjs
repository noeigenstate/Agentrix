import { testRun } from './test-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import net from 'node:net';
import { _electron as electron } from 'playwright-core';
import { runDesktopTask } from '../tests/helpers/desktop-task-fixture.mjs';
import { waitFor, terminalsSettled } from './wait.mjs';
import { openSettings } from './app-menu-helper.mjs';

const require = createRequire(import.meta.url);
const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = await testRun('desktop');
const dataDir = path.join(output, 'user-data');
await fs.mkdir(dataDir, { recursive: true });
const names = ['界面开发', '服务接口', '验证任务', "中文 空格 [a] 'b' $c", '数据处理', '工具项目'];
const projects = [];
for (const name of names) {
  const folder = path.join(output, 'projects', name);
  await fs.mkdir(folder, { recursive: true });
  await fs.mkdir(path.join(folder, 'src', 'components'), { recursive: true });
  await fs.mkdir(path.join(folder, 'assets'));
  await fs.writeFile(path.join(folder, 'README.md'), '# Agentrix fixture\n\n目录预览验证\n<script>globalThis.fileCodeRan = true</script>\n');
  await fs.writeFile(path.join(folder, 'package.json'), JSON.stringify({ name: 'fixture', private: true }, null, 2));
  await fs.writeFile(path.join(folder, '.gitignore'), 'node_modules\n');
  await fs.writeFile(path.join(folder, 'src', 'main.ts'), 'export const message = "中文文件预览";\n');
  await fs.writeFile(path.join(folder, 'src', 'components', 'panel.tsx'), 'export const Panel = () => "hello";\n');
  projects.push({ id: randomUUID(), name, path: folder, unread: 0, seenEvents: [], lastCompletedAt: null });
}
const previewProject = projects[0].path;
const relativeReportFolder = 'art/protagonist_skill_trial_hy_raw_20260915';
await fs.mkdir(path.join(previewProject, relativeReportFolder), { recursive: true });
await fs.writeFile(path.join(previewProject, relativeReportFolder, 'report.html'), '<meta charset="UTF-8"><h1>RELATIVE_REPORT_READY</h1>');
await fs.copyFile(path.join(root, 'assets/icon.png'), path.join(previewProject, relativeReportFolder, '预览_(最终).png'));
await fs.mkdir(path.join(previewProject, 'reports'));
await fs.copyFile(path.join(root, 'tests/fixtures/preview-large.png'), path.join(previewProject, 'image-preview.png'));
await fs.copyFile(path.join(root, 'assets/icon.png'), path.join(previewProject, 'image-without-extension'));
await fs.copyFile(path.join(root, 'tests/fixtures/preview.webm'), path.join(previewProject, 'preview.webm'));
await fs.copyFile(path.join(root, 'tests/fixtures/preview.mp4'), path.join(previewProject, 'preview.mp4'));
await fs.writeFile(path.join(previewProject, 'large.log'), 'LARGE_FILE_START\n' + '中文🙂大文件预览数据\n'.repeat(120000) + 'LARGE_FILE_END');
await fs.writeFile(path.join(previewProject, 'large.html'), '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><h1>大 HTML 页面</h1><!--' + ' '.repeat(2 * 1024 * 1024) + '--><footer>LARGE_HTML_END</footer></html>');
await fs.writeFile(path.join(previewProject, 'alt-screen.cjs'), "process.stdin.setRawMode(true); process.stdin.resume(); process.stdout.write('\\x1b[?1049h'); const render=()=>process.stdout.write('\\x1b[2J\\x1b[HCONPTY_ALT_SCREEN_OK '+process.stdout.columns+' columns\\r\\nPress q to return'); render(); process.stdout.on('resize', render); const timer=setInterval(render,250); process.stdin.on('data',data=>{if(data.toString().includes('q')){clearInterval(timer);process.stdout.removeListener('resize',render);process.stdin.setRawMode(false);process.stdout.write('\\x1b[?1049l',()=>process.exit(0))}});");
await fs.writeFile(path.join(previewProject, 'assets', 'preview.css'), 'body{margin:0;background:rgb(240,246,252);color:#243342;font:16px system-ui}main{padding:32px}img{width:320px;max-width:90%;border-radius:12px}button{padding:10px 20px;background:#246b55;color:white;border:0;border-radius:6px}output{margin:16px}');
await fs.writeFile(path.join(previewProject, 'assets', 'message.mjs'), 'export const message = "LOCAL MODULE READY";');
await fs.writeFile(path.join(previewProject, 'assets', 'data.json'), JSON.stringify({ label: 'LOCAL JSON READY' }));
await fs.writeFile(path.join(previewProject, 'assets', 'preview.mjs'), 'import { message } from "./message.mjs"; document.querySelector("#script-status").textContent=message; const data=await fetch(new URL("./data.json", import.meta.url)).then(r=>r.json()); document.querySelector("#data-status").textContent=data.label; document.querySelector("#increment").onclick=()=>{document.querySelector("#count").textContent=String(Number(document.querySelector("#count").textContent)+1)};');
await fs.writeFile(path.join(previewProject, 'reports', 'preview.html'), '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>HTML preview fixture</title><link rel="stylesheet" href="../assets/preview.css"><main><h1>HTML 页面已渲染</h1><img src="../image-preview.png" alt="相对路径图片"><p id="script-status">Loading scripts</p><p id="data-status"></p><button id="increment">点击计数</button><output id="count">0</output></main><script type="module" src="../assets/preview.mjs"></script></html>');
// These checks read the terminal's rows as HTML, so the compatible (DOM) renderer draws them; gpu-terminal-smoke covers the GPU one.
await fs.writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify({ version: 2, projects, settings: { language: 'zh', terminalRenderer: 'dom', autoSave: false, notifications: false, sound: false, closeToTray: true, fontSize: 12 } }));
const env = { ...process.env, AGENTRIX_DATA_DIR: dataDir };
env.NO_COLOR = '1';
env.NODE_DISABLE_COLORS = '1';
env.FORCE_COLOR = '0';
env.TERM = 'dumb';
delete env.ELECTRON_RUN_AS_NODE;
delete env.AGENTRIX_DEV_URL;
let application;
const packaged = process.argv.includes('--packaged');
const errors = [];
try {
  const captureFlags = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
  if (process.argv.includes('--compact-screen')) captureFlags.push('--force-device-scale-factor=2');
  application = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Agentrix.exe') : require('electron'), args: [...(packaged ? [] : [root]), ...captureFlags], cwd: root, env, timeout: 30000 });
  console.log(`Desktop test process: ${application.process().pid}; screenshots: ${output}`);
  application.process().stderr.on('data', data => { const text = data.toString(); if (/Uncaught|Error:|failed to load/i.test(text)) errors.push(text); });
  const page = await application.firstWindow();
  await application.evaluate(({ ipcMain, shell, dialog, BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
    globalThis.terminalTestInputs = [];
    globalThis.openedLinks = [];
    globalThis.addDialogCount = 0;
    shell.openExternal = async url => { globalThis.openedLinks.push(url); };
    dialog.showOpenDialog = async () => { globalThis.addDialogCount++; return { canceled: true, filePaths: [] }; };
    ipcMain.on('terminal:write', (_event, id, data) => {
      globalThis.terminalTestInputs.push({ id, data });
      if (globalThis.terminalTestInputs.length > 40) globalThis.terminalTestInputs.shift();
    });
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('.project-panel', { timeout: 20000 });
  assert.equal(await page.locator('.project-panel').count(), 6);
  assert.equal(await page.locator('aside').count(), 0, 'overview has no sidebar');
  assert.equal(await page.locator('.workspace-header, .grid-toolbar, .project-filters, .layout-selector').count(), 0);
  // The title bar has no search or add buttons: Ctrl+Shift+N adds a project and Ctrl+Shift+F searches (both configurable).
  const titlebar = page.locator('.titlebar');
  assert.equal(await titlebar.getByRole('button', { name: '添加项目', exact: true }).count(), 0);
  assert.equal(await titlebar.getByRole('textbox', { name: '搜索项目', exact: true }).count(), 0, 'search shows only when asked for');
  await page.keyboard.press('Control+Shift+N');
  await page.getByRole('button', { name: '选择本地文件夹', exact: true }).click();
  assert.equal(await application.evaluate(() => globalThis.addDialogCount), 1, 'Ctrl+Shift+N opens add project');
  await page.getByRole('button', { name: '关闭添加项目', exact: true }).click();
  await page.keyboard.press('Control+Shift+F');
  const searchBox = page.getByRole('textbox', { name: '搜索项目', exact: true });
  assert.equal(await searchBox.evaluate(input => input === document.activeElement), true, 'Ctrl+Shift+F opens and focuses search');
  await page.keyboard.type('abc'); await page.keyboard.press('Control+a');
  assert.deepEqual(await searchBox.evaluate(input => [input.selectionStart, input.selectionEnd]), [0, 3], 'inside a text box Ctrl+A still selects all');
  await page.keyboard.press('End'); await page.keyboard.press('Control+Shift+ArrowLeft');
  assert.deepEqual(await searchBox.evaluate(input => [input.selectionStart, input.selectionEnd, input === document.activeElement]), [0, 3, true], 'with text in it, Ctrl+Shift+Left selects a word');
  assert.equal(await page.locator('dialog[open]').count(), 0, 'and does not open add project');
  await page.keyboard.press('Escape');
  await waitFor(async () => (await titlebar.getByRole('textbox', { name: '搜索项目', exact: true }).count()) === 0, 'Escape clears and closes search');
  // Ctrl+Shift with an arrow moves between cards as they sit in the grid (three by two here) without expanding them;
  // Ctrl+Shift+Enter expands and restores.
  const focusedCard = () => page.evaluate(() => document.activeElement?.closest('[data-project-id]')?.dataset.projectId || null);
  const cardAt = index => page.locator('.project-panel').nth(index).getAttribute('data-project-id');
  await page.keyboard.press('Control+Shift+ArrowRight');
  const firstCard = await cardAt(0);
  await waitFor(async () => (await focusedCard()) === firstCard, 'Ctrl+Shift+Right focuses the first card');
  await page.keyboard.press('Control+Shift+ArrowRight');
  const secondCard = await cardAt(1);
  await waitFor(async () => (await focusedCard()) === secondCard, 'Ctrl+Shift+Right moves to the next card');
  await page.keyboard.press('Control+Shift+ArrowDown');
  const belowCard = await cardAt(4);
  await waitFor(async () => (await focusedCard()) === belowCard, 'Ctrl+Shift+Down moves to the card below');
  await page.keyboard.press('Control+Shift+ArrowUp');
  await waitFor(async () => (await focusedCard()) === secondCard, 'Ctrl+Shift+Up moves to the card above');
  assert.equal(await page.locator('.focus-mode').count(), 0, 'moving between cards never expands one');
  await page.keyboard.press('Control+Shift+ArrowLeft');
  await waitFor(async () => (await focusedCard()) === firstCard, 'Ctrl+Shift+Left moves back');
  await page.keyboard.press('Control+Shift+Enter');
  await waitFor(async () => (await page.locator(`.focus-mode [data-project-id="${firstCard}"].is-focused`).count()) === 1, 'Ctrl+Shift+Enter expands the current project');
  await page.keyboard.press('Control+Shift+Enter');
  await page.waitForFunction(() => !document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  // The grey design: a card is one flat card-coloured pane (#242424 in the workbench), with no blur.
  const material = await page.locator('.project-panel').first().evaluate(el => ({ filter: getComputedStyle(el).backdropFilter, background: getComputedStyle(el).backgroundColor }));
  assert.deepEqual(material, { filter: 'none', background: 'rgb(36, 36, 36)' });
  console.log('PASS: desktop loads six real project folders');

  for (const [index, project] of projects.entries()) {
    const projectPanel = page.locator(`[data-project-id="${project.id}"]`);
    if (index === 0) await projectPanel.getByRole('button', { name: `全屏查看 ${project.name}`, exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.focus-motion-panel'));
    assert.equal(await projectPanel.locator('.terminal-host').count(), 0, 'no empty terminal layer may intercept the start button');
    const startButton = projectPanel.getByRole('button', { name: '只打开终端', exact: true });
    assert.ok(await startButton.evaluate(button => {
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return hit === button || button.contains(hit);
    }), 'the actual start button must receive pointer input');
    await startButton.click();
    await page.waitForSelector('.focus-mode');
    await page.getByRole('button', { name: '返回总览', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-focus-motion]'));
  }
  await waitFor(async () => {
    const result = await page.evaluate(() => window.agentrix.getState());
    return result.ok && result.value.projects.every(p => p.status === 'shell' && p.shellReady);
  }, 'six PowerShell terminals ready');
  console.log('PASS: real button clicks start six ConPTY terminals in grid and fullscreen views');

  await page.locator(`[data-project-id="${projects[0].id}"] .panel-name`).click();
  await page.waitForFunction(() => !document.querySelector('[data-focus-motion]'));
  const colorProof = path.join(projects[0].path, 'color-env.json');
  await page.evaluate(id => window.agentrix.writeTerminal(id, "[IO.File]::WriteAllText((Join-Path (Get-Location).Path 'color-env.json'), (@{NoColor=$env:NO_COLOR;DisableColors=$env:NODE_DISABLE_COLORS;ForceColor=$env:FORCE_COLOR;Term=$env:TERM;ColorTerm=$env:COLORTERM} | ConvertTo-Json -Compress))\r"), projects[0].id);
  await waitFor(async () => { try { return !!JSON.parse(await fs.readFile(colorProof, 'utf8')); } catch { return false; } }, 'color environment proof');
  const colorEnv = JSON.parse(await fs.readFile(colorProof, 'utf8'));
  assert.ok(!colorEnv.NoColor && !colorEnv.DisableColors && !colorEnv.ForceColor);
  assert.equal(colorEnv.Term, 'xterm-256color');
  assert.equal(colorEnv.ColorTerm, 'truecolor');
  await waitFor(async () => (await page.evaluate(() => window.agentrix.getState())).value.projects[0].shellReady, 'prompt after color check');
  await page.evaluate(id => window.agentrix.writeTerminal(id, "Write-Host (([string][char]27) + '[31mRED ' + ([string][char]27) + '[32mGREEN ' + ([string][char]27) + '[34mBLUE ' + ([string][char]27) + '[38;2;255;140;40mTRUECOLOR' + ([string][char]27) + '[0m')\r"), projects[0].id);
  await waitFor(async () => {
    return page.locator(`[data-project-id="${projects[0].id}"] .xterm-rows > div`).evaluateAll(rows => rows.some(row => {
      if (row.textContent.trim() !== 'RED GREEN BLUE TRUECOLOR') return false;
      const colors = new Set([...row.querySelectorAll('span')].filter(span => span.textContent.trim()).map(span => getComputedStyle(span).color));
      return colors.size >= 4;
    }));
  }, 'ANSI and truecolor text render as four distinct colors');
  await page.screenshot({ path: path.join(output, 'terminal-colors.png') });
  console.log('PASS: inherited NO_COLOR is removed and ANSI/truecolor output reaches the terminal');
  await waitFor(async () => (await page.evaluate(() => window.agentrix.getState())).value.projects[0].shellReady, 'prompt after ANSI color output');

  await page.evaluate(id => window.agentrix.writeTerminal(id, "[IO.File]::WriteAllText((Join-Path (Get-Location).Path 'cwd-proof.txt'), (Get-Location).Path)\r"), projects[3].id);
  await waitFor(async () => { try { return await fs.readFile(path.join(projects[3].path, 'cwd-proof.txt'), 'utf8') === projects[3].path; } catch { return false; } }, 'literal working directory with brackets, quotes, ampersand and dollar');

  await page.evaluate(id => window.agentrix.writeTerminal(id, "Write-Output 'AGENTRIX_STREAM_OK'\r"), projects[0].id);
  await waitFor(async () => {
    return page.locator(`[data-project-id="${projects[0].id}"] .xterm-rows > div`).evaluateAll(rows => rows.some(row => row.textContent.trim() === 'AGENTRIX_STREAM_OK'));
  }, 'terminal output');
  await page.evaluate(id => window.agentrix.writeTerminal(id, 'codex --version\r'), projects[1].id);
  await waitFor(async () => {
    const result = await page.evaluate(id => window.agentrix.attachTerminal(id), projects[1].id);
    return result.ok && result.value.data.includes('codex-cli');
  }, 'Codex wrapper returns version without a model request');
  await waitFor(async () => {
    const result = await page.evaluate(() => window.agentrix.getState());
    return result.ok && result.value.projects[1].status === 'shell';
  }, 'Codex process exit returns to shell');
  assert.equal((await page.evaluate(() => window.agentrix.getState())).value.projects[1].unread, 0);
  console.log('PASS: actual Codex CLI launches through the wrapper; command exit does not mean turn complete');
  await page.evaluate(id => window.agentrix.writeTerminal(id, 'codex features list\r'), projects[1].id);
  await waitFor(async () => {
    const result = await page.evaluate(id => window.agentrix.attachTerminal(id), projects[1].id);
    return result.ok && result.value.data.includes('stable');
  }, 'Codex parses notification config without losing Windows argument quotes');
  await waitFor(async () => (await page.evaluate(() => window.agentrix.getState())).value.projects[1].shellReady, 'Codex config check returns prompt');
  assert.equal((await page.evaluate(() => window.agentrix.getState())).value.projects[1].error, null);
  await page.getByRole('button', { name: '返回总览', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-focus-motion]'));

  const runtime = (await fs.readdir(dataDir)).find(name => name.startsWith('runtime-'));
  const bootstraps = [];
  for (const filename of (await fs.readdir(path.join(dataDir, runtime))).filter(name => name.endsWith('.json'))) bootstraps.push(JSON.parse(await fs.readFile(path.join(dataDir, runtime, filename), 'utf8')));
  const info = bootstraps.find(b => b.projectId === projects[0].id);
  const complete = async (turnId, target = info, threadId = 'smoke-thread') => {
    const payload = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': threadId, 'turn-id': turnId, cwd: projects[0].path, 'last-assistant-message': '验证完成 "quotes" 中文' });
    await exec(target.powershellPath, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', target.notifyPath, '-PipeName', target.pipeName, '-ProjectId', target.projectId, '-SessionKey', target.sessionKey, '-Payload', payload], { windowsHide: true, timeout: 12000 });
  };
  await runDesktopTask(page, projects[0], path.join(output, 'codex-home'), 'turn-1', waitFor);
  await complete('turn-1');
  await waitFor(async () => (await page.evaluate(() => window.agentrix.getState())).value.projects[0].unread === 1, 'real notify.ps1 marks red');
  await complete('turn-1');
  assert.equal((await page.evaluate(() => window.agentrix.getState())).value.projects[0].unread, 1);
  const firstCompletedAt = (await page.evaluate(() => window.agentrix.getState())).value.projects[0].lastCompletedAt;
  await complete('background-turn', info, 'background-thread');
  assert.equal((await page.evaluate(() => window.agentrix.getState())).value.projects[0].unread, 1, 'different background IDs do not mean a fresh user submission');
  assert.equal((await page.evaluate(() => window.agentrix.getState())).value.projects[0].lastCompletedAt, firstCompletedAt);
  const animation = await page.locator(`[data-project-id="${projects[0].id}"]`).evaluate(el => ({
    panel: getComputedStyle(el).animationName, lit: el.classList.contains('attention-active'),
    lights: ['.panel-signal', '.status-dot'].map(selector => {
      const style = getComputedStyle(el.querySelector(selector));
      return [style.animationName, style.animationDuration, style.animationIterationCount];
    }),
  }));
  assert.equal(animation.panel, 'none', 'the reading surface never flashes');
  assert.ok(animation.lit, 'a finished turn lights its card');
  assert.deepEqual(animation.lights.map(([name]) => name), ['signal-breathe', 'none'], 'a finished turn breathes its glow, never the dot');
  assert.deepEqual(animation.lights[0].slice(1), ['2.5s', 'infinite'], 'the breath is a 2.5 s loop');
  console.log('PASS: parent lifecycle marks the card with the white needs-you glow; unrelated notify callbacks are ignored');

  const projectOrder = () => page.locator('.agentrix > .project-slot > .project-panel').evaluateAll(panels => panels.map(panel => panel.dataset.projectId));
  const beginProjectDrag = async (sourceId, targetId) => {
    const baseline = await projectOrder(), fromIndex = baseline.indexOf(sourceId), toIndex = baseline.indexOf(targetId);
    assert.ok(fromIndex >= 0 && toIndex >= 0 && fromIndex !== toIndex, 'drag source and destination are distinct baseline projects');
    const expected = [...baseline]; expected.splice(fromIndex, 1); expected.splice(toIndex, 0, sourceId);
    const stableGeometry = async () => {
      let previous, geometry;
      await waitFor(async () => {
        const current = await page.evaluate(async ({ baseline, sourceId }) => {
          const grid = document.querySelector('.agentrix'), area = grid.closest('.grid-area');
          const slots = [...grid.querySelectorAll(':scope > [data-project-slot]')];
          const state = await window.agentrix.getState();
          if (grid.classList.contains('is-reordering') || !state.ok ||
            JSON.stringify(slots.map(slot => slot.dataset.projectSlot)) !== JSON.stringify(baseline) ||
            JSON.stringify(state.value.projects.map(project => project.id)) !== JSON.stringify(baseline)) return null;
          const panels = slots.map(slot => slot.querySelector('.project-panel'));
          const headers = panels.map(panel => panel.querySelector('.panel-header'));
          const name = grid.querySelector(`[data-project-id="${sourceId}"] .panel-name`);
          // Only finite geometry animations on cards/slots/handles matter; terminal animations can run forever.
          if ([grid, ...slots, ...panels, ...headers, name].some(node => node.getAnimations().some(animation =>
            (animation.pending || animation.playState === 'running') && Number.isFinite(animation.effect?.getComputedTiming().endTime) &&
            animation.effect.getKeyframes().some(frame => ['transform', 'translate', 'scale', 'left', 'top', 'width', 'height'].some(key => key in frame))))) return null;
          const box = node => { const r = node.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; };
          return { grid: box(grid), area: box(area), name: box(name), scroll: [area.scrollLeft, area.scrollTop],
            cells: slots.map((slot, index) => ({ left: slot.offsetLeft, top: slot.offsetTop, width: slot.offsetWidth, height: slot.offsetHeight,
              slot: box(slot), header: box(headers[index]), panel: box(panels[index]) })) };
        }, { baseline, sourceId });
        const stable = current && previous && JSON.stringify(current) === JSON.stringify(previous);
        previous = current; geometry = stable ? current : null;
        return !!geometry;
      }, `drag geometry and DOM/workspace baseline settle for ${sourceId}`);
      return geometry;
    };
    const initial = await stableGeometry();
    await page.mouse.move(initial.name.x + Math.min(20, initial.name.width / 2), initial.name.y + initial.name.height / 2);
    const settled = await stableGeometry(); // Hover lift can move the header after the pointer arrives.
    await page.mouse.move(settled.name.x + Math.min(20, settled.name.width / 2), settled.name.y + settled.name.height / 2);
    await page.mouse.down();
    await page.locator(`[data-project-id="${sourceId}"].drag-source`).waitFor();
    // Keep the baseline physical ordinal, rather than following a neighboring card as it shifts away.
    const cell = settled.cells[toIndex];
    const to = await page.locator('.agentrix').evaluate((grid, cell) => {
      const bounds = grid.getBoundingClientRect();
      return { x: bounds.left + cell.left + Math.min(40, cell.width / 2),
        y: bounds.top + cell.top + cell.header.y - cell.slot.y + cell.header.height / 2 };
    }, cell);
    assert.ok(to.x > settled.area.x && to.x < settled.area.x + settled.area.width && to.y > settled.area.y && to.y < settled.area.y + settled.area.height, 'destination cell is inside the drag viewport');
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await waitFor(async () => await page.locator(`[data-project-id="${sourceId}"].drag-source`).count() === 1 &&
      JSON.stringify(await projectOrder()) === JSON.stringify(expected), `active drag previews exact insertion order ${JSON.stringify(expected)}`);
  };
  const originalOrder = projects.map(project => project.id);
  const sessionIds = Object.fromEntries((await page.evaluate(() => window.agentrix.getState())).value.projects.map(project => [project.id, project.sessionId]));
  await beginProjectDrag(projects[0].id, projects[2].id);
  await page.screenshot({ path: path.join(output, 'project-drag.png') });
  // Follow the dropped card every frame: it glides into its slot and never flashes back to where it started.
  await page.evaluate(id => {
    const panel = document.querySelector(`[data-project-id="${id}"]`); window.dropTrack = [];
    const step = () => { const box = panel.getBoundingClientRect(); window.dropTrack.push([box.left, box.top]); if (window.dropTrack.length < 90) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }, projects[0].id);
  await page.mouse.up();
  const swappedOrder = [...originalOrder]; swappedOrder.splice(0, 1); swappedOrder.splice(2, 0, originalOrder[0]);
  await waitFor(async () => JSON.stringify(await projectOrder()) === JSON.stringify(swappedOrder) && await page.locator('.is-reordering').count() === 0, 'drop inserts the project and shifts neighboring positions');
  await waitFor(async () => (await page.evaluate(() => window.dropTrack.length)) >= 90, 'drop frames recorded');
  const landed = await page.locator(`[data-project-slot="${projects[0].id}"]`).boundingBox(), dropTrack = await page.evaluate(() => window.dropTrack);
  const distances = dropTrack.map(([left, top]) => Math.hypot(left - landed.x, top - landed.y));
  assert.ok(distances.every((distance, index) => !index || distance <= distances[index - 1] + 4), `the dropped card never jumps back: ${distances.map(Math.round).join(',')}`);
  // The pointer still rests on the card it dropped, so the card ends raised over its slot by the hover lift.
  const settled = dropTrack.at(-1);
  assert.ok(Math.abs(settled[0] - landed.x) < 2 && landed.y - settled[1] > -2 && landed.y - settled[1] < 6, `the dropped card ends in its slot: ${JSON.stringify({ settled, landed })}`);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'workspace.json'), 'utf8')).projects.map(project => project.id), swappedOrder);
  const afterDrag = (await page.evaluate(() => window.agentrix.getState())).value.projects;
  assert.deepEqual(Object.fromEntries(afterDrag.map(project => [project.id, project.sessionId])), sessionIds);
  assert.equal(afterDrag.find(project => project.id === projects[0].id).unread, 1, 'drag does not acknowledge the red card');
  assert.equal(await page.locator('.focus-mode').count(), 0, 'drop does not trigger fullscreen');
  await beginProjectDrag(projects[0].id, projects[2].id);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await waitFor(async () => await page.locator('.is-reordering').count() === 0, 'canceled drag returns to its original slot');
  assert.deepEqual(await projectOrder(), swappedOrder, 'Escape cancels a pending swap');
  assert.equal(await page.locator('.focus-mode').count(), 0);
  await beginProjectDrag(projects[0].id, projects[1].id); await page.mouse.up();
  await waitFor(async () => JSON.stringify(await projectOrder()) === JSON.stringify(originalOrder), 'a second drop restores the original order');
  await page.locator(`[data-project-id="${projects[1].id}"] .panel-name`).click();
  await page.waitForSelector('.focus-mode');
  await page.getByRole('button', { name: '返回总览', exact: true }).click();
  console.log('PASS: whole-card insertion reordering preserves PTYs, persists positions, cancels with Escape and keeps ordinary clicks');

  const panel = page.locator(`[data-project-id="${projects[0].id}"]`);
  const sessionBefore = (await page.evaluate(() => window.agentrix.getState())).value.projects[0].sessionId;
  await panel.getByRole('button', { name: `查看 ${projects[0].name} 的完成结果` }).click();
  await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), false, 'opening a red tile expands the project inside the window');
  assert.equal((await page.evaluate(() => window.agentrix.getState())).value.projects[0].unread, 0);
  await page.getByRole('treeitem', { name: 'src', exact: true }).waitFor();
  assert.equal(await page.locator('.focus-toolbar').count(), 0, 'old top toolbar removed');
  assert.equal(await page.locator('.focus-sidebar').getByRole('button', { name: '返回总览', exact: true }).count(), 1);
  await page.getByRole('treeitem', { name: 'src', exact: true }).click();
  await page.getByRole('treeitem', { name: 'components', exact: true }).click();
  await page.getByRole('treeitem', { name: 'panel.tsx', exact: true }).waitFor();
  await page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
  await page.getByLabel('文件编辑器', { exact: true }).waitFor();
  assert.ok((await page.getByLabel('文件编辑器', { exact: true }).inputValue()).includes('目录预览验证'));
  assert.equal(await page.evaluate(() => globalThis.fileCodeRan), undefined, 'file markup is displayed as text');
  assert.equal((await page.evaluate(() => window.agentrix.getState())).value.projects[0].sessionId, sessionBefore);
  await page.screenshot({ path: path.join(output, 'file-preview.png') });
  await page.getByRole('button', { name: '关闭文件预览', exact: true }).click();
  await page.getByRole('treeitem', { name: 'image-preview.png', exact: true }).click();
  const imagePreview = page.locator('img.preview-image');
  await waitFor(async () => imagePreview.evaluate(image => image.complete && image.naturalWidth > 1000), 'large PNG displayed inline');
  const originalDimensions = await imagePreview.evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight }));
  const fits = await imagePreview.evaluate(image => { const box = image.getBoundingClientRect(); const viewport = image.closest('.image-viewport').getBoundingClientRect(); return box.width <= viewport.width && box.height <= viewport.height; });
  assert.equal(fits, true);
  await page.screenshot({ path: path.join(output, 'png-preview.png') });
  await page.getByRole('button', { name: '原始尺寸', exact: true }).click();
  await waitFor(async () => imagePreview.evaluate((image, width) => Math.abs(image.getBoundingClientRect().width - width) < 2, originalDimensions.width), 'image original size');
  await page.getByRole('button', { name: '适应窗口', exact: true }).click();
  await fs.copyFile(path.join(root, 'assets', 'icon.png'), path.join(previewProject, 'image-preview.png'));
  await page.getByRole('button', { name: '刷新文件', exact: true }).click();
  await waitFor(async () => imagePreview.evaluate(image => image.complete && image.naturalWidth === 256), 'image refresh updates the pixels and dimensions');
  const imageUrl = await imagePreview.getAttribute('src');
  await page.getByRole('button', { name: '关闭文件预览', exact: true }).click();
  assert.equal(await application.evaluate(async ({ net }, url) => (await net.fetch(url)).status, imageUrl), 404);
  await fs.copyFile(path.join(root, 'tests/fixtures/preview-large.png'), path.join(previewProject, 'image-preview.png'));

  await page.getByRole('treeitem', { name: 'reports', exact: true }).click();
  await page.getByRole('treeitem', { name: 'preview.html', exact: true }).click();
  const htmlFrame = page.frameLocator('iframe[title="HTML 页面预览"]');
  await htmlFrame.getByRole('heading', { name: 'HTML 页面已渲染' }).waitFor();
  await htmlFrame.getByText('LOCAL MODULE READY', { exact: true }).waitFor();
  await htmlFrame.getByText('LOCAL JSON READY', { exact: true }).waitFor();
  assert.equal(await htmlFrame.locator('body').evaluate(body => getComputedStyle(body).backgroundColor), 'rgb(240, 246, 252)');
  await waitFor(async () => htmlFrame.locator('img').evaluate(image => image.complete && image.naturalWidth > 1000), 'HTML relative PNG loaded');
  await htmlFrame.getByRole('button', { name: '点击计数' }).click();
  assert.equal(await htmlFrame.locator('#count').innerText(), '1');
  const isolated = await htmlFrame.locator('body').evaluate(() => {
    let parentAccessible = false;
    try { parentAccessible = !!parent.document; } catch {}
    return { parentAccessible, bridge: typeof window.agentrix, node: typeof window.require };
  });
  assert.deepEqual(isolated, { parentAccessible: false, bridge: 'undefined', node: 'undefined' });
  await page.screenshot({ path: path.join(output, 'html-preview.png') });
  await page.getByRole('button', { name: '源码', exact: true }).click();
  assert.ok((await page.getByLabel('文件编辑器', { exact: true }).inputValue()).includes('<h1>HTML 页面已渲染</h1>'));
  await page.getByRole('button', { name: '页面', exact: true }).click();
  await htmlFrame.getByRole('heading', { name: 'HTML 页面已渲染' }).waitFor();
  await page.getByRole('button', { name: '返回终端', exact: true }).click();
  assert.equal((await page.evaluate(() => window.agentrix.getState())).value.projects[0].sessionId, sessionBefore);
  console.log('PASS: PNG fit/original size/refresh and isolated HTML with CSS, modules, images, JSON and source toggle');

  await page.getByRole('treeitem', { name: 'image-without-extension', exact: true }).click();
  await waitFor(async () => page.locator('img.preview-image').evaluate(image => image.complete && image.naturalWidth === 256), 'image signature loads without an extension');
  await page.getByRole('button', { name: '返回终端', exact: true }).click();
  await page.getByRole('treeitem', { name: 'large.log', exact: true }).click();
  // Large text opens straight into the editor, one page at a time, with only the visible line numbers drawn.
  const largeEditor = page.getByRole('textbox', { name: '文件编辑器', exact: true });
  await waitFor(async () => (await largeEditor.inputValue()).includes('LARGE_FILE_START'), 'first large page opens in the editor');
  assert.equal(await page.getByRole('button', { name: '结束编辑', exact: true }).count(), 0, 'no save or stop-editing buttons; Ctrl+S saves');
  assert.equal(await page.locator('.preview-readonly').innerText(), '编辑模式');
  assert.ok(await page.getByRole('button', { name: '下一页', exact: true }).isEnabled());
  assert.ok(await page.locator('.editor-gutter span').count() < 150, 'large files only number the visible lines');
  await largeEditor.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await waitFor(async () => page.locator('.editor-gutter span').last().innerText().then(value => Number(value) > 100), 'line numbers follow the editor to later lines');
  await page.getByRole('button', { name: '末页', exact: true }).click();
  await page.getByRole('button', { name: '首页', exact: true }).waitFor();
  await waitFor(async () => (await largeEditor.inputValue()).includes('LARGE_FILE_END'), 'last large page opens in the editor');
  await page.getByRole('spinbutton', { name: '文件页码', exact: true }).fill('2');
  await page.getByRole('button', { name: '跳转', exact: true }).click();
  await waitFor(async () => page.getByRole('spinbutton', { name: '文件页码', exact: true }).inputValue().then(value => value === '2'), 'jump to large text page');
  await page.screenshot({ path: path.join(output, 'large-file.png') });
  await page.getByRole('button', { name: '返回终端', exact: true }).click();
  await page.getByRole('treeitem', { name: 'large.html', exact: true }).click();
  await page.frameLocator('iframe[title="HTML 页面预览"]').getByRole('heading', { name: '大 HTML 页面' }).waitFor();
  await page.getByRole('button', { name: '源码', exact: true }).click();
  await page.getByRole('button', { name: '末页', exact: true }).click();
  await waitFor(async () => (await page.getByLabel('文件编辑器', { exact: true }).inputValue()).includes('LARGE_HTML_END'), 'last HTML source page is editable');
  await page.getByRole('button', { name: '返回终端', exact: true }).click();
  console.log('PASS: large text and HTML use bounded, Unicode-safe pages with virtual scrolling and page navigation');

  for (const filename of ['preview.webm', 'preview.mp4']) {
    await page.getByRole('treeitem', { name: filename, exact: true }).click();
    const video = page.locator('video.preview-video');
    await waitFor(async () => video.evaluate(node => node.readyState >= 2 && node.videoWidth === 320), `${filename} decodes in the desktop player`);
    assert.equal(await video.evaluate(node => node.controls), true);
    await video.evaluate(node => node.play());
    await waitFor(async () => video.evaluate(node => !node.paused && node.currentTime > .15), `${filename} plays`);
    await video.evaluate(node => { node.pause(); node.currentTime = 2.5; });
    await waitFor(async () => video.evaluate(node => !node.seeking && Math.abs(node.currentTime - 2.5) < .2), `${filename} seeks using byte ranges`);
    assert.equal(await video.evaluate(node => node.paused), true);
    if (filename === 'preview.webm') {
      await video.evaluate(node => Promise.race([node.requestFullscreen(), new Promise((_, reject) => setTimeout(() => reject(new Error('Video fullscreen did not settle')), 5000))]));
      await waitFor(async () => page.evaluate(() => document.fullscreenElement?.tagName === 'VIDEO'), 'video fullscreen');
      await page.evaluate(() => Promise.race([document.exitFullscreen(), new Promise((_, reject) => setTimeout(() => reject(new Error('Exit video fullscreen did not settle')), 5000))]));
    }
    const videoUrl = await video.getAttribute('src');
    const rangeStatus = await application.evaluate(async ({ net }, url) => { const response = await net.fetch(url, { headers: { Range: 'bytes=0-15' } }); const data = await response.arrayBuffer(); return { status: response.status, length: data.byteLength }; }, videoUrl);
    assert.deepEqual(rangeStatus, { status: 206, length: 16 });
    await page.screenshot({ path: path.join(output, filename.replace('.', '-') + '.png') });
    await page.getByRole('button', { name: '返回终端', exact: true }).click();
  }
  console.log('PASS: actual WebM and MP4 decoding, playback, pause, seeking and partial-content protocol responses');

  await page.evaluate(id => window.agentrix.writeTerminal(id, 'node ./alt-screen.cjs\r'), projects[0].id);
  await waitFor(async () => panel.locator('.xterm-rows > div').evaluateAll(rows => rows.some(row => row.textContent.includes('CONPTY_ALT_SCREEN_OK') && !row.textContent.includes('node '))), 'interactive alternate-screen terminal');
  await page.getByRole('button', { name: '收起目录栏', exact: true }).click();
  await page.locator('.explorer-rail').getByRole('button', { name: '资源管理器', exact: true }).click();
  // The resizes reach ConPTY while the app still runs: on a slow runner the last refit could otherwise land after it
  // exits, in the middle of the next output, where ConPTY and xterm reflow the half-drawn lines differently.
  await terminalsSettled(page);
  await page.evaluate(id => window.agentrix.writeTerminal(id, 'q'), projects[0].id);
  await waitFor(async () => (await page.evaluate(() => window.agentrix.getState())).value.projects[0].shellReady, 'alternate-screen app exits after resizing without a cursor-report loop');
  console.log('PASS: interactive alternate-screen app remains responsive through terminal resizing');

  const clickTerminalText = async (text, control = true) => {
    // xterm reuses row elements when output scrolls, so the row found a moment ago may already hold
    // the next line. Prompt output can also scroll a link after measuring it: re-measure and hover together.
    const row = panel.locator('.xterm-rows > div').filter({ hasText: text }).last();
    const screen = panel.locator('.xterm-screen');
    let position = null;
    await terminalsSettled(page);
    await waitFor(async () => {
      await row.waitFor();
      position = await row.evaluate((element, needle) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const nodes = [];
        let node;
        while ((node = walker.nextNode())) nodes.push(node);
        const all = nodes.map(node => node.textContent).join('');
        let offset = all.indexOf(needle);
        if (offset < 0) throw new Error(`Missing terminal text: ${needle}`);
        for (const node of nodes) {
          if (offset < node.textContent.length) {
            const range = document.createRange();
            range.setStart(node, offset); range.setEnd(node, offset + 1);
            const rect = range.getBoundingClientRect();
            const screenBox = element.closest('.xterm-screen').getBoundingClientRect();
            return { x: rect.x - screenBox.x + rect.width / 2, y: rect.y - screenBox.y + rect.height / 2 };
          }
          offset -= node.textContent.length;
        }
        throw new Error('No terminal cell');
      }, text).catch(error => { if (/Missing terminal text/.test(error.message)) return null; throw error; });
      if (!position) return false;
      // xterm caches link lookups per row, empty ones included, until the pointer
      // changes rows. Step onto a neighbouring row and back, measuring again on
      // each retry in case the line moved after a late repaint.
      const step = await row.evaluate(element => element.getBoundingClientRect().height);
      await screen.hover({ position: { x: position.x, y: position.y >= step ? position.y - step : position.y + step } });
      await screen.hover({ position });
      return (await panel.locator('.terminal-host').getAttribute('title'))?.includes('Ctrl');
    }, `terminal link hover: ${text}`);
    await screen.click({ position, modifiers: control ? ['Control'] : [] });
  };
  const printLine = async text => {
    await waitFor(async () => (await page.evaluate(() => window.agentrix.getState())).value.projects[0].shellReady, 'shell prompt before printing links');
    await page.evaluate(({ id, command }) => window.agentrix.writeTerminal(id, command), { id: projects[0].id, command: `Write-Output '${text.replaceAll("'", "''")}'\r` });
    await waitFor(async () => (await page.evaluate(() => window.agentrix.getState())).value.projects[0].shellReady, 'shell prompt after printing links');
  };
  await printLine('中文链接 image-preview.png');
  await waitFor(async () => panel.locator('.xterm-rows > div').evaluateAll(rows => rows.some(row => row.textContent.trim() === '中文链接 image-preview.png')), 'terminal output after preview and fullscreen resizing is not overwritten by an old prompt');
  await clickTerminalText('image-preview.png', false);
  assert.equal(await page.locator('.file-preview, .file-popup').count(), 0, 'ordinary click does not open a file');
  // A file a terminal names opens in a popup over the terminal, not in the project's file preview.
  const popup = page.locator('.file-popup');
  const closePopup = async () => { await page.keyboard.press('Escape'); await popup.waitFor({ state: 'detached' }); };
  await clickTerminalText('image-preview.png');
  await waitFor(async () => popup.locator('img').evaluate(image => image.complete && image.naturalWidth > 1000).catch(() => false), 'Ctrl click opens a PNG within the app');
  assert.equal(await page.locator('.file-preview').count(), 0, 'the terminal stays where it was');
  await closePopup();
  const wrappedUrl = `http://127.0.0.1:43219/${'path/'.repeat(70)}WRAPPED_LINK_END`;
  await printLine(wrappedUrl);
  await clickTerminalText('_LINK_END', false);
  assert.equal((await application.evaluate(() => globalThis.openedLinks)).length, 0);
  await clickTerminalText('_LINK_END');
  await waitFor(async () => (await application.evaluate(() => globalThis.openedLinks)).at(-1) === wrappedUrl, 'Ctrl click opens the full wrapped URL');
  const reportUrl = pathToFileURL(path.join(previewProject, 'reports', 'preview.html')).href;
  const osc = `[Console]::WriteLine(([string][char]27) + ']8;;${reportUrl}' + [char]7 + 'REPORT_LINK' + [char]27 + ']8;;' + [char]7)\r`;
  await page.evaluate(({ id, command }) => window.agentrix.writeTerminal(id, command), { id: projects[0].id, command: osc });
  await waitFor(async () => panel.locator('.xterm-rows > div').evaluateAll(rows => rows.some(row => row.textContent.trim() === 'REPORT_LINK')), 'OSC 8 link rendered');
  const oscSnapshot = await page.evaluate(id => window.agentrix.attachTerminal(id), projects[0].id);
  assert.ok(oscSnapshot.ok && oscSnapshot.value.data.includes('\x1b]8;'), 'bundled ConPTY preserves OSC 8 metadata');
  await clickTerminalText('REPORT_LINK');
  await page.frameLocator('.file-popup iframe[title="HTML 页面预览"]').getByRole('heading', { name: 'HTML 页面已渲染' }).waitFor();
  await closePopup();
  console.log('PASS: OSC 8 file link opens an HTML preview in a popup');
  await printLine(`查看 HTML 报告 (${relativeReportFolder}/report.html) · 下载报告与模型包 (${relativeReportFolder}/review_bundle.zip)`);
  await clickTerminalText('report.html');
  await page.frameLocator('.file-popup iframe[title="HTML 页面预览"]').getByRole('heading', { name: 'RELATIVE_REPORT_READY' }).waitFor();
  await page.screenshot({ path: path.join(output, 'relative-report-link.png') });
  await closePopup();
  await printLine(`查看图片 (./${relativeReportFolder}/预览_(最终).png)`);
  await clickTerminalText('预览_(最终).png');
  await waitFor(async () => popup.locator('img').evaluate(image => image.complete && image.naturalWidth === 256).catch(() => false), 'parenthesized relative PNG with literal filename parentheses');
  await closePopup();
  console.log('PASS: Codex-style parenthesized relative HTML and PNG links complete from the project root');
  assert.equal((await page.evaluate(() => window.agentrix.getState())).value.projects[0].sessionId, sessionBefore);
  console.log('PASS: Ctrl-click local files and wrapped web URLs, with ordinary clicks and terminal sessions preserved');
  const fullWidth = (await panel.boundingBox()).width;
  await page.getByRole('button', { name: '收起目录栏', exact: true }).click();
  await waitFor(async () => (await panel.boundingBox()).width > fullWidth + 100, 'collapsed sidebar frees terminal width');
  await page.screenshot({ path: path.join(output, 'collapsed-sidebar.png') });
  assert.equal(await page.getByRole('button', { name: '返回总览', exact: true }).count(), 0, 'the collapsed rail has no back button');
  assert.equal(await page.getByRole('button', { name: /标记开发完成|在 VS Code 打开/ }).count(), 0);
  assert.ok(await page.locator('.focus-sidebar').getByRole('button', { name: 'Git 历史', exact: true }).isVisible());
  await page.keyboard.press('Control+b');
  await page.getByRole('treeitem', { name: 'panel.tsx', exact: true }).waitFor();
  await page.getByRole('button', { name: '更多文件操作', exact: true }).click(); await page.getByRole('menuitem', { name: '折叠所有文件夹', exact: true }).click();
  await waitFor(async () => await page.getByRole('treeitem', { name: 'src', exact: true }).getAttribute('aria-expanded') === 'false', 'collapse nested folders');
  await fs.writeFile(path.join(projects[0].path, 'new-file.txt'), 'directory refresh');
  await page.getByRole('button', { name: '刷新项目目录', exact: true }).click();
  await page.getByRole('treeitem', { name: 'new-file.txt', exact: true }).waitFor();
  await fs.writeFile(path.join(projects[0].path, 'auto-refresh.txt'), 'automatic directory refresh');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
  await page.getByRole('treeitem', { name: 'auto-refresh.txt', exact: true }).waitFor({ timeout: 7000 });
  assert.equal((await page.evaluate(() => window.agentrix.getState())).value.projects[0].sessionId, sessionBefore);
  console.log('PASS: focused explorer, nested folders, safe file preview, refresh, collapse and Ctrl+B preserve the terminal session');
  await page.screenshot({ path: path.join(output, 'fullscreen.png') });
  await page.getByRole('button', { name: '返回总览', exact: true }).click();
  await waitFor(async () => !await page.locator('.focus-mode').count(), 'back to grid');
  assert.equal((await page.evaluate(() => window.agentrix.getState())).value.projects[0].sessionId, sessionBefore);
  await page.evaluate(id => window.agentrix.writeTerminal(id, "Write-Output 'SECOND_USER_INSTRUCTION'\r"), projects[0].id);
  await waitFor(async () => (await page.evaluate(() => window.agentrix.getState())).value.projects[0].shellReady, 'new submitted instruction completes');
  await runDesktopTask(page, projects[0], path.join(output, 'codex-home'), 'turn-2', waitFor);
  await complete('turn-2');
  await waitFor(async () => (await page.evaluate(() => window.agentrix.getState())).value.projects[0].unread === 1, 'second round red');
  console.log('PASS: red tile expands inside the window without native fullscreen, marks viewed, returns without restarting terminal, and next turn lights red');

  await panel.getByRole('button', { name: `查看 ${projects[0].name} 的完成结果` }).click();
  await waitFor(async () => (await page.evaluate(() => window.agentrix.getState())).value.projects[0].unread === 0, 'viewing acknowledges the automatic completion');
  await page.getByRole('button', { name: '返回总览', exact: true }).click();
  await waitFor(async () => !await page.locator('.focus-mode').count(), 'viewed result returns to grid');
  assert.equal(await panel.evaluate(el => getComputedStyle(el).animationName), 'none');
  console.log('PASS: viewing an automatic completion clears attention without a manual project-finish action');

  const target = bootstraps.find(b => b.projectId === projects[2].id);
  await page.evaluate(id => window.agentrix.writeTerminal(id, "Write-Output 'IDLE_ALERT_FIXTURE'\r"), projects[2].id);
  await waitFor(async () => (await page.evaluate(() => window.agentrix.getState())).value.projects[2].shellReady, 'idle notification fixture command completes');
  await runDesktopTask(page, projects[2], path.join(output, 'codex-home'), 'other-project-turn', waitFor);
  await complete('other-project-turn', target);
  await page.keyboard.press('Control+Shift+F'); await page.getByRole('textbox', { name: '搜索项目' }).fill('不存在');
  await page.waitForSelector('.no-results');
  await page.getByRole('button', { name: '清除搜索' }).click();
  await page.waitForSelector('.project-panel');
  await page.screenshot({ path: path.join(output, 'grid.png') });
  await openSettings(page);
  await page.waitForSelector('dialog[open]');
  // Settings show one category at a time; updates live under "更新与关于".
  await page.locator('.settings-nav').getByRole('button', { name: '更新与关于', exact: true }).click();
  await page.getByRole('region', { name: '应用更新', exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.agentrix.getUpdateState())).value.supported, false, 'unpacked and development builds cannot install over an installed app');
  assert.equal((await page.evaluate(() => window.agentrix.installUpdate())).ok, false, 'installing before a verified download is rejected');
  await page.screenshot({ path: path.join(output, 'settings.png') });
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  const idlePanel = page.locator(`[data-project-id="${projects[2].id}"]`);
  await waitFor(async () => idlePanel.evaluate(element => !element.classList.contains('attention-active')), 'completed idle project ends its initial alert', 13000);
  await complete('other-project-turn', target);
  const idleCompletedAt = (await page.evaluate(() => window.agentrix.getState())).value.projects[2].lastCompletedAt;
  await page.evaluate(id => window.agentrix.writeTerminal(id, '\x1b[I\x1b[O\x1b[1;1R'), projects[2].id);
  await complete('idle-background-turn', target, 'another-thread');
  assert.equal((await page.evaluate(() => window.agentrix.getState())).value.projects[2].lastCompletedAt, idleCompletedAt);
  assert.equal((await page.evaluate(() => window.agentrix.getState())).value.projects[2].unread, 1, 'same completed turn never repeats the notification');
  assert.equal(await idlePanel.evaluate(element => element.classList.contains('attention-active')), false, 'an idle background callback does not restart the alert');
  assert.equal(await idlePanel.evaluate(element => element.getAnimations({ subtree: true }).some(animation => animation.animationName === 'signal-breathe')), true, 'an unread card keeps breathing until it is viewed');
  await page.evaluate(id => window.agentrix.writeTerminal(id, 'draft-only'), projects[2].id);
  await complete('draft-background-turn', target, 'yet-another-thread');
  assert.equal((await page.evaluate(() => window.agentrix.getState())).value.projects[2].unread, 1, 'an unsubmitted draft does not rearm notifications');
  await page.evaluate(id => window.agentrix.writeTerminal(id, '\x03'), projects[2].id);
  await page.evaluate(id => window.agentrix.acknowledge(id), projects[2].id);
  await complete('after-acknowledgment', target);
  assert.equal((await page.evaluate(() => window.agentrix.getState())).value.projects[2].unread, 0, 'viewing a completed turn never rearms it');
  await page.evaluate(id => window.agentrix.writeTerminal(id, "Write-Output 'NEW_REQUEST_AFTER_IDLE'\r"), projects[2].id);
  await waitFor(async () => (await page.evaluate(() => window.agentrix.getState())).value.projects[2].shellReady, 'new request after a quiet idle period');
  await runDesktopTask(page, projects[2], path.join(output, 'codex-home'), 'actual-next-turn', waitFor);
  await complete('actual-next-turn', target);
  assert.equal((await page.evaluate(() => window.agentrix.getState())).value.projects[2].unread, 1, 'newly submitted work can notify once again');
  console.log('PASS: idle callbacks with different IDs, focus reports and unsubmitted drafts stay quiet; only a new submission rearms the next alert');
  for (const width of process.argv.includes('--compact-screen') ? [1600, 1400] : [1600, 1200, 900, 820]) {
    await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 700), width);
    await waitFor(async () => page.evaluate(() => {
      const bar = document.querySelector('.titlebar').getBoundingClientRect();
      return [...document.querySelectorAll('.titlebar-brand, .titlebar-tools > *, .window-actions')].every(node => {
        const box = node.getBoundingClientRect();
        return box.top >= bar.top && box.bottom <= bar.bottom && box.left >= 0 && box.right <= innerWidth;
      }) && getComputedStyle(document.querySelector('.titlebar-tools')).webkitAppRegion === 'no-drag';
    }), `top controls fit after the native resize to ${width}px`);
  }
  await page.screenshot({ path: path.join(output, 'compact.png') });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false);
  await page.getByRole('button', { name: `${projects[0].name} 的更多操作`, exact: true }).click();
  assert.equal(await page.getByRole('menuitem', { name: /继续开发|标记开发完成|VS Code/ }).count(), 0);
  assert.deepEqual(await page.evaluate(() => ['markDone', 'openInCode'].filter(key => key in window.agentrix)), []);
  await page.getByRole('button', { name: `${projects[0].name} 的更多操作`, exact: true }).click();
  console.log('PASS: compact top titlebar, search, app menu and 820–1600px windows');

  // A spoofed or stale session key cannot light an unrelated project's tile.
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(`\\\\.\\pipe\\${info.pipeName}`);
    socket.on('connect', () => socket.end(JSON.stringify({ projectId: projects[1].id, sessionKey: 'wrong', type: 'turn-complete', eventId: 'spoof' }) + '\n'));
    socket.on('close', resolve); socket.on('error', reject);
  });
  assert.equal((await page.evaluate(() => window.agentrix.getState())).value.projects[1].unread, 0);
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'workspace.json'), 'utf8'));
  assert.ok(saved.projects.every(project => !('done' in project)));
  assert.equal(saved.projects[2].unread, 1);
  assert.deepEqual(errors, []);
  console.log('PASS: persisted completion history without manual state and rejected wrong-session events');
  console.log(`Screenshots: ${output}`);
} catch (error) {
  console.error(error);
  if (errors.length) console.error(errors.join('\n'));
  if (application) {
    try {
      const page = await application.firstWindow();
      console.error('Desktop state:', JSON.stringify(await page.evaluate(() => window.agentrix.getState())));
      console.error('Test terminal input:', JSON.stringify(await application.evaluate(() => globalThis.terminalTestInputs)));
      await page.screenshot({ path: path.join(output, 'failure.png') });
    } catch {}
  }
  process.exitCode = 1;
} finally {
  if (application) {
    // Let the isolated fixture shells exit before Electron disposes six ConPTYs
    // at once; forced parallel disposal can stall Windows runner teardown.
    try {
      const testPage = await application.firstWindow();
      await testPage.evaluate(async () => { const state = await window.agentrix.getState(); if (state.ok) for (const project of state.value.projects) if (project.shellReady && !project.codexActive) window.agentrix.writeTerminal(project.id, 'exit\r'); });
      await waitFor(async () => (await testPage.evaluate(() => window.agentrix.getState())).value.projects.every(project => project.status === 'exited' || project.status === 'stopped'), 'fixture shells exit', 4000);
    } catch {}
    await application.close();
  }
}
