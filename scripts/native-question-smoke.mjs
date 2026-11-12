// Real reading view and app-server question cards, using an injected protocol peer and isolated homes.
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
// The provider CLI the app starts: the shared question peer (tests/fixtures/question-codex-app-server.cjs) with this run's two files.
function standin(trigger, answered) {
  return `process.env.AGENTRIX_QUESTION_TRIGGER = ${JSON.stringify(trigger)};
process.env.AGENTRIX_QUESTION_ANSWERED = ${JSON.stringify(answered)};
require(${JSON.stringify(path.join(root, 'tests/fixtures/question-codex-app-server.cjs'))});
`;
}
async function run(theme, output) {
  // Keep executable and profile paths below Windows' command-line loader limits in a deep worker worktree.
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-tui-'));
  const dir = path.join(output, theme), profile = path.join(runtime, 'profile'), project = path.join(runtime, 'project'), bin = path.join(runtime, 'fakebin');
  const trigger = path.join(runtime, 'ask'), answered = path.join(runtime, 'answered.json');
  const { prepareProviders } = await import('./native-session-smoke.mjs');
  const providers = await prepareProviders(runtime);
  await fs.mkdir(dir, { recursive: true });
  for (const folder of [profile, project]) await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(providers.cli, standin(trigger, answered));
  await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects: [{ id: 'questions', name: 'Native TUI fixture', path: project, restore: { terminal: false, codex: false } }],
    settings: { language: 'en', theme, terminalRenderer: 'dom', restoreSessions: false, closeToTray: false, notifications: false, sound: false, announce: false } }));
  const env = { ...isolatedEnvironment(runtime), GIT_CEILING_DIRECTORIES: runtime, AGENTRIX_FAKE_NODE: process.execPath, AGENTRIX_FAKE_CLI: providers.cli, AGENTRIX_DATA_DIR: profile, CODEX_HOME: path.join(runtime, 'codex-home'), CLAUDE_CONFIG_DIR: path.join(runtime, 'claude-home') };
  for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (process.env[key]) env[key] = process.env[key];
  const searchPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env[process.platform === 'win32' ? 'Path' : 'PATH'] = providers.bin + path.delimiter + searchPath;
  delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
  const errors = [], checks = []; let app;
  const { createSmokeStages, closeSmokeApplication } = require('../tests/fixtures/claude-sdk-smoke.cjs');
  const stages = createSmokeStages({ totalMs: 90000 });
  try {
    app = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Agentrix.exe') : require('electron'), args: packaged ? [] : [root], cwd: root, env });
    stages.attach(app);
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    const workbench = page.getByRole('button', { name: 'Workbench', exact: true });
    if (await workbench.isVisible()) await workbench.click();
    await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setContentSize(width, height), [minWidth, minHeight]);
    const launched = await page.evaluate(() => window.agentrix.agentLaunch('questions', 'codex', 'new')); assert.equal(launched.ok, true, JSON.stringify(launched));
    const card = page.locator('[data-project-id="questions"]');
    await card.locator('.panel-name').click();
    const composer = page.locator('.reading-composer textarea');
    await composer.waitFor(); await composer.fill('keep this draft');
    await fs.writeFile(trigger, 'ask');
    const question = page.locator('.native-request.is-question'); await question.waitFor();
    const submit = question.locator('.reading-question-actions .primary');
    assert.equal(await submit.isDisabled(), true, 'both answers are required');
    assert.equal(await composer.inputValue(), 'keep this draft');
    assert.equal(await fs.stat(answered).then(() => true, () => false), false, 'opening a question never answers');
    await question.getByRole('radio', { name: /One/ }).click();
    assert.equal(await submit.isDisabled(), true, 'one answer cannot bypass validation');
    await question.getByRole('textbox', { name: 'Explain your choice', exact: true }).fill('Because it fits');
    assert.equal(await submit.isEnabled(), true);
    // Even with valid answers, Enter in the message box cannot submit the question.
    await composer.fill(''); await composer.press('Enter');
    assert.equal(await fs.stat(answered).then(() => true, () => false), false, 'composer Enter never answers the provider request');
    assert.equal(await question.isVisible(), true);
    await composer.fill('keep this draft');
    const rect = await question.boundingBox(), viewport = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(rect.x >= 0 && rect.x + rect.width <= viewport.width + 1, 'question fits the minimum window width');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(dir, 'question-validated.png') });
    checks.push('actual app-server request; minimum window; draft retained; validation requires every answer; composer Enter never answers');
    await submit.click();
    await waitFor(() => fs.stat(answered).then(() => true, () => false), 'exact request answered');
    assert.deepEqual(JSON.parse(await fs.readFile(answered, 'utf8')), { answers: { q: { answers: ['One'] }, q2: { answers: ['Because it fits'] } } });
    await question.waitFor({ state: 'detached' });
    checks.push('explicit submission resolves only the bound provider request');
    await page.screenshot({ path: path.join(dir, 'returned-to-input.png') }); assert.deepEqual(errors, []);
  } catch (error) {
    if (app) {
      const page = await app.firstWindow();
      await page.screenshot({ path: path.join(dir, 'failure.png') }).catch(() => {});
      const state = await page.evaluate(() => window.agentrix.getState()).catch(() => null);
      const terminal = state?.ok && state.value.projects[0]?.terminals[0];
      const rows = (await page.locator('.xterm-rows').allTextContents()).map(text => text.replace(/[a-f0-9]{64}/gi, '[redacted]'));
      const launch = 'app-server';
      await fs.writeFile(path.join(dir, 'failure.json'), JSON.stringify({ error: error.message, terminal: terminal && { status: terminal.status, active: terminal.codexActive, error: terminal.error }, launch, rows, errors }, null, 2));
    }
    throw error;
  } finally {
    await fs.writeFile(path.join(dir, 'results.json'), JSON.stringify({ theme, checks, errors }, null, 2));
    try {
      if (app) {
        const page = await app.firstWindow();
        await page.evaluate(async () => {
          const state = await window.agentrix.getState();
          for (const terminal of state.value.projects[0].terminals) {
            const snapshot = await window.agentrix.nativeSession.snapshot(terminal.id);
            if (snapshot.ok && snapshot.value) await window.agentrix.nativeSession.stop(terminal.id, snapshot.value.runtimeSessionId);
          }
        });
      }
      await closeSmokeApplication(app, stages);
    } finally { stages.dispose(); }
  }
}
const output = await testRun('native-question');
await withGuiLock('native-question', async () => { for (const theme of ['mono', 'light']) await run(theme, output); });
console.log('PASS: app-server questions validate and submit exact answers, both themes. Evidence: ' + output);

process.exit(0);
