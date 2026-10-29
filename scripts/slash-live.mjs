// Every slash command the reading view offers, run against the real Claude Code and Codex on this machine.
// It needs both CLIs installed and signed in, and spends a few tokens: commands that start model work are
// interrupted as soon as the agent starts. Commands that would change the account or global settings are only
// checked to be listed (see SKIP). Run: node scripts/slash-live.mjs [claude|codex] [/a,/b]
import { testRun } from './test-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright-core';
import { waitFor } from './wait.mjs';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { listAgentCommands } = require('../electron/agent-commands.cjs');
const output = await testRun('slash-live'), profile = path.join(output, 'profile');
// A fixed project path, so trusting it in each CLI's own settings adds one entry, not one per run.
const project = { id: randomUUID(), name: '命令实测', path: path.join(root, '.test-output', 'slash-live-project'), restore: { terminal: false, codex: false } };
await fs.mkdir(profile, { recursive: true }); await fs.mkdir(project.path, { recursive: true });
const git = (...args) => execFileSync('git', ['-C', project.path, ...args], { encoding: 'utf8', windowsHide: true });
try { git('rev-parse', '--git-dir'); } catch {
  git('init', '-b', 'main'); git('config', 'user.name', 'Slash Test'); git('config', 'user.email', 'slash@example.invalid');
  await fs.writeFile(path.join(project.path, 'README.md'), '# Slash test\n'); git('add', '.'); git('commit', '-m', 'base');
}
await fs.writeFile(path.join(project.path, 'notes.txt'), `changed ${new Date().toISOString()}\n`);
await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects: [project], settings: { terminalRenderer: 'dom', restoreSessions: false, closeToTray: false, notifications: false, sound: false, announce: false, language: 'zh' } }));
const env = { ...process.env, AGENTRIX_DATA_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
// Started from inside Claude Code, the test would hand the CLI this session's markers (which turn transcripts off).
for (const name of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_EFFORT$|CLAUDE_PID$)/.test(name)) delete env[name];

// Not run: they sign out, start a sign-in, or rewrite settings outside this test. Exit commands run last.
const SKIP = {
  '/login': 'starts a sign-in flow for the real account', '/logout': 'signs the real account out',
  '/terminal-setup': 'writes the terminal\'s own key bindings', '/statusline': 'has the agent rewrite ~/.claude settings',
};
const MODEL = new Set(['/init', '/review', '/security-review', '/pr-comments', '/btw', '/compact']);
const LAST = new Set(['/exit', '/quit']);
const agents = process.argv[2] ? [process.argv[2]] : ['claude', 'codex'];
const strip = text => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b./g, '').replace(/\r/g, '');
let app, page, card, terminal, composer;
const results = [];
const state = async () => (await page.evaluate(() => window.agentrix.getState())).value.projects[0].terminals[0];
const write = data => page.evaluate(({ id, data }) => window.agentrix.writeTerminal(id, data), { id: project.id, data });
const screenText = async () => strip((await page.evaluate(id => window.agentrix.attachTerminal(id), project.id)).value.data);
const visible = locator => locator.first().isVisible().catch(() => false);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const view = async () => ({
  choice: await visible(terminal.locator('.reading-choice:not(.reading-sessions)')),
  panel: await visible(terminal.locator('.reading-terminal-popup')),
  sessions: await visible(terminal.locator('.reading-sessions')),
  composer: await visible(composer),
  enabled: await composer.isEnabled().catch(() => false),
});
const text = async selector => (await terminal.locator(selector).allInnerTexts().catch(() => [])).join('\n').trim();
// The CLI's own screen (the DOM renderer keeps its rows readable): busy while a spinner or hook line shows, and its
// input line must be empty before the next command, or the command lands on whatever was left there.
const cliRows = async () => (await terminal.locator('.xterm-rows > div').allTextContents().catch(() => [])).map(row => row.replace(/\s+$/, ''));
async function cliState(agent) {
  const rows = await cliRows();
  const busy = rows.some(row => /^\s*[·✢✳✶✻✽*•]\s+[\w'’-]+…|running \w+ hooks|esc to interrupt/i.test(row));
  const marker = agent === 'claude' ? '❯' : '›';
  const input = [...rows].reverse().find(row => row.trim().startsWith(marker));
  const left = input ? input.trim().slice(1).trim() : '';
  return { busy, left: /^Try ["“]|^Ask Codex to do anything|^Explain this codebase|^Implement \{feature\}|^Find and fix a bug|^Summarize recent commits|^Improve documentation|^Write tests for/.test(left) ? '' : left };
}
async function quiet(agent, timeout = 30000) {
  const until = Date.now() + timeout;
  let leftSince = 0;
  while (Date.now() < until) {
    const v = await view(), cli = await cliState(agent);
    if (v.panel || v.choice || v.sessions) { await dismiss(); continue; }
    if (cli.left) { leftSince ||= Date.now(); if (Date.now() - leftSince > 1500) { await write('\x15'); leftSince = 0; } }
    else leftSince = 0;
    if (!cli.busy && !cli.left && v.composer && v.enabled) return true;
    await sleep(400);
  }
  return false;
}

// At startup, accept the folder trust question and similar first-run prompts so the agent reaches its input box;
// between commands, anything left open is dismissed, never confirmed.
async function settle(agent, startup = false) {
  for (let round = 0; round < 40; round++) {
    const s = await state(), v = await view();
    if (s.codexActive && v.composer && v.enabled && !v.choice && !v.panel) return;
    if (v.panel || v.sessions || (v.choice && !startup)) await dismiss();
    else if (v.choice) {
      const first = terminal.locator('.reading-choice:not(.reading-sessions)').first();
      await first.focus(); await page.keyboard.press('Enter');
    } else if (s.codexActive && !v.composer) {
      // Handed off to the raw terminal for a prompt: take its default, then return to reading.
      await write('\r'); await sleep(800);
      const back = page.locator('.titlebar-tools').getByRole('button', { name: '阅读视图：按文档排版显示对话', exact: true });
      if (await visible(back)) await back.click();
    }
    await sleep(700);
  }
  throw new Error(`${agent} never reached its input box`);
}
async function start(agent) {
  if ((await state()).codexActive) return;
  await write(`${agent}\r`);
  await waitFor(async () => (await state()).codexActive && (await state()).agent === agent, `${agent} started`, 90000);
  await composer.waitFor({ state: 'visible', timeout: 30000 });
  await settle(agent, true);
  // The input box appears before the CLI has finished starting (plugins, MCP servers); a command typed in that
  // window can be lost, as a user's would be.
  await sleep(5000); await settle(agent, true);
}
// Work in the real terminal to leave the command, then close its popup with the button.
async function dismiss(command = '') {
  for (let round = 0; round < 6; round++) {
    const v = await view();
    if (v.sessions) { await terminal.locator('.reading-sessions').getByRole('button', { name: /关闭|取消/ }).first().click().catch(async () => { await page.keyboard.press('Escape'); }); await sleep(600); continue; }
    const s = await state();
    if (!s.codexActive) return 'exited';
    if (v.composer && v.enabled && !v.choice && !v.panel && s.codexActivity !== 'working') return 'ready';
    const target = terminal.locator(v.panel ? '.reading-terminal-popup' : '.reading-choice:not(.reading-sessions)').first();
    if (v.panel) {
      await target.locator('.xterm-helper-textarea').focus();
      await page.keyboard.press(command === '/side' ? 'Control+c' : command === '/diff' ? 'q' : 'Escape');
      await target.getByRole('button', { name: '关闭', exact: true }).click();
    } else if (v.choice) { await target.focus().catch(() => {}); await page.keyboard.press('Escape'); }
    else if (s.codexActivity === 'working') { await composer.focus(); await page.keyboard.press('Escape'); }
    else await write('\x1b');
    await sleep(1200);
  }
  const v = await view();
  return v.composer && v.enabled && !v.choice && !v.panel ? 'ready' : `stuck ${JSON.stringify(v)}`;
}
async function run(agent, command) {
  await settle(agent);
  if (!await quiet(agent)) console.log(`  (${agent} was not idle before ${command})`);
  const before = (await screenText()).length;
  await composer.fill(command); await sleep(150);
  await composer.press('Enter');
  // The palette may complete the name first; a second Enter sends it.
  if ((await composer.inputValue()).trim() === command) await composer.press('Enter');
  if (!LAST.has(command)) await terminal.locator(command === '/resume' ? '.reading-sessions' : '.reading-terminal-popup').waitFor();
  const seen = { panel: false, choice: false, sessions: false, working: false };
  const until = Date.now() + (MODEL.has(command) ? 12000 : 7000);
  let panelText = '', choiceText = '';
  while (Date.now() < until) {
    const v = await view(), s = await state();
    if (v.panel) { seen.panel = true; panelText = await text('.reading-terminal-popup .xterm-rows'); }
    if (v.choice) { seen.choice = true; choiceText = await text('.reading-choice:not(.reading-sessions)'); }
    if (v.sessions) seen.sessions = true;
    if (s.codexActivity === 'working') seen.working = true;
    if (!s.codexActive) break;
    if ((seen.panel || seen.choice || seen.sessions) && Date.now() > until - 4000) break;
    await sleep(300);
  }
  const shot = path.join(output, `${agent}-${command.replace(/[^a-z-]/gi, '')}.png`);
  await page.screenshot({ path: shot }).catch(() => {});
  const screen = (await screenText()).slice(before);
  // Only the CLI's own answer to this command counts; its autocomplete says "No commands match" while a name is typed.
  const name = command.slice(1);
  const unknown = new RegExp(`(Unknown (slash )?command:? |Unrecognized command '?)/${name}(?![\\w-])`, 'i').test(screen + panelText);
  let after = LAST.has(command) ? ((await state()).codexActive ? 'still running' : 'exited') : await dismiss(command);
  if (after === 'ready' && !await quiet(agent)) after = 'CLI never went idle';
  const shown = seen.sessions ? 'session picker' : seen.choice ? 'choice' : seen.panel ? 'live terminal' : seen.working ? 'agent turn' : 'nothing';
  const ok = !unknown && shown !== 'nothing' && (LAST.has(command) ? after === 'exited' : after === 'ready');
  const record = { agent, command, ok, shown, after, unknown, excerpt: (panelText || choiceText || screen.trim()).split('\n').filter(Boolean).slice(0, 6).join(' | ').slice(0, 300), screenshot: path.basename(shot) };
  results.push(record);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${agent} ${command}: ${shown}, then ${after}${unknown ? ', CLI says unknown' : ''} :: ${record.excerpt}`);
  if (after === 'exited' && !LAST.has(command)) await start(agent);
}

try {
  app = await electron.launch({ executablePath: require('electron'), args: [root], cwd: root, env });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(1500, 950); BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false); });
  await page.waitForSelector('.project-panel');
  card = page.locator(`[data-project-id="${project.id}"]`); terminal = page.locator(`[data-terminal-id="${project.id}"]`);
  composer = terminal.locator('.reading-composer textarea');
  await card.getByRole('button', { name: `进入 ${project.name}`, exact: true }).click();
  await card.getByRole('button', { name: '只打开终端', exact: true }).click();
  await waitFor(async () => (await state()).shellReady, 'PowerShell ready', 60000);
  for (const agent of agents) {
    await start(agent);
    const listed = (await listAgentCommands({ agent, projectPath: project.path })).filter(command => command.source === 'builtin').map(command => command.name);
    // node scripts/slash-live.mjs codex /pwd,/diff runs just those.
    const only = process.argv[3]?.split(',');
    const order = [...listed.filter(name => !LAST.has(name)), ...listed.filter(name => LAST.has(name))].filter(name => !only || only.includes(name));
    for (const command of order) {
      if (SKIP[command]) { results.push({ agent, command, ok: null, shown: 'skipped', after: SKIP[command] }); console.log(`SKIP ${agent} ${command}: ${SKIP[command]}`); continue; }
      try { await run(agent, command); }
      catch (error) { results.push({ agent, command, ok: false, shown: 'error', after: String(error.message || error).slice(0, 200) }); console.log(`FAIL ${agent} ${command}: ${error.message}`); await dismiss().catch(() => {}); }
      // /vim toggles a saved setting; send it again so the setting ends where it started.
      if (command === '/vim') { await run(agent, '/vim').catch(() => {}); results.pop(); }
    }
    if ((await state()).codexActive) { await write('\x03'); await sleep(500); await write('\x03'); await waitFor(async () => !(await state()).codexActive, `${agent} closed`, 30000).catch(() => {}); }
  }
} finally {
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(item => item.ok === false), passed = results.filter(item => item.ok === true).length, skipped = results.filter(item => item.ok === null).length;
  console.log(`\n${passed} worked, ${failed.length} failed, ${skipped} skipped. Evidence: ${output}`);
  if (app) {
    try { await page.evaluate(id => window.agentrix.closeTerminal(id), project.id); } catch { }
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  }
  if (failed.length) process.exitCode = 1;
}
