const sources = new Set(['ANTHROPIC_API_KEY', 'apiKeyHelper', '/login managed key', 'none', 'user', 'project', 'org', 'temporary', 'oauth']);
const billingSource = source => sources.has(source) ? source : null;
const identityFailures = new WeakSet();

function billingIdentityError(source, { beforeInput = false, messageType, tokenSource } = {}) {
  let detail = messageType
    ? `message before init=${['assistant', 'result'].includes(messageType) ? messageType : 'unknown'}`
    : `apiKeySource=${sources.has(source) ? source : source == null ? 'missing' : 'unknown'}`;
  if (['apiKeyHelper', 'ANTHROPIC_AUTH_TOKEN'].includes(tokenSource)) detail += `; tokenSource=${tokenSource}`;
  const error = Object.assign(new Error(`Claude API 计费身份不符（${detail}）。`), {
    code: 'billing_identity_mismatch', beforeInput, source: billingSource(source),
  });
  identityFailures.add(error); return error;
}

function startupFailure(error) {
  if (identityFailures.has(error)) return error;
  const timeout = error?.code === 'sdk_initialization_timeout';
  return Object.assign(new Error(timeout ? 'Claude API 初始化超时，尚未发送消息。' : 'Claude API 启动失败，尚未发送消息。'), {
    code: timeout ? 'sdk_initialization_timeout' : 'sdk_startup_failed', beforeInput: true,
  });
}

module.exports = { billingIdentityError, billingSource, startupFailure };
