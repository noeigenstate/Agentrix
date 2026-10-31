// Opt-in installed CLI probe. Uses only fresh homes, dummy local credentials and a loopback model.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { createStandin } = require('./native-approval-model.cjs');
const { createNativeSession, resolveCli } = require('../electron/features/terminal/native-session.cjs');

function isolatedEnvironment(home, inherited = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'lang'].includes(key.toLowerCase())) env[key] = value;
  }
  return Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: home, XDG_DATA_HOME: home, CODEX_HOME: path.join(home, 'codex'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
    TERM: 'xterm-256color', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1',
    NO_PROXY: '127.0.0.1,localhost',
  });
}
function cancellationDecision(request) {
  const decision = ['cancel', 'decline', 'deny'].find(value => request.decisions.includes(value));
  if (!decision) throw new Error('Native request offers no supported cancellation decision');
  return decision;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runInstalled(provider, scenario = 'approval') {
  const output = path.join(__dirname, '../.test-output/native-approval-probe');
  fs.mkdirSync(output, { recursive: true });
  const run = fs.mkdtempSync(path.join(output, `${provider}-`));
  // Keep CLI cwd outside the repository so ancestor project settings/hooks cannot be loaded.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-native-probe-'));
  const cwd = path.join(workspace, 'project'), home = path.join(workspace, 'home'), owned = new Set();
  for (const folder of [cwd, home]) fs.mkdirSync(folder, { recursive: true });
  const env = isolatedEnvironment(home), model = createStandin({ scenario });
  env.TEMP = env.TMP = path.join(workspace, 'tmp'); fs.mkdirSync(env.TMP);
  const report = { provider, run, workspace, cwd, executed: true, installedCliProof: false, version: null, nativeRequest: null };
  let terminal, exited = false, resolved = false, aborted = false, deadline;
  const killOwned = child => {
    if (!child?.pid) return;
    // Only PIDs created by this invocation, never name-based termination.
    if (process.platform === 'win32') {
      const root = env.SystemRoot || env.SYSTEMROOT || env.windir || env.WINDIR;
      spawnSync(root ? path.join(root, 'System32/taskkill.exe') : 'taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { env, windowsHide: true, timeout: 5000, stdio: 'ignore' });
    }
    else {
      // Spawn children own a process group; node-pty exposes kill but no ChildProcess stdio.
      try { if (child.stdout !== undefined) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
    }
  };
  const launch = (file, args, options) => {
    if (scenario === 'elicitation' && args.includes('--input-format')) args = [...args, '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {
      native_probe: { command: process.execPath, args: [path.join(__dirname, 'native-approval-mcp.cjs')] },
    } })];
    const child = spawn(file, args, { ...options, detached: process.platform !== 'win32' }); owned.add(child);
    child.once('close', () => owned.delete(child)); return child;
  };
  async function waitFor(predicate, name) {
    const end = Date.now() + 45000;
    while (!predicate()) {
      if (terminal?.error) throw new Error(terminal.error);
      if (exited || aborted || Date.now() > end) throw new Error(`Native probe stopped or timed out: ${name}`);
      await delay(50);
    }
  }
  try {
    deadline = setTimeout(() => { aborted = true; for (const child of owned) killOwned(child); terminal?.kill(); }, 70000);
    const cli = resolveCli(provider, env);
    const version = await new Promise((resolve, reject) => {
      const child = launch(cli.file, [...cli.prefix, '--version'], { cwd, env: cli.node ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let text = '';
      const timer = setTimeout(() => { killOwned(child); reject(new Error('Version query timed out')); }, 10000);
      child.stdout.on('data', bytes => { text += bytes; if (text.length > 65536) { killOwned(child); reject(new Error('Version output too large')); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(text.trim()) : reject(new Error('Version query failed')); });
    });
    report.version = version;
    await new Promise((resolve, reject) => { model.server.once('error', reject); model.server.listen(0, '127.0.0.1', resolve); });
    const endpoint = `http://127.0.0.1:${model.server.address().port}`;
    for (const folder of [env.CODEX_HOME, env.CLAUDE_CONFIG_DIR]) fs.mkdirSync(folder, { recursive: true });
    if (provider === 'codex') {
      env.STANDIN_API_KEY = 'local-standin-only';
      fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), [
        'model = "gpt-6-sol"', 'model_provider = "standin"', 'approval_policy = "on-request"', 'sandbox_mode = "read-only"', 'check_for_update_on_startup = false',
        '[model_providers.standin]', 'name = "Local stand-in"', `base_url = "${endpoint}/v1"`, 'wire_api = "responses"', 'env_key = "STANDIN_API_KEY"',
        '[windows]', 'sandbox = "unelevated"', `[projects.${JSON.stringify(cwd)}]`, 'trust_level = "trusted"', '',
      ].join('\n'));
    } else {
      env.ANTHROPIC_BASE_URL = endpoint; env.ANTHROPIC_API_KEY = 'local-standin-only'; env.ANTHROPIC_MODEL = 'claude-sonnet-4-5';
      fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));
    }
    let ready = false;
    const pty = provider === 'codex' ? require('node-pty') : null;
    terminal = createNativeSession({ binding: { provider, projectId: 'local-probe', terminalId: 'local-probe', sessionId: randomUUID() },
      mode: provider === 'codex' ? 'codex-native' : 'claude-sdk', cwd, env, cli, launch,
      pty: pty && { spawn(...args) { const child = pty.spawn(...args); owned.add(child); child.onExit(() => owned.delete(child)); return child; } },
      event: event => {
        if (event.type === 'managed-ready') ready = true;
        if (report.nativeRequest && (event.method === 'serverRequest/resolved' && event.params.requestId === report.nativeRequest.requestId || event.type === 'result')) resolved = true;
      },
    });
    terminal.onExit(() => { exited = true; });
    terminal.onData(text => { if (/\x1b\[6n/.test(text)) terminal.write('\x1b[1;1R'); });
    if (provider === 'claude') { await waitFor(() => ready, 'SDK initialize'); terminal.prompt('NATIVE_REQUEST_PROBE'); }
    else { await delay(4000); terminal.write('NATIVE_REQUEST_PROBE'); await delay(500); terminal.write('\r'); }
    await waitFor(() => terminal.registry.list().length > 0, 'CLI-issued native approval');
    let request = terminal.registry.list()[0];
    if (scenario === 'elicitation' && request.params.tool_name === 'mcp__native_probe__request_input') {
      terminal.answer({ token: request.token, decision: 'allow' });
      await waitFor(() => terminal.registry.list().length > 0, 'CLI-issued native elicitation'); request = terminal.registry.list()[0];
    }
    const decision = scenario !== 'approval' && request.question && !request.question.unsupported ? 'submit' : cancellationDecision(request);
    report.nativeRequest = { requestId: request.requestId, requestIdType: typeof request.requestId, method: request.method, decisions: request.decisions, toolUseId: request.params.tool_use_id };
    if (scenario !== 'approval') { report.nativeRequest.params = request.params; report.questionSchema = model.questionSchema; }
    report.decision = decision;
    const payload = { token: request.token, decision, ...(decision === 'submit' ? { values: Object.fromEntries(request.question.fields.map(field => [field.id,
      field.type === 'multi' ? [field.options[0].value] : field.options ? field.options[0].value : field.type === 'boolean' ? false : 'local probe answer'])) } : {}) };
    const respond = request.question ? terminal.answerQuestion : terminal.answer;
    const answer = respond(payload); assert.equal(answer.requestId, request.requestId);
    assert.throws(() => respond(payload)); report.duplicateBlocked = true;
    await waitFor(() => resolved, 'native response resolution');
    assert.equal(fs.existsSync(path.join(cwd, 'native-proof.txt')), false, 'Denied tool unexpectedly created the probe file');
    report.installedCliProof = true;
  } catch (error) { report.error = error.message; }
  finally {
    clearTimeout(deadline);
    // Kill owned trees before adapter cleanup can release their parent PIDs.
    for (const child of owned) killOwned(child);
    terminal?.kill();
    model.server.closeAllConnections();
    if (model.server.listening) await new Promise(resolve => model.server.close(resolve));
    report.localModelRequests = model.requests;
    fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  return { report: path.join(run, 'report.json'), ...report };
}

async function main(args = process.argv.slice(2)) {
  if (!args.includes('--run-installed')) return { executed: false, installedCliProof: false, usage: 'node scripts/native-approval-probe.cjs codex|claude --run-installed' };
  if (![2, 3].includes(args.length) || !['codex', 'claude'].includes(args[0]) || args[1] !== '--run-installed' || args.length === 3 && (args[0] !== 'claude' || !['--questions', '--elicitation'].includes(args[2]))) throw new Error('Usage: node scripts/native-approval-probe.cjs codex|claude --run-installed [--questions|--elicitation (Claude)]');
  return runInstalled(args[0], args[2] === '--questions' ? 'question' : args[2] === '--elicitation' ? 'elicitation' : 'approval');
}
if (require.main === module) main().then(report => { console.log(JSON.stringify(report, null, 2)); if (report.error) process.exitCode = 1; }).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, isolatedEnvironment, cancellationDecision };
