const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const { BILLING_REJECTION } = require('../../conversation-record.cjs');
const seconds = value => count(value) !== null ? count(value * 1000) : null;
function rateLimits(message, previous, scopeId, now) {
  const info = message.type === 'rate_limit_event' ? message.rate_limit_info : null;
  const failed = message.type === 'assistant' && typeof message.error === 'string'
    || message.type === 'result' && (message.is_error === true || message.subtype?.startsWith('error_'));
  if (!info && !failed) return null;
  const text = [message.result, ...(Array.isArray(message.errors) ? message.errors : []), ...(Array.isArray(message.message?.content) ? message.message.content.map(block => block.text) : [])].filter(value => typeof value === 'string').join('\n');
  const spend = info?.errorCode === 'enforced_spend_limit_reached' || /enforced_spend_limit_reached|You have reached your specified API usage limits/i.test(text);
  const code = info?.errorCode === 'credits_required' || message.error === 'billing_error' ? 'credits_required'
    : spend ? 'spend_limit' : info?.status === 'rejected' || message.error === 'rate_limit' ? 'rate_limited' : null;
  if (!info && !code) return null;
  const buckets = { ...previous?.limitsById };
  const reset = seconds(info?.resetsAt) ?? (previous?.notice?.code === code ? previous.notice.resetsAtMs : null);
  if (info?.rateLimitType) buckets[info.rateLimitType] = { primary: {
    usedPercent: Number.isFinite(info.utilization) && info.utilization >= 0 && info.utilization <= 1 ? info.utilization * 100 : null,
    windowDurationMins: info.rateLimitType === 'five_hour' ? 300 : info.rateLimitType.startsWith('seven_day') ? 10080 : null, resetsAtMs: seconds(info.resetsAt) } };
  const line = code === 'credits_required' ? BILLING_REJECTION : code === 'spend_limit' ? 'API 用量已达上限。' : 'API 请求受到限流。';
  const notice = code ? { code, resetsAtMs: reset, message: line, ...(code === 'credits_required' ? { action: 'check-console', url: 'https://platform.claude.com/settings/billing' } : {}) } : null;
  return { scopeId, billingRoute: 'api', observedAtMs: now, state: code ? 'unavailable' : 'ready', limitsById: buckets,
    resetCredits: null, ordinaryUsageAllowed: code ? false : info?.status === 'allowed' || info?.status === 'allowed_warning' ? true : null,
    source: 'claude-sdk', ...(info && ['allowed', 'allowed_warning', 'rejected'].includes(info.status) ? { providerStatus: info.status } : {}), notice };
}
module.exports = { rateLimits };
