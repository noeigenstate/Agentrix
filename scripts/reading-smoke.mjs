import { testRun } from './test-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright-core';
import { waitFor, terminalsSettled } from './wait.mjs';
import { setMode } from './mode-switch.mjs';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { parseAgentScreen } = require('../src/features/agents/agent-screen.ts');
const { hasCliInput, isCliIdle, cliInputDraft } = require('../src/features/reading/cli-panel.ts');
const fixtureIdle = rows => {
  const screen = parseAgentScreen('claude', rows);
  return hasCliInput('claude', rows, screen) && isCliIdle('claude', rows, screen) && cliInputDraft('claude', rows, screen) === '';
};
const waitForFixtureIdle = async (readRows, label) => {
  let emptySince;
  await waitFor(async () => {
    if (!fixtureIdle(await readRows())) { emptySince = undefined; return false; }
    emptySince ??= Date.now();
    // Let the isolated shell finish redrawing before this script starts its next action.
    return Date.now() - emptySince >= 600;
  }, `${label}: fixture has stable empty CLI input`);
};
const output = await testRun('reading'), profile = path.join(output, 'profile'), home = path.join(output, 'codex-home'), claudeHome = path.join(output, 'claude-home');
const project = { id: randomUUID(), name: '阅读命令', path: path.join(output, 'project'), restore: { terminal: false, codex: false } };
for (const directory of [profile, home, claudeHome, path.join(project.path, '.claude/commands')]) await fs.mkdir(directory, { recursive: true });
const usageFile = path.join(claudeHome, '.claude.json');
const cachedUsage = JSON.parse(await fs.readFile(path.join(root, 'tests/fixtures/usage-refresh/claude.json'), 'utf8'));
cachedUsage.cachedUsageUtilization.fetchedAtMs = Date.now();
for (const window of Object.values(cachedUsage.cachedUsageUtilization.utilization)) window.resets_at = new Date(Date.now() + 86400000).toISOString();
await fs.writeFile(usageFile, JSON.stringify(cachedUsage));
await fs.writeFile(path.join(project.path, '.claude/commands/fix-issue.md'), '---\ndescription: 修复问题\n---\nFix issue $ARGUMENTS.\n');
await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects: [project], settings: { terminalRenderer: 'dom', restoreSessions: false, closeToTray: false, notifications: false, sound: false, announce: false, language: 'zh' } }));
const env = { ...process.env, AGENTRIX_DATA_DIR: profile, CODEX_HOME: home, CLAUDE_CONFIG_DIR: claudeHome }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
const packaged = process.argv.includes('--packaged'), errors = [], checks = [], commandTargets = [];
let app, page, terminalId = project.id, failure;
const state = async () => (await page.evaluate(() => window.agentrix.getState())).value.projects[0].terminals.find(terminal => terminal.id === terminalId);
const write = data => page.evaluate(({ id, data }) => window.agentrix.writeTerminal(id, data), { id: terminalId, data });
const physicalRows = () => page.locator(`[data-terminal-id="${terminalId}"] .xterm-rows > div`).evaluateAll(nodes => nodes.map(node => node.textContent.replace(/\u00a0/g, ' ').trimEnd()));
// xterm reports focus separately when the card switches views, and answers the CLI's cursor queries when the popup refits it.
const writes = () => app.evaluate(() => globalThis.voicePastes.filter(item => !['\x1b[I', '\x1b[O'].includes(item.data) && !/^\x1b\[\d+;\d+R$/.test(item.data)));
const resetWrites = () => app.evaluate(() => { globalThis.voicePastes = []; });
const hook = (kind, payload) => `'${JSON.stringify(payload)}' | & $global:AgentrixSession.powershellPath -NoProfile -ExecutionPolicy Bypass -File $global:AgentrixSession.claudeHookPath -PipeName $global:AgentrixSession.pipeName -ProjectId $global:AgentrixSession.projectId -SessionKey $global:AgentrixSession.sessionKey -Kind ${kind}\r`;
try {
  app = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Agentrix.exe') : require('electron'), args: packaged ? [] : [root], cwd: root, env });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    globalThis.voicePastes = [];
    ipcMain.on('terminal:write', (_event, id, data) => globalThis.voicePastes.push({ id, data, at: Date.now() }));
    BrowserWindow.getAllWindows()[0].setContentSize(1400, 900);
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
  });
  await page.waitForSelector('.project-panel');
  const card = page.locator(`[data-project-id="${project.id}"]`), plain = page.locator(`[data-terminal-id="${project.id}"]`);
  await card.getByRole('button', { name: '只打开终端', exact: true }).click();
  await waitFor(async () => (await state()).shellReady, 'isolated plain PowerShell ready');
  const plainSession = (await state()).sessionId;
  await plain.locator('.xterm').evaluate(node => { globalThis.readingPlainXterm = node; });
  const added = await page.evaluate(id => window.agentrix.addTerminal(id), project.id);
  assert.ok(added.ok); terminalId = added.value;
  await waitFor(async () => (await state()).shellReady, 'isolated agent fixture PowerShell ready');
  const terminal = page.locator(`[data-terminal-id="${terminalId}"]`);
  const composer = terminal.locator('.reading-composer textarea'), palette = terminal.getByRole('listbox');
  const reading = () => composer.waitFor({ state: 'visible' });
  const raw = () => composer.waitFor({ state: 'detached' });
  const showReading = async () => { await setMode(page, project.name, 'reading', { terminalId }); await reading(); };
  const showRaw = async () => { await setMode(page, project.name, 'terminal', { terminalId }); await raw(); };
  // A normal shell prompt reports the agent's exit. Keep this fixture active without launching a CLI, and let
  // PowerShell read at the cursor the idle frame supplies. A truly empty return invokes PowerShell's PS> fallback,
  // so return one blank that overwrites the frame's blank after ❯ instead of drawing a second prompt below it.
  const fixturePrompt = ". '" + path.join(root, 'scripts/reading-smoke-fixture.ps1').replace(/'/g, "''") + "'";
  await write(fixturePrompt + "; Send-AgentrixEvent 'codex-started' -Agent 'claude'\r");
  await waitFor(async () => (await state()).codexActive && (await state()).agent === 'claude', 'authenticated Claude fixture');
  await showReading(); // The activity pane follows the selected split; the first plain shell is still selected.
  const pane = page.locator('.activity-pane'); await pane.waitFor();
  const limitValues = () => pane.locator('.activity-limit > b').allTextContents();
  await waitFor(async () => (await limitValues()).join() === '5%,15%', 'Claude cache reaches the activity pane', 4000);
  const newerUsage = structuredClone(cachedUsage);
  newerUsage.cachedUsageUtilization.fetchedAtMs = Date.now();
  newerUsage.cachedUsageUtilization.utilization.five_hour.utilization = 34;
  newerUsage.cachedUsageUtilization.utilization.seven_day.utilization = 23;
  const replacement = usageFile + '.tmp';
  await fs.writeFile(replacement, JSON.stringify(newerUsage)); await fs.rename(replacement, usageFile);
  await waitFor(async () => (await limitValues()).join() === '34%,23%', 'Claude cache replacement pushes limits without /usage or a hook', 4000);
  assert.match(await pane.innerText(), /额度来自 Claude Code，/);
  await fs.writeFile(usageFile, JSON.stringify(cachedUsage));
  await new Promise(resolve => setTimeout(resolve, 2300));
  assert.deepEqual(await limitValues(), ['34%', '23%'], 'an older Claude cache cannot roll the pane back');
  assert.equal((await page.evaluate(() => window.agentrix.getState())).value.projects[0].unread, 0);
  checks.push('Claude limits: cache replacement pushes to the activity pane without /usage; older snapshots lose and background reads never rearm completion');
  // Draw the stand-in CLI's input; the popup shows its actual xterm output.
  const idle = "Clear-Host; Show-ReadingFixtureInput\r";
  const renderIdle = async label => { await write(idle); await waitForFixtureIdle(physicalRows, label); };
  await renderIdle('initial idle');
  // Leave the first plain shell selected before it becomes hidden, so header actions must choose the visible agent.
  await plain.locator('.xterm-helper-textarea').focus();
  assert.match(await plain.getAttribute('class'), /is-active-terminal/);
  await page.getByRole('button', { name: '返回总览', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  await terminalsSettled(page);
  assert.equal(await plain.isVisible(), false, 'the first plain shell is hidden in the grid');
  assert.equal(await terminal.isVisible(), true, 'the second, agent-marked terminal is visible in the grid');
  assert.match(await terminal.getAttribute('class'), /is-active-terminal/);
  await showRaw(); await showReading();
  assert.equal(await plain.locator('.reading-view').count(), 0, 'header reading actions leave the hidden plain shell alone');
  assert.ok(await plain.locator('.xterm').evaluate(node => node === globalThis.readingPlainXterm), 'the hidden shell stays mounted');
  await waitForFixtureIdle(physicalRows, 'overview idle');
  await terminal.locator('.xterm').evaluate(node => { globalThis.readingXterm = node; });
  const popup = terminal.locator('.reading-terminal-popup');
  const closePopup = async (backdrop = false) => {
    const before = await writes();
    if (backdrop) await terminal.locator('.reading-terminal-overlay').click({ position: { x: 2, y: 2 } });
    else await popup.getByRole('button', { name: '关闭', exact: true }).click();
    await popup.waitFor({ state: 'detached' });
    assert.deepEqual(await writes(), before, 'closing sends no key to the CLI');
    assert.ok(await terminal.locator('.terminal-split-body > .terminal-host > .xterm').evaluate(node => node === globalThis.readingXterm), 'the same xterm returns to its original host');
    assert.equal(await composer.evaluate(node => document.activeElement === node), true);
  };
  const settled = async (label, command = label) => {
    await popup.waitFor();
    assert.equal(await popup.getAttribute('aria-label'), command);
    assert.ok(await popup.locator('.xterm').evaluate(node => node === globalThis.readingXterm));
    assert.ok(await popup.evaluate(node => node.contains(document.activeElement)), 'the live CLI owns keyboard focus');
    await waitFor(async () => (await writes()).some(item => item.data === '\r'), `${label} submitted`);
    const sent = await writes();
    assert.ok(sent.length > 0 && sent.every(item => item.id === terminalId), `${label}: command input targets only the visible agent terminal`);
    commandTargets.push({ label, terminalId, writes: sent });
    await waitForFixtureIdle(physicalRows, label);
    assert.ok((await physicalRows()).some(row => row.includes('CommandNotFoundException')), `${label}: the agent stand-in executes the slash command in its real PowerShell`);
    const hidden = (await page.evaluate(() => window.agentrix.getState())).value.projects[0].terminals.find(item => item.id === project.id);
    assert.equal(hidden.sessionId, plainSession, 'the hidden plain shell keeps its running session');
    assert.equal(hidden.codexActive, false, 'the separate plain shell never becomes the agent fixture');
    await closePopup();
    await waitFor(async () => await composer.isEnabled(), `${label} returned to the reading view`);
  };
  await reading(); await composer.fill('/');
  await palette.getByRole('option').filter({ has: page.getByText('/status', { exact: true }) }).waitFor();
  const custom = palette.getByRole('option').filter({ hasText: '/fix-issue' });
  assert.equal(await custom.locator('small').innerText(), '项目');
  assert.ok((await custom.innerText()).includes('修复问题'));
  assert.equal(await composer.getAttribute('aria-expanded'), 'true');
  assert.equal(await composer.getAttribute('aria-controls'), await palette.getAttribute('id'));
  const count = await palette.getByRole('option').count();
  await waitFor(() => palette.evaluate(node => {
    const list = node.getBoundingClientRect(), box = node.parentElement.querySelector('.reading-composer').getBoundingClientRect();
    return getComputedStyle(node).position === 'static' && Math.abs(list.width - box.width) < 1 && Math.abs(list.left - box.left) < 1 && list.bottom <= box.top && list.height <= 266;
  }), 'command list in the page above the composer, same width and at most eight visible rows');
  assert.ok(await palette.evaluate(node => node.scrollHeight > node.clientHeight), 'command list scrolls');
  await page.screenshot({ path: path.join(output, 'all-commands.png') });
  await composer.press('ArrowUp');
  assert.equal(await palette.getByRole('option').nth(count - 1).getAttribute('aria-selected'), 'true');
  await composer.press('ArrowDown');
  assert.equal(await palette.getByRole('option').first().getAttribute('aria-selected'), 'true');
  assert.equal(await composer.getAttribute('aria-activedescendant'), await palette.getByRole('option').first().getAttribute('id'));
  await custom.click(); assert.equal(await composer.inputValue(), '/fix-issue ');
  await composer.fill('/'); await palette.waitFor(); await composer.press('Escape');
  assert.equal(await composer.inputValue(), '/'); assert.equal(await palette.count(), 0);
  checks.push('palette, project tag, ARIA, wraparound, click and Escape');
  await composer.fill('/rev');
  await palette.getByRole('option').filter({ hasText: '/security-review' }).waitFor();
  assert.equal(await palette.getByRole('option').first().locator('code').innerText(), '/review', 'prefix matches precede contained matches');
  await composer.fill('/ISS'); await palette.getByRole('option').filter({ hasText: '/fix-issue' }).waitFor();
  checks.push('case-insensitive contains matching after prefix matches');
  await composer.fill('/sta'); await palette.getByRole('option').filter({ has: page.getByText('/status', { exact: true }) }).waitFor();
  await page.screenshot({ path: path.join(output, 'palette.png') });
  await composer.press('Tab'); assert.equal(await composer.inputValue(), '/status ');
  await resetWrites(); await composer.press('Enter'); await settled('/status');
  let sent = await writes();
  assert.deepEqual(sent.map(item => item.data), ['\x15', '/status', '\r'], 'slash command is typed, never bracketed paste');
  assert.ok(sent[1].at - sent[0].at >= 50, 'Ctrl+U is processed before typing');
  assert.ok(sent[2].at - sent[1].at >= 140, 'Enter follows the command after its typing delay');
  assert.equal(await composer.count(), 1, 'a typed command keeps the reading view');
  assert.equal(await page.locator('.focus-mode').count(), 0, 'composer interaction keeps the card small');
  checks.push('Tab completion, typed /status and delayed Enter, inside the reading view');
  await composer.fill('/fix-issue 42'); await resetWrites(); await composer.press('Enter');
  await waitFor(async () => (await writes()).some(item => item.data === '\r'), 'project command submitted');
  assert.deepEqual((await writes()).map(item => item.data), ['\x15', '/fix-issue 42', '\r']);
  await settled('project command', '/fix-issue 42');
  assert.equal(await composer.isVisible(), true);
  await resetWrites(); await composer.press('Shift+Tab');
  await waitFor(async () => (await writes()).some(item => item.data === '\x1b[Z'), 'CLI Shift+Tab');
  assert.equal(await composer.evaluate(node => document.activeElement === node), true);
  await composer.press('ArrowUp'); assert.equal(await composer.inputValue(), '/fix-issue 42');
  await composer.press('End'); await composer.press('ArrowDown'); assert.equal(await composer.inputValue(), '');
  await composer.fill('unfinished'); await composer.press('Home'); await composer.press('ArrowUp');
  assert.equal(await composer.inputValue(), '/fix-issue 42');
  await composer.press('End'); await composer.press('ArrowDown'); assert.equal(await composer.inputValue(), 'unfinished');
  checks.push('project command stays in reading, Shift+Tab and history restores unsent draft');
  await composer.fill('/fix-iss'); await palette.getByRole('option').first().waitFor(); await composer.press('Enter');
  assert.equal(await composer.inputValue(), '/fix-issue ', 'Enter completes a partial command');
  await composer.fill('/fix-issue'); await resetWrites(); await composer.press('Enter');
  await settled('exact command', '/fix-issue');
  assert.equal(await composer.isVisible(), true);
  await composer.fill('/unknown-reading-command'); await resetWrites(); await composer.press('Enter'); await settled('unknown command', '/unknown-reading-command');
  assert.deepEqual((await writes()).map(item => item.data), ['\x15', '/unknown-reading-command', '\r']);
  await composer.fill('!echo reading-fixture'); await resetWrites(); await composer.press('Enter');
  await popup.waitFor();
  await waitFor(async () => (await writes()).some(item => item.data === '\r'), 'shell mode submitted');
  await waitForFixtureIdle(physicalRows, 'shell output');
  assert.ok((await physicalRows()).some(row => row.includes('reading-fixture')));
  assert.deepEqual((await writes()).map(item => item.data), ['\x15', '!echo reading-fixture', '\r']);
  await closePopup();
  await composer.fill('!true'); await resetWrites(); await composer.press('Enter');
  await popup.waitFor();
  await waitFor(async () => (await writes()).some(item => item.data === '\r'), 'silent shell command submitted');
  await waitForFixtureIdle(physicalRows, 'silent shell result');
  assert.deepEqual((await writes()).map(item => item.data), ['\x15', '!true', '\r']);
  assert.ok((await physicalRows()).some(row => row.includes('(Bash completed with no output)')));
  await page.keyboard.press('Escape');
  assert.equal(await popup.count(), 1, 'Escape belongs to the CLI and keeps the popup open');
  await closePopup(true);
  checks.push('slash and shell commands use the same live xterm; Escape stays in the CLI and closing sends nothing');
  await composer.fill('keep this draft'); await resetWrites();
  await page.evaluate(id => window.dispatchEvent(new CustomEvent('agentrix:command', { detail: { terminalId: id, text: '/status' }, cancelable: true })), terminalId);
  await settled('external /status', '/status');
  assert.equal(await composer.inputValue(), 'keep this draft');
  await write("Clear-Host; Write-Host 'Settings'; Write-Host 'Esc to close'; Start-Sleep -Seconds 4\r");
  await waitFor(async () => (await physicalRows()).some(row => row.trim() === 'Esc to close'), 'dialog remains in the CLI');
  await resetWrites(); await composer.press('Enter'); await popup.waitFor();
  assert.equal(await composer.inputValue(), 'keep this draft'); assert.deepEqual(await writes(), []);
  // The stand-in dialog ends by itself (Ctrl+C does not reach Start-Sleep through ConPTY here); the idle frame follows.
  await renderIdle('after dialog'); await closePopup(); await composer.fill('');
  checks.push('external commands preserve the composer; normal messages in a CLI dialog open the popup without typing');
  const permission = { session_id: 's1', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' };
  await write(hook('notify', permission));
  await waitFor(async () => (await state()).needsInput === permission.message, 'permission reaches renderer'); await raw();
  await page.screenshot({ path: path.join(output, 'permission-terminal.png') });
  await write(hook('stop', { session_id: 's1' }));
  await waitFor(async () => (await state()).needsInput === null, 'stop clears permission'); await reading();
  checks.push('permission automatically opens terminal and stop returns to reading');
  await write(hook('notify', permission)); await raw(); await showReading();
  assert.ok((await terminal.locator('.reading-status').innerText()).includes(`等待你确认：${permission.message}`));
  // No choice the reading view can lay out (none is on this screen): the waiting line offers the terminal itself.
  await page.screenshot({ path: path.join(output, 'permission-waiting.png') });
  await terminal.locator('.reading-status').getByRole('button', { name: '切换到终端', exact: true }).click(); await raw();
  await write(hook('stop', { session_id: 's1' }));
  await waitFor(async () => (await state()).needsInput === null, 'manual choice survives permission clear');
  assert.equal(await composer.count(), 0);
  await showReading();
  // Claude runs no hook when its permission prompt is answered: the answering key itself (Enter here, as a choice in
  // the reading view sends it) ends the notice, not the end of the round.
  await write(hook('notify', permission));
  await waitFor(async () => (await state()).needsInput === permission.message, 'another permission');
  await write('\r');
  await waitFor(async () => (await state()).needsInput === null, 'answering the permission ends the waiting notice');
  await waitFor(async () => (await terminal.locator('.reading-status', { hasText: '等待你确认' }).count()) === 0, 'no waiting line after the answer');
  checks.push('answering a permission ends its waiting notice before the round ends');
  await write(hook('start', { session_id: 's1', prompt: 'test interrupt' }));
  await waitFor(async () => (await state()).codexActivity === 'working', 'working fixture');
  // Claude's spinner line while it works (an idle input on screen would mean it has finished).
  await write("Clear-Host; Write-Host ([string][char]0x2736 + ' Osmosing' + [char]0x2026); Show-ReadingFixtureInput\r");
  await waitFor(async () => await terminal.locator('.reading-status.is-working').count() > 0, 'working status rendered');
  assert.equal(await terminal.locator('.reading-content .reading-status.is-working').count(), 1, 'the working line ends the conversation, not a corner');
  await page.screenshot({ path: path.join(output, 'working.png') });
  await waitFor(async () => {
    const rows = await physicalRows();
    return hasCliInput('claude', rows, parseAgentScreen('claude', rows));
  }, 'working CLI still has its input');
  await resetWrites();
  await composer.fill("Write-Output 'READING_WORKING_SENT'; Show-ReadingFixtureInput"); await composer.press('Enter');
  await waitFor(async () => (await physicalRows()).some(row => row.trim().startsWith('READING_WORKING_SENT')), 'normal message submitted while Claude works');
  assert.equal(await popup.count(), 0, 'a message during work never opens the terminal popup');
  assert.equal(await composer.inputValue(), ''); assert.deepEqual((await writes()).map(item => item.data), ["Write-Output 'READING_WORKING_SENT'; Show-ReadingFixtureInput", '\r']);
  checks.push('normal messages while Claude works reach the CLI with one Enter and no terminal popup');
  await composer.fill('/'); await palette.waitFor(); await resetWrites(); await composer.press('Escape');
  await waitFor(async () => await composer.getAttribute('aria-expanded') === 'false', 'palette Escape closes the list');
  assert.deepEqual(await writes(), [], 'palette Escape does not interrupt');
  await composer.press('Escape'); await waitFor(async () => (await writes()).some(item => item.data === '\x1b'), 'Escape interrupts working CLI');
  checks.push('manual view choice and status, palette Escape before interrupt');
  // Replay actual transcript shapes through the main-process reader, IPC and React, in this run's Claude home.
  const queueSession = randomUUID(), transcript = path.join(claudeHome, 'projects', project.path.replace(/[^A-Za-z0-9]/gu, '-'), `${queueSession}.jsonl`);
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  const row = record => JSON.stringify({ timestamp: new Date().toISOString(), ...record }) + '\n';
  await fs.writeFile(transcript, row({ type: 'user', uuid: 'queue-start', message: { content: 'Queue fixture work' } }));
  await write(hook('start', { session_id: queueSession, transcript_path: transcript, prompt: 'Queue fixture work' }));
  await waitFor(async () => (await terminal.locator('.reading-user', { hasText: 'Queue fixture work' }).count()) === 1, 'isolated Claude transcript is bound');
  const queueRows = records => fs.appendFile(transcript, records.map(row).join(''));
  const queueCard = text => terminal.locator('.reading-pending.is-queued', { hasText: text });
  await queueRows([
    { type: 'queue-operation', operation: 'enqueue', content: 'GUI_TAKEN_UP' },
    { type: 'queue-operation', operation: 'enqueue', content: 'GUI_STILL_WAITING' },
    { type: 'queue-operation', operation: 'enqueue', content: '<task-notification>done</task-notification>' },
    { type: 'queue-operation', operation: 'dequeue' },
  ]);
  await queueCard('GUI_TAKEN_UP').waitFor(); await queueCard('GUI_STILL_WAITING').waitFor();
  await queueRows([
    { type: 'user', uuid: 'queue-received', message: { content: [{ type: 'text', text: 'GUI_TAKEN_UP' }] } },
    { type: 'assistant', uuid: 'queue-reply', message: { content: [{ type: 'text', text: 'GUI_WORKED_ON_IT' }] } },
  ]);
  await queueCard('GUI_TAKEN_UP').waitFor({ state: 'detached' });
  assert.equal(await terminal.locator('.reading-user', { hasText: 'GUI_TAKEN_UP' }).count(), 1);
  assert.equal(await queueCard('GUI_STILL_WAITING').count(), 1, 'the receipt does not discard another waiting send');
  const order = await terminal.locator('.reading-content').innerText();
  assert.ok(order.indexOf('GUI_TAKEN_UP') < order.indexOf('GUI_WORKED_ON_IT'));
  await queueRows([{ type: 'queue-operation', operation: 'popAll', content: 'GUI_STILL_WAITING' }]);
  await queueCard('GUI_STILL_WAITING').waitFor({ state: 'detached' });
  assert.equal(await terminal.locator('.reading-user', { hasText: 'GUI_STILL_WAITING' }).count(), 0);
  await page.screenshot({ path: path.join(output, 'queue-receipt.png') });
  checks.push('transcript receipt clears stale queue status, anonymous dequeue preserves waiting work, popAll withdraws it, and message order stays intact');
  // Exercise the real transcript -> Markdown -> preload -> main handler. Intercept shell calls so no file manager
  // or user file opens during the suite, and leave the existing plain-click preview behavior observable.
  const revealFolder = path.join(project.path, 'reveal results'), revealFile = path.join(revealFolder, 'guide-whats-new.html');
  await fs.mkdir(revealFolder); await fs.writeFile(revealFile, '<!doctype html><title>Reveal fixture</title><p>The plain click still previews this document.</p>');
  const absoluteFile = path.join(output, 'outside-result.txt'); await fs.writeFile(absoluteFile, 'outside project');
  await app.evaluate(({ shell }) => {
    globalThis.readingReveals = []; globalThis.readingFolderOpens = [];
    globalThis.originalReadingShowItem = shell.showItemInFolder; globalThis.originalReadingOpenPath = shell.openPath;
    shell.showItemInFolder = target => { globalThis.readingReveals.push(target); };
    shell.openPath = async target => { globalThis.readingFolderOpens.push(target); return ''; };
  });
  try {
    await queueRows([{ type: 'assistant', uuid: 'reveal-reply', message: { content: [{ type: 'text', text:
      `文件：\`${revealFile}:142:3\`。目录：\`${revealFolder}\`。\n[阅读结果](<reveal results/guide-whats-new.html:142>)\n[绝对结果](<${revealFile}>)\n文件卡：\`${revealFile}\`。\n外部结果：\`${absoluteFile}\`。\n缺失：\`missing-reading-path.txt\`。`,
    }] } }]);
    const reply = terminal.locator('.reading-assistant').filter({ hasText: '外部结果：' });
    const filePath = reply.locator('[data-reading-path]').filter({ hasText: `${revealFile}:142:3` });
    await filePath.waitFor();
    assert.match(await filePath.getAttribute('title'), /Ctrl\+点击|⌘\+点击/);
    await filePath.click();
    assert.deepEqual(await app.evaluate(() => globalThis.readingReveals), [], 'plain output clicks do not reveal');
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.down(modifier); await filePath.hover();
    assert.deepEqual(await filePath.evaluate(node => ({ cursor: getComputedStyle(node).cursor, underline: getComputedStyle(node).textDecorationLine })), { cursor: 'pointer', underline: 'underline' });
    await page.keyboard.up(modifier);
    const revealed = () => app.evaluate(() => globalThis.readingReveals);
    await filePath.click({ modifiers: [modifier] });
    await waitFor(async () => (await revealed()).length === 1, 'Ctrl/Cmd click reaches showItemInFolder');
    assert.equal((await revealed())[0], revealFile);
    assert.equal(await page.locator('.file-popup-overlay').count(), 0, 'modifier click does not also preview');
    const folderPath = reply.locator('[data-reading-path]').filter({ hasText: revealFolder }).filter({ hasNotText: 'guide-whats-new' });
    await folderPath.click({ modifiers: [modifier] });
    await waitFor(async () => (await app.evaluate(() => globalThis.readingFolderOpens)).includes(revealFolder), 'folder opens through shell.openPath');
    const link = reply.getByRole('link', { name: '阅读结果', exact: true });
    await link.click({ modifiers: [modifier] });
    await waitFor(async () => (await revealed()).length === 2, 'relative Markdown link resolves through the project root');
    assert.equal((await revealed())[1], revealFile);
    await reply.getByRole('link', { name: '绝对结果', exact: true }).click({ modifiers: [modifier] });
    await waitFor(async () => (await revealed()).length === 3, 'absolute Markdown link retains encoded drive separators');
    assert.equal((await revealed())[2], revealFile);
    await reply.locator('[data-reading-path]').filter({ hasText: absoluteFile }).click({ modifiers: [modifier] });
    await waitFor(async () => (await revealed()).includes(absoluteFile), 'absolute result outside project is revealed');
    const name = reply.locator('.file-card-name').filter({ hasText: 'guide-whats-new.html' }).first();
    await name.waitFor(); await name.click({ modifiers: [modifier] });
    await waitFor(async () => (await revealed()).length === 5, 'file-card modifier click reveals instead of previewing');
    await name.click(); await page.locator('.file-popup-overlay').waitFor();
    await page.keyboard.press('Escape'); await page.locator('.file-popup-overlay').waitFor({ state: 'detached' });
    await reply.locator('[data-reading-path]').filter({ hasText: 'missing-reading-path.txt' }).click({ modifiers: [modifier] });
    await page.getByText('未找到此路径。', { exact: true }).waitFor();
    assert.equal(await page.locator('.focus-mode').count(), 0, 'path interactions keep the project card small');
    checks.push('reading paths: native tooltip/underline, files, folders, relative links, outside results, file cards, preserved plain preview and missing-path toast');
  } finally {
    await app.evaluate(({ shell }) => { shell.showItemInFolder = globalThis.originalReadingShowItem; shell.openPath = globalThis.originalReadingOpenPath; });
  }
  await write("Send-AgentrixEvent 'codex-started' -Agent 'codex'\r");
  await waitFor(async () => (await state()).agent === 'codex', 'fixture agent changes');
  await composer.fill('/a'); await composer.fill('/');
  await palette.getByRole('option').filter({ has: page.getByText('/plan', { exact: true }) }).waitFor();
  assert.equal(await palette.getByRole('option').filter({ hasText: '/fix-issue' }).count(), 0, 'agent change reloads commands');
  assert.equal(await palette.getByRole('option').filter({ hasText: '/security-review' }).count(), 0);
  checks.push('command list reloads when the terminal agent changes');
  // A card that comes while someone writes in the box never takes the keyboard: the Enter meant for the message must not
  // answer it (here, approve a command). The fixture prints Codex's approval prompt and keeps its own prompt away.
  await composer.fill(''); await composer.click(); await page.keyboard.type('先别批准', { delay: 40 });
  await write("Clear-Host; Write-Host '  Would you like to run the following command?'; Write-Host ''; Write-Host '  $ npm test'; Write-Host ''; Write-Host '› 1. Yes, proceed (y)'; Write-Host '  2. No, and tell Codex what to do differently (esc)'; Write-Host ''; Write-Host '  Press enter to confirm or esc to cancel'; $global:ReadingFixtureClearOnPrompt = $true; Start-Sleep -Seconds 30\r");
  const asked = page.locator('.reading-choice'); await asked.waitFor({ timeout: 10000 });
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.reading-choice-host')), false, 'the card does not take the keyboard from someone writing');
  await resetWrites(); await page.keyboard.press('Enter'); await page.waitForTimeout(800);
  assert.ok(!(await writes()).some(item => item.data.includes('\r') || item.data === 'y'), 'the Enter meant for the message answers nothing');
  assert.equal(await asked.count(), 1, 'the card still waits for an answer');
  await write('\x03'); await asked.waitFor({ state: 'detached', timeout: 10000 });
  checks.push('a card that comes while someone writes never takes the keyboard');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ packaged, checks, errors, targeting: { plainTerminalId: project.id, plainSession, agentTerminalId: terminalId, commandTargets } }, null, 2));
  console.log(`PASS: reading palette, typed slash/shell commands, CLI keys, history and permission handoff. Evidence: ${output}`);
} catch (error) {
  failure = error;
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    await physicalRows().then(async rows => {
      await fs.writeFile(path.join(output, 'failure-terminal.txt'), rows.join('\n'));
      // CI's screenshot artifact currently includes PNGs/results.json only; keep the physical evidence in its log too.
      console.error('Reading fixture terminal rows:', JSON.stringify(rows));
    }).catch(() => {});
    await writes().then(sent => console.error('Reading fixture writes:', JSON.stringify(sent))).catch(() => {});
    await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ checks, errors, terminalId, state: await state(), writes: await writes(), commandTargets }, null, 2)).catch(() => {});
  }
  throw error;
} finally {
  if (app) {
    try {
      if (page && !page.isClosed()) {
        for (const terminal of (await page.evaluate(() => window.agentrix.getState())).value.projects[0].terminals) {
          await page.evaluate(id => window.agentrix.writeTerminal(id, '\x03exit\r'), terminal.id);
        }
        await waitFor(async () => (await page.evaluate(() => window.agentrix.getState())).value.projects[0].terminals.every(terminal => terminal.status === 'exited'), 'isolated test shells exit');
      }
    } catch (error) {
      console.error('Reading fixture cleanup:', error);
    } finally {
      try { await app.close(); } catch (error) {
        if (!failure) throw error;
        console.error('Reading fixture close:', error);
      }
    }
  }
}
