const path = require('node:path');
const fs = require('node:fs/promises');
const { setTimeout: sleep } = require('node:timers/promises');
const { withSandboxServer, readiness } = require('../codex-app-server/index.cjs');
const { REFRESH_LIMIT, WAIT_MESSAGE, readRefresh, sandboxCwd, sandboxHome } = require('../codex-app-server/sandbox-refresh.cjs');
const { runSetup } = require('./elevate.cjs');

async function hasSetupMarker(home) {
  try {
    const file = path.join(home, '.sandbox', 'setup_marker.json');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 4096) return false;
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(4097);
      const { bytesRead } = await handle.read(buffer);
      return bytesRead <= 4096 && Number.isSafeInteger(JSON.parse(buffer.toString('utf8', 0, bytesRead))?.version);
    } finally { await handle.close(); }
  } catch { return false; }
}

async function finishRefresh(file, { cwd, env, home, active }, { now = Date.now, pause = sleep, read = readRefresh, ...server } = {}) {
  const until = now() + REFRESH_LIMIT;
  const timer = new AbortController();
  const timeout = sleep(REFRESH_LIMIT, false, { signal: timer.signal }).catch(() => false);
  const working = withSandboxServer(file, { cwd, env }, server, async rpc => {
    let commandEnded = false, since;
    const remaining = until - now();
    const waiting = () => active() && !timer.signal.aborted && now() < until;
    if (remaining <= 0 || !waiting()) return false;
    // This fixed, offline command requests a refresh without creating a thread or model turn.
    void sandboxCwd(rpc, cwd, env, undefined, remaining, { onWritten: () => { since = now(); } })
      .catch(() => {}).finally(() => { commandEnded = true; });
    while (waiting()) {
      if (commandEnded && since === undefined) return false;
      const latest = since === undefined ? null : await read(home, since, now());
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
  dismissed = () => false, dismiss = () => {}, progress = () => {}, check = readiness, setup = runSetup, finish = finishRefresh,
  defer = () => sleep(30_000, undefined, { ref: false }) }) {
  let checked = false;
  const title = () => t('Codex 角色沙箱');
  const tell = (type, message) => active() && show({ type, title: title(), message: t(message), buttons: [t('关闭')] });
  return async function offer() {
    if (platform !== 'win32' || checked || dismissed() || !active()) return;
    checked = true;
    try {
      const home = sandboxHome(env);
      // A marker changes only when to ask. Codex validates its version and account file.
      if (await hasSetupMarker(home)) await defer();
      if (dismissed() || !active()) return;
      const file = await find();
      if (!file) { checked = false; return; }
      if (dismissed() || !active()) return;
      const status = await check(file, { cwd, env });
      if ((status !== 'notConfigured' && status !== 'updateRequired') || dismissed() || !active()) return;
      const locations = [t('Codex 程序：{file}', { file }), t('Codex 主目录：{home}', { home })].join('\n');
      const detail = [
        locations,
        t('设置会修改你自己的 Codex 配置，让所有 Codex 会话默认使用 Windows 提权沙箱，并创建两个本地沙箱账户。'),
        t('Windows 会请求批准运行「Windows PowerShell」。如果你没有管理员权限，需要请管理员批准。'),
        t('完成设置前，这台电脑无法启动 Codex 角色。Claude 角色仍可启动。'),
      ].join('\n\n');
      const { response } = await show({ type: 'question', title: title(),
        message: t('Agentrix 的 Codex 角色需要管理员批准，才能完成一次性的 Windows 沙箱设置。'),
        detail, buttons: [t('设置（Codex 沙箱）').replace('（Codex 沙箱）', ''), t('以后再说'), t('不再提示')], defaultId: 1, cancelId: 1 });
      if (response === 2) { dismiss(); return; }
      if (response !== 0 || !active()) return;
      const result = await Promise.resolve().then(() => setup(file, home, env)).catch(() => 'failed');
      if (result === 'invalidHome') {
        await tell('info', 'Codex 主目录必须是本机的绝对路径，且不能是驱动器根目录或经过重解析点。沙箱设置已跳过。');
        return;
      }
      if (result === 'unverified') {
        await tell('warning', '无法验证 Codex 程序。请在管理员终端中运行 codex sandbox setup --elevated --current-user。');
        return;
      }
      if (!active()) return;
      if (result === 'succeeded' && await Promise.resolve().then(() => check(file, { cwd, env })).catch(() => null) === 'ready') {
        if (!active()) return;
        progress(t(WAIT_MESSAGE));
        let finished;
        try { finished = await finish(file, { cwd, env, home, active }); }
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
