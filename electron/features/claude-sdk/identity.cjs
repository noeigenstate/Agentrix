const sources = new Set(['ANTHROPIC_API_KEY', 'apiKeyHelper', '/login managed key', 'none', 'user', 'project', 'org', 'temporary', 'oauth']);
const billingSource = source => sources.has(source) ? source : null;

function billingIdentityError(source, { beforeInput = false, messageType } = {}) {
  const detail = messageType
    ? `message before init=${['assistant', 'result'].includes(messageType) ? messageType : 'unknown'}`
    : `apiKeySource=${sources.has(source) ? source : source == null ? 'missing' : 'unknown'}`;
  return Object.assign(new Error(`Claude API 计费身份不符（${detail}）。`), {
    code: 'billing_identity_mismatch', beforeInput, source: billingSource(source),
  });
}

module.exports = { billingIdentityError, billingSource };
