// Codex's own approval prompts in the reading view: asked to run a command and to write a file, the reading view shows
// each as a choice, and the edit step names the file rather than the patch. No model and no credential: Codex talks to
// a stand-in on 127.0.0.1 (a model provider of its own in an isolated CODEX_HOME) that asks for the tools the way GPT-6
// does in Codex 0.162 (code mode). Each prompt is left with Esc ("No, and tell Codex what to do differently"), so
// nothing runs and nothing is remembered. Isolated Agentrix profile; the rows of each prompt are kept for fixtures
// (skills/cli-screen-capture). Run with `node scripts/codex-approval-probe.mjs` after `npm run build`.
import { testRun } from './test-output.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright-core';
import { setMode } from './mode-switch.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const output = await testRun('codex-approval'), profile = path.join(output, 'profile'), home = path.join(output, 'codex-home');
const project = { id: randomUUID(), name: 'approval', path: path.join(output, 'approval'), restore: { terminal: false, codex: false } };
for (const directory of [profile, project.path, home]) await fs.mkdir(directory, { recursive: true });
await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects: [project], settings: { terminalRenderer: 'dom', restoreSessions: false, closeToTray: false, notifications: false, sound: false, language: 'zh', startView: 'workspace' } }));

// The stand-in model, answering as the Responses API streams: a tool call for the words RUNCOMMAND and MAKEEDIT, a
// short message for anything else (Codex asks it for a title too) and for the outcome of its own calls.
const sse = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
const completed = id => ({ type: 'response.completed', response: { id, usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } });
const answer = (id, item) => [{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item }, completed(id)];
const say = (id, text) => answer(id, { type: 'message', role: 'assistant', id: `msg_${id}`, content: [{ type: 'output_text', text }] });
// Codex 0.162 gives GPT-6 its tools through one JavaScript tool, exec.
const CODE = {
  RUNCOMMAND: `await tools.exec_command(${JSON.stringify({ cmd: "Set-Content -LiteralPath 'hello.txt' -Value 'hi'", sandbox_permissions: 'require_escalated', justification: 'Create hello.txt in the project?' })});`,
  MAKEEDIT: `await tools.apply_patch(${JSON.stringify(['*** Begin Patch', '*** Add File: notes.md', '+# 示例', '+', '+- 第一项', '*** End Patch', ''].join('\n'))});`,
};
let count = 0;
const server = http.createServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    if (request.method !== 'POST' || !/\/responses$/.test(request.url)) { response.writeHead(404).end(); return; }
    const input = JSON.parse(body || '{}').input || [], last = input.at(-1) || {}, id = `resp_${++count}`;
    const said = JSON.stringify([...input].reverse().find(item => item.role === 'user')?.content || '');
    const word = Object.keys(CODE).find(key => said.includes(key));
    const events = /output$/.test(last.type || '') && String(last.call_id).startsWith('call_resp_') ? say(id, '好的，没有执行。')
      : word ? answer(id, { type: 'custom_tool_call', id: `ct_${id}`, call_id: `call_${id}`, namespace: 'functions', name: 'exec', input: CODE[word] })
      : say(id, '好的。');
    response.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse(events));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const trusted = [project.path, root, root.toLowerCase()].map(folder => `[projects.'${folder}']\ntrust_level = "trusted"\n`).join('\n');
await fs.writeFile(path.join(home, 'config.toml'), ['model = "gpt-6-sol"', 'model_provider = "standin"', 'approval_policy = "on-request"', 'sandbox_mode = "read-only"', 'check_for_update_on_startup = false', '',
  '[model_providers.standin]', 'name = "Stand-in"', `base_url = "http://127.0.0.1:${server.address().port}/v1"`, 'wire_api = "responses"', 'env_key = "STANDIN_API_KEY"', '', '[windows]', 'sandbox = "unelevated"', '', trusted].join('\n'));
const env = { ...process.env, AGENTRIX_DATA_DIR: profile, CODEX_HOME: home, STANDIN_API_KEY: 'standin' }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
const app = await electron.launch({ executablePath: require('electron'), args: [root], cwd: root, env, timeout: 30000 });
const page = await app.firstWindow(); const errors = [];
page.on('pageerror', error => errors.push(error.message));
const waitFor = async (check, what, tries = 120) => { for (let i = 0; i < tries; i++) { if (await check().catch(() => false)) return; await sleep(250); } throw new Error('timed out: ' + what); };
const rows = () => page.evaluate(id => [...document.querySelectorAll(`[data-terminal-id="${id}"] .xterm-rows > div`)].map(row => row.textContent.replace(/ /g, ' ').replace(/\s+$/, '')), project.id);
const write = data => page.evaluate(({ id, data }) => window.agentrix.writeTerminal(id, data), { id: project.id, data });
const type = async text => {
  for (const key of text) { await write(key); await sleep(25); }
  await waitFor(async () => (await rows()).some(row => row.includes(text)), 'typed: ' + text, 40);
  await sleep(300); await write('\r');
};
const card = page.locator('.project-panel').first();
// A prompt's rows, then the reading view's choice for it; Esc leaves it.
async function prompt(name, title) {
  await waitFor(async () => (await rows()).some(row => title.test(row)), `${name}: the prompt`, 160);
  await sleep(1200);
  await fs.writeFile(path.join(output, `rows-${name}.json`), JSON.stringify(await rows(), null, 1));
  if (!await card.locator('.reading-view').count()) await setMode(page, project.name, 'reading');
  const choice = card.locator('.reading-choice');
  await choice.waitFor({ timeout: 5000 }).catch(() => {});
  assert.ok(await choice.count(), `${name}: the reading view shows the prompt as a choice`);
  const text = (await choice.first().innerText()).replace(/\s+/g, ' ');
  assert.match(text, title);
  console.log(`${name}: ${text.slice(0, 160)}`);
  await page.screenshot({ path: path.join(output, `${name}.png`) });
  return async () => { await write('\x1b'); await waitFor(async () => !(await rows()).some(row => title.test(row)), `${name}: the prompt closed`, 80); await sleep(1500); };
}
try {
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1500, 950); w.webContents.setBackgroundThrottling(false); });
  await card.waitFor({ timeout: 20000 });
  await card.getByRole('button', { name: `全屏查看 ${project.name}`, exact: true }).click();
  await page.evaluate(id => window.agentrix.startTerminal(id), project.id);
  await waitFor(async () => (await page.evaluate(() => window.agentrix.getState())).value.projects[0].terminals[0]?.shellReady, 'shell');
  await write('codex\r');
  await waitFor(async () => (await rows()).some(row => /^\s*›(\s|$)/.test(row)), 'the composer', 160);
  await sleep(6000);
  await type('RUNCOMMAND please');
  await (await prompt('command', /Would you like to run the following command\?/))();
  await type('MAKEEDIT please');
  const leave = await prompt('edit', /Would you like to make the following edits\?/);
  const steps = (await card.locator('.reading-view').innerText()).replace(/\s+/g, ' ');
  assert.ok(steps.includes('notes.md') && !steps.includes('Begin Patch'), 'the edit step names the file, not the patch');
  await leave();
  assert.deepEqual(errors, []);
  console.log('PASS: Codex asking to run a command and to write a file shows as a choice in the reading view. Evidence:', output);
} catch (error) {
  console.log('FAIL', error.message.split('\n').slice(0, 3).join(' | '));
  await fs.writeFile(path.join(output, 'rows-failure.json'), JSON.stringify(await rows().catch(() => []), null, 1));
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  server.close();
}
