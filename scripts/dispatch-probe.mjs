// Lead only, after merging both worktrees and `npm run build`:
// node scripts/dispatch-probe.mjs [--packaged] [--failure]
// Latest contract: no row before confirmation -> running -> done -> removed after 3 s.
// Failures use reviewing + failure until the next lead round. There is no dispatch preparing event.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { withGuiLock } from './gui-lock.mjs';
import { waitFor } from './wait.mjs';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { isolatedEnvironment } = require('./native-approval-probe.cjs');
const { claudeProbeConfig } = require('./skills-probe-config.cjs');
const { instructionsOf } = require('./skills-probe-model.cjs');
const sse = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
const sh = value => `'${value.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;

function standin(command, failure) {
  const requests = [];
  let dispatched = false, replies = 0;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; if (body.length > 4 * 1024 * 1024) request.destroy(); });
    request.on('end', () => {
      try {
        const data = JSON.parse(body || '{}'), id = `dispatch_${randomUUID()}`;
        if (request.method !== 'POST') { response.writeHead(404).end(); return; }
        if (/\/count_tokens/.test(request.url)) { response.writeHead(200).end('{"input_tokens":1}'); return; }
        const codex = /\/responses(?:\?.*)?$/.test(request.url);
        requests.push({ agent: codex ? 'codex' : 'claude', model: data.model, instructions: instructionsOf(data) });
        if (codex) {
          replies++;
          if (failure && replies > 1) {
            response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { type: 'server_error', message: 'Model at capacity (local dispatch probe)' } }));
            return;
          }
          const item = replies === 1 ? { type: 'custom_tool_call', id: `ct_${id}`, call_id: `call_${id}`, namespace: 'functions', name: 'exec',
            input: `text(await tools.exec_command(${JSON.stringify({ cmd: process.platform === 'win32' ? 'Start-Sleep -Seconds 2' : 'sleep 2' })}));` }
            : { type: 'message', role: 'assistant', id: `msg_${id}`, content: [{ type: 'output_text', text: 'Local dispatch probe finished.' }] };
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write(sse([{ type: 'response.created', response: { id } }]));
          setTimeout(() => response.end(sse([{ type: 'response.output_item.done', item }, { type: 'response.completed', response: { id,
            usage: { input_tokens: 1, output_tokens: 100, total_tokens: 101 } } }])), 1800).unref();
          return;
        }
        // Claude Code also asks for a session title without tools; only the conversation request (it offers Bash) gets the tool call.
        const useTool = !dispatched && Array.isArray(data.tools) && data.tools.some(tool => tool.name === 'Bash');
        dispatched ||= useTool;
        const block = useTool ? { type: 'tool_use', id: `tool_${id}`, name: 'Bash', input: {} } : { type: 'text', text: '' };
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        // A review response stays open long enough to inspect a failed worker before the Stop hook removes it.
        setTimeout(() => response.end(sse([
          { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: data.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: block },
          { type: 'content_block_delta', index: 0, delta: useTool ? { type: 'input_json_delta', partial_json: JSON.stringify({ command, description: 'Launch isolated dispatch probe', run_in_background: true }) }
            : { type: 'text_delta', text: 'Dispatch output received and reviewed.' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: useTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
        ])), useTool ? 20 : 1500).unref();
      } catch { response.writeHead(400).end(); }
    });
  });
  return { server, requests };
}

const output = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-dispatch-probe-'));
const profile = path.join(output, 'profile'), home = path.join(output, 'home'), cwd = path.join(output, 'project');
const project = { id: randomUUID(), name: 'Dispatch probe', path: cwd, restore: { terminal: false, codex: false } };
const title = 'Verify dispatched Codex worker', declared = { model: 'gpt-6.1-sol', effort: 'max', fast: true };
const failure = process.argv.includes('--failure'), evidence = { profile, cwd, declared, title, failure, snapshots: [], passed: false };
let app, model;

async function run() {
  const { _electron: electron } = await import('playwright-core');
  const env = { ...isolatedEnvironment(home), AGENTRIX_DATA_DIR: profile, AGENTRIX_TEST_AGENTS: '1', ANTHROPIC_API_KEY: 'standin', STANDIN_API_KEY: 'standin' };
  for (const folder of [profile, cwd, env.CODEX_HOME, env.CLAUDE_CONFIG_DIR]) await fs.mkdir(folder, { recursive: true });
  const initialized = spawnSync('git', ['init', cwd], { stdio: 'ignore', windowsHide: true });
  assert.equal(initialized.status, 0, 'initialize only the generated probe project');
  const brief = path.join(output, 'brief.md'), out = path.join(output, 'answer.md');
  await fs.writeFile(brief, 'Return the deterministic local response. This is an isolated protocol probe.');
  const packaged = process.argv.includes('--packaged');
  const helper = packaged ? path.join(root, 'release/win-unpacked/resources/integration/dispatch.cjs') : path.join(root, 'integration/dispatch.cjs');
  await fs.access(helper);
  const command = `node ${sh(helper)} codex --role 执行 --title ${sh(title)} --model ${declared.model} --effort ${declared.effort} --fast --read-only --cwd ${sh(cwd)} --brief ${sh(brief)} --out ${sh(out)}`;
  model = standin(command, failure);
  await new Promise(resolve => model.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${model.server.address().port}`;
  env.ANTHROPIC_BASE_URL = base;
  await fs.writeFile(path.join(env.CODEX_HOME, 'config.toml'), [
    `model = "${declared.model}"`, 'model_provider = "standin"', 'approval_policy = "never"', 'sandbox_mode = "read-only"', 'check_for_update_on_startup = false',
    '[model_providers.standin]', 'name = "Local stand-in"', `base_url = "${base}/v1"`, 'wire_api = "responses"', 'env_key = "STANDIN_API_KEY"', 'request_max_retries = 0', 'stream_max_retries = 0',
    '[windows]', 'sandbox = "unelevated"', `[projects.'${cwd.replace(/'/g, "''")}']`, 'trust_level = "trusted"', '',
  ].join('\n'));
  await fs.writeFile(path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify(claudeProbeConfig(cwd, env.ANTHROPIC_API_KEY)));
  await fs.writeFile(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }));
  await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects: [project], settings: {
    terminalRenderer: 'dom', restoreSessions: false, closeToTray: false, notifications: false, sound: false, language: 'zh', startView: 'workspace', guideVersion: '9.9.9', activityPane: true,
  } }));
  app = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Agentrix.exe') : require('electron'), args: packaged ? [] : [root], cwd: root, env, timeout: 30000 });
  const page = await app.firstWindow(); await page.waitForFunction(() => !!window.agentrix);
  await app.evaluate(({ app, BrowserWindow, dialog }, expected) => {
    if (app.getPath('userData') !== expected) throw new Error('Refusing a non-probe profile');
    dialog.showMessageBox = async () => ({ response: 1 });
    const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1500, 950); window.webContents.setBackgroundThrottling(false);
  }, profile);
  const call = async (method, ...args) => {
    const result = await page.evaluate(({ method, args }) => window.agentrix[method](...args), { method, args });
    assert.ok(result.ok, `${method}: ${result.error || 'failed'}`); return result.value;
  };
  const terminalId = await call('addTerminal', project.id);
  const groups = async () => {
    const state = await call('getState'), projectState = state.projects.find(value => value.id === project.id);
    return (projectState.terminals.find(value => value.id === terminalId)?.agentUsage?.calls || []).filter(group => group.items.some(item => item.title === title));
  };
  await waitFor(async () => (await call('getState')).projects[0].terminals.find(value => value.id === terminalId)?.shellReady, 'isolated shell ready');
  assert.deepEqual(await groups(), [], 'no preparing row is invented before dispatch-start');
  const expand = page.getByRole('button', { name: /全屏查看 Dispatch probe|Full screen.*Dispatch probe/i }).first();
  if (await expand.isVisible().catch(() => false)) await expand.click();
  const write = data => page.evaluate(({ id, data }) => window.agentrix.writeTerminal(id, data), { id: terminalId, data });
  await write('claude --model claude-sonnet-4-5 --dangerously-skip-permissions AGENTRIX_DISPATCH_PROBE\r');
  const answered = new Set();
  let running, ended, liveRate = false;
  await waitFor(async () => {
    const screen = (await page.locator(`[data-terminal-id="${terminalId}"] .xterm-rows > div`).allTextContents()).join('\n');
    for (const [key, pattern, answer] of [['trust', /Yes, I trust this folder|trust the files in this folder/i, '\r'], ['bypass', /Yes, I accept|accept.*bypass permissions/i, '\x1b[B\r'], ['theme', /Choose the text style/i, '\r']]) {
      if (!answered.has(key) && pattern.test(screen)) { answered.add(key); await write(answer); }
    }
    const current = await groups(), group = current[0], item = group?.items.find(item => item.title === title);
    if (!item) return false;
    evidence.snapshots.push({ at: Date.now(), group });
    if (item.state === 'running') {
      liveRate ||= !!group.rate?.samples;
      if (!running) {
        running = group;
        await waitFor(async () => (await page.locator('.activity-calls').allTextContents()).join(' ').includes(title), 'pane renders the dispatched title');
        assert.match((await page.locator('.activity-calls').allTextContents()).join(' '), /运行中/);
        await page.screenshot({ path: path.join(output, 'running.png') });
      }
    }
    if (item.state === (failure ? 'reviewing' : 'done')) {
      ended = group;
      await waitFor(async () => (await page.locator('.activity-calls').allTextContents()).join(' ').includes(failure ? '模型满载' : '已完成'), 'pane renders the final state');
      assert.match((await page.locator('.activity-calls').allTextContents()).join(' '), /\d+ token\/s/);
      await page.screenshot({ path: path.join(output, 'ended.png') }); return true;
    }
    return false;
  }, 'real Bash -> helper -> real Codex -> ended row', 90000);
  assert.ok(running, 'pane showed the running row');
  assert.equal(ended.items[0].title, title);
  assert.ok(ended.rate?.samples && ended.rate.activeMs > 0, 'pane shows the final measured rate');
  if (failure) assert.equal(ended.items[0].failure?.reason, 'capacity');
  else await waitFor(async () => !(await groups()).length, 'successful row removed after three seconds', 7000);
  await fs.writeFile(path.join(output, 'worker.log'), await fs.readFile(out + '.log'));
  evidence.liveRate = liveRate; evidence.running = running; evidence.ended = ended;
  assert.equal(running.model, declared.model, 'CLI must report its actual model; unreported is a protocol limitation, not routing proof');
  assert.equal(running.effort, declared.effort, 'CLI must report its actual effort');
  assert.equal(running.fast, declared.fast, 'CLI must report its actual service tier');
  // The failing worker ends within the first 5 s rate tick, so only the successful run must show a live rate.
  if (!failure) assert.ok(liveRate, 'a completed model response produced a rate while the worker was still running');
  assert.ok(model.requests.some(value => value.agent === 'claude' && value.instructions.includes('Dispatch helper: node ')), 'lead received the helper startup note');
  const pane = await page.locator('.activity-calls').allTextContents(); evidence.pane = pane;
  evidence.passed = true;
}

try { await withGuiLock('dispatch-probe', async () => { try { await run(); } finally { if (app) await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); } }); }
catch (error) { evidence.error = error.message; process.exitCode = 1; }
finally {
  model?.server.closeAllConnections();
  if (model?.server.listening) await new Promise(resolve => model.server.close(resolve));
  evidence.requests = model?.requests;
  await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify(evidence, null, 2));
  console.log(`${evidence.passed ? 'PASS' : 'FAIL'} dispatch probe: ${evidence.error || 'worker lifecycle and route verified'}. Evidence: ${output}`);
}
