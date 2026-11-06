// Opt-in observation of a Codex native TUI. Fresh homes and a loopback model; never answer for the user.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { createStandin } = require('./native-approval-model.cjs');
const { createNativeSession, resolveCli } = require('../scripts/codex-terminal-probe.cjs');

function isolatedEnvironment(home, inherited = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (key.toLowerCase() === 'psmodulepath') { if (value) env.PSModulePath = value; continue; }
    if (['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'lang'].includes(key.toLowerCase())) env[key] = value;
  }
  if (process.platform === 'win32' && !env.PSModulePath) {
    env.PSModulePath = path.join(env.SystemRoot || env.SYSTEMROOT || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/Modules');
  }
  return Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: home, XDG_DATA_HOME: home, CODEX_HOME: path.join(home, 'codex'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
    TERM: 'xterm-256color', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1',
    NO_PROXY: '127.0.0.1,localhost',
  });
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function runInstalled() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-native-probe-'));
  const cwd = path.join(workspace, 'project'), home = path.join(workspace, 'home');
  const env = isolatedEnvironment(home), model = createStandin();
  fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(env.CODEX_HOME, { recursive: true });
  let terminal, observed = false, output = '';
  try {
    await new Promise((resolve, reject) => { model.server.once('error', reject); model.server.listen(0, '127.0.0.1', resolve); });
    env.STANDIN_API_KEY = 'local-standin-only';
    fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), [
      'model = "gpt-6-sol"', 'model_provider = "standin"', 'approval_policy = "on-request"', 'sandbox_mode = "read-only"',
      'check_for_update_on_startup = false', '[model_providers.standin]', 'name = "Local stand-in"',
      'base_url = "http://127.0.0.1:' + model.server.address().port + '/v1"', 'wire_api = "responses"', 'env_key = "STANDIN_API_KEY"',
      '[windows]', 'sandbox = "unelevated"', '[projects.' + JSON.stringify(cwd) + ']', 'trust_level = "trusted"', '',
    ].join('\n'));
    terminal = createNativeSession({ binding: { provider: 'codex', projectId: 'local-probe', terminalId: 'local-probe', sessionId: randomUUID() },
      mode: 'codex-native', cwd, env, cli: resolveCli('codex', env), pty: require('node-pty'),
      event: message => { if (message.method?.endsWith('/requestApproval')) observed = true; },
    });
    terminal.onData(text => { output = (output + text).slice(-65536); if (/\x1b\[6n/.test(text)) terminal.write('\x1b[1;1R'); });
    await delay(4000); terminal.write('NATIVE_REQUEST_PROBE'); await delay(500); terminal.write('\r');
    for (const end = Date.now() + 30000; !observed && !terminal.error && Date.now() < end;) await delay(100);
    await delay(500);
    return { executed: true, installedCliProof: observed && /proceed|approve|permission/i.test(output), requestForwarded: observed,
      hostAnswered: false, workspace, ...(terminal.error ? { error: terminal.error } : {}) };
  } finally {
    terminal?.kill(); model.server.closeAllConnections(); if (model.server.listening) await new Promise(resolve => model.server.close(resolve));
  }
}
async function main(args = process.argv.slice(2)) {
  if (!args.includes('--run-installed')) return { executed: false, installedCliProof: false, usage: 'node scripts/native-approval-probe.cjs codex --run-installed' };
  if (args.length !== 2 || args[0] !== 'codex' || args[1] !== '--run-installed') throw new Error('Usage: node scripts/native-approval-probe.cjs codex --run-installed');
  return runInstalled();
}
if (require.main === module) main().then(report => { console.log(JSON.stringify(report, null, 2)); if (report.error) process.exitCode = 1; }).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, isolatedEnvironment };
