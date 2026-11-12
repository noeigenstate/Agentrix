const https = require('node:https');
const { billingSource } = require('./identity.cjs');
const { probeBillingIdentity } = require('./billing.cjs');
const { VIAS, REQUIRED: required } = require('../claude-runtime/locator.cjs');
const details = { ok: 'API 密钥验证成功。', missing: '还没有保存 API key。', invalid: 'API 密钥无效。',
  forbidden: 'API 密钥没有调用权限。', rate_limited: 'API 请求被限流，请稍后重试。',
  unreachable: '无法连接 Anthropic API。', error: '无法完成 API 连接检查。' };
const CLI_REASONS = new Set(['not_found', 'timeout', 'failed', 'unreadable']);
// The token count asks about the model the connection spec names. Main's spec names none (a new session leaves the
// choice to the CLI), so in the app the count always asks about this stand-in; a model it may not use still shows the
// key works.
const DEFAULT_MODEL = 'claude-opus-5-5';
const BODY_LIMIT = 262144;
const statusOf = code => code === 200 ? 'ok' : code === null ? 'unreachable' : ({ 401: 'invalid', 403: 'forbidden', 429: 'rate_limited' }[code] || 'error');

// Electron's net goes through the session's proxy settings, which main also copies into the environment Claude Code
// runs with, so the check reaches the API the way a session does. It takes the request shape of https.request; net
// sets the body's length itself.
const netRequest = net => (url, { method, headers }, callback) => {
  const { 'content-length': _length, ...sent } = headers;
  const request = net.request({ url, method, headers: sent });
  request.on('response', callback);
  return { on(event, listener) { request.on(event, listener); return this; },
    end: payload => payload === undefined ? request.end() : request.end(payload), destroy() { try { request.abort(); } catch { } } };
};

// One request to the API: its status code (null when it never answered) and body (null past the size limit).
function callApi(key, route, { method = 'GET', body, request = https.request, timeoutMs = 5000 } = {}) {
  return new Promise(resolve => {
    let req, timer, done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); req?.destroy(); resolve(value); };
    const unreachable = () => finish({ statusCode: null, text: null });
    timer = setTimeout(unreachable, timeoutMs);
    try {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      req = request(`https://api.anthropic.com${route}`, { method, headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', accept: 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } }, response => {
        const chunks = []; let bytes = 0;
        response.on('error', unreachable); response.on('aborted', unreachable);
        response.on('data', chunk => {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += data.length;
          if (bytes > BODY_LIMIT) finish({ statusCode: response.statusCode, text: null }); else chunks.push(data);
        });
        response.on('end', () => finish({ statusCode: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', unreachable); req.end(payload);
    } catch { unreachable(); }
  });
}
const errorOf = text => { try { return JSON.parse(text)?.error || null; } catch { return null; } };
// Anthropic's own words for a refusal (`type: message`): one line, shortened, with the key and anything shaped like one removed.
function describe(error, key) {
  const words = [error?.type, error?.message].filter(value => typeof value === 'string' && value).join(': ')
    .replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim().split(key).join('…').replace(/sk-ant-[\w-]*/gi, '…');
  return /[a-z0-9]/i.test(words) ? words.slice(0, 300) : null;
}
const withError = (value, error, key) => { const words = describe(error, key); return words ? { ...value, error: words } : value; };

async function listModels(key, options) {
  const { statusCode, text } = await callApi(key, '/v1/models?limit=100', options), status = statusOf(statusCode);
  if (status !== 'ok') return withError({ status, models: null }, text && errorOf(text), key);
  try {
    const value = JSON.parse(text);
    if (!Array.isArray(value.data) || value.data.length > 100) throw new Error();
    const models = value.data.map(model => model.id);
    if (models.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9][\w.:-]{0,159}$/.test(id) || /sk-ant|api.?key/i.test(id) || id.includes(key))) throw new Error();
    return { status: 'ok', models: [...new Set(models)] };
  } catch { return { status: 'error', models: null }; }
}
async function countTokens(key, model, options) {
  const { statusCode, text } = await callApi(key, '/v1/messages/count_tokens', { ...options, method: 'POST',
    body: { model, messages: [{ role: 'user', content: 'ping' }] } });
  const error = text && errorOf(text);
  // The model is looked up only for a key the API accepted: the key works, and this model is not one it may use.
  if (statusCode === 404 && error?.type === 'not_found_error') return { status: 'ok', unavailableModel: model };
  const status = statusOf(statusCode);
  return status === 'ok' ? { status } : withError({ status }, error, key);
}
// A key may be refused the model list and still run inference, so a refused list is followed by the free token
// count: its answer means the key works without a list; its refusal is the key's verdict, in its own words. The
// latency is that of the request that decided.
async function checkKey(key, model, options, now) {
  let started = now();
  const listed = await listModels(key, options);
  if (listed.status !== 'forbidden') return { ...listed, latencyMs: Math.max(0, now() - started) };
  started = now();
  const counted = await countTokens(key, model, options), latencyMs = Math.max(0, now() - started);
  if (counted.status !== 'ok') return { status: counted.status, models: null, latencyMs, error: counted.error || listed.error };
  return { status: 'ok', models: null, latencyMs, modelsForbidden: true, modelsError: listed.error,
    ...(counted.unavailableModel ? { unavailableModel: counted.unavailableModel } : {}) };
}
// Only the fields the view words a CLI check with, each of a known shape.
function cliResult(value) {
  const status = ['ok', 'missing', 'too_old'].includes(value.status) ? value.status : 'missing';
  const semver = text => typeof text === 'string' && /^\d+\.\d+\.\d+$/.test(text), place = text => typeof text === 'string' && text.length <= 1024;
  // Where a CLI was found: its `via` and `fileShown`, read as a pair.
  const where = found => VIAS.includes(found?.via) && place(found.fileShown) ? { via: found.via, fileShown: found.fileShown } : {};
  const cli = { status, version: semver(value.version) ? value.version : null, required };
  if (status === 'ok') {
    Object.assign(cli, where(value));
    const terminal = value.split?.terminal;
    if (value.notice === 'cli_split_versions' && semver(terminal?.version) && where(terminal).via) {
      Object.assign(cli, { notice: value.notice, split: { terminal: { version: terminal.version, ...where(terminal) } } });
    }
  }
  if (status !== 'missing') return cli;
  cli.reason = CLI_REASONS.has(value.reason) ? value.reason : 'not_found';
  if (cli.reason === 'not_found') {
    if (Number.isSafeInteger(value.pathFolders) && value.pathFolders >= 0) cli.pathFolders = value.pathFolders;
    if (Array.isArray(value.searched) && value.searched.length <= 16 && value.searched.every(place)) cli.searched = value.searched;
    if (place(value.incomplete)) cli.incomplete = value.incomplete;
    return cli;
  }
  if (place(value.found)) cli.found = value.found;
  if (typeof value.error === 'string' && /^[\w ]{1,64}$/.test(value.error)) cli.error = value.error;
  if (cli.reason === 'timeout' && Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0) cli.elapsedMs = value.elapsedMs;
  return cli;
}

// The model a new session for this scope sets, when it names a full model ID; otherwise the stand-in default.
function probeModel(sessionModel, config) {
  try {
    const model = sessionModel(config);
    if (typeof model === 'string' && /^claude-[\w.-]{1,100}$/.test(model)) return model;
  } catch { }
  return DEFAULT_MODEL;
}

function createConnectionTest({ credentials, inspectCli, request, probeBilling = async () => ({ status: 'unknown', source: null }), sessionModel = () => null,
  availabilityGeneration = () => undefined, now = Date.now, timeoutMs = 5000 }) {
  const pending = new Map();
  async function check(config) {
    const checkedAt = now(), generation = availabilityGeneration();
    let key, observed = { status: 'error', models: null, latencyMs: null };
    try { key = credentials.read(); } catch { }
    if (key) observed = await checkKey(key, probeModel(sessionModel, config), { request, timeoutMs }, now);
    else {
      try { observed.status = credentials.status().saved ? 'error' : 'missing'; } catch { observed.status = 'error'; }
    }
    // An inspection that throws is a check that failed, not a CLI that is absent.
    let cli;
    try { cli = cliResult(await inspectCli()); } catch { cli = { status: 'missing', version: null, required, reason: 'failed' }; }
    // The billing line says why billing is not this key or could not be read, and what to check (`detail`); the path's
    // reason only names the consequence, so the card does not say the same sentence twice.
    let billing = { status: 'unknown', source: null };
    if (key && cli.status === 'ok') {
      try {
        const value = await probeBilling(key, config, generation), source = billingSource(value.source);
        billing = { status: value.status === 'mismatch' ? 'mismatch' : source === 'ANTHROPIC_API_KEY' && value.status === 'ok' ? 'ok' : 'unknown', source,
          ...(value.status === 'mismatch' && value.reported ? { reported: value.reported } : {}), ...(value.why ? { detail: value.why } : {}) };
      } catch { billing.detail = { text: '检查 Claude Code 的计费来源时出错，请重试。', values: {} }; }
    }
    return { checkedAt, key: { status: observed.status, detail: details[observed.status], latencyMs: observed.latencyMs, error: observed.error || null },
      models: observed.models, ...(observed.modelsForbidden ? { modelsForbidden: true, modelsError: observed.modelsError || null,
        ...(observed.unavailableModel ? { unavailableModel: observed.unavailableModel } : {}) } : {}), cli,
      billing, path: null, reason: { mismatch: 'billing_identity_mismatch', unknown: 'billing_unconfirmed' }[billing.status] ?? null };
  }
  return (config = {}) => {
    const scope = config.projectId || '';
    if (!pending.has(scope)) pending.set(scope, check(config).finally(() => pending.delete(scope)));
    return pending.get(scope);
  };
}
module.exports = { createConnectionTest, listModels, netRequest, probeBillingIdentity };
