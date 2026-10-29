// How soon the reading view shows what an agent writes: a reply is appended to the agent's own record file (a Claude
// Code transcript, a Codex rollout) and the time until it is on screen is measured, several times, for both. Fixtures
// play the CLIs; isolated profile with Claude and Codex homes of its own. Run after a build.
import { testRun } from './test-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const output = await testRun('latency'), profile = path.join(output, 'profile'), claude = path.join(output, 'claude'), codexHome = path.join(output, 'codex-home');
const projects = ['Claude', 'Codex'].map(name => ({ id: randomUUID(), name, path: path.join(output, 'p', name), restore: { terminal: false, codex: false } }));
for (const directory of [profile, path.join(claude, 'projects'), path.join(codexHome, 'sessions'), ...projects.map(project => project.path)]) await fs.mkdir(directory, { recursive: true });
await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects, settings: { terminalRenderer: 'dom', restoreSessions: false, closeToTray: false, notifications: false, sound: false, announce: false, language: 'zh', startView: 'workspace' } }));
const env = { ...process.env, AGENTRIX_DATA_DIR: profile, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codexHome }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
const app = await electron.launch({ executablePath: require('electron'), args: [root], cwd: root, env, timeout: 30000 });
const page = await app.firstWindow();
const state = async index => (await page.evaluate(() => window.agentrix.getState())).value.projects[index];
const write = (id, data) => page.evaluate(({ id, data }) => window.agentrix.writeTerminal(id, data), { id, data });
const hook = (kind, payload) => `'${JSON.stringify(payload)}' | & $global:AgentrixSession.powershellPath -NoProfile -ExecutionPolicy Bypass -File $global:AgentrixSession.claudeHookPath -PipeName $global:AgentrixSession.pipeName -ProjectId $global:AgentrixSession.projectId -SessionKey $global:AgentrixSession.sessionKey -Kind ${kind}\r`;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
// The time from appending a record until its words are on screen in that project's reading view.
async function measure(project, file, record, words) {
  await page.evaluate(({ id, words }) => { window.__seenAt = null; const view = document.querySelector(`[data-terminal-id="${CSS.escape(id)}"] .reading-view`) || document.body;
    const observer = new MutationObserver(() => { if (!window.__seenAt && view.textContent.includes(words)) { window.__seenAt = performance.now(); observer.disconnect(); } });
    observer.observe(view, { childList: true, subtree: true, characterData: true }); window.__watchFrom = performance.now(); }, { id: project.id, words });
  const before = await page.evaluate(() => performance.now()), wallBefore = Date.now();
  await fs.appendFile(file, JSON.stringify(record) + '\n');
  const appendedAt = before + (Date.now() - wallBefore);
  for (let i = 0; i < 300; i++) { const seen = await page.evaluate(() => window.__seenAt); if (seen) return Math.round(seen - appendedAt); await sleep(10); }
  return null;
}
try {
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1500, 950); w.webContents.setBackgroundThrottling(false); });
  await page.waitForSelector('.project-panel');
  for (const [index, project] of projects.entries()) {
    await page.evaluate(id => window.agentrix.startTerminal(id), project.id);
    for (let i = 0; i < 100 && !(await state(index)).terminals[0].shellReady; i++) await sleep(200);
  }
  // Claude: a transcript followed through the hooks, as Claude Code's own are.
  const transcript = path.join(claude, 'projects', 's1.jsonl'), at = new Date().toISOString();
  await fs.writeFile(transcript, JSON.stringify({ type: 'user', uuid: 'u0', timestamp: at, message: { role: 'user', content: '开始' } }) + '\n');
  await write(projects[0].id, "function global:prompt { 'claude> ' }; Send-AgentrixEvent 'codex-started' -Agent 'claude'\r");
  for (let i = 0; i < 100 && !(await state(0)).terminals[0].codexActive; i++) await sleep(200);
  await write(projects[0].id, hook('start', { session_id: 's1', transcript_path: transcript, prompt: '开始' }));
  // Codex: a rollout in its home for the folder, found the way Codex's own are.
  const thread = randomUUID(), rollout = path.join(codexHome, 'sessions', `rollout-2026-10-13T10-00-00-${thread}.jsonl`);
  await fs.writeFile(rollout, [{ type: 'session_meta', timestamp: at, payload: { id: thread, cwd: projects[1].path, source: 'cli' } },
    { type: 'event_msg', timestamp: at, payload: { type: 'task_started', turn_id: 't0' } },
    { type: 'event_msg', timestamp: at, payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u0', content: [{ type: 'text', text: '开始' }] } } }].map(record => JSON.stringify(record)).join('\n') + '\n');
  await write(projects[1].id, `function global:prompt { 'codex> ' }; Send-AgentrixEvent 'codex-started' -Agent 'codex'; $Host.UI.RawUI.WindowTitle = '${thread}'\r`);
  for (let i = 0; i < 100 && !(await state(1)).terminals[0].codexActive; i++) await sleep(200);
  for (const project of projects) {
    await page.locator(`[data-project-id="${project.id}"]`).getByRole('button', { name: `进入 ${project.name}`, exact: true }).click();
    await sleep(600);
    const card = page.locator(`[data-project-id="${project.id}"]`);
    if (!await card.locator('.reading-view').count()) await page.locator('.titlebar-tools').getByRole('button', { name: '阅读视图：按文档排版显示对话', exact: true }).click().catch(() => {});
    await sleep(2500);
    const times = [];
    for (let n = 1; n <= 6; n++) {
      const words = `第 ${n} 条回复 ${randomUUID().slice(0, 6)}`, now = new Date().toISOString();
      const record = project === projects[0]
        ? { type: 'assistant', uuid: `a${n}`, timestamp: now, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: words }] } }
        : { type: 'event_msg', timestamp: now, payload: { type: 'item_completed', item: { type: 'AgentMessage', id: `a${n}`, content: [{ type: 'text', text: words }] } } };
      times.push(await measure(project, project === projects[0] ? transcript : rollout, record, words));
      await sleep(700 + n * 37);
    }
    console.log(JSON.stringify({ agent: project.name, ms: times, median: median(times.filter(time => time !== null)) }));
    await page.locator('.focus-sidebar').getByRole('button', { name: /总览/ }).first().click({ timeout: 3000 }).catch(() => {});
    await sleep(800);
  }
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
}
