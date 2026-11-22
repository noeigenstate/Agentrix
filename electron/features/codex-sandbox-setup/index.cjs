const { spawn } = require('node:child_process');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { createRpc, stopProcess, workerEnvironment } = require('../codex-app-server/index.cjs');
const { ELEVATED_SANDBOX_ARGS, REFRESH_LIMIT, WAIT_MESSAGE, readRefresh, sandboxCwd, sandboxHome } = require('../codex-app-server/sandbox-refresh.cjs');
const { runSetup } = require('./elevate.cjs');

async function withServer(file, { cwd, env }, { launch = spawn, rpcFactory = createRpc, stop = stopProcess } = {}, query, refresh = false) {
  const args = ['app-server', '--listen', 'stdio://', ...ELEVATED_SANDBOX_ARGS];
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
    return await query(rpc);
  } finally {
    rpc?.close();
    // The ACL worker may still be running when the UI deadline expires.
    if (refresh) await stop(child, { preserveDescendants: true });
    else await stop(child);
  }
}

async function readiness(file, context, deps) {
  const result = await withServer(file, context, deps, rpc => rpc.request('windowsSandbox/readiness', {}));
  return result?.status ?? null;
}

async function finishRefresh(file, { cwd, env, home, since, active }, { now = Date.now, pause = sleep, read = readRefresh, ...server } = {}) {
  const until = now() + REFRESH_LIMIT;
  const timer = new AbortController();
  const timeout = sleep(REFRESH_LIMIT, false, { signal: timer.signal }).catch(() => false);
  const working = withServer(file, { cwd, env }, server, async rpc => {
    let commandEnded = false;
    const remaining = until - now();
    const waiting = () => active() && !timer.signal.aborted && now() < until;
    if (remaining <= 0 || !waiting()) return false;
    // This fixed, offline command requests a refresh without creating a thread or model turn.
    void sandboxCwd(rpc, cwd, env, undefined, remaining).catch(() => {}).finally(() => { commandEnded = true; });
    while (waiting()) {
      const latest = await read(home, since, now());
      if (!waiting()) return false;
      if (commandEnded && latest?.status === 'complete') return true;
      await pause(Math.max(0, Math.min(1000, until - now())));
    }
    return false;
  }, true);
  try { return await Promise.race([timeout, working]); }
  finally { timer.abort(); }
}

function createSandboxSetup({ platform = process.platform, find, cwd, env = process.env, show, t, active,
  progress = () => {}, check = readiness, setup = runSetup, finish = finishRefresh, now = Date.now }) {
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
      const home = sandboxHome(env);
      const since = now();
      const result = await Promise.resolve().then(() => setup(file, home, env)).catch(() => 'failed');
      if (result === 'invalidHome') {
        await tell('info', 'Codex 主目录必须是本机的绝对路径，沙箱设置已跳过。');
        return;
      }
      if (!active()) return;
      const ready = await Promise.resolve().then(() => check(file, { cwd, env })).catch(() => null) === 'ready';
      if (result === 'succeeded' && ready) {
        if (!active()) return;
        progress(t(WAIT_MESSAGE));
        let finished;
        try { finished = await finish(file, { cwd, env, home, since, active }); }
        catch { finished = false; }
        finally { if (active()) progress(null); }
        await tell('info', finished ? 'Codex 沙箱授权已完成，可以启动角色了。' : 'Codex 沙箱授权仍在完成中，请稍后再试。');
      }
      else if (result === 'declined') await tell('info', '管理员批准已取消，Agentrix 下次启动时会再次询问。');
      else await tell('warning', '未能完成 Codex 沙箱设置，Agentrix 下次启动时会再次询问。');
    } catch { /* Missing CLI, unsupported readiness or a closing window do not require startup UI. */ }
  };
}

module.exports = { createSandboxSetup, readiness, finishRefresh };
