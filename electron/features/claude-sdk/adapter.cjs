const { decide, nameOf } = require('../claude-runtime/decide.cjs');

// Whole sentences are also translation keys. The second includes the retained input.
const LIMIT_SWITCHED = {
  credits_exhausted: ['控制台余额不足，请到 Claude Console 的 Billing 充值。已转到 Claude Code 终端。',
    '控制台余额不足，请到 Claude Console 的 Billing 充值。已转到 Claude Code 终端，未自动发送的消息已保留，请检查终端输入框后继续。'],
  rate_limited: ['API 请求达到速率限制，已转到 Claude Code 终端。',
    'API 请求达到速率限制，已转到 Claude Code 终端，未自动发送的消息已保留，请检查终端输入框后继续。'],
  account_limit: ['Claude 账号或组织的 API 用量已达上限，已转到 Claude Code 终端。',
    'Claude 账号或组织的 API 用量已达上限，已转到 Claude Code 终端，未自动发送的消息已保留，请检查终端输入框后继续。'],
};
const fallbackEnabled = settings => settings.claudePath === 'api-then-terminal';

function select(native, spec, card, settings, options) {
  const facts = native.facts(spec.projectId, card, { running: options.running === true });
  return decide(facts, settings, { owner: spec.owner, trial: spec.apiTrial, ...options });
}

function quotaSwitchNotices(native, spec, card, getSettings) {
  // A rate limit belongs to this card, while credits and account limits belong to the project.
  const facts = native.facts(spec.projectId, card, { running: true });
  const limit = nameOf(decide(facts, {}, { owner: spec.owner, running: true }).reason);
  return fallbackEnabled(getSettings()) && Object.hasOwn(LIMIT_SWITCHED, limit) ? LIMIT_SWITCHED[limit] : null;
}

function observeSubagents(spec, report) {
  spec.onSubagent = (signal, binding) => report(spec, signal, binding);
  spec.onSeat = (observed, binding) => report(spec, { ...observed, kind: 'seat', terminalId: spec.terminalId }, binding);
}

const native = { load: () => require('./index.cjs').createClaudeRuntime };
const nativePolicy = {
  path: 'api',
  transport: 'claude-sdk',
  checkpointOnKeyClear: true,
  observationCommands: ['/context', '/cost', '/status', '/usage'],
  observationUnavailable: 'Claude API 暂时不可用，不能读取。',
  unavailable: 'Claude API 路径当前不可用。',
  select,
  usageFacts: (runtime, projectId) => runtime.facts(projectId),
  usesClaudeAvailability: true,
  configure(spec, getSettings, mayContinue) {
    spec.mayContinue = mayContinue;
    spec.quotaFallback = () => spec.owner !== 'dispatch' && fallbackEnabled(getSettings());
  },
  refresh: runtime => runtime.refreshAvailability?.(),
  claimTrial(native, spec, settings) {
    if (spec.owner !== 'dispatch' && spec.kind !== 'ssh' && fallbackEnabled(settings)) spec.apiTrial = native.claimApiRetry?.(spec.projectId);
  },
  fallbackEnabled,
  fallback(error, settings, starting = false) {
    if (fallbackEnabled(settings) && (error.beforeInput === true || starting && error.code === 'native_cli_required')) return 'terminal';
  },
  quotaSwitchNotices,
  prepareResume: (runtime, options) => runtime.prepareResume(options),
  fileCommands: true,
  observeSubagents,
  bootstrapLead: true,
  nativeConnection: (host, runtime) => runtime.connection(host.nativeRuntimeSessionId),
  terminalConnection: host => ({ kind: 'subscription', source: 'Claude Code terminal login', observedAt: host.activitySince || null }),
};

module.exports = { native, nativePolicy };
