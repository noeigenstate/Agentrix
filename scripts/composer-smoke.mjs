import './clipboard-guard.mjs';
import { testRun } from './test-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright-core';
import { waitFor } from './wait.mjs';
import { setMode } from './mode-switch.mjs';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A terminal agent's input surface. Codex opens in native mode and has no terminal run, so the agent here is Claude
// Code's offline stand-in (the reading fixture's input box at a live prompt), under a line on the dark surface colour a
// terminal agent paints its composer and history with. No CLI runs, so nothing can reach a model.
const output = await testRun('composer'), profile = path.join(output, 'profile'), home = path.join(output, 'codex-home');
const projects = ['终端输入', '其他项目'].map((name, index) => ({ id: randomUUID(), name, path: path.join(output, `project-${index}`), restore: { terminal: false, codex: false } }));
for (const dir of [profile, home, ...projects.map(project => project.path)]) await fs.mkdir(dir, { recursive: true });
const errors = [], samples = [];
// These checks read the terminal's rows as HTML, so the compatible (DOM) renderer draws them; gpu-terminal-smoke covers the GPU one.
await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects, settings: { language: 'zh', terminalRenderer: 'dom', restoreSessions: false, closeToTray: false, notifications: false, fontSize: 14 } }));
const env = { ...process.env, AGENTRIX_DATA_DIR: profile, CODEX_HOME: home, CLAUDE_CONFIG_DIR: path.join(output, 'claude-home') }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
const packaged = process.argv.includes('--packaged'), doneFile = path.join(output, 'fixture.done');
let app, page, controlId;
const state = async () => (await page.evaluate(() => window.agentrix.getState())).value;
const write = (id, data) => page.evaluate(({ id, data }) => window.agentrix.writeTerminal(id, data), { id, data });
async function composerSample(terminal, label) {
  await waitFor(async () => terminal.locator('.xterm-rows span').evaluateAll(cells => cells.some(cell => /background-color:\s*(#1e1e1e|rgb\(30, 30, 30\))/.test(cell.getAttribute('style') || ''))), `${label}: the agent's dark surface is drawn`);
  const sample = await terminal.locator('.xterm-rows').evaluate(rows => {
    const context = document.createElement('canvas').getContext('2d');
    const rgba = color => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data]; };
    const cells = [...rows.querySelectorAll('span')].filter(cell => /background-color:\s*(#1e1e1e|rgb\(30, 30, 30\))/.test(cell.getAttribute('style') || '') && !cell.matches('.xterm-cursor-block,.xterm-decoration-top'));
    return { cells: cells.length, backgrounds: [...new Set(cells.map(cell => getComputedStyle(cell).backgroundColor))], dim: cells.filter(cell => cell.classList.contains('xterm-dim')).map(cell => rgba(getComputedStyle(cell).webkitTextFillColor)), text: rows.textContent };
  });
  assert.ok(sample.cells > 0, `${label}: the agent's dark surface cells were captured`);
  assert.deepEqual(sample.backgrounds, ['rgba(0, 0, 0, 0)'], `${label}: input and padding are transparent`);
  for (const fill of sample.dim) assert.equal(fill[3], 255, 'faint hint glyphs are fully opaque');
  samples.push({ label, ...sample });
  return sample;
}
try {
  app = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Agentrix.exe') : require('electron'), args: packaged ? [] : [root], cwd: root, env });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(async ({ clipboard, ClipboardItem, ipcMain }) => {
    globalThis.composerWrites = [];
    ipcMain.on('terminal:write', (_event, id, data) => globalThis.composerWrites.push({ id, data }));
    // Keep every original format in memory only, never in logs or artifacts.
    globalThis.composerClipboardBackup = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
    globalThis.composerWriteText = clipboard.writeText.bind(clipboard);
    clipboard.writeText = async text => { await globalThis.composerWriteText(text); globalThis.composerClipboardOwner = text; };
  });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 900));
  await page.waitForSelector('.project-panel');
  const first = page.locator(`[data-project-id="${projects[0].id}"]`);
  await first.getByRole('button', { name: '只打开终端', exact: true }).click();
  await waitFor(async () => (await state()).projects[0].shellReady, 'shell ready');
  await first.getByRole('button', { name: `${projects[0].name} 的更多操作`, exact: true }).click(); await first.getByRole('menuitem', { name: '新建终端并分屏', exact: true }).click();
  await waitFor(async () => (await state()).projects[0].terminals.length === 2 && (await state()).projects[0].terminals.every(terminal => terminal.shellReady), 'independent split ready');
  controlId = (await state()).projects[0].terminals[1].id;
  const terminal = page.locator(`[data-terminal-id="${projects[0].id}"]`), control = page.locator(`[data-terminal-id="${controlId}"]`);
  // The title-bar switch acts on the split in use: select the split, then switch it to the raw terminal.
  const showTerminal = async split => {
    await setMode(page, projects[0].name, 'terminal', { terminalId: await split.getAttribute('data-terminal-id') });
    await split.locator('.reading-view').waitFor({ state: 'detached' });
  };
  const fixture = '\x1b[48;2;30;30;30mDARK_SURFACE\x1b[0m\r\n\x1b[48;2;69;31;29mDIFF_RED\x1b[0m\r\n\x1b[48;2;29;60;35mDIFF_GREEN\x1b[0m\r\n\x1b[41mANSI_RED\x1b[0m\r\n\x1b[7mINVERSE\x1b[0m\r\n';
  const paint = `[Console]::Write([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(fixture).toString('base64')}')))`;
  await write(controlId, `Clear-Host; ${paint}\r`);
  const cellBackgrounds = () => control.locator('.xterm-rows').evaluate(rows => Object.fromEntries(['DARK_SURFACE', 'DIFF_RED', 'DIFF_GREEN', 'ANSI_RED', 'INVERSE'].map(label => {
    const cell = [...rows.querySelectorAll('span')].find(cell => cell.textContent.trim() === label);
    return [label, cell ? getComputedStyle(cell).backgroundColor : null];
  })));
  await waitFor(async () => (await cellBackgrounds()).INVERSE !== null, 'ANSI controls rendered');
  const original = await cellBackgrounds();
  assert.equal(original.DARK_SURFACE, 'rgb(30, 30, 30)');
  // The stand-in's screen: a faint hint on the dark surface, then Claude Code's empty input box, where the prompt waits.
  const surface = `[Console]::Write([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from('\x1b[48;2;30;30;30m \x1b[2mAsk the agent to do anything\x1b[22m \x1b[0m\r\n').toString('base64')}')))`;
  const idle = `Clear-Host; ${surface}; Show-ReadingFixtureInput\r`;
  await write(projects[0].id, `. '${path.join(root, 'scripts/reading-smoke-fixture.ps1').replace(/'/g, "''")}'; Send-AgentrixEvent 'codex-started' -Agent 'claude'\r`);
  await waitFor(async () => { const agent = (await state()).projects[0].terminals[0]; return agent.codexActive && agent.agent === 'claude'; }, 'agent identity reaches renderer');
  await write(projects[0].id, idle);
  // A running agent shows its conversation as a document by default; this test is about the agent's own input box in
  // the terminal, so it switches to the terminal the way a user does.
  await showTerminal(terminal);
  await waitFor(async () => terminal.locator('.xterm-rows').innerText().then(text => text.includes('Ask the agent to do anything')), 'the stand-in input prompt');
  assert.deepEqual(await cellBackgrounds(), original, 'another shell in the same project keeps all ANSI backgrounds');
  await page.getByRole('button', { name: '返回总览', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  assert.equal(await terminal.isVisible(), true, "the agent's terminal is visible in the small card");
  assert.equal(await control.isVisible(), false, 'the independent plain shell stays hidden in the small card');
  const sessions = (await state()).projects[0].terminals.map(terminal => terminal.sessionId);
  await terminal.locator('.terminal-host').evaluate(node => { globalThis.composerTerminal = node; });
  await composerSample(terminal, 'catalina');
  await page.screenshot({ path: path.join(output, 'catalina-empty.png') });
  await terminal.locator('textarea.xterm-helper-textarea').focus();
  await page.evaluate(() => window.agentrix.copy('第一行：透明输入与清晰文字'));
  await page.keyboard.press('Control+v');
  await waitFor(async () => terminal.locator('.xterm-rows').innerText().then(text => text.includes('第一行：透明输入与清晰文字')), 'first paste rendered before newline');
  await page.keyboard.press('Shift+Enter');
  await page.evaluate(() => window.agentrix.copy('第二行：保留中文草稿'));
  await page.keyboard.press('Control+v');
  await waitFor(async () => terminal.locator('.xterm-rows').innerText().then(text => text.includes('保留中文草稿')), 'Chinese multiline draft');
  const draftRows = await terminal.locator('.xterm-rows > div').allTextContents();
  assert.equal(draftRows.findIndex(text => text.includes('第二行：保留中文草稿')), draftRows.findIndex(text => text.includes('第一行：透明输入与清晰文字')) + 1, 'Shift+Enter creates the next input line');
  assert.equal(await page.locator('.focus-mode').count(), 0, 'typing in the small card stays small');
  await composerSample(terminal, 'multiline');
  await page.screenshot({ path: path.join(output, 'multiline-small.png') });
  await page.keyboard.press('Control+Shift+a'); await page.keyboard.press('Control+c');
  assert.ok((await page.evaluate(() => window.agentrix.readClipboard())).value.includes('第一行：透明输入与清晰文字'));
  assert.equal(await page.locator('.focus-mode').count(), 0, 'selecting and copying in the small card stays small');
  await waitFor(async () => await terminal.locator('.xterm-decoration-top').count() > 0, 'selected cells rendered');
  assert.ok(await terminal.locator('.xterm-decoration-top:not(.xterm-cursor-block)').evaluateAll(cells => cells.every(cell => getComputedStyle(cell).backgroundColor === 'rgb(56, 56, 56)')), 'selection keeps its opaque grey background (#383838)');
  await page.screenshot({ path: path.join(output, 'selection.png') }); await page.keyboard.press('Escape');
  await first.getByRole('button', { name: `进入 ${projects[0].name}`, exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  await page.evaluate(() => window.agentrix.settings({ fontSize: 17 }));
  await composerSample(terminal, 'focused-17px');
  await page.screenshot({ path: path.join(output, 'focused-draft.png') });
  await page.getByRole('button', { name: '返回总览', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  await page.evaluate(() => window.agentrix.settings({ fontSize: 14 }));
  await composerSample(terminal, 'returned');
  assert.deepEqual((await state()).projects[0].terminals.map(terminal => terminal.sessionId), sessions);
  assert.ok(await terminal.locator('.terminal-host').evaluate(node => node === globalThis.composerTerminal));
  // Ctrl+C drops the draft (sent again as its byte, in case the key copied a selection still held); the stand-in then
  // draws its empty input again.
  await terminal.locator('textarea.xterm-helper-textarea').focus(); await page.keyboard.press('Control+c'); await write(projects[0].id, '\x03'); await write(projects[0].id, idle);
  await waitFor(async () => terminal.locator('.xterm-rows').innerText().then(text => text.includes('Ask the agent to do anything') && !text.includes('保留中文草稿')), 'cleared draft restores placeholder');
  await composerSample(terminal, 'cleared');
  await terminal.locator('.xterm').evaluate(node => { globalThis.composerXterm = node; });
  await setMode(page, projects[0].name, 'reading');
  const reader = terminal.locator('.reading-composer textarea'), popup = terminal.locator('.reading-terminal-popup');
  await app.evaluate(() => { globalThis.composerWrites = []; });
  await reader.fill('/status'); await reader.press('Enter'); await popup.waitFor();
  assert.ok(await popup.locator('.xterm').evaluate(node => node === globalThis.composerXterm), 'the reading popup moves the real terminal');
  assert.ok(await popup.evaluate(node => node.contains(document.activeElement)), 'the CLI takes focus');
  await waitFor(async () => app.evaluate((_, id) => /\/status[\s\S]*\r/.test(globalThis.composerWrites.filter(item => item.id === id).map(item => item.data).join('')), projects[0].id), 'the status command was submitted to the CLI');
  await waitFor(async () => popup.locator('.xterm-rows').innerText().then(text => text.includes('/status')), 'the submitted command shows in the popup terminal');
  await page.keyboard.press('Escape'); assert.equal(await popup.count(), 1, 'Escape remains a CLI key');
  await page.keyboard.press('Control+Shift+a'); await page.keyboard.press('Control+c');
  assert.ok((await page.evaluate(() => window.agentrix.readClipboard())).value, 'select/copy still uses xterm');
  assert.equal(await page.locator('.focus-mode').count(), 0, 'popup terminal interaction never expands the card');
  await popup.getByRole('button', { name: '关闭', exact: true }).click(); await popup.waitFor({ state: 'detached' });
  assert.ok(await terminal.locator('.terminal-split-body > .terminal-host > .xterm').evaluate(node => node === globalThis.composerXterm));
  // The plain-shell control is available in the expanded project; the preceding popup checks ran in the grid.
  await first.locator('.panel-name').click();
  await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  await reader.fill('preserved reading draft');
  await page.evaluate(id => window.dispatchEvent(new CustomEvent('agentrix:command', { detail: { terminalId: id, text: '/status' }, cancelable: true })), projects[0].id);
  await popup.waitFor();
  await control.locator('.xterm-helper-textarea').focus(); await popup.waitFor({ state: 'detached' });
  assert.equal(await reader.inputValue(), 'preserved reading draft');
  assert.ok(await control.locator('.xterm-helper-textarea').evaluate(node => document.activeElement === node), 'closing on terminal switch keeps the new focus');
  await reader.click();
  await page.evaluate(id => window.dispatchEvent(new CustomEvent('agentrix:command', { detail: { terminalId: id, text: '/status' }, cancelable: true })), projects[0].id);
  await popup.waitFor();
  await page.locator('.titlebar-tools').getByRole('button', { name: '切换到终端', exact: true }).click();
  await popup.waitFor({ state: 'detached' });
  assert.ok(await terminal.locator('.terminal-host > .xterm').evaluate(node => node === globalThis.composerXterm), 'leaving reading restores the same terminal');
  await page.getByRole('button', { name: '返回总览', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  samples.push({ label: 'reading-terminal-popup', sameTerminal: true, closesOnTerminalSwitch: true, closesOnLeavingReading: true });
  // An authenticated agent fixture covers the same surface in output/history,
  // alongside backgrounds that must remain colored in an active agent's terminal.
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  await write(controlId, `Clear-Host; Send-AgentrixEvent 'codex-started' -Agent 'claude'; ${paint}; for ($pgComposer=0; $pgComposer -lt 1200 -and -not (Test-Path -LiteralPath ${quote(doneFile)}); $pgComposer++) { Start-Sleep -Milliseconds 100 }; Send-AgentrixEvent 'codex-exited' -Agent 'claude'\r`);
  await waitFor(async () => (await state()).projects[0].terminals[1].codexActive, 'control becomes an authenticated agent fixture');
  await showTerminal(control);
  await waitFor(async () => (await cellBackgrounds()).DARK_SURFACE === 'rgba(0, 0, 0, 0)', 'same dark history surface becomes transparent');
  const agentColors = await cellBackgrounds();
  for (const label of ['DIFF_RED', 'DIFF_GREEN', 'ANSI_RED', 'INVERSE']) assert.equal(agentColors[label], original[label], `${label} background survives`);
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ packaged, samples, original, agentColors, sessions, errors }, null, 2));
  console.log(`PASS: a terminal agent's transparent dark surface, bright hints, Chinese multiline paste, selection, focus/resize, the reading popup on the same terminal and independent split colors. Evidence: ${output}`);
} catch (error) {
  console.error(error);
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    await fs.writeFile(path.join(output, 'failure-cells.json'), JSON.stringify(await page.locator('.xterm-rows span').evaluateAll(cells => cells.map(cell => ({ text: cell.textContent, className: cell.className, style: cell.getAttribute('style') }))), null, 2)).catch(() => {});
  }
  throw error;
}
finally {
  if (app) {
    try {
      await fs.writeFile(doneFile, 'done');
      if (page && !page.isClosed()) {
        // The stand-in's prompt reports no shell, so each fixture shell is told to exit where it stands.
        for (const terminal of (await state()).projects[0].terminals) await write(terminal.id, '\x03exit\r');
        await waitFor(async () => (await state()).projects[0].terminals.every(terminal => terminal.status === 'exited'), 'test shells exit');
      }
    } finally {
      try {
        await app.evaluate(async ({ clipboard }) => {
          if (globalThis.composerWriteText) clipboard.writeText = globalThis.composerWriteText;
          if (globalThis.composerClipboardOwner !== undefined && await clipboard.readText() === globalThis.composerClipboardOwner) {
            if (globalThis.composerClipboardBackup?.length) await clipboard.write(globalThis.composerClipboardBackup); else await clipboard.clear();
          }
        });
      } finally { await app.close(); }
    }
  }
}
