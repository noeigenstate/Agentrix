import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { testRun } from './test-output.mjs';
import { waitFor } from './wait.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url);
const output = await testRun('question-appearance'), profile = path.join(output, 'profile'), project = path.join(output, 'project');
await fs.mkdir(profile, { recursive: true }); await fs.mkdir(project);
await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects: [{ id: 'questions', name: '问题主题对照', path: project, restore: { terminal: false, codex: false } }], settings: { language: 'zh', terminalRenderer: 'dom', fontSize: 10, restoreSessions: false, closeToTray: false, notifications: false, sound: false, announce: false } }));
const env = { ...process.env, AGENTRIX_DATA_DIR: profile, CODEX_HOME: await fs.mkdtemp(path.join(path.dirname(profile), 'codex-home-')) }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
const theme = 'grey', errors = [], results = []; let app, page;
const state = async () => (await page.evaluate(() => window.agentrix.getState())).value;
const write = data => page.evaluate(data => window.agentrix.writeTerminal('questions', data), data);
try {
  app = await electron.launch({ executablePath: require('electron'), args: [root], cwd: root, env }); page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1800, 1200));
  await page.getByRole('button', { name: '只打开终端', exact: true }).click(); await waitFor(async () => (await state()).projects[0].shellReady, 'question fixture shell');
  const session = (await state()).projects[0].sessionId;
  for (const [agent, file] of [['codex', 'codex-question'], ['claude', 'claude-question-multi'], ['claude', 'claude-question-review'], ['claude', 'claude-question-typed']]) {
    await write("function global:prompt { 'question-fixture> ' }; Send-AgentrixEvent 'codex-started' -Agent '" + agent + "'\r");
    await waitFor(async () => (await state()).projects[0].codexActive && (await state()).projects[0].agent === agent, 'authenticated question fixture');
    const raw = page.locator('.titlebar-tools').getByRole('button', { name: '切换到终端', exact: true }); if (await raw.isVisible()) await raw.click();
    const content = (await fs.readFile(path.join(root, 'tests/fixtures/questions', file + '.txt'), 'utf8')).replace(/\r?\n/g, '\r\n'), encoded = Buffer.from(content).toString('base64');
    const release = path.join(output, file + '.done').replaceAll("'", "''");
    await write("Clear-Host; [Console]::Write([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encoded + "'))); while (-not (Test-Path -LiteralPath '" + release + "')) { Start-Sleep -Milliseconds 50 }\r");
    await waitFor(async () => (await page.evaluate(() => window.agentrix.attachTerminal('questions'))).value.data.includes(content.trim().split(/[\r\n]/)[0].trim()), 'fixture reaches real PTY');
    const show = page.getByRole('button', { name: '阅读视图：按文档排版显示对话', exact: true }); if (await show.isVisible()) await show.click();
    await page.locator('.reading-question-title, .reading-question-review').first().waitFor();
    const colors = await page.locator('.reading-question-title, .reading-question-review dd, .reading-question-input input').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).color));
    assert.ok(colors.length); assert.ok(colors.every(color => color === 'rgb(242, 242, 242)'), JSON.stringify({ file, theme, colors }));
    assert.equal((await state()).projects[0].sessionId, session);
    await page.screenshot({ path: path.join(output, theme + '-' + file + '.png') }); results.push({ theme, file, colors });
    await fs.writeFile(release, 'done'); await waitFor(() => page.locator('.reading-question-title, .reading-question-review').count().then(count => count === 0), 'fixture returns to shell');
  }
  assert.deepEqual(errors, []); await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log('PASS: actual PTY question, multiselect, review and typed-answer cards on Catalina: ' + output);
} catch (error) { if (page) { await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ state: await state(), terminal: await page.evaluate(() => window.agentrix.attachTerminal('questions')), rows: await page.locator('.xterm-rows').allTextContents() }, null, 2)).catch(() => {}); } if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
finally { if (app) await app.close(); }
