// Real reading view + xterm + native proxy, using an injected synthetic Codex TUI and isolated homes.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { testRun } from './test-output.mjs';
import { withGuiLock } from './gui-lock.mjs';
import { waitFor } from './wait.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url);
const { isolatedEnvironment } = require('./native-approval-probe.cjs');
const { minWidth, minHeight } = require('../electron/window-zoom.json');
const packaged = process.argv.includes('--packaged');
const idle = ['\u203a Ask Codex to do anything', '', 'gpt-6.1-sol \u00b7 high \u00b7 100% context left'];
const rows = (await fs.readFile(path.join(root, 'tests/fixtures/questions/codex-question.txt'), 'utf8')).split(/\r?\n/);
function standin(trigger, answered) {
  return `
const fs = require('node:fs'), readline = require('node:readline');
let phase = 'loading', failure;
process.on('uncaughtException', error => { failure = { name: error.name, code: error.code }; process.exit(1); });
process.on('exit', code => fs.writeFileSync(${JSON.stringify(answered)} + (process.argv.includes('app-server') ? '.server' : '.tui'), JSON.stringify({ phase, code, failure })));
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
const draw = rows => process.stdout.write('\\x1b[2J\\x1b[H' + rows.join('\\r\\n'));
if (process.argv.includes('app-server')) {
  let asked = false;
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') { send({ id: message.id, result: { userAgent: 'synthetic-TUI' } }); send({ method: 'thread/started', params: { thread: { id: 'fixture-thread' } } }); }
    if (!message.method && message.id === 'fixture-question') {
      fs.writeFileSync(${JSON.stringify(answered)}, JSON.stringify(message.result));
      send({ method: 'serverRequest/resolved', params: { requestId: message.id, threadId: 'fixture-thread' } });
    }
  });
  setInterval(() => {
    if (asked || !fs.existsSync(${JSON.stringify(trigger)})) return; asked = true;
    send({ id: 'fixture-question', method: 'item/tool/requestUserInput', params: { threadId: 'fixture-thread', turnId: 'fixture-turn', itemId: 'fixture-item', questions: [{ id: 'q', header: 'Fixture', question: 'Choose one', options: [{ label: 'One', description: 'First' }, { label: 'Two', description: 'Second' }] }] } });
  }, 50);
} else {
  const { WebSocket } = require(${JSON.stringify(require.resolve('ws'))});
  const args = process.argv, address = args[args.indexOf('--remote') + 1], name = args[args.indexOf('--remote-auth-token-env') + 1];
  phase = 'connecting';
  const socket = new WebSocket(address, { headers: { Authorization: 'Bearer ' + process.env[name] } }); let held = null;
  socket.on('error', error => { phase = 'websocket-error'; failure = { name: error.name, code: error.code, status: error.message.match(/response: (\d+)/)?.[1] }; process.exit(1); }); socket.on('close', () => process.exit(0));
  socket.on('open', () => socket.send(JSON.stringify({ id: 'initialize', method: 'initialize', params: {} })));
  socket.on('message', bytes => {
    const message = JSON.parse(bytes);
    if (message.id === 'initialize') draw(${JSON.stringify(idle)});
    if (message.method === 'item/tool/requestUserInput') { held = message.id; draw(${JSON.stringify(rows)}); }
    if (message.method === 'serverRequest/resolved') { held = null; draw(${JSON.stringify(idle)}); }
  });
  process.stdin.setRawMode?.(true); process.stdin.resume();
  process.stdin.on('data', bytes => {
    if (held && bytes.includes(13)) socket.send(JSON.stringify({ id: held, result: { answers: { q: { answers: ['One'] } } } }));
  });
}
`;
}
async function run(theme, output) {
  // Keep executable and profile paths below Windows' command-line loader limits in a deep worker worktree.
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-tui-'));
  const dir = path.join(output, theme), profile = path.join(runtime, 'profile'), project = path.join(runtime, 'project'), bin = path.join(runtime, 'fakebin');
  const trigger = path.join(runtime, 'ask'), answered = path.join(runtime, 'answered.json'), cli = path.join(bin, 'node_modules/@openai/codex/bin');
  await fs.mkdir(dir, { recursive: true });
  for (const folder of [profile, project, cli]) await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(cli, 'codex.js'), standin(trigger, answered));
  await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects: [{ id: 'questions', name: 'Native TUI fixture', path: project, restore: { terminal: false, codex: false } }],
    settings: { language: 'en', theme, terminalRenderer: 'dom', restoreSessions: false, closeToTray: false, notifications: false, sound: false, announce: false } }));
  const env = { ...isolatedEnvironment(runtime), AGENTRIX_DATA_DIR: profile, CODEX_HOME: path.join(runtime, 'codex-home'), CLAUDE_CONFIG_DIR: path.join(runtime, 'claude-home') };
  for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (process.env[key]) env[key] = process.env[key];
  const searchPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env[process.platform === 'win32' ? 'Path' : 'PATH'] = bin + path.delimiter + searchPath;
  delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
  const errors = [], checks = []; let app;
  try {
    app = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Agentrix.exe') : require('electron'), args: packaged ? [] : [root], cwd: root, env });
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate((_electron, { runtime, ptyPath, nodePath }) => {
      const pty = process.mainModule.require(ptyPath), spawn = pty.spawn;
      globalThis.nativeProbeLaunch = null;
      pty.spawn = (file, args, options) => {
        globalThis.nativeProbeLaunch = { file: nodePath, requestedFile: file, script: args[0], remote: args.includes('--remote') };
        if (!args[0]?.startsWith(runtime)) throw new Error('The fixture PATH did not select the injected CLI');
        // The injected peer is JavaScript; use the test runner's Node for its physical TUI.
        return spawn(nodePath, args, options);
      };
    }, { runtime, ptyPath: require.resolve('node-pty'), nodePath: process.execPath });
    const workbench = page.getByRole('button', { name: 'Workbench', exact: true });
    if (await workbench.isVisible()) await workbench.click();
    await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setContentSize(width, height), [minWidth, minHeight]);
    const launched = await page.evaluate(() => window.agentrix.agentLaunch('questions', 'codex', 'native')); assert.equal(launched.ok, true, JSON.stringify(launched));
    const card = page.locator('[data-project-id="questions"]');
    await card.locator('.panel-name').click();
    const composer = page.locator('.reading-composer textarea');
    await waitFor(async () => {
      const state = await page.evaluate(() => window.agentrix.getState());
      if (state.ok && state.value.projects[0]?.terminals[0]?.status === 'exited') throw new Error('Synthetic TUI exited before input');
      return composer.evaluateAll(nodes => nodes.length === 1 && !nodes[0].disabled);
    }, 'the synthetic Codex TUI draws its idle input');
    await composer.fill('keep this draft'); await fs.writeFile(trigger, 'ask');
    const popup = page.locator('.reading-terminal-popup'); await popup.waitFor({ timeout: 15000 });
    await waitFor(() => popup.locator('.xterm-rows').innerText().then(text => text.includes('Question 1/2')), 'the actual xterm shows the provider question');
    assert.equal(await composer.isDisabled(), false, 'the composer keeps accepting text behind a dialog'); assert.equal(await composer.inputValue(), 'keep this draft');
    assert.equal(await popup.evaluate(node => !!document.activeElement?.closest('.xterm')), false, 'automatic opening never took typing focus');
    assert.equal(await page.locator('.native-question, .reading-choice-option, .reading-question-option').count(), 0);
    await page.keyboard.press('Enter'); await page.waitForTimeout(150);
    assert.equal(await fs.stat(answered).then(() => true, () => false), false, 'a composer Enter did not answer');
    await page.screenshot({ path: path.join(dir, 'popup-no-focus.png') }); checks.push('popup visible without focus, composer locked, no host answer');
    await popup.locator('.xterm-screen').click(); await page.keyboard.press('Enter');
    await waitFor(() => fs.stat(answered).then(() => true, () => false), 'the owner clicked the TUI and answered there');
    assert.deepEqual(JSON.parse(await fs.readFile(answered, 'utf8')), { answers: { q: { answers: ['One'] } } });
    await waitFor(() => popup.locator('.xterm-rows').innerText().then(text => text.includes('Ask Codex to do anything')), 'TUI returned to input');
    await popup.getByRole('button', { name: 'Close', exact: true }).click();
    await waitFor(() => composer.isEnabled(), 'composer unlocked after dialog'); assert.equal(await composer.inputValue(), 'keep this draft');
    checks.push('explicit TUI click + Enter resolves the exact provider request; draft survives');
    await page.screenshot({ path: path.join(dir, 'returned-to-input.png') }); assert.deepEqual(errors, []);
  } catch (error) {
    if (app) {
      const page = await app.firstWindow();
      await page.screenshot({ path: path.join(dir, 'failure.png') }).catch(() => {});
      const state = await page.evaluate(() => window.agentrix.getState()).catch(() => null);
      const terminal = state?.ok && state.value.projects[0]?.terminals[0];
      const rows = (await page.locator('.xterm-rows').allTextContents()).map(text => text.replace(/[a-f0-9]{64}/gi, '[redacted]'));
      const launch = await app.evaluate(() => globalThis.nativeProbeLaunch);
      await fs.writeFile(path.join(dir, 'failure.json'), JSON.stringify({ error: error.message, terminal: terminal && { status: terminal.status, active: terminal.codexActive, error: terminal.error }, launch, rows, errors }, null, 2));
    }
    throw error;
  } finally {
    await fs.writeFile(path.join(dir, 'results.json'), JSON.stringify({ theme, checks, errors }, null, 2));
    if (app) await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 15000))]);
  }
}
const output = await testRun('native-question');
await withGuiLock('native-question', async () => { for (const theme of ['mono', 'light']) await run(theme, output); });
console.log('PASS: native requests answered only in the TUI, both themes. Evidence: ' + output);
