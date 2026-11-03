// Desktop smoke for the native session view (CI only, in an isolated profile). The main process feeds the window events on the native:event
// channel — no real Claude SDK, Codex app-server, API key or account is involved — and the checks cover what the window draws and does with
// them: the conversation, a request waiting, the message box in a small card (typing must not expand the project), a replay that adds
// nothing, the activity pane's usage card and the 运行方式 settings page. A session the main process does not know refuses the sends and
// answers, which is what the window must show without losing the owner's words.
import { testRun } from './test-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright-core';
import { waitFor } from './wait.mjs';
import { withGuiLock } from './gui-lock.mjs';
import { chooseFromAppMenu } from './app-menu-helper.mjs';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { isolatedEnvironment } = require('./native-approval-probe.cjs');
const packaged = process.argv.includes('--packaged');

async function run(output) {
  const profile = path.join(output, 'profile'), project = { id: randomUUID(), name: '原生会话', path: path.join(output, 'project'), kind: 'local', restore: { terminal: false, codex: false } };
  for (const dir of [profile, project.path]) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects: [project], settings: { language: 'zh', terminalRenderer: 'dom', restoreSessions: false, closeToTray: false, notifications: false, fontSize: 14 } }));
  const env = { ...isolatedEnvironment(output), AGENTRIX_DATA_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
  const errors = [], checks = [];
  let app;
  try {
    app = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Agentrix.exe') : require('electron'), args: packaged ? [] : [root], cwd: root, env });
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 900));
    await page.waitForSelector('.project-panel');
    const terminalId = (await page.evaluate(() => window.agentrix.getState())).value.projects[0].terminals[0].id;
    const card = page.locator(`[data-terminal-id="${terminalId}"]`), view = card.locator('.native-view'), box = view.locator('textarea');

    // The contract's event envelope (contract §1); one stream, sequence counting up.
    let sequence = 0;
    const event = (type, payload = {}, extra = {}) => ({ schemaVersion: 1, eventId: `smoke-${++sequence}`, sequence, connectionEpoch: 'smoke', provider: 'claude', transport: 'claude-sdk', projectId: project.id, terminalId,
      runtimeSessionId: 'rs-smoke', providerSessionId: null, runId: null, turnId: 'turn-1', itemId: null, receivedAtMs: Date.now(), occurredAtMs: Date.now(), replay: false, type, payload, ...extra });
    const emit = events => app.evaluate(({ BrowserWindow }, list) => { for (const item of list) BrowserWindow.getAllWindows()[0].webContents.send('native:event', item); }, events);

    assert.equal(await page.locator('.activity-pane').count(), 0, 'a small card has no activity pane');
    const reply = event('item.delta', { channel: 'text', text: 'Done: it passes now.' }, { itemId: 'm1' });
    await emit([
      event('session.state', { state: 'running', reason: null }), event('turn.started', { origin: 'user', clientMessageId: 'c1' }),
      event('item.upsert', { kind: 'user-message', status: 'completed', content: { text: 'fix the test', clientMessageId: 'c1' } }, { itemId: 'u1' }),
      event('item.upsert', { kind: 'command', status: 'in_progress', content: { command: 'npm test', cwd: project.path } }, { itemId: 'k1' }), event('item.delta', { channel: 'output', text: 'FAIL a.test.js' }, { itemId: 'k1' }),
      reply, event('request.opened', { requestId: 'r1', kind: 'command', blocking: true, title: 'Run rm -rf build', preview: 'rm -rf build', actions: [], providerData: {} }),
    ]);
    await view.waitFor({ timeout: 15000 });
    assert.match(await view.locator('.native-runtime').innerText(), /Claude · API/);
    await waitFor(async () => (await view.locator('.reading-user p').allInnerTexts()).includes('fix the test'), 'your message is drawn');
    await waitFor(async () => (await view.locator('.reading-assistant').allInnerTexts()).some(text => text.includes('it passes now')), 'the agent’s words are drawn');
    assert.match(await view.locator('.native-step-body').first().innerText(), /FAIL a\.test\.js/, 'a running command is open with its output');
    const request = view.locator('.native-request');
    await request.getByRole('button', { name: '允许本次', exact: true }).waitFor(); await request.getByRole('button', { name: '拒绝', exact: true }).waitFor();
    assert.equal(await box.isEnabled(), true, 'the message box stays usable while the agent works');
    checks.push('events drawn: message, words, running command, request card, usable composer');

    // Typing and sending in a small card never expands the project; a refused send keeps the words and says why.
    await box.click(); await box.fill('hello'); await page.keyboard.press('Enter');
    await waitFor(async () => (await box.inputValue()) === 'hello' && await view.locator('.native-error').count() > 0, 'the refused send brings the words back with its reason');
    assert.equal(await page.locator('.activity-pane').count(), 0, 'typing in the card did not expand the project');
    await request.getByRole('button', { name: '允许本次', exact: true }).click();
    await waitFor(async () => request.locator('[role="alert"]').count().then(count => count > 0), 'an answer the main process refuses shows its reason and the card stays');
    await page.screenshot({ path: path.join(output, 'native-small-card.png') });
    checks.push('small card: typing and a refused send keep the words, the project stays small, a refused answer keeps the card');

    // A replay adds nothing; the request resolves and the card goes.
    const assistantBefore = await view.locator('.reading-assistant').count();
    await emit([{ ...reply, replay: true }, event('request.resolved', { requestId: 'r1', resolution: 'cancelled', reason: null }), event('turn.completed', { status: 'completed', error: null }), event('session.state', { state: 'idle', reason: null })]);
    await waitFor(async () => (await view.locator('.native-request').count()) === 0, 'the resolved request is gone');
    assert.equal(await view.locator('.reading-assistant').count(), assistantBefore, 'a replayed event adds nothing');
    assert.equal(await view.locator('.native-stop').count(), 0, 'no Stop once idle');
    checks.push('replay adds nothing; resolved request leaves; Stop only while working');

    // Expanded: the activity pane shows the path and API usage card.
    await page.locator(`[data-project-id="${project.id}"] .panel-name`).click();
    await page.locator('.activity-api').waitFor({ timeout: 15000 });
    assert.match(await page.locator('.activity-api').innerText(), /运行方式与 API 额度/); assert.match(await page.locator('.activity-api').innerText(), /最近切换/);
    await page.screenshot({ path: path.join(output, 'native-expanded.png') });
    checks.push('activity pane shows the usage card');

    // The settings page: the key field is a password field, nothing is saved here.
    await chooseFromAppMenu(page, '设置');
    const settings = page.locator('dialog.settings-dialog');
    await settings.locator('[data-settings-tab="runtime"]').click();
    await settings.getByRole('heading', { name: '运行方式', exact: true }).waitFor();
    assert.equal(await settings.locator('input[type="password"]').count(), 1);
    assert.ok((await settings.locator('.select-trigger').count()) >= 2, 'Claude’s path and Codex’s view');
    assert.match(await settings.locator('.runtime-key-row small[role="status"]').innerText(), /已保存|未保存/);
    await page.screenshot({ path: path.join(output, 'native-settings.png') });
    checks.push('运行方式 settings page');
    assert.deepEqual(errors, []);
  } catch (error) {
    if (app) {
      const page = await app.firstWindow().catch(() => null);
      await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ checks, errors }, null, 2));
    if (app) await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 15000))]);
  }
}

const output = await testRun('native-session');
await withGuiLock('native-session', () => run(output));
console.log('PASS: the native session view, its request cards, usage card and settings page. Evidence: ' + output);
