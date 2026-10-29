import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright-core';
import { testRun } from './test-output.mjs';
import { waitFor } from './wait.mjs';
import { setMode } from './mode-switch.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url))), require = createRequire(import.meta.url);
const recordOnly = process.argv.includes('--record');
const renderer = process.argv.includes('--gpu') ? 'gpu' : 'dom';
const output = await testRun(`reading-focus-document-${recordOnly ? 'before' : 'after'}-${renderer}`);
const profile = path.join(output, 'profile'), home = path.join(output, 'codex-home'), claudeHome = path.join(output, 'claude-home');
const projects = ['Codex focus', 'Claude focus', 'Three', 'Four', 'Five', 'Six'].map(name => ({
  id: randomUUID(), name, path: path.join(output, name), restore: { terminal: false, codex: false },
}));
for (const directory of [profile, home, claudeHome, ...projects.map(project => project.path)]) await fs.mkdir(directory, { recursive: true });
await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects, settings: {
  language: 'zh', terminalRenderer: renderer, focusAnimation: 'smooth', restoreSessions: false,
  closeToTray: false, notifications: false, sound: false, announce: false,
} }));
const env = { ...process.env, AGENTRIX_DATA_DIR: profile, CODEX_HOME: home, CLAUDE_CONFIG_DIR: claudeHome };
delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
if (process.argv.includes('--startup')) {
  const bin = path.join(output, 'bin'); await fs.mkdir(bin);
  await promisify(execFile)(path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo', '/target:exe', '/reference:System.Web.Extensions.dll', `/out:${path.join(bin, 'codex.exe')}`, path.join(root, 'tests/fixtures/restore-codex.cs')], { windowsHide: true });
  await fs.copyFile(path.join(bin, 'codex.exe'), path.join(bin, 'claude.exe'));
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path'); env[pathKey] = bin + path.delimiter + env[pathKey];
}
const errors = [], results = [];
let app, page, cdp;
const panel = index => page.locator(`[data-project-id="${projects[index].id}"]`);
const terminal = id => page.locator(`[data-terminal-id="${id}"]`);
const state = async () => (await page.evaluate(() => window.agentrix.getState())).value;
const write = (id, data) => page.evaluate(({ id, data }) => window.agentrix.writeTerminal(id, data), { id, data });
const settled = () => page.waitForFunction(() => !document.querySelector('[data-focus-motion]'));
async function grid() {
  if (await page.locator('.focus-mode').count()) {
    await page.keyboard.press('Control+Shift+Enter'); await settled();
  }
  await page.getByRole('button', { name: '工作台', exact: true }).click();
}
async function agent(id, kind) {
  await waitFor(async () => (await state()).projects.flatMap(project => project.terminals).find(item => item.id === id)?.shellReady, `${kind} shell ready`);
  const fixture = path.join(root, 'scripts/reading-smoke-fixture.ps1').replace(/'/g, "''");
  await write(id, `. '${fixture}'; Clear-Host; Write-Host 'RAW TERMINAL MUST NOT FLASH'; Write-Host ([char]27 + '[48;2;255;0;255m' + (' ' * 24) + [char]27 + '[0m'); Show-ReadingFixtureInput; Send-AgentrixEvent 'codex-started' -Agent '${kind}'\r`);
  await terminal(id).locator('.reading-view').waitFor();
  await terminal(id).locator('.reading-step.is-user').waitFor();
  await waitFor(async () => (await state()).projects.flatMap(project => project.terminals).find(item => item.id === id)?.codexActive, `${kind} active`);
  await page.waitForTimeout(300);
}

async function sample(name, ids, action, { raw = false } = {}) {
  const captures = [];
  const capture = event => {
    captures.push(event.data);
    void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId });
  };
  cdp.on('Page.screencastFrame', capture);
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: 1120, maxHeight: 840 });
  await page.evaluate(({ ids, raw, duration }) => {
    const original = ids.map(id => {
      const split = document.querySelector(`[data-terminal-id="${id}"]`);
      return { id, reading: split?.querySelector('.reading-view'), xterm: split?.querySelector('.xterm') };
    });
    const start = performance.now();
    window.readingFocusFrames = [];
    const tick = now => {
      const splits = original.map(reference => {
        const { id } = reference;
        const split = document.querySelector(`[data-terminal-id="${id}"]`);
        const reading = split?.querySelector('.reading-view'), xterm = split?.querySelector('.xterm');
        const rect = xterm?.getBoundingClientRect();
        const points = rect && [.2, .5, .8].flatMap(x => [.2, .5, .8].map(y => [rect.x + rect.width * x, rect.y + rect.height * y]));
        const visible = !!xterm?.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true });
        const uncovered = visible && points.some(([x, y]) => {
          if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
          const top = document.elementFromPoint(x, y);
          return top === xterm || xterm.contains(top);
        });
        const sameReading = !reference.reading || !reading || reading === reference.reading;
        const sameXterm = !reference.xterm || !xterm || xterm === reference.xterm;
        if (reading) reference.reading = reading;
        if (xterm) reference.xterm = xterm;
        return {
          id, readingShown: !!split?.dataset.sessionId && split?.dataset.codexActive === 'true' && !raw,
          readingPresent: !!reading, readingVisible: !!reading?.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }),
          sameReading, sameXterm,
          xtermVisibility: xterm && getComputedStyle(xterm).visibility, xtermVisible: !!uncovered,
          readingBackground: reading && getComputedStyle(reading).backgroundColor,
          popup: !!split?.querySelector('.reading-terminal-popup'),
        };
      });
      window.readingFocusFrames.push({ ms: now - start, motion: document.querySelector('.app-shell')?.dataset.focusMotion || null, splits });
      if (now - start < duration) requestAnimationFrame(tick);
      else window.readingFocusDone = true;
    };
    window.readingFocusDone = false;
    requestAnimationFrame(tick);
  }, { ids, raw, duration: name.startsWith('startup-') ? 6000 : 1100 });
  await action();
  for (const [index, delay] of [35, 140, 400].entries()) {
    await page.waitForTimeout(delay);
    await page.screenshot({ path: path.join(output, `${name}-${index}.png`) });
  }
  await page.waitForFunction(() => window.readingFocusDone);
  await cdp.send('Page.stopScreencast'); cdp.off('Page.screencastFrame', capture);
  const frames = await page.evaluate(() => window.readingFocusFrames);
  const flashes = frames.filter(frame => frame.splits.some(split => split.readingShown && split.xtermVisible)).length;
  const magenta = await page.evaluate(async captures => {
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
    return Promise.all(captures.map(async data => {
      const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
      canvas.width = image.width; canvas.height = image.height; context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 220 && pixels[i + 2] > 220 && pixels[i + 1] < 40) count++;
      return count;
    }));
  }, captures);
  for (const [index, data] of captures.entries()) await fs.writeFile(path.join(output, `${name}-capture-${index}.png`), Buffer.from(data, 'base64'));
  const result = { name, frames: frames.length, flashes, motionFrames: frames.filter(frame => frame.motion).length,
    visibleTerminalFrames: frames.filter(frame => frame.splits.some(split => split.xtermVisible)).length,
    captureFrames: captures.length, terminalPixelFrames: magenta.filter(count => count > 10).length,
    readingRemounts: frames.filter(frame => frame.splits.some(split => !split.sameReading)).length,
    xtermRemounts: frames.filter(frame => frame.splits.some(split => !split.sameXterm)).length };
  results.push(result);
  await fs.writeFile(path.join(output, `${name}-frames.json`), JSON.stringify(frames, null, 2));
  await fs.writeFile(path.join(output, `${name}-pixels.json`), JSON.stringify(magenta));
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ results, errors }, null, 2));
  console.log(JSON.stringify(result));
  if (!recordOnly) {
    assert.equal(flashes, 0, `${name}: raw terminal never visible while readingShown`);
    if (!raw) assert.equal(result.visibleTerminalFrames, 0, `${name}: only reading or its background appears`);
    if (!raw) assert.equal(result.terminalPixelFrames, 0, `${name}: compositor never shows terminal text`);
  }
  return frames;
}

try {
  app = await electron.launch({ executablePath: require('electron'), args: [root], cwd: root, env });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  cdp = await page.context().newCDPSession(page);
  await app.evaluate(({ BrowserWindow, ipcMain, dialog }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1400, 900); window.webContents.setBackgroundThrottling(false);
    dialog.showMessageBox = async () => ({ response: 1 });
    // Delayed offline transcripts exercise the document and its first paint, without model requests.
    ipcMain.removeHandler('terminal:conversation');
    ipcMain.handle('terminal:conversation', async (_event, id) => {
      await new Promise(resolve => setTimeout(resolve, 200));
      return { ok: true, value: [
        { id: `${id}-user`, at: Date.now() - 1000, role: 'user', text: 'Keep this conversation visible while opening the project.' },
        { id: `${id}-reply`, at: Date.now(), role: 'assistant', text: '## Reading view\n\n' + 'The conversation stays mounted through focus, keyboard navigation and split selection.\n\n'.repeat(8) },
      ] };
    });
  });
  await page.waitForSelector('.project-panel');
  for (const [index, kind] of ['codex', 'claude'].entries()) {
    await grid();
    await panel(index).getByRole('button', { name: '只打开终端', exact: true }).click();
    await agent(projects[index].id, kind);
  }
  await grid();
  for (const index of [0, 1]) assert.equal(await terminal(projects[index].id).locator('.reading-view').isVisible(), true, 'the agent document is visible in its overview card');
  await page.screenshot({ path: path.join(output, 'overview.png') });
  for (const index of [0, 1]) {
    const id = projects[index].id, kind = index ? 'claude' : 'codex';
    for (const entry of ['header', 'name', 'expand']) {
      await grid();
      let target = panel(index).locator(entry === 'header' ? '.panel-index' : '.panel-name');
      if (entry === 'expand') {
        const expand = panel(index).locator('.panel-header > .icon-button').and(panel(index).getByRole('button', { name: `进入 ${projects[index].name}`, exact: true }));
        if (await expand.count()) target = expand;
        else {
          await panel(index).getByRole('button', { name: `${projects[index].name} 的更多操作`, exact: true }).click();
          target = panel(index).getByRole('menuitem', { name: '进入会话', exact: true });
        }
      }
      await sample(`${kind}-${entry}`, [id], () => target.click());
      assert.equal(await panel(index).getAttribute('class').then(value => value.includes('is-focused')), true);
      await sample(`${kind}-${entry}-return`, [id], () => page.keyboard.press('Control+Shift+Enter'));
    }
    await grid();
    await page.getByRole('button', { name: '决策', exact: true }).click();
    await page.locator('.inbox-row').filter({ hasText: projects[index].name }).click();
    await sample(`${kind}-decision`, [id], () => page.locator('.session-open').click());
    await settled();
  }
  await sample('keyboard-focused-previous', [projects[0].id], () => page.keyboard.press('Control+Shift+ArrowLeft'));
  await sample('keyboard-focused-next', [projects[1].id], () => page.keyboard.press('Control+Shift+ArrowRight'));
  await grid();
  await panel(0).locator('.reading-composer textarea').click();
  await sample('keyboard-overview-next', [projects[1].id], () => page.keyboard.press('Control+Shift+ArrowRight'));
  assert.equal(await page.locator('.focus-mode').count(), 0, 'keyboard navigation in overview does not expand a card');
  const added = await page.evaluate(id => window.agentrix.addTerminal(id), projects[0].id);
  assert.ok(added.ok); const splitId = added.value;
  const splitState = (await state()).projects[0].terminals.find(item => item.id === splitId);
  if (!splitState?.sessionId) await page.evaluate(id => window.agentrix.startTerminal(id), splitId);
  await agent(splitId, 'claude');
  assert.equal(await page.locator('.focus-mode').count(), 0, 'adding the authenticated split keeps the project in overview');
  for (const id of [projects[0].id, splitId]) {
    await sample(`split-overview-${id === splitId ? 'claude' : 'codex'}`, [projects[0].id, splitId], () => terminal(id).dispatchEvent('pointerdown'));
    assert.match(await terminal(id).getAttribute('class'), /is-active-terminal/);
    assert.equal(await page.locator('.focus-mode').count(), 0, 'selecting an overview split does not expand the project');
  }
  await sample('split-expand', [projects[0].id, splitId], () => panel(0).locator('.panel-name').click());
  await sample('split-focus-codex', [projects[0].id, splitId], () => terminal(projects[0].id).dispatchEvent('pointerdown'));
  await sample('split-focus-claude', [projects[0].id, splitId], () => terminal(splitId).dispatchEvent('pointerdown'));
  await grid();
  await terminal(projects[0].id).locator('.reading-composer textarea').click();
  await setMode(page, projects[0].name, 'terminal');
  const rawFrames = await sample('raw-positive-control', [projects[0].id], () => panel(0).locator('.panel-name').click(), { raw: true });
  assert.ok(rawFrames.some(frame => frame.splits.some(split => split.xtermVisible)), 'the detector sees a raw terminal');
  assert.ok(results.at(-1).terminalPixelFrames > 0, 'the compositor detector sees the magenta terminal marker');
  assert.equal(await terminal(projects[0].id).locator('.reading-view').count(), 0, 'manual raw choice survives focus');
  const showActivity = page.getByRole('button', { name: '显示活动栏：它正在做什么', exact: true });
  if (await showActivity.count()) await showActivity.click();
  await setMode(page, projects[0].name, 'reading');
  for (const [mode, reduced] of [['off', 'no-preference'], ['system', 'reduce'], ['system', 'no-preference'], ['smooth', 'reduce']]) {
    await grid();
    await page.evaluate(mode => window.agentrix.settings({ focusAnimation: mode }), mode);
    await page.waitForFunction(mode => document.documentElement.dataset.motion === mode, mode);
    await page.emulateMedia({ reducedMotion: reduced });
    const frames = await sample(`motion-${mode}-${reduced}`, [projects[1].id], () => panel(1).locator('.panel-name').click());
    assert.equal(frames.some(frame => frame.motion), mode === 'smooth' || mode === 'system' && reduced !== 'reduce', `${mode}/${reduced}: motion preference is respected`);
  }
  if (process.argv.includes('--startup')) for (const [offset, kind] of ['codex', 'claude'].entries()) {
    await grid(); const index = offset + 2, id = projects[index].id;
    const frames = await sample(`startup-${kind}`, [id], () => panel(index).getByRole('button', { name: new RegExp(`^${kind === 'codex' ? 'Codex' : 'Claude Code'}`) }).click());
    assert.ok(frames.some(frame => frame.splits.some(split => split.readingShown && split.readingVisible)), `${kind} startup captures the visible agent document`);
    await waitFor(async () => (await state()).projects[index].terminals[0].codexActive, `${kind} fake CLI starts`);
  }
  assert.deepEqual(errors, []);
  console.log(`Evidence: ${output}`);
} catch (error) {
  console.error(error);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), timeout: 5000 }).catch(() => {});
  console.error(`Evidence: ${output}`); throw error;
} finally {
  if (app) {
    try {
      if (page && !page.isClosed()) for (const item of (await state()).projects.flatMap(project => project.terminals)) {
        if (item.sessionId && item.status !== 'exited') await write(item.id, '\x03exit\r');
      }
    } finally { await app.close(); }
  }
}
