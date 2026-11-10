import './clipboard-guard.mjs';
// macOS desktop check: the app starts a Bash (the default) or zsh terminal through the integration, runs a command,
// keeps macOS window buttons, copies terminal text with ⌘C, and hands a typed codex to native mode: the host starts the
// user's Codex as an app-server (a stand-in that answers that protocol), sends the typed prompt and follows the turn to
// its end. Runs with an isolated profile and its own HOME, so the user's start-up files and agents are never touched.
// Usage: node scripts/mac-smoke.mjs [--packaged] [--shell zsh]
import { testRun } from './test-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { waitFor } from './wait.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shellName = process.argv.includes('--shell') ? process.argv[process.argv.indexOf('--shell') + 1] : 'bash';
assert.ok(['bash', 'zsh'].includes(shellName), 'the shell is bash or zsh');
const output = await testRun(`mac-${shellName}`);
const dataDir = path.join(output, 'user-data'), home = path.join(output, 'home'), bin = path.join(home, 'bin');
const project = { id: randomUUID(), name: '中文 项目', path: path.join(output, 'projects', '中文 项目'), unread: 0, seenEvents: [], lastCompletedAt: null };
for (const folder of [dataDir, bin, project.path]) await fs.mkdir(folder, { recursive: true });
// The user's own start-up files put the stand-in codex on PATH. A macOS terminal's Bash is a login shell: it reads
// .bash_profile and leaves .bashrc alone unless that file sources it (this one does not, and .bashrc must stay unread).
await fs.writeFile(path.join(home, '.bash_profile'), 'export PATH="$HOME/bin:$PATH"\n');
await fs.writeFile(path.join(home, '.bashrc'), 'export PG_BASHRC=read\n');
await fs.writeFile(path.join(home, '.zprofile'), 'path=("$HOME/bin" $path)\n');
// A stand-in for Codex that answers the app-server protocol and leaves a receipt of how it was started and what it was sent.
await fs.writeFile(path.join(bin, 'codex'), `#!${process.execPath}\nrequire(${JSON.stringify(path.join(root, 'tests/fixtures/gui-codex-app-server.cjs'))});\n`, { mode: 0o755 });
const receipt = async () => { try { return JSON.parse(await fs.readFile(path.join(project.path, 'resume-receipt.json'), 'utf8')); } catch { return null; } };
await fs.writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify({ version: 2, projects: [project], settings: { language: 'zh', ...(shellName === 'zsh' && { shell: 'zsh' }), terminalRenderer: 'dom', autoSave: false, notifications: false, sound: false, announce: false, closeToTray: false, restoreSessions: false } }));

const env = { ...process.env, AGENTRIX_DATA_DIR: dataDir, CODEX_HOME: await fs.mkdtemp(path.join(path.dirname(dataDir), 'codex-home-')), HOME: home, SHELL: '/bin/zsh' }; // The login shell is zsh on purpose: the default terminal is Bash whatever $SHELL says.
for (const name of ['ELECTRON_RUN_AS_NODE', 'AGENTRIX_DEV_URL', 'ZDOTDIR']) delete env[name];
const packaged = process.argv.includes('--packaged');
const executablePath = packaged ? path.join(root, 'release/mac-arm64/Agentrix.app/Contents/MacOS/Agentrix') : require('electron');
const errors = [];
let application, savedClipboard = null;
try {
  application = await electron.launch({ executablePath, args: packaged ? [] : [root], cwd: root, env, timeout: 30000 });
  application.process().stdout.on('data', data => process.stdout.write(data));
  application.process().stderr.on('data', data => { process.stderr.write(data); const text = data.toString(); if (/Uncaught|Error:|failed to load/i.test(text)) errors.push(text); });
  const page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('.project-panel', { timeout: 20000 });
  const state = async () => (await page.evaluate(() => window.agentrix.getState())).value.projects[0];

  // macOS draws the window buttons; the page leaves room for them and has none of its own.
  assert.equal(await page.evaluate(() => document.documentElement.dataset.platform), 'darwin');
  assert.equal(await page.locator('.window-actions').isVisible(), false, 'no page-drawn window buttons');
  assert.equal(await page.locator('.titlebar-brand').count(), 0, 'the app menu lives in the system menu bar, not the window');
  // The addon's native 决策 / 工作台 buttons sit after the traffic lights, so the page draws none of its own.
  assert.equal((await page.evaluate(() => window.agentrix.getState())).value.nativeTitlebar, true, 'the native title-bar buttons are attached');
  assert.equal(await page.locator('.home-nav').count(), 0, 'the page draws no copies of them');
  assert.deepEqual(await application.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map(item => item.label)), ['Agentrix'], 'the menu bar');
  await page.locator('.titlebar').screenshot({ path: path.join(output, 'titlebar.png') });

  await page.getByRole('button', { name: '只打开终端', exact: true }).click();
  await waitFor(async () => { const value = await state(); return value.terminals[0].status === 'shell' && value.terminals[0].shellReady && value.codexAvailable === true; }, `${shellName} reports its prompt with codex available`);
  assert.equal((await state()).terminals[0].shell, shellName);
  const terminal = page.locator('.project-panel .xterm');
  await terminal.click();
  // Bash must not have read .bashrc; zsh must not have been pointed at another ZDOTDIR.
  const [variable, unset] = shellName === 'zsh' ? ['ZDOTDIR', 'no-zdotdir'] : ['PG_BASHRC', 'no-bashrc'];
  await page.keyboard.type(`echo PG_MAC_$((6*7)) "$LANG" "\${${variable}-${unset}}"`);
  await page.keyboard.press('Enter');
  await waitFor(async () => new RegExp(`PG_MAC_42 \\S+\\.UTF-8 ${unset}`).test(await terminal.innerText()), `the command runs in a UTF-8 ${shellName} that starts nested shells normally`);
  assert.doesNotMatch(await terminal.innerText(), /default interactive shell is now zsh/, 'no deprecation banner');
  await page.screenshot({ path: path.join(output, 'terminal.png') });

  // ⌘A selects the terminal's text and ⌘C copies it; Control+C stays an interrupt.
  savedClipboard = await application.evaluate(({ clipboard }) => clipboard.readText());
  await application.evaluate(({ clipboard }) => clipboard.writeText(''));
  await terminal.click();
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('Meta+c');
  await waitFor(async () => (await application.evaluate(({ clipboard }) => clipboard.readText())).includes('PG_MAC_42'), '⌘C copies the selected terminal text');
  await page.keyboard.type('sleep 30');
  await page.keyboard.press('Enter');
  await new Promise(resolve => setTimeout(resolve, 500));
  await page.keyboard.press('Control+c');
  await page.keyboard.type('echo AFTER_INTERRUPT');
  await page.keyboard.press('Enter');
  await waitFor(async () => /\nAFTER_INTERRUPT/.test(await terminal.innerText()), 'Control+C interrupts the running command');

  // Codex has no terminal run. Typing it gives this terminal's place to a native session: the host starts the user's
  // Codex as an app-server, sends the typed prompt and follows the turn. The shell itself never runs the executable.
  await page.keyboard.type("codex 'PG native prompt'");
  await page.keyboard.press('Enter');
  await waitFor(async () => { const value = await state(); return value.codexActive === true && value.terminals[0].nativeMode === 'codex-app-server'; }, 'typing codex opens Codex in native mode');
  assert.equal((await state()).agent, 'codex');
  await waitFor(async () => (await receipt())?.input === 'PG native prompt', 'the typed prompt reaches Codex through the host');
  assert.deepEqual((await receipt()).args, ['app-server', '--listen', 'stdio://'], 'the host starts Codex as an app-server; the shell never runs it with the typed words');
  assert.match((await receipt()).developerInstructions, /^You run inside Agentrix/, 'the startup note goes with the native start');
  const terminalId = (await state()).terminals[0].id;
  const native = async () => (await page.evaluate(id => window.agentrix.nativeSession.snapshot(id), terminalId)).value;
  await waitFor(async () => (await native())?.events.some(event => event.type === 'turn.completed' && event.payload.status === 'completed'), 'the turn is followed to its end');
  assert.ok(JSON.stringify((await native()).events).includes('RESTORE_FIXTURE_REPLY'), 'the reply is in the native session');
  await waitFor(async () => (await state()).codexActivity === 'complete', 'the project shows the finished turn');
  assert.equal(await page.locator('.project-panel .xterm').count(), 0, "the native session takes the terminal's place");
  await page.screenshot({ path: path.join(output, 'native-codex.png') });
  await page.evaluate(({ id, runtime }) => window.agentrix.nativeSession.stop(id, runtime), { id: terminalId, runtime: (await native()).runtimeSessionId });
  await waitFor(async () => (await state()).codexActive === false, 'stopping the native session ends Codex');

  assert.deepEqual(errors, []);
  console.log(`PASS: macOS ${packaged ? 'packaged' : 'development'} app runs a ${shellName} terminal and hands a typed codex to native mode; screenshots: ${output}`);
} finally {
  if (application) {
    if (savedClipboard !== null) await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), savedClipboard).catch(() => {});
    // Quitting asks about running terminals; the check answers "quit".
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }).catch(() => {});
    await application.close().catch(() => application.process().kill());
  }
}
