// macOS desktop check: the app starts a zsh terminal through the integration, runs a command, follows codex
// from start to finish (with a stand-in codex that calls the real notify command), keeps macOS window buttons
// and copies terminal text with ⌘C. Runs with an isolated profile and its own HOME, so the user's start-up
// files and agents are never touched. Usage: node scripts/mac-smoke.mjs [--packaged]
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
const output = await testRun('mac');
const dataDir = path.join(output, 'user-data'), home = path.join(output, 'home'), bin = path.join(home, 'bin');
const project = { id: randomUUID(), name: '中文 项目', path: path.join(output, 'projects', '中文 项目'), unread: 0, seenEvents: [], lastCompletedAt: null };
for (const folder of [dataDir, bin, project.path]) await fs.mkdir(folder, { recursive: true });
await fs.writeFile(path.join(home, '.zprofile'), 'path=("$HOME/bin" $path)\n');
// A stand-in for Codex: it stays a moment, then runs its notify command for one finished turn, as Codex does.
await fs.writeFile(path.join(bin, 'codex'), `#!/bin/zsh
while (( $# )); do [[ $1 == -c && $2 == notify=* ]] && notify=\${2#notify=}; shift; done
sleep 2
eval "command=($(print -r -- \${notify:1:-1} | sed 's/,/ /g'))"
"\${command[@]}" '{"type":"agent-turn-complete","thread-id":"thread","turn-id":"turn"}'
print -r -- "STAND_IN_CODEX_DONE"
`, { mode: 0o755 });
await fs.writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify({ version: 2, projects: [project], settings: { language: 'zh', terminalRenderer: 'dom', autoSave: false, notifications: false, sound: false, announce: false, closeToTray: false, restoreSessions: false } }));

const env = { ...process.env, AGENTRIX_DATA_DIR: dataDir, HOME: home, SHELL: '/bin/zsh' };
for (const name of ['ELECTRON_RUN_AS_NODE', 'AGENTRIX_DEV_URL', 'ZDOTDIR', 'CODEX_HOME']) delete env[name];
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
  assert.equal(await page.locator('.brand-mark').evaluate(element => element.getBoundingClientRect().left), 86, 'room for the traffic lights');
  await page.locator('.titlebar').screenshot({ path: path.join(output, 'titlebar.png') });

  await page.getByRole('button', { name: '只打开终端', exact: true }).click();
  await waitFor(async () => { const value = await state(); return value.terminals[0].status === 'shell' && value.terminals[0].shellReady && value.codexAvailable === true; }, 'zsh reports its prompt with codex available');
  assert.equal((await state()).terminals[0].shell, 'zsh');
  const terminal = page.locator('.project-panel .xterm');
  await terminal.click();
  await page.keyboard.type('echo PG_MAC_$((6*7)) "$LANG" "${ZDOTDIR-no-zdotdir}"');
  await page.keyboard.press('Enter');
  await waitFor(async () => /PG_MAC_42 \S+\.UTF-8 no-zdotdir/.test(await terminal.innerText()), 'the command runs in a UTF-8 zsh that starts nested shells normally');

  await page.keyboard.type('codex');
  await page.keyboard.press('Enter');
  await waitFor(async () => (await state()).codexActive === true, 'codex is reported as started');
  assert.equal((await state()).agent, 'codex');
  await waitFor(async () => /STAND_IN_CODEX_DONE/.test(await terminal.innerText()), 'the stand-in codex ran its notify command');
  await waitFor(async () => { const value = await state(); return !value.codexActive && value.terminals[0].shellReady; }, 'codex exit returns the terminal to its prompt');
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

  assert.deepEqual(errors, []);
  console.log(`PASS: macOS ${packaged ? 'packaged' : 'development'} app runs a zsh terminal with codex reporting; screenshots: ${output}`);
} finally {
  if (application) {
    if (savedClipboard !== null) await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), savedClipboard).catch(() => {});
    // Quitting asks about running terminals; the check answers "quit".
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }).catch(() => {});
    await application.close().catch(() => application.process().kill());
  }
}
