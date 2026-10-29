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
const project = { id: randomUUID(), name: 'Skills probe', path: path.join(output, 'project'), restore: { terminal: false, codex: false } };
const model = createSkillsModel(), summary = [];
let app, page;

async function run() {
  const env = { ...isolatedEnvironment(home), AGENTRIX_DATA_DIR: profile, AGENTRIX_TEST_AGENTS: '1',
    ANTHROPIC_API_KEY: 'standin', STANDIN_API_KEY: 'standin' };
  for (const folder of [profile, project.path, env.CODEX_HOME, env.CLAUDE_CONFIG_DIR]) await fs.mkdir(folder, { recursive: true });
  await new Promise(resolve => model.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${model.server.address().port}`;
  env.ANTHROPIC_BASE_URL = base;
  await fs.writeFile(path.join(env.CODEX_HOME, 'config.toml'), [
    'model = "gpt-6-sol"', 'model_provider = "standin"', 'approval_policy = "never"', 'sandbox_mode = "read-only"', 'check_for_update_on_startup = false',
    '[model_providers.standin]', 'name = "Stand-in"', `base_url = "${base}/v1"`, 'wire_api = "responses"', 'env_key = "STANDIN_API_KEY"',
    '[windows]', 'sandbox = "unelevated"', `[projects.'${project.path.replace(/'/g, "''")}']`, 'trust_level = "trusted"', '',
  ].join('\n'));
  // Claude Code indexes trusted projects with forward slashes, including on Windows.
  await fs.writeFile(path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify(claudeProbeConfig(project.path, env.ANTHROPIC_API_KEY)));
  await fs.writeFile(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }));
  await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects: [project], settings: {
    terminalRenderer: 'dom', restoreSessions: false, closeToTray: false, notifications: false, sound: false, language: 'en', startView: 'workspace',
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
  model.setSkill(builtin.path);
  const instruction = `Before any task, read and follow ${builtin.path.replace(/\\/g, '/')}.`;
  await app.evaluate(({ app, BrowserWindow, dialog }, expectedProfile) => {
    if (app.getPath('userData') !== expectedProfile) throw new Error('Refusing a non-probe profile');
    // Closing generated test terminals must not leave a modal waiting for a person.
    dialog.showMessageBox = async () => ({ response: 1 });
    const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1500, 950); window.webContents.setBackgroundThrottling(false);
  }, profile);
  for (const agent of agents) {
    let terminalId;
    try {
      assert.ok(onPath(agent, env), `${agent} is not installed in PATH`);
      terminalId = agent === agents[0] ? project.id : await call('addTerminal', project.id);
      if (agent === agents[0]) await call('startTerminal', terminalId);
      await waitFor(async () => (await call('getState')).projects[0].terminals.find(t => t.id === terminalId)?.shellReady, `${agent}: isolated shell ready`);
      // The isolated project's terminal is mounted in a focus view so CLI cursor queries receive real answers.
      const expand = page.getByRole('button', { name: /Full screen.*Skills probe|全屏查看 Skills probe/i }).first();
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
        return model.results.has(agent) && usage?.agent === agent && usage.project === project.name;
      }, `${agent}: tool read and lastUsed`, 90000);
      assert.ok(model.requests.some(request => request.agent === agent && request.instructions.includes(instruction)), `${agent}: system/developer instructions contain the always skill and exact path`);
      const skill = (await call('listSkills')).find(skill => skill.id === builtin.id);
      summary.push({ agent, result: 'PASS', instruction, lastUsed: skill.lastUsed });
      console.log(`PASS ${agent}: captured always instruction, executed SKILL.md read, listSkills lastUsed matches project/agent.`);
    } catch (error) {
      summary.push({ agent, result: 'FAIL', error: error.message });
      console.log(`FAIL ${agent}: ${error.message}`);
      if (terminalId) await fs.writeFile(path.join(output, `${agent}-rows.json`), JSON.stringify(await page.locator(`[data-terminal-id="${terminalId}"] .xterm-rows > div`).allTextContents().catch(() => []), null, 2));
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
  await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify({ profile, project: project.path, checks: summary }, null, 2));
}
const passed = summary.filter(check => check.result === 'PASS').length;
console.log(`${passed === agents.length ? 'PASS' : 'FAIL'} skills probe: ${passed}/${agents.length} CLIs. Evidence: ${output}`);
if (passed !== agents.length || summary.some(check => check.result === 'FAIL')) process.exitCode = 1;
