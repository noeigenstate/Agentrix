const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const { LIMIT_MESSAGES, creditsLow } = require('./identity.cjs');
const seconds = value => count(value) !== null ? count(value * 1000) : null;
const refusalReason = code => ({ credits_required: 'credits_exhausted', rate_limited: 'rate_limited', spend_limit: 'account_limit' })[code];
function rateLimits(message, previous, scopeId, now) {
  const info = message.type === 'rate_limit_event' ? message.rate_limit_info : null;
  const failed = message.type === 'assistant' && typeof message.error === 'string'
    || message.type === 'result' && (message.is_error === true || message.subtype?.startsWith('error_'));
  if (!info && !failed) return null;
  const text = [message.result, ...(Array.isArray(message.errors) ? message.errors : []), ...(Array.isArray(message.message?.content) ? message.message.content.map(block => block.text) : [])].filter(value => typeof value === 'string').join('\n');
  const spend = ['enforced_spend_limit_reached', 'spend_limit'].includes(info?.errorCode) || /enforced_spend_limit_reached|You have reached your specified API usage limits/i.test(text);
  const balance = creditsLow(text);
  let code = null;
  if (spend || message.error === 'spend_limit') code = 'spend_limit';
  else if (info?.errorCode === 'credits_required' || message.error === 'billing_error' || balance) code = 'credits_required';
  else if (info?.status === 'rejected' || message.error === 'rate_limit') code = 'rate_limited';
  if (!info && !code) return null;
  const buckets = { ...previous?.limitsById };
  const reset = seconds(info?.resetsAt) ?? (previous?.notice?.code === code ? previous.notice.resetsAtMs : null);
  let windowDurationMins = null, ordinaryUsageAllowed = null;
  if (info?.rateLimitType === 'five_hour') windowDurationMins = 300;
  else if (info?.rateLimitType?.startsWith('seven_day')) windowDurationMins = 10080;
  if (code) ordinaryUsageAllowed = false;
  else if (['allowed', 'allowed_warning'].includes(info?.status)) ordinaryUsageAllowed = true;
  if (info?.rateLimitType) buckets[info.rateLimitType] = { primary: {
    usedPercent: Number.isFinite(info.utilization) && info.utilization >= 0 && info.utilization <= 1 ? info.utilization * 100 : null,
    windowDurationMins, resetsAtMs: seconds(info.resetsAt) } };
  const line = LIMIT_MESSAGES[refusalReason(code)];
  const notice = code ? { code, resetsAtMs: reset, message: line, ...(code === 'credits_required' ? { action: 'check-console', url: 'https://platform.claude.com/settings/billing' } : {}) } : null;
  return { scopeId, billingRoute: 'api', observedAtMs: now, state: code ? 'unavailable' : 'ready', limitsById: buckets,
    resetCredits: null, ordinaryUsageAllowed,
    source: 'claude-sdk', ...(info && ['allowed', 'allowed_warning', 'rejected'].includes(info.status) ? { providerStatus: info.status } : {}), notice };
}
module.exports = { rateLimits, refusalReason };
