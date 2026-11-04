const https = require('node:https');
const fs = require('node:fs');
const { createPolicy } = require('./policy.cjs');
const { billingSource, billingIdentityError } = require('./identity.cjs');
const { inputQueue, queryOptions, readBillingIdentity } = require('./query.cjs');
const required = '2.1.317';
const details = { ok: 'API 密钥验证成功。', missing: '还没有保存 API key。', invalid: 'API 密钥无效。',
  forbidden: 'API 密钥没有模型列表权限。', rate_limited: 'API 请求被限流，请稍后重试。',
  unreachable: '无法连接 Anthropic API。', error: '无法完成 API 连接检查。' };

function listModels(key, { request = https.request, timeoutMs = 5000 } = {}) {
  return new Promise(resolve => {
    let req, timer, done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); req?.destroy(); resolve(value); };
    timer = setTimeout(() => finish({ status: 'unreachable', models: null }), timeoutMs);
    try {
      req = request('https://api.anthropic.com/v1/models?limit=100', { method: 'GET',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', accept: 'application/json' } }, response => {
        response.on('error', () => finish({ status: 'unreachable', models: null }));
        const status = response.statusCode === 200 ? 'ok' : ({ 401: 'invalid', 403: 'forbidden', 429: 'rate_limited' }[response.statusCode] || 'error');
        if (status !== 'ok') { response.resume(); finish({ status, models: null }); return; }
        let body = '', bytes = 0;
        response.setEncoding('utf8');
        response.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (bytes > 262144) finish({ status: 'error', models: null }); else body += chunk; });
        response.on('aborted', () => finish({ status: 'unreachable', models: null }));
        response.on('end', () => {
          try {
            const value = JSON.parse(body);
            if (!Array.isArray(value.data) || value.data.length > 100) throw new Error();
            const models = value.data.map(model => model.id);
            if (models.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9][\w.:-]{0,159}$/.test(id) || /sk-ant|api.?key/i.test(id) || id.includes(key))) throw new Error();
            finish({ status: 'ok', models: [...new Set(models)] });
          } catch { finish({ status: 'error', models: null }); }
        });
      });
      req.on('error', () => finish({ status: 'unreachable', models: null })); req.end();
    } catch { finish({ status: 'unreachable', models: null }); }
  });
}
async function probeBillingIdentity({ key, spec, configDirectory, loadSdk, resolveExecutable, maxBudgetUsd, timeoutMs }) {
  const prompt = inputQueue(), abort = new AbortController();
  let query;
  try {
    const executable = await resolveExecutable({ env: spec.env || process.env });
    if (!executable) return { status: 'unknown', source: null };
    const sdk = await loadSdk();
    fs.mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    query = sdk.query({ prompt, options: queryOptions(spec, { key, executable, configDirectory, abort, maxBudgetUsd,
      policy: createPolicy(spec), canUseTool: async () => ({ behavior: 'deny', message: 'Connection tests do not execute tools.' }) }) });
    // The queue is never populated: initialize is a control request, not an inference turn.
    return { status: 'ok', source: await readBillingIdentity(query, { signal: abort.signal, timeoutMs }) };
  } catch (error) {
    const source = error.code === 'billing_identity_mismatch' ? billingSource(error.source) : null;
    return { status: source ? 'mismatch' : 'unknown', source };
  } finally {
    prompt.close(); abort.abort();
    try { query?.close(); } catch { }
  }
}

function createConnectionTest({ credentials, inspectCli, request, probeBilling = async () => ({ status: 'unknown', source: null }), now = Date.now, timeoutMs = 5000 }) {
  let pending;
  async function check(config) {
    const checkedAt = now();
    let key, observed = { status: 'error', models: null }, latencyMs = null;
    try { key = credentials.read(); } catch { }
    if (key) {
      const started = now(); observed = await listModels(key, { request, timeoutMs }); latencyMs = Math.max(0, now() - started);
    } else {
      try { observed.status = credentials.status().saved ? 'error' : 'missing'; } catch { observed.status = 'error'; }
    }
    let cli;
    try {
      const value = await inspectCli();
      cli = { status: ['ok', 'missing', 'too_old'].includes(value.status) ? value.status : 'missing',
        version: typeof value.version === 'string' && /^\d+\.\d+\.\d+$/.test(value.version) ? value.version : null, required };
    } catch { cli = { status: 'missing', version: null, required }; }
    let billing = { status: 'unknown', source: null };
    if (key && cli.status === 'ok') {
      try {
        const value = await probeBilling(key, config), source = billingSource(value.source);
        if (source) billing = { status: source === 'ANTHROPIC_API_KEY' && value.status === 'ok' ? 'ok'
          : source !== 'ANTHROPIC_API_KEY' && value.status === 'mismatch' ? 'mismatch' : 'unknown', source };
      } catch { }
    }
    return { checkedAt, key: { status: observed.status, detail: details[observed.status], latencyMs }, models: observed.models, cli,
      billing, path: null, reason: billing.status === 'mismatch' ? billingIdentityError(billing.source).message
        : billing.status === 'unknown' ? '无法确认 Claude Code 的计费来源。' : null };
  }
  return config => pending ||= check(config).finally(() => { pending = null; });
}
module.exports = { createConnectionTest, listModels, probeBillingIdentity };
