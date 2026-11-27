const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRpc } = require('../../shared/stdio-rpc.cjs');
const { workerLocalModel: localModel, workerModelKey } = require('../cli-adapters/workers.cjs');
const { stopProcess } = require('../codex-app-server/index.cjs');
const { cliEnvironment, supportedExecutable } = require('./locator.cjs');

const SESSION_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ROLE_SERVER = 'agentrix_role';
const ROLE_TOOL = 'mcp_agentrix_role_finish_role';
const errorWithCode = (code, message = code) => Object.assign(new Error(message), { code });
const config = (options, id) => Array.isArray(options) ? options.find(option => option?.id === id) : undefined;
const TRANSPORT = 'agy-acp';
const modelKey = model => model ? workerModelKey(model, 'agy') : null;

function profileOf(dataDir, env) {
  const root = dataDir || env.AGENTRIX_DATA_DIR;
  if (!root) throw errorWithCode('agy_data_dir_required');
  return path.resolve(root, 'agy', 'role');
}

function createConnection({ spawnProcess = spawn, resolveExecutable = supportedExecutable, stopChild = stopProcess, onTreeStopFailure, launchRemote } = {}) {
  async function launchLocal({ profile, cwd, env = process.env, checkOpen }) {
    const file = await resolveExecutable(env);
    if (!file) throw errorWithCode('agy_cli_required');
    if (profile) await fs.mkdir(profile, { recursive: true });
    checkOpen?.();
    return { cwd, child: spawnProcess(file, profile ? ['acp', '--gemini-dir', profile] : ['acp'], {
      cwd, env: cliEnvironment(env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
    }) };
  }
  return async ({ spec, purpose, signal, rpcTimeoutMs, onRequest, onNotification, onDisconnect, onDropped, ...local }) => {
    const remote = spec?.kind === 'ssh';
    const launched = remote ? await launchRemote(spec, { signal, readOnly: purpose !== 'session', purpose }) : await launchLocal(local);
    const { child } = launched;
    const rpc = createRpc(child, { jsonrpc: true, timeout: rpcTimeoutMs, onRequest, onNotification, onDisconnect, onDropped,
      errorDetails: error => error.code === -32000 && /auth|log.?in|sign.?in/i.test(error.message || '') ? { code: 'agy_auth_required' } : {} });
    const stopProcess = async () => {
      rpc.close();
      if (remote) {
        try { await child.stop(); }
        finally { child.dispose(); }
      } else await stopChild(child, { onTreeStopFailure });
    };
    if (remote) {
      const abort = () => child.dispose();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      try { await child.opened; }
      catch (error) { rpc.close(); child.dispose(); throw error; }
      finally { signal?.removeEventListener('abort', abort); }
    }
    let stop;
    return { ...launched, rpc, pid: child.pid, close: () => stop ??= Promise.resolve().then(stopProcess) };
  };
}

async function projectExtensions(cwd) {
  const folder = path.join(cwd, '.agents');
  const hooks = await fs.stat(path.join(folder, 'hooks.json')).then(stat => stat.isFile(), () => false);
  let names = [];
  try {
    const config = JSON.parse((await fs.readFile(path.join(folder, 'mcp_config.json'), 'utf8')).replace(/^\uFEFF/, ''));
    if (config?.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)) names = Object.keys(config.mcpServers);
  } catch { /* The CLI handles unreadable or invalid project configuration. */ }
  if (names.some(name => name.toLowerCase() === ROLE_SERVER)) {
    throw errorWithCode('agy_role_server_conflict', 'The project MCP server agentrix_role conflicts with Agentrix role tools.');
  }
  return { hooks, mcp: names.length > 0 };
}

async function initialize(rpc, version = '0.0.0') {
  const result = await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'Agentrix', title: 'Agentrix', version } });
  if (result?.protocolVersion !== 1) throw errorWithCode('agy_unsupported_protocol');
  return result;
}

async function openSession(rpc, spec, resumed = false) {
  const sessionId = resumed ? spec.providerSessionId : null;
  if (resumed && !SESSION_ID.test(sessionId)) throw errorWithCode('agy_invalid_session');
  const params = { cwd: spec.cwd, mcpServers: spec.mcpServers ?? [] };
  if (resumed) params.sessionId = sessionId;
  else if (spec._meta) params._meta = spec._meta;
  const method = !resumed ? 'session/new' : spec.owner === 'gui' ? 'session/load' : 'session/resume';
  const result = await rpc.request(method, params);
  const id = result?.sessionId ?? sessionId;
  if (!SESSION_ID.test(id) || resumed && id !== sessionId) throw errorWithCode('agy_invalid_session');
  return { ...result, sessionId: id };
}

async function setConfig(rpc, sessionId, configId, value) {
  const response = await rpc.request('session/set_config_option', { sessionId, configId, value });
  if (!Array.isArray(response?.configOptions) || config(response.configOptions, configId)?.currentValue !== value)
    throw errorWithCode('agy_config_mismatch');
  return response.configOptions;
}

async function configure(rpc, session, spec, applied = () => {}) {
  let options = session.configOptions;
  const select = async (id, value) => {
    options = await setConfig(rpc, session.sessionId, id, value);
    applied(options);
  };
  const model = spec.model && localModel(spec.model);
  if (model && model !== 'default') await select('model', model);
  const effort = config(options, 'thought_level');
  if (effort?.options?.length && spec.effort && spec.effort !== 'default') await select('thought_level', spec.effort);
  if (config(options, 'mode')?.currentValue !== 'default') await select('mode', 'default');
  if (config(options, 'mode')?.currentValue !== 'default') throw errorWithCode('agy_config_mismatch');
  return options;
}

function effectiveOptions(options) {
  const appliedEffort = config(options, 'thought_level');
  return { model: modelKey(config(options, 'model')?.currentValue), effort: appliedEffort?.options?.length ? appliedEffort.currentValue : null, fast: false };
}

module.exports = {
  SESSION_ID, ROLE_SERVER, ROLE_TOOL, TRANSPORT, errorWithCode, config, modelKey, profileOf, createConnection, projectExtensions, initialize, openSession, setConfig, configure,
  effectiveOptions,
};
