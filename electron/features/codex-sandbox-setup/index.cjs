const { spawn } = require('node:child_process');
const { homedir } = require('node:os');
const path = require('node:path');
const { createRpc, stopProcess, workerEnvironment } = require('../codex-app-server/index.cjs');
const { runSetup } = require('./elevate.cjs');

async function readiness(file, { cwd, env }, { launch = spawn, rpcFactory = createRpc, stop = stopProcess } = {}) {
  const args = ['app-server', '--listen', 'stdio://', '-c', 'windows.sandbox=elevated'];
  const options = { cwd, env: workerEnvironment(env), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };
  let child, rpc;
  try {
    if (/\.cmd$/i.test(file)) {
      // Use argv data through a single quoted variable expansion, as in the setup command.
      const cmd = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
      options.env.AGENTRIX_SETUP_CLI = file;
      options.windowsVerbatimArguments = true;
      child = launch(cmd, ['/d', '/v:off', '/s', '/c', '""%AGENTRIX_SETUP_CLI%" ' + args.join(' ') + '"'], options);
    } else {
      child = launch(file, args, options);
    }
    rpc = rpcFactory(child);
    await rpc.request('initialize', { clientInfo: { name: 'agentrix-sandbox-setup', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    rpc.notify('initialized');
    const result = await rpc.request('windowsSandbox/readiness', {});
    return result?.status ?? null;
  } finally {
    rpc?.close();
    await stop(child);
  }
}

function createSandboxSetup({ platform = process.platform, find, cwd, env = process.env, show, t, active,
  check = readiness, setup = runSetup }) {
  let checked = false;
  const title = () => t('Codex 角色沙箱');
  const tell = (type, message) => active() && show({ type, title: title(), message: t(message), buttons: [t('关闭')] });
  return async function offer() {
    if (platform !== 'win32' || checked || !active()) return;
    try {
      const file = await find();
      if (!file || checked || !active()) return;
      checked = true;
      const status = await check(file, { cwd, env });
      if ((status !== 'notConfigured' && status !== 'updateRequired') || !active()) return;
      // Settings uses the same Chinese label as a noun.
      const setupLabel = t('设置（Codex 沙箱）').replace('（Codex 沙箱）', '');
      const { response } = await show({ type: 'question', title: title(),
        message: t('Agentrix 的 Codex 角色需要管理员批准，才能完成一次性的 Windows 沙箱设置。'),
        buttons: [setupLabel, t('以后再说')], defaultId: 0, cancelId: 1 });
      if (response !== 0 || !active()) return;
      const home = env.CODEX_HOME || path.win32.join(env.USERPROFILE || env.HOME || homedir(), '.codex');
      const result = await Promise.resolve().then(() => setup(file, home, env)).catch(() => 'failed');
      if (result === 'invalidHome') {
        await tell('info', 'Codex 主目录必须是本机的绝对路径，沙箱设置已跳过。');
        return;
      }
      if (!active()) return;
      const ready = await Promise.resolve().then(() => check(file, { cwd, env })).catch(() => null) === 'ready';
      if (result === 'succeeded' && ready) await tell('info', 'Codex 沙箱已设置完成。');
      else if (result === 'declined') await tell('info', '管理员批准已取消，Agentrix 下次启动时会再次询问。');
      else await tell('warning', '未能完成 Codex 沙箱设置，Agentrix 下次启动时会再次询问。');
    } catch { /* Missing CLI, unsupported readiness or a closing window do not require startup UI. */ }
  };
}

module.exports = { createSandboxSetup, readiness };
