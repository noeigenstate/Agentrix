// A local view of provider-reported state, handed to the owner's popup and never written to the conversation. Missing
// values stay null (the popup says unknown); token counts are never estimated from text or summed twice with reasoning tokens.
const text = value => typeof value === 'string' && value ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function statusPanel({ options, thread, cwd, usage, account, limits, errors }, t = value => value) {
  const tier = typeof options.fast === 'boolean' ? options.fast : ['fast', 'priority'].includes(thread.serviceTier) ? true : thread.serviceTier === 'default' ? false : null;
  const total = count(usage?.input) !== null && count(usage?.output) !== null ? usage.input + usage.output : null;
  const buckets = limits?.limitsById || {};
  const windows = (buckets.codex ? [buckets.codex] : Object.values(buckets)).flatMap(bucket => [bucket?.primary, bucket?.secondary]).filter(Boolean);
  const quota = (id, minutes) => {
    const window = windows.find(value => value.windowDurationMins === minutes), at = count(window?.resetsAtMs);
    return { id, usedPercent: Number.isFinite(window?.usedPercent) ? window.usedPercent : null, resetsAtMs: at !== null && Number.isFinite(new Date(at).getTime()) ? at : null };
  };
  const reason = error => Number.isInteger(error.code) ? `RPC ${error.code}` : t(['timeout', 'rpc_timeout'].includes(error.code) ? '请求超时' : ['closed', 'disconnected', 'process_exited'].includes(error.code) ? '连接已断开' : '原因未知');
  return {
    session: { model: text(options.model), effort: text(options.effort), fast: tier, cwd: text(cwd), sandbox: text(thread.sandbox?.type),
      approval: text(thread.approvalPolicy) ?? (thread.approvalPolicy?.granular ? 'granular' : null) },
    account: { provider: text(thread.modelProvider), kind: ['api', 'subscription', 'none'].includes(account?.kind) ? account.kind : 'unknown' },
    tokens: { total, input: count(usage?.input), output: count(usage?.output), cachedInput: count(usage?.cachedInput), reasoning: count(usage?.reasoning),
      context: count(usage?.contextTokens), window: count(usage?.contextWindow) },
    limits: [quota('5h', 300), quota('week', 10080)],
    errors: errors.map(([source, error]) => ({ source: source === 'account/read' ? 'account' : 'limits', reason: reason(error) })),
  };
}
module.exports = { statusPanel };
