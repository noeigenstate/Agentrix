// Linux desktop check: the app starts a Bash or zsh terminal through the integration, runs a command, follows
// codex from start to finish (with a stand-in codex that calls the real notify command), draws its own window
// buttons and copies terminal text with Ctrl+Shift+C. Runs with an isolated profile and its own HOME, so the
// user's start-up files and agents are never touched.
// Usage: node scripts/linux-smoke.mjs [--packaged | --appimage <file>] [--shell zsh]
import { testRun } from './test-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { waitFor, timeoutScale } from './wait.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shellName = process.argv.includes('--shell') ? process.argv[process.argv.indexOf('--shell') + 1] : 'bash';
assert.ok(['bash', 'zsh'].includes(shellName), 'the shell is bash or zsh');
const output = await testRun(`linux-${shellName}`);
const dataDir = path.join(output, 'user-data'), home = path.join(output, 'home'), bin = path.join(home, 'bin');
const project = { id: randomUUID(), name: '中文 项目', path: path.join(output, 'projects', '中文 项目'), unread: 0, seenEvents: [], lastCompletedAt: null };
for (const folder of [dataDir, bin, project.path]) await fs.mkdir(folder, { recursive: true });
// The user's own start-up files put the stand-in codex on PATH.
await fs.writeFile(path.join(home, '.bashrc'), 'export PATH="$HOME/bin:$PATH"\n');
await fs.writeFile(path.join(home, '.zshrc'), 'path=("$HOME/bin" $path)\n');
// Debian and Ubuntu's /etc/zsh/zshrc runs compinit, which stops to ask when a completion folder is writable by
// others (as /usr/local is on CI runners); the documented switch turns that off for this user.
await fs.writeFile(path.join(home, '.zshenv'), 'skip_global_compinit=1\n');
// A stand-in for Codex: it stays a moment, then runs its notify command for one finished turn, as Codex does.
await fs.writeFile(path.join(bin, 'codex'), `#!${process.execPath}
const args = process.argv.slice(2), index = args.findIndex((value, i) => value === '-c' && args[i + 1]?.startsWith('notify='));
const command = JSON.parse(args[index + 1].slice('notify='.length));
setTimeout(() => import('node:child_process').then(({ spawnSync }) => {
  spawnSync(command[0], [...command.slice(1), '{"type":"agent-turn-complete","thread-id":"thread","turn-id":"turn"}'], { stdio: 'inherit' });
  console.log('STAND_IN_CODEX_DONE');
}), 2000);
`, { mode: 0o755 });
await fs.writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify({ version: 2, projects: [project], settings: { language: 'zh', shell: shellName, terminalRenderer: 'dom', autoSave: false, notifications: false, sound: false, announce: false, closeToTray: false, restoreSessions: false } }));

const env = { ...process.env, AGENTRIX_DATA_DIR: dataDir, HOME: home, SHELL: `/bin/${shellName}` };
for (const name of ['ELECTRON_RUN_AS_NODE', 'AGENTRIX_DEV_URL', 'ZDOTDIR', 'CODEX_HOME', 'PROMPT_COMMAND']) delete env[name];
const appImage = process.argv.includes('--appimage') ? path.resolve(process.argv[process.argv.indexOf('--appimage') + 1]) : null;
const packaged = !!appImage || process.argv.includes('--packaged');
const unpacked = process.arch === 'x64' ? 'linux-unpacked' : `linux-${process.arch}-unpacked`;
const executablePath = appImage || (packaged ? path.join(root, 'release', unpacked, 'agentrix') : require('electron'));
// Ubuntu 23.10 and later keep unprivileged user namespaces from programs without an AppArmor profile; the
// AppImage turns Chromium's sandbox off by itself there, and this check does the same.
const args = [...(packaged ? [] : [root]), '--no-sandbox'];
const errors = [];
let application, savedClipboard = null;
try {
  application = await electron.launch({ executablePath, args, cwd: root, env, timeout: 30000 });
  application.process().stdout.on('data', data => process.stdout.write(data));
  application.process().stderr.on('data', data => { process.stderr.write(data); const text = data.toString(); if (/Uncaught|Error:|failed to load/i.test(text) && !/ERROR:|dbus|libva|vaInitialize/i.test(text)) errors.push(text); });
  const page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('.project-panel', { timeout: 20000 });
  const state = async () => (await page.evaluate(() => window.agentrix.getState())).value.projects[0];

  // A frameless window: the page draws its own window buttons.
  assert.equal(await page.evaluate(() => document.documentElement.dataset.platform), 'linux');
  assert.equal(await page.locator('.window-actions').isVisible(), true, 'page-drawn window buttons');
  await page.locator('.titlebar').screenshot({ path: path.join(output, 'titlebar.png') });

  await page.getByRole('button', { name: '只打开终端', exact: true }).click();
  await waitFor(async () => { const value = await state(); return value.terminals[0].status === 'shell' && value.terminals[0].shellReady && value.codexAvailable === true; }, `${shellName} reports its prompt with codex available`);
  assert.equal((await state()).terminals[0].shell, shellName);
  const terminal = page.locator('.project-panel .xterm');
  await terminal.click();
  await page.keyboard.type('echo PG_LINUX_$((6*7)) "${AGENTRIX_SESSION_KEY-clean}" "${APPDIR-no-appdir}"');
  await page.keyboard.press('Enter');
  await waitFor(async () => /PG_LINUX_42 clean no-appdir/.test(await terminal.innerText()), `the command runs in ${shellName} without Agentrix's or the AppImage's variables`);

  await page.keyboard.type('codex');
  await page.keyboard.press('Enter');
  await waitFor(async () => (await state()).codexActive === true, 'codex is reported as started');
  assert.equal((await state()).agent, 'codex');
  await waitFor(async () => /STAND_IN_CODEX_DONE/.test(await terminal.innerText()), 'the stand-in codex ran its notify command');
  await waitFor(async () => { const value = await state(); return !value.codexActive && value.terminals[0].shellReady; }, 'codex exit returns the terminal to its prompt');
  await page.screenshot({ path: path.join(output, 'terminal.png') });

  // Ctrl+Shift+A selects the terminal's text and Ctrl+Shift+C copies it; Ctrl+C without a selection interrupts.
  savedClipboard = await application.evaluate(({ clipboard }) => clipboard.readText());
  await application.evaluate(({ clipboard }) => clipboard.writeText(''));
  await terminal.click();
  await page.keyboard.press('Control+Shift+a');
  await page.keyboard.press('Control+Shift+c');
  await waitFor(async () => (await application.evaluate(({ clipboard }) => clipboard.readText())).includes('PG_LINUX_42'), 'Ctrl+Shift+C copies the selected terminal text');
  await terminal.click();
  await page.keyboard.type('sleep 30');
  await page.keyboard.press('Enter');
  await new Promise(resolve => setTimeout(resolve, 500));
  await page.keyboard.press('Control+c');
  await page.keyboard.type('echo AFTER_INTERRUPT');
  await page.keyboard.press('Enter');
  await waitFor(async () => /\nAFTER_INTERRUPT/.test(await terminal.innerText()), 'Ctrl+C interrupts the running command');

  assert.deepEqual(errors, []);
  console.log(`PASS: Linux ${appImage ? 'AppImage' : packaged ? 'packaged' : 'development'} app runs a ${shellName} terminal with codex reporting; screenshots: ${output}`);
} catch (error) {
  // What the window showed, for the CI log and its uploaded screenshots.
  const page = application?.windows()[0];
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  console.error(`--- terminal ---\n${await page?.locator('.project-panel .xterm').innerText().catch(() => '') ?? ''}`);
  throw error;
} finally {
  if (application) {
    const shutdown = (async () => {
      if (savedClipboard !== null) await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), savedClipboard).catch(() => {});
      // Quitting asks about running terminals; the check answers "quit".
      await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }).catch(() => {});
      await application.close().catch(() => application.process().kill());
    })();
    // A shutdown that never settles must not hold the CI step until its timeout once the checks above have run.
    let timer;
    const quit = await Promise.race([shutdown.then(() => true), new Promise(resolve => { timer = setTimeout(resolve, 30000 * timeoutScale, false); })]);
    clearTimeout(timer);
    if (!quit) { console.log('::warning::the app did not quit in time; killing it'); application.process().kill('SIGKILL'); }
  }
}
