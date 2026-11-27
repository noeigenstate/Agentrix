const REMOTE_MISSING = '远端未找到 Codex 程序。请在远端登录 shell 中安装 Codex，并确认 type -P codex 能找到它。';
const START_FAILED = 'Codex app-server 连接失败，请重试。';

function startupMessage(error, spec) {
  const reason = error.code || error.message;
  // The runtime knows which sandbox it asked for and which sandbox it received.
  if (reason === 'sandbox_mismatch') return error.message;
  if (['codex_cli_required', 'ENOENT'].includes(reason)) return spec.kind === 'ssh' ? REMOTE_MISSING : '未找到 Codex 程序，请在设置中安装。';
  if (reason === 'unsupported_codex_version') return 'Codex 版本过低，请升级后重试。';
  return START_FAILED + (error.detail ? `原因：${error.detail}` : '');
}

async function readNativeConnection(host) {
  let connection;
  try { connection = await host.nativeReadConnection?.(); } catch { }
  return connection || { kind: 'unknown', source: 'codex-app-server account/read', observedAt: null };
}

function terminalConnection(host) {
  // Quota alone proves neither billing path. The reader's account name goes with its observed kind.
  const connection = host.terminalAccount?.connection;
  const kind = ['api', 'subscription'].includes(connection?.kind) ? connection.kind : 'unknown';
  return { kind, source: 'codex-account-usage', observedAt: host.terminalAccount?.at || null,
    ...(kind !== 'unknown' && connection.scopeId ? { scopeId: connection.scopeId } : {}) };
}

const native = { load: async () => (await import('./index.cjs')).createCodexRuntime };
const nativePolicy = {
  path: 'native',
  transport: 'codex-app-server',
  observationCommands: ['/status', '/usage'],
  canContinueInterrupted: true,
  trackShellInput: true,
  launchOptions: true,
  shellHome: true,
  missingResume: '没有找到可恢复的 Codex 会话，请使用 codex 开始新会话。',
  newConversationIdentity: started => started.providerSessionId,
  permissions: settings => ({ permissions: settings.codexPermissions }),
  envSeats: dispatchSnapshot => dispatchSnapshot ?? 'null',
  startupMessage,
  startupCode: 'codex_start_failed',
  invalidateResume: error => error.stage === 'thread_resume' && error.missingThread,
  structuredHistory: true,
  remoteHistoryError: error => error.code === 'codex_cli_required' ? REMOTE_MISSING : null,
  restoreWithoutNative: 'Codex 原生模式连接失败，请重试。',
  readNativeConnection,
  terminalConnection,
};

module.exports = { native, nativePolicy };
