// Lead-only, opt-in GUI/installed CLI proof. Run after merging the built-in skill and `npm run build`:
// node scripts/skills-probe.mjs [--packaged] [--agent=claude|codex]
// Every shell, CLI home and project is generated below an OS temp folder, outside repo/owner settings.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright-core';
import { withGuiLock } from './gui-lock.mjs';
import { waitFor } from './wait.mjs';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createSkillsModel } = require('./skills-probe-model.cjs');
const { claudeProbeConfig } = require('./skills-probe-config.cjs');
const { isolatedEnvironment } = require('./native-approval-probe.cjs');
const { onPath } = require('../electron/agents.cjs');
const selected = process.argv.find(arg => arg.startsWith('--agent='))?.slice(8);
if (selected && !['claude', 'codex'].includes(selected)) throw new Error('Use --agent=claude or --agent=codex');
const agents = selected ? [selected] : ['claude', 'codex'];
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-skills-probe-'));
const profile = path.join(output, 'profile'), home = path.join(output, 'home');
const projects = agents.map(agent => ({ id: randomUUID(), name: `Skills probe ${agent}`, path: path.join(output, agent), restore: { terminal: false, codex: false } }));
const phases = ['first-open', 'later-session', 'yielded'];
const model = createSkillsModel(), summary = [];
let app, page;

async function run() {
  const env = { ...isolatedEnvironment(home), AGENTRIX_DATA_DIR: profile, AGENTRIX_TEST_AGENTS: '1',
    ANTHROPIC_API_KEY: 'standin', STANDIN_API_KEY: 'standin' };
  for (const folder of [profile, ...projects.map(project => project.path), env.CODEX_HOME, env.CLAUDE_CONFIG_DIR]) await fs.mkdir(folder, { recursive: true });
  await new Promise(resolve => model.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${model.server.address().port}`;
  env.ANTHROPIC_BASE_URL = base;
  await fs.writeFile(path.join(env.CODEX_HOME, 'config.toml'), [
    'model = "gpt-6-sol"', 'model_provider = "standin"', 'approval_policy = "never"', 'sandbox_mode = "read-only"', 'check_for_update_on_startup = false',
    '[model_providers.standin]', 'name = "Stand-in"', `base_url = "${base}/v1"`, 'wire_api = "responses"', 'env_key = "STANDIN_API_KEY"',
    '[windows]', 'sandbox = "unelevated"', ...projects.flatMap(project => [`[projects.'${project.path.replace(/'/g, "''")}']`, 'trust_level = "trusted"']), '',
  ].join('\n'));
  // Claude Code indexes trusted projects with forward slashes, including on Windows.
  await fs.writeFile(path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify(claudeProbeConfig(projects.map(project => project.path), env.ANTHROPIC_API_KEY)));
  await fs.writeFile(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }));
  await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects, settings: {
    terminalRenderer: 'dom', restoreSessions: false, closeToTray: false, notifications: false, sound: false, language: 'en', startView: 'workspace', guideVersion: '9.9.9',
  } }));
  const packaged = process.argv.includes('--packaged');
  app = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Agentrix.exe') : require('electron'), args: packaged ? [] : [root], cwd: root, env, timeout: 30000 });
  page = await app.firstWindow();
  await page.waitForFunction(() => !!window.agentrix);
  const call = async (method, ...args) => {
    const result = await page.evaluate(({ method, args }) => window.agentrix[method](...args), { method, args });
    assert.ok(result.ok, `${method}: ${result.error || 'failed'}`); return result.value;
  };
  const builtin = (await call('listSkills')).find(skill => skill.id === 'builtin:model-routing');
  assert.ok(builtin, 'Merge the built-in resources/skills/model-routing/SKILL.md before running this probe.');
  const standard = (await call('listSkills')).find(skill => skill.id === 'builtin:code-standard');
  assert.equal(standard?.trigger, 'first-open', 'The built-in code standard defaults to first-open.');
  model.setSkill(builtin.path);
  const instruction = `Before any task, read and follow ${builtin.path.replace(/\\/g, '/')}.`;
  const standardPath = standard.path.replace(/\\/g, '/');
  const firstOpen = `Before the first task of this session, read and follow ${standardPath}; this is its first run in this project.`;
  const yieldLine = 'This project has its own code-standard skill; follow it.';
  await app.evaluate(({ app, BrowserWindow, dialog }, expectedProfile) => {
    if (app.getPath('userData') !== expectedProfile) throw new Error('Refusing a non-probe profile');
    // Closing generated test terminals must not leave a modal waiting for a person.
    dialog.showMessageBox = async () => ({ response: 1 });
    const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1500, 950); window.webContents.setBackgroundThrottling(false);
  }, profile);
  for (const [index, agent] of agents.entries()) for (const phase of phases) {
    const project = projects[index];
    let terminalId;
    try {
      assert.ok(onPath(agent, env), `${agent} is not installed in PATH`);
      if (phase === 'yielded') await fs.mkdir(path.join(project.path, 'skills', 'code-standard'), { recursive: true });
      const previousUse = (await call('listSkills')).find(skill => skill.id === builtin.id)?.lastUsed?.at || 0;
      const requestStart = model.requests.length;
      model.results.delete(agent);
      terminalId = await call('addTerminal', project.id);
      await waitFor(async () => (await call('getState')).projects.find(item => item.id === project.id)?.terminals.find(t => t.id === terminalId)?.shellReady, `${agent} ${phase}: isolated shell ready`);
      if (await page.locator('.app-shell.focus-mode').count()) {
        await page.getByRole('button', { name: 'Agentrix', exact: true }).click();
        await page.getByRole('menuitem', { name: /Back to projects|返回项目/i }).click();
      }
      // The isolated project's terminal is mounted in a focus view so CLI cursor queries receive real answers.
      const expand = page.getByRole('button', { name: new RegExp(`Full screen.*${project.name}|全屏查看 ${project.name}`, 'i') }).first();
      if (await expand.isVisible().catch(() => false)) await expand.click();
      const write = data => page.evaluate(({ id, data }) => window.agentrix.writeTerminal(id, data), { id: terminalId, data });
      const rows = () => page.locator(`[data-terminal-id="${terminalId}"] .xterm-rows > div`).allTextContents();
      const command = agent === 'claude' ? 'claude --model claude-sonnet-4-5 --dangerously-skip-permissions AGENTRIX_SKILLS_PROBE'
        : 'codex -a never --sandbox read-only --no-alt-screen AGENTRIX_SKILLS_PROBE';
      await write(command + '\r');
      const answered = new Set();
      await waitFor(async () => {
        const screen = (await rows()).join('\n');
        for (const [key, pattern, answer] of [['trust', /Yes, I trust this folder|trust the files in this folder/i, /[❯›>]\s*No, exit/i.test(screen) ? '\x1b[B\r' : '\r'],
          ['bypass', /Yes, I accept|accept.*bypass permissions/i, '\x1b[B\r'], ['theme', /Choose the text style/i, '\r']]) {
          if (!answered.has(key) && pattern.test(screen)) { answered.add(key); await write(answer); }
        }
        const usage = (await call('listSkills')).find(skill => skill.id === builtin.id)?.lastUsed;
        return model.results.has(agent) && usage?.agent === agent && usage.project === project.name && usage.at > previousUse;
      }, `${agent} ${phase}: tool read and lastUsed`, 90000);
      const captured = model.requests.slice(requestStart).filter(request => request.agent === agent).map(request => request.instructions);
      assert.ok(captured.some(text => text.includes(instruction)), `${agent}: system/developer instructions contain the always skill and exact path`);
      if (phase === 'first-open') assert.ok(captured.some(text => text.includes(firstOpen)), `${agent}: first session carries code-standard first-open`);
      else assert.ok(captured.every(text => !text.includes(firstOpen)), `${agent}: ${phase} does not repeat first-open`);
      if (phase === 'later-session') assert.ok(captured.some(text => text.includes(`code-standard: ${standard.description} (${standardPath})`)), `${agent}: later session offers code-standard as auto`);
      if (phase === 'yielded') {
        assert.ok(captured.some(text => text.includes(yieldLine)), `${agent}: project skill receives the yield note`);
        assert.ok(captured.every(text => !text.includes(standardPath)), `${agent}: yielded built-in path is omitted`);
      }
      const skill = (await call('listSkills')).find(skill => skill.id === builtin.id);
      summary.push({ agent, phase, project: project.path, result: 'PASS', instruction, timing: phase === 'first-open' ? firstOpen : phase === 'yielded' ? yieldLine : 'code-standard offered as auto', lastUsed: skill.lastUsed });
      console.log(`PASS ${agent} ${phase}: captured always and timing instructions, executed SKILL.md read, lastUsed matches project/agent.`);
    } catch (error) {
      summary.push({ agent, phase, result: 'FAIL', error: error.message });
      console.log(`FAIL ${agent} ${phase}: ${error.message}`);
      if (terminalId) await fs.writeFile(path.join(output, `${agent}-${phase}-rows.json`), JSON.stringify(await page.locator(`[data-terminal-id="${terminalId}"] .xterm-rows > div`).allTextContents().catch(() => []), null, 2));
    }
    // Only this probe's generated terminal. The next CLI starts sequentially in a new isolated terminal.
    if (terminalId) await call('closeTerminal', terminalId).catch(() => {});
  }
}

try { await withGuiLock('skills-probe', async () => { try { await run(); } finally { if (app) await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); } }); }
catch (error) { summary.push({ result: 'FAIL', error: error.message }); console.log(`FAIL setup: ${error.message}`); }
finally {
  model.server.closeAllConnections();
  if (model.server.listening) await new Promise(resolve => model.server.close(resolve));
  await fs.writeFile(path.join(output, 'instructions.json'), JSON.stringify(model.requests, null, 2));
  await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify({ profile, projects: projects.map(project => project.path), checks: summary }, null, 2));
}
const passed = summary.filter(check => check.result === 'PASS').length, expected = agents.length * phases.length;
console.log(`${passed === expected ? 'PASS' : 'FAIL'} skills probe: ${passed}/${expected} session checks. Evidence: ${output}`);
if (passed !== expected || summary.some(check => check.result === 'FAIL')) process.exitCode = 1;
