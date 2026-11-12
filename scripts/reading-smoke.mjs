import { testRun } from './test-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { _electron as electron } from 'playwright-core';
import { waitFor, terminalsSettled, timeoutScale } from './wait.mjs';
import { setMode } from './mode-switch.mjs';
import { guiCodexEnvironment, windowsCodexStandIn } from './gui-codex-env.mjs';
import { claudeHook } from '../tests/helpers/desktop-task-fixture.mjs';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { parseAgentScreen } = require('../src/features/agents/agent-screen.ts');
const { hasCliInput, isCliIdle, cliInputDraft } = require('../src/features/reading/cli-panel.ts');
const fixtureIdle = (rows, agent = 'claude') => {
  const screen = parseAgentScreen(agent, rows);
  return hasCliInput(agent, rows, screen) && isCliIdle(agent, rows, screen) && cliInputDraft(agent, rows, screen) === '';
};
const waitForFixtureIdle = async (readRows, label, agent = 'claude') => {
  let emptySince;
  await waitFor(async () => {
    if (!fixtureIdle(await readRows(), agent)) { emptySince = undefined; return false; }
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
// Nothing here may reach the owner's Claude Code, Codex or their settings: the user directories point into this run, and
// PATH keeps no folder that holds a claude or codex program (the stand-in below is the only codex).
const userDirectory = path.join(output, 'user');
const sandbox = { HOME: userDirectory, USERPROFILE: userDirectory, APPDATA: path.join(userDirectory, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(userDirectory, 'AppData', 'Local') };
for (const directory of [sandbox.APPDATA, sandbox.LOCALAPPDATA]) await fs.mkdir(directory, { recursive: true });
const env = { ...process.env, ...guiCodexEnvironment(), ...sandbox, AGENTRIX_DATA_DIR: profile, CODEX_HOME: home, CLAUDE_CONFIG_DIR: claudeHome, READING_FIXTURE_ENTER_LOG: path.join(output, 'enter.log') }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
const bin = path.join(output, 'bin'), pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
const holdsCli = async folder => (await Promise.all(['claude', 'codex'].flatMap(name => ['.exe', '.cmd', '.bat', '.ps1', ''].map(extension => fs.access(path.join(folder, name + extension)).then(() => true, () => false))))).some(Boolean);
const realFolders = [];
for (const folder of env[pathKey].split(path.delimiter).filter(Boolean)) if (!await holdsCli(folder)) realFolders.push(folder);
// The codex typed at the end of this check is the app-server stand-in, first on PATH.
await fs.mkdir(bin); await windowsCodexStandIn(bin); env[pathKey] = [bin, ...realFolders].join(path.delimiter);
for (const folder of env[pathKey].split(path.delimiter)) if (folder !== bin) assert.equal(await holdsCli(folder), false, `${folder} holds no real claude or codex`);
const packaged = process.argv.includes('--packaged'), errors = [], checks = [], commandTargets = [];
let app, page, terminalId = project.id, failure;
const state = async () => (await page.evaluate(() => window.agentrix.getState())).value.projects[0].terminals.find(terminal => terminal.id === terminalId);
const write = data => page.evaluate(({ id, data }) => window.agentrix.writeTerminal(id, data), { id: terminalId, data });
const physicalRows = () => page.locator(`[data-terminal-id="${terminalId}"] .xterm-rows > div`).evaluateAll(nodes => nodes.map(node => node.textContent.replace(/\u00a0/g, ' ').trimEnd()));
// xterm reports focus separately when the card switches views, and answers the CLI's cursor queries when the popup refits it.
const writes = () => app.evaluate(() => globalThis.voicePastes.filter(item => !['\x1b[I', '\x1b[O'].includes(item.data) && !/^\x1b\[\d+;\d+R$/.test(item.data)));
const resetWrites = () => app.evaluate(() => { globalThis.voicePastes = []; });
const hook = (kind, payload) => claudeHook(kind, payload) + '\r';
async function backgroundHook(kind, payload) {
  const runtime = (await fs.readdir(profile)).find(name => name.startsWith('runtime-'));
  const bootstrap = JSON.parse(await fs.readFile(path.join(profile, runtime, `${(await state()).sessionId}.json`), 'utf8'));
  const event = require('../integration/agent-event.cjs').claudeEvent(JSON.stringify(payload), bootstrap.projectId, bootstrap.sessionKey, kind);
  await new Promise((resolve, reject) => {
    const socket = net.connect(`\\\\.\\pipe\\${bootstrap.pipeName}`);
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('Fixture hook timed out')); });
    socket.on('error', reject); socket.on('close', resolve);
    socket.on('connect', () => socket.end(JSON.stringify(event) + '\n'));
  });
}
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
  const renderIdle = async (label, agent = 'claude') => { await write(idle); await waitForFixtureIdle(physicalRows, label, agent); };
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
    if (await composer.isEnabled()) assert.equal(await composer.evaluate(node => document.activeElement === node), true);
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
    // This Console-based stand-in has no CLI resize handler. Repaint its input
    // after xterm moves out of the popup; old absolute cursor rows are no longer valid.
    await renderIdle(`${label}: input after popup resize`);
    return sent;
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
  await resetWrites(); await composer.press('Enter');
  let sent = await settled('/status');
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
  await composer.fill('/unknown-reading-command'); await resetWrites(); await composer.press('Enter');
  const unknownSent = await settled('unknown command', '/unknown-reading-command');
  assert.deepEqual(unknownSent.map(item => item.data), ['\x15', '/unknown-reading-command', '\r']);
  await composer.fill('!echo reading-fixture'); await resetWrites(); await composer.press('Enter');
  await popup.waitFor();
  await waitFor(async () => (await writes()).some(item => item.data === '\r'), 'shell mode submitted');
  await waitForFixtureIdle(physicalRows, 'shell output');
  assert.ok((await physicalRows()).some(row => row.includes('reading-fixture')));
  assert.deepEqual((await writes()).map(item => item.data), ['\x15', '!echo reading-fixture', '\r']);
  await closePopup();
  await renderIdle('shell result: input after popup resize');
  await composer.fill('!true'); await resetWrites(); await composer.press('Enter');
  await popup.waitFor();
  await waitFor(async () => (await writes()).some(item => item.data === '\r'), 'silent shell command submitted');
  await waitForFixtureIdle(physicalRows, 'silent shell result');
  assert.deepEqual((await writes()).map(item => item.data), ['\x15', '!true', '\r']);
  assert.ok((await physicalRows()).some(row => row.includes('(Bash completed with no output)')));
  await page.keyboard.press('Escape');
  assert.equal(await popup.count(), 1, 'Escape belongs to the CLI and keeps the popup open');
  await closePopup(true);
  await renderIdle('silent shell result: input after popup resize');
  checks.push('slash and shell commands use the same live xterm; Escape stays in the CLI and closing sends nothing');
  await composer.fill('keep this draft'); await resetWrites();
  await page.evaluate(id => window.dispatchEvent(new CustomEvent('agentrix:command', { detail: { terminalId: id, text: '/status' }, cancelable: true })), terminalId);
  await settled('external /status', '/status');
  assert.equal(await composer.inputValue(), 'keep this draft');
  await write("Clear-Host; Write-Host 'Settings'; Write-Host 'Esc to close'; Start-Sleep -Seconds 4\r");
  await waitFor(async () => (await physicalRows()).some(row => row.trim() === 'Esc to close'), 'dialog remains in the CLI');
  await resetWrites(); await popup.waitFor(); await page.keyboard.press('Enter');
  assert.equal(await composer.inputValue(), ''); assert.deepEqual(await writes(), []);
  assert.match(await terminal.locator('.reading-outbox').innerText(), /keep this draft/);
  // The stand-in dialog ends by itself (Ctrl+C does not reach Start-Sleep through ConPTY here); the idle frame follows.
  // Do not wait for 600 ms of empty input here: the queue deliberately consumes that first input frame.
  await write(idle); await popup.waitFor({ state: 'detached', timeout: 10000 });
  await terminal.locator('.reading-outbox').waitFor({ state: 'detached' });
  await renderIdle('queued draft delivered'); await composer.fill('');
  checks.push('external commands preserve the composer; a message submitted during a dialog waits and sends after input returns');
  // A real terminal frame owns every confirmation. It opens even while the composer holds a draft.
  const permissionRows = (await fs.readFile(path.join(root, 'tests/fixtures/screens/claude-permission.txt'), 'utf8')).split(/\r?\n/);
  await composer.fill('keep the confirmation draft');
  await backgroundHook('permission', { session_id: 'permission-fixture', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'fixture command' }, permission_suggestions: [] });
  await waitFor(async () => (await state()).cliState?.state === 'waiting', 'permission without request id waits');
  const permissionRevision = (await state()).cliState.revision;
  await write('Clear-Host; ' + permissionRows.map(row => "Write-Host '" + row.replace(/'/g, "''") + "'").join('; ') + '; $global:ReadingFixtureClearOnPrompt = $true; Start-Sleep -Seconds 4\r');
  await popup.waitFor(); assert.equal(await composer.isDisabled(), false);
  await backgroundHook('progress', { session_id: 'permission-fixture', hook_event_name: 'PostToolUse', tool_use_id: 'sibling-read', tool_name: 'Read' });
  assert.equal((await state()).cliState.revision, permissionRevision, 'sibling progress cannot dismiss an uncorrelated permission');
  assert.ok((await state()).needsInput); assert.equal(await popup.isVisible(), true);
  assert.equal(await popup.evaluate(node => node.contains(document.activeElement)), false);
  await page.screenshot({ path: path.join(output, 'permission-terminal.png') });
  await resetWrites(); await composer.press('Enter'); assert.deepEqual(await writes(), []);
  await terminal.locator('.reading-outbox').waitFor();
  await write(idle);
  await popup.waitFor({ state: 'detached', timeout: 10000 });
  await waitFor(async () => (await writes()).some(item => item.data === '\r'), 'queued instruction delivered after permission ends');
  await terminal.locator('.reading-outbox').waitFor({ state: 'detached' });
  await renderIdle('queued instruction ended'); await composer.fill('');
  checks.push('confirmations keep the composer editable; messages wait without answering, then drain when input returns');
  await write(hook('session', { session_id: 's1', source: 'startup' }));
  await write(hook('start', { session_id: 's1', prompt: 'test interrupt' }));
  await waitFor(async () => (await state()).codexActivity === 'working', 'working fixture');
  await waitFor(async () => (await state()).cliState?.state === 'working', 'host publishes CLI work');
  const workingRevision = (await state()).cliState.revision;
  // Claude's spinner line while it works (an idle input on screen would mean it has finished).
  await write("Clear-Host; Write-Host ([string][char]0x2736 + ' Osmosing' + [char]0x2026); Show-ReadingFixtureInput\r");
  await waitFor(async () => await terminal.locator('.reading-status.is-working').count() > 0, 'working status rendered');
  assert.equal(await terminal.locator('.reading-content .reading-status.is-working').count(), 1, 'the working line ends the conversation, not a corner');
  await page.screenshot({ path: path.join(output, 'working.png') });
  await waitFor(async () => {
    const rows = await physicalRows();
    return hasCliInput('claude', rows, parseAgentScreen('claude', rows));
  }, 'working CLI still has its input');
  await waitFor(async () => await popup.count() === 0, 'working input releases the earlier automatic popup', 500);
  // The owner keeps typing while the agent works (the CLI queues the message); an empty Enter still sends nothing.
  await resetWrites(); assert.equal(await composer.isDisabled(), false);
  await composer.focus(); await page.keyboard.press('Enter'); assert.deepEqual(await writes(), []); assert.equal(await popup.count(), 0);
  await renderIdle('working frame returned to idle');
  await waitFor(async () => await terminal.locator('.reading-status.is-working, .reading-choice-host').count() === 0, 'idle screen immediately retires stale activity', 1500);
  checks.push('a working CLI keeps the composer usable, and an empty Enter sends nothing');
  await write(hook('stop', { session_id: 's1' }));
  await waitFor(async () => (await state()).cliState?.state === 'idle', 'Stop publishes idle');
  assert.ok((await state()).cliState.revision > workingRevision);
  await waitFor(async () => (await state()).codexActivity === 'complete', 'the real turn completes');
  const idleRevision = (await state()).cliState.revision;
  const completedAt = (await page.evaluate(() => window.agentrix.getState())).value.projects[0].lastCompletedAt;
  assert.ok(Number.isFinite(completedAt));
  await write(hook('progress', { session_id: 's1', hook_event_name: 'PostToolUse' }));
  await renderIdle('background progress after completion');
  assert.equal((await state()).cliState.revision, idleRevision, 'background progress cannot reopen an idle turn');
  await write(hook('stop', { session_id: 's1' })); await renderIdle('repeated Stop');
  // Writing the next fixture command acknowledges unread completion; the accepted completion timestamp must stay put.
  assert.equal((await page.evaluate(() => window.agentrix.getState())).value.projects[0].lastCompletedAt, completedAt, 'repeated Stop cannot rearm completion');
  assert.equal(await pane.locator('.activity-main-tasks .is-working').count(), 0);
  checks.push('host CLI revisions reach both views; Stop and background progress never rearm completion');
  await composer.fill('/'); await palette.waitFor(); await resetWrites(); await composer.press('Escape');
  await waitFor(async () => await composer.getAttribute('aria-expanded') === 'false', 'palette Escape closes the list');
  assert.deepEqual(await writes(), [], 'palette Escape sends no CLI key');
  // Replay actual transcript shapes through the main-process reader, IPC and React, in this run's Claude home.
  const queueSession = randomUUID(), transcript = path.join(claudeHome, 'projects', project.path.replace(/[^A-Za-z0-9]/gu, '-'), `${queueSession}.jsonl`);
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  const row = record => JSON.stringify({ timestamp: new Date().toISOString(), ...record }) + '\n';
  await fs.writeFile(transcript, ['keep this draft', 'keep the confirmation draft'].map((text, index) => row({ type: 'user', uuid: `dialog-received-${index}`, message: { content: text } })).join('')
    + row({ type: 'user', uuid: 'queue-start', message: { content: 'Queue fixture work' } }));
  await write(hook('session', { session_id: queueSession, transcript_path: transcript, source: 'resume' }));
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
    // Worker worktree paths can wrap over several lines. The bounding-box centre may be empty space between inline rects.
    const hoverPoint = await filePath.evaluate(node => {
      const viewport = node.closest('.reading-scroll').getBoundingClientRect();
      const rect = [...node.getClientRects()].find(rect => rect.width > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom);
      return { x: rect.left + Math.min(12, rect.width / 2), y: (Math.max(rect.top, viewport.top) + Math.min(rect.bottom, viewport.bottom)) / 2 };
    });
    await page.mouse.move(hoverPoint.x, hoverPoint.y);
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
  // A card that comes while someone writes in the box never takes the keyboard: the Enter meant for the message must not
  // answer it (here, approve a command). The fixture prints Claude Code's permission prompt, with no hook to announce
  // it, and keeps its own prompt away.
  await renderIdle('idle before typing');
  await composer.fill(''); await composer.click(); await page.keyboard.type('先别批准', { delay: 40 });
  await write('Clear-Host; ' + permissionRows.map(row => "Write-Host '" + row.replace(/'/g, "''") + "'").join('; ') + '; $global:ReadingFixtureClearOnPrompt = $true; Start-Sleep -Seconds 4\r');
  await popup.waitFor({ timeout: 10000 });
  assert.equal(await popup.evaluate(node => node.contains(document.activeElement)), false, 'automatic terminal mounting preserves typing ownership');
  assert.equal(await composer.isDisabled(), false);
  await resetWrites(); await page.keyboard.press('Enter'); await page.waitForTimeout(150);
  assert.deepEqual(await writes(), [], 'the Enter meant for the message answers nothing');
  assert.equal(await page.locator('.reading-choice-option, .native-question').count(), 0);
  await terminal.locator('.reading-outbox').waitFor();
  await write(idle);
  await popup.waitFor({ state: 'detached', timeout: 10000 });
  await waitFor(async () => (await writes()).some(item => item.data === '\r'), 'queued instruction delivered after the confirmation typed over');
  await terminal.locator('.reading-outbox').waitFor({ state: 'detached' });
  await renderIdle('typed-over confirmation ended'); await composer.fill('');
  checks.push('a confirmation arriving while typing opens a terminal without focusing it or answering; input return drains its queue');
  // Sending while Claude Code works: the terminal takes the message, Claude Code queues it, and only our own unsubmitted
  // words, a choice or the terminal popup hold the next one. The wording is the one thing a copy change touches.
  const SEND_TEXT = { leftoverTitle: '终端输入框里还有没提交的文字', sendLeftover: '发送框里的内容', clearLeftover: '清空后发送本条', waiting: '等待终端输入就绪后发送' };
  const enterLog = path.join(output, 'enter.log');
  const entered = async () => (await fs.readFile(enterLog, 'utf8').catch(() => '')).split(/\r?\n/).filter(Boolean);
  const enteredSince = async mark => (await entered()).slice(mark);
  const leftover = terminal.locator('.reading-leftover'), outbox = terminal.locator('.reading-outbox:not(.reading-leftover)');
  let holding = false;
  // Ctrl+G flips the stand-in between taking Enter and leaving the words in its input (the CLI that did not submit).
  const holdEnter = async on => { if (holding !== on) { await write('\x07'); holding = on; } };
  const shot = name => page.screenshot({ path: path.join(output, name + '.png') });
  const busyFrame = async prompt => {
    await write(hook('start', { session_id: queueSession, transcript_path: transcript, prompt }));
    await write("Clear-Host; Write-Host ([string][char]0x2736 + ' Osmosing' + [char]0x2026); Show-ReadingFixtureInput\r");
    await waitFor(async () => await terminal.locator('.reading-status.is-working').count() > 0, 'working status rendered for the send check');
    await waitFor(async () => await terminal.locator('button[title="中断（Esc）"]:not([disabled])').count() === 1, 'the working composer takes messages');
  };
  const rowsInclude = async text => (await physicalRows()).some(row => row.includes(text));
  const layout = (root, names) => root.evaluate((node, labels) => {
    const box = rect => { const r = rect.getBoundingClientRect(); return { x: +r.left.toFixed(1), y: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
    const buttons = labels.map(label => {
      const button = [...node.querySelectorAll('button')].find(item => item.textContent === label), style = getComputedStyle(button);
      return { label, ...box(button), fontSize: style.fontSize, color: style.color, border: style.borderTopWidth, background: style.backgroundColor, display: style.display, padding: style.padding };
    });
    const style = getComputedStyle(node);
    return { node: box(node), fontSize: style.fontSize, color: style.color, padding: style.padding, buttons, gapBetweenButtons: +(buttons[1].x - (buttons[0].x + buttons[0].w)).toFixed(1),
      sameRow: Math.abs(buttons[0].y - buttons[1].y) < 1, composerTop: +document.querySelector('.reading-composer').getBoundingClientRect().top.toFixed(1) };
  }, names);
  // Claude Code records each message it takes; without that record the safety net sends an unconfirmed message again once the agent has been idle for five seconds.
  const acknowledge = text => queueRows([{ type: 'user', uuid: randomUUID(), message: { content: [{ type: 'text', text }] } }]);
  await acknowledge('先别批准');
  const sendLayouts = {}, flicker = {}, clearedWordsReturned = {}, strict = process.argv.includes('--strict');
  // The composer while Claude Code works for about five seconds: what each part of it shows, sampled every 50 ms. The
  // light stream redraws the spinner every 100 ms; the heavy one repaints the whole live region every 30 ms, as Claude Code's renderer does.
  const sampleWhileWorking = async (label, streamArguments) => {
    await holdEnter(false); await write(hook('start', { session_id: queueSession, transcript_path: transcript, prompt: label })); await renderIdle(`${label} start`);
    const mark = (await entered()).length;
    await page.evaluate(id => {
      const log = window.agentrixComposerSamples = { samples: [], timer: 0 }, begin = performance.now();
      log.timer = setInterval(() => {
        const box = document.querySelector(`[data-terminal-id="${id}"] .reading-composer`), area = box?.querySelector('textarea');
        const stop = box?.querySelector('button[title="中断（Esc）"]'), send = box?.querySelector('button.reading-send');
        log.samples.push({ at: Math.round(performance.now() - begin), placeholder: area?.placeholder ?? null, textareaDisabled: area?.disabled ?? null,
          interrupt: !stop ? 'absent' : stop.disabled ? 'disabled' : 'enabled', sendDisabled: send?.disabled ?? null, composerClass: box?.className ?? null,
          composerHeight: box ? Math.round(box.getBoundingClientRect().height * 10) / 10 : null, textareaHeight: area ? Math.round(area.getBoundingClientRect().height * 10) / 10 : null });
      }, 50);
    }, terminalId);
    await write(`Stream-ReadingFixtureWork -Seconds 5 ${streamArguments}\r`);
    await waitFor(async () => (await enteredSince(mark)).includes('stream:done'), 'the stand-in finished its five seconds of work', 30000);
    const samples = await page.evaluate(() => { clearInterval(window.agentrixComposerSamples.timer); return window.agentrixComposerSamples.samples; });
    const summary = {};
    for (const field of ['placeholder', 'textareaDisabled', 'interrupt', 'sendDisabled', 'composerClass', 'composerHeight', 'textareaHeight']) {
      const transitions = {}; let flips = 0;
      for (let index = 1; index < samples.length; index++) if (samples[index][field] !== samples[index - 1][field]) {
        flips++; const key = `${JSON.stringify(samples[index - 1][field])} -> ${JSON.stringify(samples[index][field])} at ${samples[index].at} ms`; transitions[key] = (transitions[key] ?? 0) + 1;
      }
      summary[field] = { flips, values: [...new Set(samples.map(sample => sample[field]))], transitions };
    }
    summary.sampleCount = samples.length; summary.spanMs = samples.at(-1)?.at ?? 0;
    flicker[label] = summary;
    await fs.writeFile(path.join(output, `composer-samples-${label}.json`), JSON.stringify({ summary, samples }, null, 1));
    console.log(`Composer while Claude Code works, ${label} (50 ms samples):`, JSON.stringify(summary));
    await renderIdle(`${label} done`); await composer.fill('');
  };
  await sampleWhileWorking('light-stream', '-IntervalMs 100');
  await sampleWhileWorking('heavy-stream', '-IntervalMs 30 -Redraw');
  for (const theme of ['mono', 'light']) {
    await page.evaluate(settings => window.agentrix.settings(settings), { theme });
    await waitFor(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, `${theme} theme applied`);
    const name = label => `send-${theme}-${label}`;
    // a. A message sent while Claude Code works goes straight into the terminal; it does not wait in the outbox.
    await holdEnter(false); await busyFrame(`Send check ${theme}`);
    await holdEnter(true);
    let mark = (await entered()).length; const whileWorking = `GUI_WHILE_WORKING_${theme}`;
    await composer.fill(whileWorking); await resetWrites(); await composer.press('Enter');
    await waitFor(async () => (await enteredSince(mark)).includes('held:' + whileWorking), 'the terminal received the message while Claude works');
    assert.equal(await outbox.count(), 0, 'a working Claude Code takes the message; nothing waits in the outbox');
    assert.equal(await terminal.getByText(SEND_TEXT.waiting, { exact: true }).count(), 0);
    assert.equal(await leftover.count(), 0);
    assert.equal(await composer.inputValue(), '', 'the message left the box');
    assert.ok(await rowsInclude(whileWorking), 'the words are in the terminal input');
    await shot(name('a-sent-while-working'));
    // b. Claude Code's own queue receipt.
    const queued = terminal.locator('.reading-pending.is-queued', { hasText: whileWorking });
    await queueRows([{ type: 'queue-operation', operation: 'enqueue', content: whileWorking }]);
    await queued.waitFor();
    assert.equal(await leftover.count(), 0, 'what Claude Code queued is not a leftover input');
    assert.equal(await outbox.count(), 0);
    await shot(name('b-claude-queued'));
    const heldCount = (await enteredSince(mark)).filter(line => line === 'held:' + whileWorking).length;
    assert.ok(heldCount >= 1 && heldCount <= 4, 'the message was entered once and retried at most three times: ' + heldCount);
    assert.equal((await enteredSince(mark)).some(line => line.startsWith('submitted:')), false);
    await write('\x15');
    await waitFor(async () => !await rowsInclude(whileWorking), 'the held words are cleared from the stand-in input');
    await holdEnter(false);
    await acknowledge(whileWorking);
    await queued.waitFor({ state: 'detached' });
    // c. Words of ours left in the input hold the next message; the two actions.
    for (const action of ['sendLeftover', 'clearLeftover']) {
      await holdEnter(false); await busyFrame(`Leftover ${action} ${theme}`);
      await holdEnter(true);
      const first = `GUI_LEFTOVER_${action}_${theme}`, second = `GUI_NEXT_${action}_${theme}`;
      mark = (await entered()).length;
      await composer.fill(first); await composer.press('Enter');
      await waitFor(async () => await rowsInclude(first), 'the first message sits unsubmitted in the input');
      // The next message is sent once the first send has finished (its Retrieve button is enabled again); sent earlier it only waits behind it.
      for (let attempt = 0; ; attempt++) {
        assert.ok(attempt < 6, 'the next message found the first send finished');
        await composer.fill(second); await resetWrites(); await composer.press('Enter');
        await waitFor(async () => await leftover.count() + await outbox.count() > 0, 'the next message was held');
        if (await leftover.count()) break;
        const retrieve = outbox.getByRole('button', { name: '取回' });
        await waitFor(async () => await retrieve.isEnabled(), 'the first send finished');
        await retrieve.click();
      }
      assert.ok((await leftover.locator('li').first().innerText()).includes(first), 'the notice shows the words in the input');
      assert.ok((await leftover.innerText()).includes(SEND_TEXT.leftoverTitle));
      assert.deepEqual(await leftover.getByRole('button').allInnerTexts(), [SEND_TEXT.sendLeftover, SEND_TEXT.clearLeftover]);
      assert.match(await outbox.innerText(), new RegExp(second), 'the new message waits in the outbox');
      assert.equal(await rowsInclude(second), false, 'no character of the new message reached the terminal');
      assert.deepEqual((await writes()).filter(item => item.data !== '\r'), [], 'nothing typed over the leftover');
      assert.equal(await composer.inputValue(), '');
      assert.equal(await popup.count(), 0, 'the old "terminal input still has an earlier message" popup is gone');
      sendLayouts[`${theme}-${action}`] = await layout(leftover, [SEND_TEXT.sendLeftover, SEND_TEXT.clearLeftover]);
      if (action === 'sendLeftover') {
        await shot(name('c-leftover'));
        // The same notice in a 320px wide card, the width of a card in a crowded grid.
        const card = terminal.locator('xpath=ancestor::*[@data-project-id][1]');
        await card.evaluate(node => { node.dataset.smokeStyle = node.getAttribute('style') ?? ''; node.style.width = '320px'; node.style.maxWidth = '320px'; node.style.flex = 'none'; });
        await terminalsSettled(page);
        sendLayouts[`${theme}-narrow`] = { ...await layout(leftover, [SEND_TEXT.sendLeftover, SEND_TEXT.clearLeftover]), cardWidth: await card.evaluate(node => node.getBoundingClientRect().width) };
        await shot(name('c-leftover-narrow'));
        await card.evaluate(node => { node.setAttribute('style', node.dataset.smokeStyle); delete node.dataset.smokeStyle; });
        await terminalsSettled(page);
      }
      await holdEnter(false);
      const before = (await entered()).length;
      await leftover.getByRole('button', { name: SEND_TEXT[action], exact: true }).click();
      if (action === 'sendLeftover') {
        await waitFor(async () => (await enteredSince(before)).includes('submitted:' + first), 'the words in the input were submitted');
        await write(idle); // The stand-in ran them as a command; Claude Code would show its input again.
      }
      await waitFor(async () => (await enteredSince(before)).includes('submitted:' + second), 'the waiting message reached the terminal');
      await leftover.waitFor({ state: 'detached' }); await outbox.waitFor({ state: 'detached' });
      if (action === 'sendLeftover') await acknowledge(first);
      await acknowledge(second);
      if (action === 'clearLeftover') {
        // The cleared words were never taken by Claude Code, so their echo has no record. Once the agent has been idle for five seconds the
        // safety net sends an unconfirmed message again: that must not bring back words the owner chose to clear.
        await write(hook('stop', { session_id: queueSession, transcript_path: transcript }));
        await waitFor(async () => (await state()).cliState?.state === 'idle', `Stop publishes idle (${theme})`);
        const until = Date.now() + 15000 * timeoutScale; let resent = false;
        while (!resent && Date.now() < until) { resent = (await enteredSince(before)).includes('submitted:' + first); if (!resent) await new Promise(resolve => setTimeout(resolve, 100)); }
        clearedWordsReturned[theme] = resent;
        if (resent) console.error(`PRODUCT FINDING: the words cleared with "${SEND_TEXT.clearLeftover}" (${first}) were sent to the terminal again by the five-second safety net`);
        if (strict) assert.equal(resent, false, 'cleared words are never sent again');
        await acknowledge(first);
      }
      await renderIdle(`after ${action}`);
      const received = (await enteredSince(before)).filter(line => /^(submitted|held):GUI_/.test(line));
      assert.deepEqual(received, action === 'sendLeftover' ? ['submitted:' + first, 'submitted:' + second] : ['submitted:' + second], `${action}: the terminal received each message once, in order`);
      if (action === 'clearLeftover') assert.ok((await writes()).some(item => item.data === '\x15'), 'the input was cleared with Ctrl+U');
      await composer.fill('');
      await shot(name(action === 'sendLeftover' ? 'c-after-send-input' : 'c-after-clear'));
    }
    // d. A confirmation holds a message even while Claude Code works.
    await holdEnter(false); await busyFrame(`Choice check ${theme}`);
    const heldByChoice = `GUI_HELD_BY_CHOICE_${theme}`; mark = (await entered()).length;
    await write('Clear-Host; ' + permissionRows.map(row => "Write-Host '" + row.replace(/'/g, "''") + "'").join('; ') + '; $global:ReadingFixtureClearOnPrompt = $true; Start-Sleep -Seconds 4\r');
    await popup.waitFor();
    await waitFor(async () => await rowsInclude('Do you want to create hello.txt?'), 'the confirmation is drawn in the terminal');
    await composer.fill(heldByChoice); await resetWrites(); await composer.press('Enter');
    await outbox.waitFor();
    assert.match(await outbox.innerText(), new RegExp(heldByChoice));
    assert.deepEqual(await writes(), [], 'not one character reached the terminal while the choice was open');
    assert.equal(await rowsInclude(heldByChoice), false);
    await shot(name('d-choice-holds'));
    await write(idle);
    await popup.waitFor({ state: 'detached', timeout: 10000 });
    await waitFor(async () => (await enteredSince(mark)).includes('submitted:' + heldByChoice), 'the held message is sent once the choice ends');
    await outbox.waitFor({ state: 'detached' });
    assert.equal((await enteredSince(mark)).filter(line => line === 'submitted:' + heldByChoice).length, 1);
    await acknowledge(heldByChoice);
    await renderIdle(`choice ended ${theme}`); await composer.fill('');
  }
  await page.evaluate(settings => window.agentrix.settings(settings), { theme: 'mono' });
  await fs.writeFile(path.join(output, 'send-layout.json'), JSON.stringify(sendLayouts, null, 1));
  await fs.writeFile(path.join(output, 'composer-flicker.json'), JSON.stringify({ flicker, clearedWordsReturned }, null, 1));
  checks.push('sending while Claude works: the terminal takes the message, Claude Code queues it, a leftover input and a choice hold the next one, both leftover actions deliver exactly once; composer samples recorded (both themes)');
  // Switching providers switches the whole input. Codex has no terminal run: typed once Claude Code has left the shell
  // (a terminal with a running agent refuses another), it takes this terminal's place as a native session (the
  // app-server stand-in), whose box is no terminal frame and whose commands are Codex's own.
  await composer.fill('/'); await palette.getByRole('option').filter({ hasText: '/fix-issue' }).waitFor(); await composer.fill('');
  await write("Send-AgentrixEvent 'codex-exited' -Agent 'claude'; codex\r");
  await waitFor(async () => { const now = await state(); return now.agent === 'codex' && now.nativeMode === 'codex-app-server' && now.codexActive; }, 'typed codex opens Codex in native mode');
  await waitFor(async () => (await page.evaluate(id => window.agentrix.nativeSession.snapshot(id), terminalId)).value?.state === 'idle', 'native Codex is ready');
  await waitFor(async () => !await composer.isDisabled(), 'the native box takes messages');
  assert.equal(await terminal.locator('.xterm').count(), 0, "the native session takes the terminal's place");
  assert.equal(await popup.count(), 0, 'a provider change is not a confirmation');
  await composer.fill('/');
  await palette.getByRole('option').filter({ has: page.getByText('/compact', { exact: true }) }).waitFor();
  assert.equal(await palette.getByRole('option').filter({ hasText: '/fix-issue' }).count(), 0, 'agent change reloads commands');
  assert.equal(await palette.getByRole('option').filter({ hasText: '/security-review' }).count(), 0);
  await composer.fill('');
  const native = await page.evaluate(id => window.agentrix.nativeSession.snapshot(id), terminalId);
  await page.evaluate(({ id, runtime }) => window.agentrix.nativeSession.stop(id, runtime), { id: terminalId, runtime: native.value.runtimeSessionId });
  await waitFor(async () => !(await state()).codexActive, 'stopping the native session ends Codex');
  checks.push('command list reloads when the terminal agent changes: a typed codex opens natively with its own commands');
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
