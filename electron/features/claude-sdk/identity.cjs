const { stderrTail } = require('../agents/start-failure.cjs');
const sources = new Set(['ANTHROPIC_API_KEY', 'apiKeyHelper', '/login managed key', 'none', 'user', 'project', 'org', 'temporary', 'oauth']);
const billingSource = source => sources.has(source) ? source : null;
// A name the CLI reported is echoed only when it is one of the values Claude Code is known to report; any other
// becomes 'unknown', so nothing the CLI printed in its place reaches the owner.
const REPORTED = new Set([...sources, 'claude.ai', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']);
const reportedName = value => value == null ? null : REPORTED.has(value) ? value : 'unknown';
const identityFailures = new WeakSet();
const routeFailures = new WeakSet();

function routeFailure(code, file) {
  const message = code === 'user_api_key_override'
    ? 'Claude 用户设置不能覆盖应用保存的 API 密钥。请删除用户 settings.json 中的 env.ANTHROPIC_API_KEY，或改用终端。'
    : code === 'project_api_key_override'
    ? `项目 Claude 配置 ${file} 不能覆盖应用保存的 API 密钥。请删除其中的 env.ANTHROPIC_API_KEY，或改用终端。`
    : `无法安全读取 Claude 路由配置 ${file}。请缩小文件或改用终端。`;
  const error = Object.assign(new Error(message), { code, beforeInput: true });
  routeFailures.add(error); return error;
}

const whyText = ({ text, values }) => text.replace(/\{(\w+)\}/g, (match, name) => name in values ? String(values[name]) : match);
// What the owner can check for each credential Claude Code reported in place of the saved key, as a template the view
// translates; the first match wins. The native API channel clears a user apiKeyHelper and ANTHROPIC_AUTH_TOKEN in its
// flag settings (proved against the real 2.1.322: the init then reports tokenSource=none and requests carry only the
// key), so either one still reported comes from a managed policy, which outranks flag settings.
const MISMATCHES = [
  [({ apiKeySource, tokenSource }) => tokenSource === 'apiKeyHelper' || apiKeySource === 'apiKeyHelper',
    'Claude Code 的托管策略配置了 apiKeyHelper，它优先于 Agentrix 的设置，请求会带上它给出的凭据，费用不一定记在这个密钥上。请联系管理员，或改用终端。（{detail}）'],
  [({ tokenSource }) => tokenSource === 'ANTHROPIC_AUTH_TOKEN',
    'Claude Code 的托管策略设置了 ANTHROPIC_AUTH_TOKEN，它会覆盖这个密钥。请联系管理员，或改用终端。（{detail}）'],
  [({ apiKeySource }) => apiKeySource === '/login managed key',
    'Claude Code 用的是 /login 登录 Anthropic 控制台时保存的密钥，不是这个密钥。请在 Claude Code 里退出这个登录后重试。（{detail}）'],
  [({ apiKeySource }) => apiKeySource === 'none',
    'Claude Code 没有使用 API 密钥，可能在用 claude.ai 登录或云服务商的凭据。请检查 Claude Code 的登录方式和环境变量。（{detail}）'],
  [({ apiKeySource }) => apiKeySource == null, 'Claude Code 没有报告计费来源，可能版本太旧。请升级 Claude Code 后重试。（{detail}）'],
  [() => true, 'Claude Code 报告的计费来源不是 ANTHROPIC_API_KEY。请检查 Claude Code 的设置和环境变量。（{detail}）'],
];
const mismatchWhy = (reported, detail) => ({ text: MISMATCHES.find(([matches]) => matches(reported))[1], values: { detail } });

function billingIdentityError(source, { beforeInput = false, messageType, tokenSource } = {}) {
  const reported = { apiKeySource: reportedName(source), tokenSource: reportedName(tokenSource) };
  let detail = messageType
    ? `message before init=${['assistant', 'result'].includes(messageType) ? messageType : 'unknown'}`
    : `apiKeySource=${reported.apiKeySource ?? 'missing'}`;
  if (['apiKeyHelper', 'ANTHROPIC_AUTH_TOKEN'].includes(tokenSource)) detail += `; tokenSource=${tokenSource}`;
  const why = messageType ? { text: 'Claude API 计费身份不符（{detail}）。', values: { detail } } : mismatchWhy(reported, detail);
  const error = Object.assign(new Error(whyText(why)), { code: 'billing_identity_mismatch', beforeInput, source: billingSource(source), reported, why });
  identityFailures.add(error); return error;
}

// Why a start failed before any input, from the SDK error's own fields (errorClass, exitCode, signal; an errno code
// for a process that never ran), the redacted end of the stderr the caller collected, or the SDK's own error in one
// redacted line. The saved key never appears.
function startWhy(error, stderr, key) {
  // The saved key, and anything shaped like an Anthropic key, before the shared redaction.
  const scrub = text => (key ? String(text).split(key).join('<key>') : String(text)).replace(/sk-ant-[\w-]+/gi, '<key>');
  if (error?.code === 'sdk_initialization_timeout') {
    return { text: 'Claude Code 初始化 {seconds} 秒仍未完成，尚未发送消息。请稍后重试。', values: { seconds: Math.max(1, Math.round((error.elapsedMs ?? 0) / 1000)) } };
  }
  const tail = stderrTail(scrub(stderr)), output = tail ? '，尚未发送消息。错误输出：{stderr}' : '，尚未发送消息，也没有错误输出。';
  if (error?.errorClass === 'process_exited_nonzero' && Number.isInteger(error.exitCode)) {
    return { text: `Claude Code 启动后退出（退出码 {code}）${output}`, values: { stderr: tail, code: error.exitCode } };
  }
  if (error?.errorClass === 'process_killed_by_signal' && typeof error.signal === 'string') {
    return { text: `Claude Code 启动后被终止（信号 {signal}）${output}`, values: { stderr: tail, signal: error.signal } };
  }
  if (typeof error?.code === 'string' && /^E[A-Z0-9]{2,20}$/.test(error.code)) {
    return { text: `Claude Code 没能启动（{code}）${output}`, values: { stderr: tail, code: error.code } };
  }
  const detail = stderrTail(scrub(error?.message || ''), { limit: 200 });
  return detail ? { text: 'Claude Agent SDK 出错，尚未发送消息：{detail}', values: { detail } } : { text: 'Claude Code 没能启动，尚未发送消息。', values: {} };
}

// A start failure the owner can read: identity and route failures as they are, anything else with its cause (`why`).
// The code and beforeInput, which decide a fallback to the terminal, are the same whatever the cause.
function startupFailure(error, { stderr = '', key = null } = {}) {
  if (identityFailures.has(error) || routeFailures.has(error)) return error;
  if (['route_config_unreadable', 'project_api_key_override', 'user_api_key_override'].includes(error?.code)) {
    const message = error.code === 'user_api_key_override' ? 'Claude 用户设置不能覆盖应用保存的 API 密钥。'
      : error.code === 'project_api_key_override' ? '项目 Claude 配置不能覆盖应用保存的 API 密钥。' : '无法读取 Claude 路由配置。';
    return Object.assign(new Error(message), { code: error.code, beforeInput: true });
  }
  const why = startWhy(error, stderr, key);
  return Object.assign(new Error(whyText(why)), {
    code: error?.code === 'sdk_initialization_timeout' ? 'sdk_initialization_timeout' : 'sdk_startup_failed', beforeInput: true, why,
  });
}

module.exports = { billingIdentityError, billingSource, startupFailure, routeFailure, whyText };
