// The real NativeQuestionCard in the real reading view, at the smallest window: a managed Claude session (agentLaunch native) whose CLI is a stand-in found first on PATH
// (<run>/fakebin/node_modules/@anthropic-ai/claude-code/cli.js, the layout resolveCli looks for). It answers the SDK's initialize and then raises an MCP elicitation whose form has a
// required boolean with no default, so the card is the one main builds from a live request. Nothing is sent back: the form stays unfinished.
//
//   node scripts/native-question-smoke.mjs        # both themes (mono, light)
//
// Checks: Enter on the unfinished form shows the reason and puts focus on the first field; Tab reaches the 前往第一项 link (2px ring that touches neither the status text nor the
// action row); activating it focuses the first unfinished field again. The profile is isolated (AGENTRIX_DATA_DIR, CODEX_HOME, CLAUDE_CONFIG_DIR); screenshots land in the run folder.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { testRun } from './test-output.mjs';
import { withGuiLock } from './gui-lock.mjs';
import { waitFor } from './wait.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url);
const { minWidth, minHeight } = require('../electron/window-zoom.json');
const THEMES = ['mono', 'light'], packaged = process.argv.includes('--packaged');

// The stand-in CLI: a JSON-lines peer that confirms the SDK's initialize, then asks one form with a required boolean (no default) and an optional note.
const FAKE_CLI = `
let buffer = '';
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
process.stdin.on('data', bytes => {
  buffer += bytes;
  for (const line of buffer.split('\\n').slice(0, -1)) {
    const message = JSON.parse(line);
    if (message.type !== 'control_request' || message.request.subtype !== 'initialize') continue;
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } });
    send({ type: 'control_request', request_id: 'form-1', request: { subtype: 'elicitation', mode: 'form', mcp_server_name: 'deploy-helper', message: 'Configure the deployment',
      requested_schema: { type: 'object', required: ['approve'], properties: { approve: { type: 'boolean', title: 'Approve the release' }, note: { type: 'string', title: 'Note for the log' } } } } });
  }
  buffer = buffer.slice(buffer.lastIndexOf('\\n') + 1);
});
process.stdin.on('end', () => process.exit(0));
setInterval(() => {}, 1 << 30);
`;

// The card's status line: its text and the link's ring box (the border box grown by the 2px offset and the 2px ring) against the status text and the action row.
const measureLink = () => {
  const link = document.activeElement, status = link.closest('.native-question-status'), actions = document.querySelector('.native-question-actions');
  const range = document.createRange(), ring = link.getBoundingClientRect(), style = getComputedStyle(link), grow = parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
  range.selectNodeContents(status.firstChild);
  const text = range.getBoundingClientRect(), row = actions.getBoundingClientRect(), box = { left: ring.left - grow, right: ring.right + grow, top: ring.top - grow, bottom: ring.bottom + grow };
  const meet = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0;
  const body = document.querySelector('.native-question-footer').getBoundingClientRect();
  return { label: link.textContent, outline: `${style.outlineWidth} ${style.outlineStyle}`, hit: Math.round(ring.height), underline: style.textDecorationLine, overStatusText: meet(box, text), overActions: meet(box, row),
    clipped: box.left < body.left || box.right > body.right || box.top < body.top || box.bottom > body.bottom + 12 };
};

async function runTheme(theme, output) {
  const dir = path.join(output, theme), profile = path.join(dir, 'profile'), project = path.join(dir, 'project'), bin = path.join(dir, 'fakebin');
  const cli = path.join(bin, 'node_modules/@anthropic-ai/claude-code');
  await fs.mkdir(profile, { recursive: true }); await fs.mkdir(project, { recursive: true }); await fs.mkdir(cli, { recursive: true });
  await fs.writeFile(path.join(cli, 'cli.js'), FAKE_CLI);
  await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects: [{ id: 'questions', name: '原生问题', path: project, restore: { terminal: false, codex: false } }],
    settings: { language: 'zh', theme, terminalRenderer: 'dom', restoreSessions: false, closeToTray: false, notifications: false, sound: false, announce: false } }));
  const env = { ...process.env, AGENTRIX_DATA_DIR: profile, CODEX_HOME: path.join(dir, 'codex-home'), CLAUDE_CONFIG_DIR: path.join(dir, 'claude-home') };
  // Windows spells it Path: keep one key with the stand-in first, so the app cannot find a real CLI.
  const searchPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env[process.platform === 'win32' ? 'Path' : 'PATH'] = bin + path.delimiter + searchPath;
  delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
  const errors = [], results = { theme, steps: [] }, shot = (page, name) => page.screenshot({ path: path.join(dir, `${name}.png`) });
  let app;
  try {
    app = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Agentrix.exe') : require('electron'),
      args: packaged ? [] : [root], cwd: root, env });
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setContentSize(width, height), [minWidth, minHeight]);
    await waitFor(() => page.evaluate(([width, height]) => innerWidth <= width + 1 && innerHeight <= height + 1, [minWidth, minHeight]), 'the minimum window size');
    results.window = await page.evaluate(() => [innerWidth, innerHeight]);
    await waitFor(async () => (await page.evaluate(() => document.documentElement.dataset.theme ?? 'mono')) === theme, `the profile theme ${theme}`);
    // A native session starts in a terminal that has no shell yet: the project is not opened first.
    await page.evaluate(() => window.agentrix.agentLaunch('questions', 'claude', 'native')).then(result => assert.equal(result.ok, true, JSON.stringify(result)));
    const show = page.getByRole('button', { name: '阅读视图：按文档排版显示对话', exact: true }); if (await show.isVisible()) await show.click();
    const card = page.locator('.native-question');
    await card.waitFor({ timeout: 30000 });
    assert.equal(await card.count(), 1, 'one native question card');
    const required = page.locator('.native-question-bool input[type="radio"]');
    assert.equal(await required.count(), 2, 'a required boolean offers yes and no only');
    assert.equal(await required.evaluateAll(nodes => nodes.filter(node => node.checked).length), 0, 'the boolean is left empty');
    assert.match(await card.locator('.native-question-status').innerText(), /还有 1 项未完成/);
    await shot(page, 'card-initial');

    // Enter on the unfinished form: the reason shows and the first unfinished field takes focus.
    await page.locator('.native-question-field').first().locator('input').first().focus();
    await page.keyboard.press('Enter');
    await card.locator('.native-question-reason').first().waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.type), 'radio', 'Enter leaves focus on the first unfinished field');
    await shot(page, 'card-enter');

    // Tab to the link: radios of the group first, then the link.
    for (let step = 0; step < 4 && await page.evaluate(() => document.activeElement.textContent !== '前往第一项'); step++) await page.keyboard.press('Tab');
    const link = await page.evaluate(measureLink);
    assert.equal(link.label, '前往第一项', 'Tab reaches the link');
    assert.deepEqual({ ...link, label: undefined }, { label: undefined, outline: '2px solid', hit: 32, underline: 'underline', overStatusText: false, overActions: false, clipped: false });
    await shot(page, 'card-link-focus');
    results.steps.push({ link });

    // Activating it puts focus back on the first unfinished field.
    await page.keyboard.press('Enter');
    await waitFor(() => page.evaluate(() => document.activeElement.type === 'radio'), 'the link focuses the first unfinished field');
    assert.equal(await page.evaluate(() => document.activeElement.closest('.native-question-field') === document.querySelector('.native-question-field')), true);
    await shot(page, 'card-after-jump');
    assert.deepEqual(errors, []);
  } finally {
    await fs.writeFile(path.join(dir, 'results.json'), JSON.stringify(results, null, 2));
    if (app) await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 15000))]);
  }
}

const output = await testRun('native-question');
await withGuiLock('native-question', async () => { for (const theme of THEMES) await runTheme(theme, output); });
console.log(`PASS: the real native question card at ${minWidth}×${minHeight}: empty required boolean, Enter, Tab to 前往第一项 and activating it, in the mono and light themes: ${output}`);
