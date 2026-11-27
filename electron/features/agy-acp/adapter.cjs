const { inspectAgy, locateAgy } = require('./locator.cjs');
const { TRANSPORT } = require('./session.cjs');
const { workerManifest } = require('../cli-adapters/workers.cjs');
const { remoteAgyLimits } = require('./usage.cjs');
const { isCatalogModel } = require('./models.cjs');

const remoteMinimum = workerManifest('agy').install.minVersion;
const remoteMessages = {
  agy_cli_required: '远端未找到 Google Antigravity CLI（agy）。请在远端主机自行安装并登录。',
  agy_cli_outdated: '远端 Google Antigravity CLI（agy）版本过低。请在远端主机自行升级后登录。',
  agy_auth_required: '请先在远端主机登录 Google Antigravity CLI（agy）。',
  ssh_worker_outdated: '当前 SSH 连接使用的远端助手不支持 agy。请重新连接 SSH 后再试。',
};

function createInstall(inspect = inspectAgy) {
  let last = null;
  async function locate(env) { return last = await inspect(env); }
  return { locate, refresh: locate, peek: () => last, detect: env => !!locateAgy(env), terminalExecutable: env => last?.file ?? locateAgy(env),
    stateOf: result => ({ ...result, ...(result.file && { fileShown: result.file }) }) };
}

const native = { load: async () => (await import('./index.cjs')).createAgyRuntime };
const nativePolicy = {
  path: 'native',
  transport: TRANSPORT,
  observationCommands: [],
  launchOptions: true,
  historyList: true,
  rememberModelOptions: true,
  isCatalogModel,
  remoteProcessOptions: purpose => ({ purpose, minimumVersion: remoteMinimum }),
  remoteQuotaUnavailable: '暂时无法读取远端 agy 的额度。',
  remoteLimits: remoteAgyLimits,
  remoteHistoryError: error => remoteMessages[error.code],
  missingResume: '没有找到可恢复的 Google Antigravity CLI（agy）会话，请开始新的对话。',
  restoreWithoutNative: 'Google Antigravity CLI（agy）原生模式连接失败，请重试。',
  permissions: settings => ({ permissions: settings?.agyPermissions ?? 'full' }),
  ownerContext: (spec, { roleTools, notes }) => ({
    ...notes.startup(spec.context).config, ...(spec.roleServer && roleTools.config(spec.roleServer)),
  }),
  newConversationIdentity: started => started.providerSessionId,
  startupCode: 'agy_start_failed',
  startupMessage: (error, spec) => (spec?.kind === 'ssh' && remoteMessages[error.code]) || ({
    agy_cli_required: '未找到 Google Antigravity CLI（agy）。',
    agy_cli_outdated: 'Google Antigravity CLI（agy）版本过低，请升级后重试。',
    agy_auth_required: '请先登录 Google Antigravity CLI（agy）。',
    agy_role_server_conflict: '项目的 MCP 配置已占用 Agentrix 的角色工具名称 agentrix_role。',
    agy_session_in_use: '该 Antigravity 会话正在其他终端运行。',
  })[error.code] || (spec?.providerSessionId ? '无法续接 Google Antigravity CLI（agy）会话，请重试或开始新的对话。'
    : '无法启动 Google Antigravity CLI（agy）会话。'),
};

async function modelProbe(host, cwd, installed) {
  if (!installed()) return null;
  const createAgyRuntime = await native.load();
  return createAgyRuntime({ dataDir: host.dataDir ?? host.app?.getPath('userData'), spawnProcess: host.spawn, report: host.report })
    .models({ cwd, env: host.process?.env }).catch(error => {
      const catalogCode = { agy_auth_required: 'auth_required', agy_cli_required: 'cli_required', agy_cli_outdated: 'cli_outdated' }[error.code];
      throw Object.assign(error, { catalogCode });
    });
}

module.exports = { createInstall, modelProbe, native, nativePolicy };
