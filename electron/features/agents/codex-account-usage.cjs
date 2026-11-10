const fs = require('node:fs');
const { sameDirectory } = require('../../session-files.cjs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { createHmac, randomBytes, randomUUID } = require('node:crypto');
const { retainAccount } = require('./usage-observation.cjs');

// Codex 0.163's generated GetAccountRateLimitsResponse/Params contract. This is an
// owned stdio clients, never the person's PTY. Polls only read; the separate
// consumeCodexResetCredit path is admitted only after an owner hits a limit.
const MAX_OUTPUT = 256 * 1024;
const unavailable = reason => ({ resets: null, resetQuery: { state: 'unavailable', reason } });
const loading = () => ({ resets: null, resetQuery: { state: 'loading' } });
const fingerprintKey = randomBytes(32);
const SCOPE_ENVIRONMENT = new Set(['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'PROGRAMDATA', 'PATH', 'PATHEXT',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']);
const accountVariable = name => /^(?:OPENAI|CHATGPT|AZURE_OPENAI|CODEX)_/.test(name);
const accountOverride = name => /^(?:OPENAI|CHATGPT|AZURE_OPENAI)_/.test(name)
  || name !== 'CODEX_HOME' && /^CODEX_.*(?:AUTH|TOKEN|KEY|PROVIDER|PROFILE|CONFIG|URL|ENDPOINT|GATEWAY|HOME|MANAGED)/.test(name);
const environmentValue = (env, name) => process.platform === 'win32'
  ? Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1] : env[name];

function environmentFingerprint(env) {
  // Stable across terminal copies, including account overrides and executable/config
  // locations. Only the digest enters the cache key; no credential value is logged.
  const values = Object.entries(env).filter(([key]) => SCOPE_ENVIRONMENT.has(key.toUpperCase()) || accountVariable(key.toUpperCase()))
    .map(([key, value]) => [process.platform === 'win32' ? key.toUpperCase() : key, value])
    .sort(([a], [b]) => a.localeCompare(b));
  return createHmac('sha256', fingerprintKey).update(JSON.stringify(values)).digest('hex');
}

// An account's opaque name, the same for every reader of account/read in this process; the identifiers never leave it.
const accountScopeId = account => createHmac('sha256', fingerprintKey)
  .update(JSON.stringify([account?.type, account?.id, account?.accountId, account?.email])).digest('hex');

function accountResult(result, at = Date.now()) {
  const left = result?.rateLimitResetCredits?.availableCount;
  // JSON's integer representation must be safe before crossing Electron IPC.
  if (left != null && (!Number.isSafeInteger(left) || left < 0)) throw new Error('invalid-count');
  const limits = [result?.rateLimits?.primary, result?.rateLimits?.secondary]
    .filter(value => value && Number.isFinite(value.usedPercent))
    .map(value => ({ minutes: value.windowDurationMins ?? null, percent: value.usedPercent,
      resetsAt: Number.isFinite(value.resetsAt) ? value.resetsAt * 1000 : null }));
  const evidence = { atLimit: usageAtLimit(result), ordinaryUsageAllowed: typeof result?.ordinaryUsageAllowed === 'boolean' ? result.ordinaryUsageAllowed : null };
  if (left == null) return { ...unavailable('unsupported'), ...(limits.length ? { limits, at, source: 'Codex' } : {}), ...evidence };
  return { resets: { left, total: null }, limits, at, source: 'Codex', resetQuery: { state: 'ready', at }, ...evidence };
}

function usageAtLimit(value) {
  if (value?.ordinaryUsageAllowed === true) return false;
  const buckets = Object.values(Object.keys(value?.rateLimitsByLimitId || {}).length ? value.rateLimitsByLimitId : value?.rateLimits ? { codex: value.rateLimits } : {});
  return buckets.some(bucket => ['rate_limit_reached', 'workspace_owner_usage_limit_reached', 'workspace_member_usage_limit_reached'].includes(bucket?.rateLimitReachedType)
    || value?.ordinaryUsageAllowed === false && [bucket?.primary, bucket?.secondary].some(window => window?.usedPercent >= 100));
}
function limitPeriod(value) {
  const buckets = Object.values(value?.rateLimitsByLimitId || {});
  if (value?.rateLimits) buckets.push(value.rateLimits);
  return JSON.stringify(buckets.map(bucket => [bucket?.limitId || 'codex', bucket?.primary?.resetsAt ?? null, bucket?.secondary?.resetsAt ?? null]).sort());
}

function resetCreditMessage(result, translate = value => value) {
  if (result.status === 'redeemed') {
    const text = result.remaining === null || result.remaining === undefined
      ? translate('额度已用完，已自动使用 1 次重置，剩余次数未知。')
      : translate('额度已用完，已自动使用 1 次重置，还剩 {n} 次。', { n: result.remaining });
    return text + (result.confirmed ? '' : translate('服务端仍未确认额度恢复；不会再次消耗，请核对额度后继续。'));
  }
  if (result.status === 'uncertain') return translate('已尝试自动重置，但未能确认结果；不会再次消耗，请核对额度后继续。');
  if (result.status === 'declined') return translate('服务端未应用自动重置，请核对额度后继续。');
  return null;
}

// One explicit action, with no login, refresh, thread, turn or transport retry.
// claim() serializes accounts across project/cwd scopes before any consume RPC.
async function consumeCodexResetCredit({ env = process.env, cwd, codexHome, executable, launch = spawn,
  stop = stopChild, claim, current = () => true, timeout = 8000, scopeCheck = accountConfigScope, rpcFactory, signal } = {}) {
  if (!cwd || !codexHome || !claim || !rpcFactory || !current() || await scopeCheck({ env, cwd, codexHome })) return { status: 'ineligible' };
  const file = executable || await codexExecutable(env);
  if (!file || !current()) return { status: 'unavailable' };
  let child, rpc, attempted = false, outcome = null, idempotencyKey;
  const abort = () => { rpc?.close(); stop(child); };
  if (signal?.aborted) return { status: 'ineligible' };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    child = launch(file, ['app-server', '--listen', 'stdio://'], { cwd, env: { ...env, CODEX_HOME: codexHome }, windowsHide: true,
      shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    rpc = rpcFactory(child, { timeout, onNotification() {}, onRequest() {}, onDisconnect() {} });
    child.stderr?.on('data', () => {});
    await rpc.request('initialize', { clientInfo: { name: 'agentrix_usage', title: 'Agentrix usage', version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false, explicitGatewayOauth: true } });
    rpc.notify('initialized');
    const account = await rpc.request('account/read', { refreshToken: false });
    if (!['chatgpt', 'chatgptAuthTokens'].includes(account?.account?.type)) return { status: 'ineligible' };
    const before = await rpc.request('account/rateLimits/read', { excludeResetCreditDetails: false });
    const count = before?.rateLimitResetCredits?.availableCount;
    if (!current() || !usageAtLimit(before) || !Number.isSafeInteger(count) || count <= 0) return { status: 'unavailable' };
    // Without a backend account identity, two homes cannot be proved distinct.
    if (typeof before.accountId !== 'string' || !before.accountId) return { status: 'unavailable' };
    idempotencyKey = claim(before.accountId, before);
    if (!idempotencyKey) return { status: 'cooldown' };
    const rows = before.rateLimitResetCredits.credits;
    const selected = (Array.isArray(rows) ? rows : []).filter(row => row?.status === 'available' && typeof row.id === 'string'
      && (row.expiresAt === null || Number.isSafeInteger(row.expiresAt) && row.expiresAt * 1000 > Date.now()))
      .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity))[0];
    if (!current()) return { status: 'ineligible' };
    attempted = true;
    const response = await rpc.request('account/rateLimitResetCredit/consume', { idempotencyKey, ...(selected ? { creditId: selected.id } : {}) });
    outcome = response?.outcome;
    if (!['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'].includes(outcome)) throw new Error('invalid-reset-response');
    const after = await rpc.request('account/rateLimits/read', { excludeResetCreditDetails: true });
    const remaining = after?.rateLimitResetCredits?.availableCount;
    return { status: outcome === 'reset' || outcome === 'alreadyRedeemed' ? 'redeemed' : 'declined', outcome, idempotencyKey,
      confirmed: after.accountId === before.accountId && after.ordinaryUsageAllowed === true,
      remaining: after.accountId === before.accountId && Number.isSafeInteger(remaining) && remaining >= 0 ? remaining : null,
      limits: after.accountId === before.accountId ? after : null };
  } catch {
    return { status: ['reset', 'alreadyRedeemed'].includes(outcome) ? 'redeemed' : attempted ? 'uncertain' : 'unavailable', outcome, idempotencyKey };
  } finally { signal?.removeEventListener('abort', abort); rpc?.close(); stop(child); }
}

// Use a native executable, avoiding a shell and unowned npm shim descendants.
// Standard Windows npm installations can expose the vendor binary here too.
async function codexExecutable(env = process.env, platform = process.platform, cancelled = () => false) {
  const folders = String(Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '').split(path.delimiter);
  for (const folder of folders.filter(Boolean)) {
    const root = folder.replace(/"/g, '');
    const candidates = platform === 'win32' ? [path.join(root, 'codex.exe'),
      ...['node_modules/@openai/codex/vendor', 'node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor',
        'node_modules/@openai/codex/node_modules/@openai/codex-win32-arm64/vendor']
        .flatMap(base => ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc'].map(target => path.join(root, base, target, 'codex/codex.exe')))]
      : [path.join(root, 'codex')];
    for (const candidate of candidates) {
      if (cancelled()) return null;
      try { if ((await fs.promises.stat(candidate)).isFile()) return candidate; } catch { }
    }
  }
  return null;
}

function stopChild(child) {
  if (!child || child.exitCode != null) return;
  // Only our own pid/tree. Never enumerate or signal any running Codex sessions.
  if (process.platform === 'win32' && child.pid) {
    const killer = execFile('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: 2000 }, () => {
      try { if (child.exitCode == null) child.kill('SIGKILL'); } catch { }
    });
    killer.unref?.();
    return;
  } else if (child.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); return; } catch { }
  }
  try { child.kill('SIGKILL'); } catch { }
}

function readCodexAccount({ env = process.env, cwd, codexHome, signal, timeout = 8000,
  executable, launch = spawn, stop = stopChild } = {}) {
  return new Promise(resolve => {
    let child, timer, limitsReadAt, connection, done = false, pending = '', bytes = 0, stage = 1;
    const finish = value => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      child?.stdout?.removeListener('data', read);
      try { child?.stdin?.end(); } catch { }
      stop(child);
      resolve(value);
    };
    const fail = reason => finish({ resets: null, resetQuery: { state: 'error', reason },
      connection: connection || { kind: 'unknown', active: false, source: 'codex-account-usage account/read', observedAt: null } });
    const abort = () => fail('cancelled');
    const write = value => { try { child.stdin.write(JSON.stringify(value) + '\n'); } catch { fail('query'); } };
    const read = data => {
      bytes += Buffer.byteLength(data);
      if (bytes > MAX_OUTPUT) { fail('query'); return; }
      pending += data;
      let end;
      while (!done && (end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { fail('query'); return; }
        if (!message || typeof message !== 'object') { fail('query'); return; }
        // Notifications may be interleaved. Never answer a server request that
        // could ask for auth or an action; this connection only reads usage.
        if (message.id !== stage || message.method) continue;
        if (message.error) { if (message.error.code === -32601) finish({ ...unavailable('version'), ...(connection ? { connection } : {}) }); else fail('query'); return; }
        if (!Object.hasOwn(message, 'result')) continue;
        if (stage === 1) {
          stage = 2;
          write({ method: 'initialized' });
          write({ id: 2, method: 'account/read', params: { refreshToken: false } });
        } else if (stage === 2) {
          const account = message.result?.account;
          connection = { kind: account === null ? 'none' : account?.type === 'apiKey' ? 'api'
            : ['chatgpt', 'chatgptAuthTokens'].includes(account?.type) ? 'subscription' : 'unknown',
          active: false, source: 'codex-account-usage account/read', observedAt: null };
          if (connection.kind !== 'unknown') {
            connection.observedAt = Date.now();
            connection.scopeId = accountScopeId(account);
          }
          // API accounts have no subscription windows. An absent account is not logged in.
          if (connection.kind === 'none' || connection.kind === 'api') {
            finish({ ...unavailable('unsupported'), connection }); return;
          }
          stage = 3;
          // A reply delayed in transit must not supersede a rollout written after this read began.
          limitsReadAt = Date.now();
          write({ id: 3, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } });
        } else {
          try { finish({ ...accountResult(message.result, limitsReadAt), connection }); } catch { fail('query'); }
        }
      }
    };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => fail('timeout'), timeout);
    timer.unref?.();
    const start = file => {
      if (done) return;
      if (!file) { finish(unavailable('missing')); return; }
      try {
        child = launch(file, ['app-server', '--listen', 'stdio://'], {
          cwd, env: { ...env, CODEX_HOME: codexHome || env.CODEX_HOME || path.join(os.homedir(), '.codex') },
          windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
        });
        child.stdout.setEncoding('utf8'); child.stdout.on('data', read);
        // Drain but never retain/log diagnostics (they may contain account data).
        child.stderr?.on('data', data => { bytes += data.length; if (bytes > MAX_OUTPUT) fail('query'); });
        child.stdin.on('error', () => fail('query'));
        child.once('error', () => fail('query'));
        child.once('exit', () => { if (!done) fail('query'); });
        child.once('close', () => { if (!done) fail('query'); });
        write({ id: 1, method: 'initialize', params: {
          clientInfo: { name: 'agentrix_usage', title: 'Agentrix usage', version: '1' },
          capabilities: { experimentalApi: true, requestAttestation: false, explicitGatewayOauth: true },
        } });
      } catch { fail('query'); }
    };
    if (executable) start(executable);
    else void codexExecutable(env, process.platform, () => done).then(start, () => fail('query'));
  });
}

// Scope only to the actual reported home + inherited account environment + cwd
// (Codex resolves project config there). No credential files or account IDs read.
function scopePathKey(value, platform = process.platform) {
  if (platform !== 'win32') return path.posix.resolve(value);
  // Codex can write Win32 extended paths while the shell reports DOS/UNC paths.
  const normal = value.replace(/\//g, '\\').replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, '');
  return path.win32.resolve(normal).toLowerCase();
}

function usageScope({ codexHome, cwd, recordedCwd, env = process.env, provider, remote, accountLaunch } = {}) {
  if (remote) return { reason: 'remote' };
  const opening = accountLaunch === 'project-open-v1';
  if (!provider && !opening) return { reason: 'scope' };
  if (provider && provider !== 'openai') return { reason: 'provider' };
  if (!opening && accountLaunch !== 'model-only-v1') return { reason: 'scope' };
  const directory = path.resolve(cwd || process.cwd());
  if (recordedCwd === null || recordedCwd && !sameDirectory(recordedCwd, directory)) return { reason: 'scope' };
  const userHome = environmentValue(env, process.platform === 'win32' ? 'USERPROFILE' : 'HOME') || os.homedir();
  const home = path.resolve(directory, codexHome || environmentValue(env, 'CODEX_HOME') || path.join(userHome, '.codex'));
  // Project opens prove the default route in config preflight, not session_meta.
  // Once independently proven, both launch kinds read the same official scope.
  return { home, cwd: directory, key: JSON.stringify([scopePathKey(home), scopePathKey(directory), environmentFingerprint(env)]) };
}

// This is deliberately a conservative boundary check, not a second Codex config
// loader. The owned server loads the real config in the same home/cwd. Reject
// account endpoints, redefinitions of "openai", selected profiles and config
// syntax we cannot prove safe. Inactive custom provider definitions are fine.
function configScope(text) {
  let section = [], multiline = null;
  const keys = input => {
    const parts = input.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+|\./g);
    if (!parts || parts.length % 2 !== 1 || parts.some((part, i) => i % 2 ? part !== '.' : part === '.')
      || parts.join('').replace(/\s/g, '') !== input.replace(/\s/g, '')) return null;
    try { return parts.filter(part => part !== '.').map(part => part[0] === '"' ? JSON.parse(part) : part[0] === "'" ? part.slice(1, -1) : part); }
    catch { return null; }
  };
  for (let line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (multiline) { const end = line.indexOf(multiline); if (end < 0) continue; line = line.slice(end + 3); multiline = null; }
    // Strip comments only outside quoted strings. Values are never logged.
    let quote = null, escaped = false, equal = -1, end = line.length;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (escaped) { escaped = false; continue; }
      if (quote) { if (c === '\\' && quote === '"') escaped = true; else if (c === quote) quote = null; continue; }
      if (c === '#') { end = i; break; }
      if ((c === '"' || c === "'") && line.slice(i, i + 3) === c.repeat(3)) {
        const close = line.indexOf(c.repeat(3), i + 3);
        if (close < 0) { multiline = c.repeat(3); end = i; break; }
        i = close + 2; continue;
      }
      if (c === '"' || c === "'") quote = c;
      else if (c === '=' && equal < 0) equal = i;
    }
    if (quote) return 'scope';
    line = line.slice(0, end).trim();
    if (!line) continue;
    let field;
    if (line.startsWith('[')) {
      section = keys(line.replace(/^\[\[?|\]\]?$/g, '').trim());
      if (!section) return 'scope';
      field = section;
    } else {
      if (equal < 0) continue; // continuation of an unrelated array/value
      const parts = keys(line.slice(0, line.indexOf('=')).trim());
      if (!parts) return 'scope';
      field = [...section, ...parts];
      if (field.length === 1 && field[0] === 'model_provider') {
        if (!/^(?:"openai"|'openai')$/.test(line.slice(line.indexOf('=') + 1).trim())) return 'provider';
      }
    }
    if (field[0] === 'model_providers' && (field.length === 1 || field[1] === 'openai')) return 'provider';
    if (['profile', 'chatgpt_base_url', 'openai_base_url', 'auth', 'auth_keyring', 'mcp_enterprise_managed_auth'].includes(field[0])) return 'scope';
  }
  return multiline ? 'scope' : null;
}

async function accountConfigScope({ codexHome, cwd, env = process.env }) {
  // Presence alone is sufficient to decline account/endpoint overrides.
  if (Object.keys(env).some(key => accountOverride(key.toUpperCase()))) return 'scope';
  const files = new Set([path.join(codexHome, 'config.toml')]);
  let directory = cwd;
  for (let depth = 0; depth < 64; depth++) {
    files.add(path.join(directory, '.codex', 'config.toml'));
    const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
    if (depth === 63) return 'scope';
  }
  // Codex's system config lives here on Unix. On Windows it uses ProgramData.
  const system = process.platform === 'win32' ? path.join(environmentValue(env, 'PROGRAMDATA') || 'C:\\ProgramData', 'OpenAI', 'Codex') : '/etc/codex';
  files.add(path.join(system, 'config.toml'));
  // Managed routing may remap credential sources. Its presence is enough to
  // decline; do not read that configuration or any credential store.
  for (const filename of [path.join(system, 'managed_config.toml'), path.join(system, 'requirements.toml'),
    path.join(codexHome, 'managed_config.toml')]) {
    try { await fs.promises.stat(filename); return 'scope'; }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return 'scope'; }
  }
  for (const filename of files) {
    let file;
    try {
      file = await fs.promises.open(filename, 'r');
      const bytes = Buffer.alloc(MAX_OUTPUT + 1); let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break; length += bytesRead;
      }
      if (length > MAX_OUTPUT) return 'scope';
      const reason = configScope(bytes.subarray(0, length).toString('utf8'));
      if (reason) return reason;
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return 'scope'; }
    finally { await file?.close(); }
  }
  return null;
}

class CodexAccountUsage {
  #projects = new Map();
  #projectQueue = [];
  #projectRunning = false;
  #disposed = false;

  constructor({ read = readCodexAccount, scope = accountConfigScope, interval = 30000, consume = consumeCodexResetCredit, audit = () => {}, now = Date.now, resetStorage, resetClient } = {}) {
    this.read = read; this.scope = scope; this.interval = interval; this.entries = new Map(); this.runtimes = new Map();
    this.consume = consume; this.audit = audit; this.now = now; this.resetStorage = resetStorage; this.resetClient = resetClient; this.resetPending = new Map(); this.resetAborts = new Set();
  }
  claimReset(accountId, limits) {
    const saved = this.resetStorage?.read() || this.resetState;
    const state = saved && /^[\da-f]{64}$/.test(saved.salt) && saved.attempts && typeof saved.attempts === 'object'
      ? saved : { salt: randomBytes(32).toString('hex'), attempts: {} };
    const key = createHmac('sha256', state.salt).update(accountId).digest('hex'), previous = state.attempts[key];
    const period = limitPeriod(limits);
    if (previous && (this.now() < previous.until || this.now() < previous.keepUntil && (previous.frozen || previous.period === period))) return null;
    state.attempts = Object.fromEntries(Object.entries(state.attempts).filter(([, value]) => value?.keepUntil > this.now()).slice(-499));
    const times = [limits?.rateLimits, ...Object.values(limits?.rateLimitsByLimitId || {})].flatMap(bucket => [bucket?.primary?.resetsAt, bucket?.secondary?.resetsAt])
      .filter(time => Number.isSafeInteger(time) && time * 1000 > this.now()).map(time => time * 1000);
    const attempt = { key: randomUUID(), period, frozen: true, until: this.now() + 30 * 60000, keepUntil: Math.max(this.now() + 30 * 60000, ...times, times.length ? 0 : this.now() + 86400000) };
    state.attempts[key] = attempt;
    // Persist before sending: a crash or app restart must not spend a second credit.
    this.resetStorage?.write(state); this.resetState = state;
    return attempt.key;
  }
  async resetAtLimit(options, { enabled = true, atLimit = false, current = () => true } = {}) {
    if (!enabled || !atLimit || options.owner !== 'gui' || options.remote || !current() || this.#disposed) return { status: 'ineligible' };
    const scope = this.scopeFor(options);
    if (scope.reason || await this.scope({ ...options, codexHome: scope.home, cwd: scope.cwd })) return { status: 'ineligible' };
    if (this.resetPending.has(scope.key)) return this.resetPending.get(scope.key);
    const abort = new AbortController(); this.resetAborts.add(abort);
    const task = this.consume({ ...this.resetClient, ...options, cwd: scope.cwd, codexHome: scope.home, signal: abort.signal, current: () => !this.#disposed && current(),
      claim: (accountId, limits) => this.claimReset(accountId, limits),
    }).catch(() => ({ status: 'unavailable' })).then(result => {
      // IDs, paths and backend bodies never enter the local audit or UI.
      if (result.idempotencyKey) {
        try {
          const state = this.resetStorage?.read() || this.resetState;
          const attempt = Object.values(state?.attempts || {}).find(value => value.key === result.idempotencyKey);
          if (attempt) { attempt.frozen = !result.confirmed; this.resetStorage?.write(state); this.resetState = state; }
          this.audit({ at: this.now(), status: result.status, outcome: result.outcome || null, remaining: result.remaining ?? null, idempotencyKey: result.idempotencyKey });
        } catch { result.auditFailed = true; }
      }
      if (result.limits) {
        const value = accountResult(result.limits, this.now());
        const entry = this.entries.get(scope.key);
        if (entry) { entry.nextReadAt = this.now() + this.interval; this.#publish(entry, value); }
      }
      return result;
    }).finally(() => { this.resetPending.delete(scope.key); this.resetAborts.delete(abort); });
    this.resetPending.set(scope.key, task); return task;
  }
  // The verified scope is the same one used by the terminal reader. Attaching a transport never broadens it.
  attachRuntime(options, runtime) {
    const scope = this.scopeFor(options);
    if (scope.reason) return { dispose() {} };
    const binding = { read: runtime.readLimits };
    this.runtimes.set(scope.key, binding);
    return { dispose: () => { if (this.runtimes.get(scope.key) === binding) this.runtimes.delete(scope.key); } };
  }
  openProject(id, options) {
    if (this.#disposed) return Promise.resolve(null);
    const existing = this.#projects.get(id);
    if (existing) return existing.done;
    options = { ...options, accountLaunch: 'project-open-v1' };
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const project = { id, options, key: usageScope(options).key, done, finish };
    this.#projects.set(id, project); this.#projectQueue.push(project);
    void this.#drainProjects();
    return done;
  }
  closeProject(id) {
    const project = this.#projects.get(id);
    if (!project) return;
    this.#projects.delete(id); project.subscription?.dispose(); project.finish(null);
  }
  async #drainProjects() {
    if (this.#projectRunning) return;
    this.#projectRunning = true;
    try {
      while (this.#projectQueue.length && !this.#disposed) {
        const project = this.#projectQueue.shift();
        if (this.#projects.get(project.id) !== project) continue;
        project.subscription = this.#subscribe(project.options, value => {
          if (value.resetQuery.state !== 'loading') project.finish(value);
        }, true);
        const entry = this.entries.get(project.subscription.key);
        await project.done;
        // Even a closed project's cancelled reader must settle before another
        // background check starts. A slow abort must not create a startup burst.
        await entry?.readPromise;
      }
    } finally { this.#projectRunning = false; }
  }
  scopeFor(options) {
    // Only the project's own preflight can bridge the gap before session_meta.
    // Missing metadata that was actually reported must remain unproven.
    if (!options.scopeReported && options.accountLaunch === 'model-only-v1') {
      const opening = { ...options, recordedCwd: undefined, accountLaunch: 'project-open-v1' };
      const scope = usageScope(opening), check = this.#projects.get(options.projectId);
      if (check?.key && check.key === scope.key) return { ...scope, options: opening };
    }
    return { ...usageScope(options), options };
  }
  watch(options, changed) {
    return this.#subscribe(options, changed, false);
  }
  #subscribe(options, changed, projectCheck) {
    const scope = this.scopeFor(options); options = scope.options;
    if (scope.reason) { changed(unavailable(scope.reason)); return { dispose() {}, refresh() {}, output() {} }; }
    // A quick rebind must retain the old read and throttle, even after its last listener leaves.
    for (const [key, entry] of this.entries) if (!entry.retainCache && !entry.listeners.size && !entry.checks.size && !entry.pending &&
      Date.now() >= Math.max((entry.lastReadAt ?? entry.lastAttemptAt ?? 0) + 5000, entry.retryAt || 0)) this.entries.delete(key);
    let entry = this.entries.get(scope.key);
    if (!entry) {
      entry = { options: { ...options, codexHome: scope.home, cwd: scope.cwd }, listeners: new Map(), checks: new Map(), failures: 0, generation: 0 };
      this.entries.set(scope.key, entry);
    }
    // Every watcher keeps the last dated observation through loading and failed reads. A session's watcher keeps only
    // what it was given, so an expired answer never shows in a new session; the pane's focused reads (retainCache)
    // live for one read each and share the entry's, which outlives them. Listeners map to which of the two they take.
    const listeners = projectCheck ? entry.checks : entry.listeners, retain = options.retainCache === true;
    let seen;
    const deliver = retain ? changed : value => changed(seen = retainAccount(seen, value));
    entry.retainCache ||= retain;
    listeners.set(deliver, retain);
    // An expired value is not replayed: the refresh below answers, so a read past the interval is that refresh.
    const fresh = entry.value && Date.now() < entry.nextReadAt;
    if (fresh) deliver(retain ? entry.retained : entry.value);
    else if (entry.pending) deliver(retain ? retainAccount(entry.retained, loading()) : loading());
    if (!entry.pending) {
      if (fresh) {
        if (!projectCheck && !entry.timer) this.schedule(entry, entry.nextReadAt);
      } else this.refresh(entry);
    }
    let tail = '';
    return {
      key: scope.key,
      refresh: (maxAge = 0) => this.refresh(entry, true, maxAge),
      // A success printed by the actual CLI invalidates any pre-reset read. No
      // query ever writes into its PTY, submits a prompt or initiates a reset.
      output: data => {
        tail = (tail + data).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').slice(-4096);
        const success = /Usage reset\.\s+You have \d+\b[^.]*?\bleft\.?/i.exec(tail);
        if (success) {
          tail = tail.slice(success.index + success[0].length);
          if (entry.pending) { entry.invalidated = true; entry.abort?.abort(); }
          this.refresh(entry, true);
        }
      },
      dispose: () => {
        listeners.delete(deliver);
        if (entry.listeners.size) return;
        clearTimeout(entry.timer); entry.timer = null; entry.queued = false;
        if (entry.checks.size) return;
        if (!entry.retainCache) entry.value = entry.retained = null;
        if (entry.pending) { entry.invalidated = true; entry.abort?.abort(); }
      },
    };
  }
  // A removed project's scope is no longer retained: once idle it is dropped like any other.
  releaseCache(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.retainCache = false;
    if (!entry.listeners.size && !entry.checks.size) entry.value = entry.retained = null;
  }
  #publish(entry, value) {
    // Only a settled read becomes the entry's retained observation: an aborted one must not leave it loading.
    const retained = retainAccount(entry.retained, value);
    if (value.resetQuery.state !== 'loading') entry.retained = retained;
    entry.value = value;
    for (const [deliver, retain] of [...entry.listeners, ...entry.checks]) deliver(retain ? retained : value);
  }
  schedule(entry, at) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.refresh(entry), Math.max(0, at - Date.now())); entry.timer.unref?.();
  }
  refresh(entry, force = false, maxAge = 0) {
    if (!entry.listeners.size && !entry.checks.size) return;
    const now = Date.now(), lastRead = entry.lastReadAt ?? entry.lastAttemptAt;
    if (maxAge && lastRead != null && now - lastRead <= maxAge) return;
    if (entry.pending) { if (force) entry.queued = true; return; }
    const earliest = Math.max(lastRead == null ? 0 : lastRead + 5000, entry.retryAt || 0);
    if (now < earliest) { this.schedule(entry, earliest); return; }
    clearTimeout(entry.timer); entry.timer = null;
    const generation = ++entry.generation;
    const abort = entry.abort = new AbortController();
    entry.pending = true; entry.queued = false; entry.lastAttemptAt = now;
    this.#publish(entry, loading());
    entry.readPromise = Promise.resolve().then(async () => {
      const reason = await this.scope(entry.options);
      if (abort.signal.aborted) return null;
      if (reason) return unavailable(reason);
      entry.lastReadAt = Date.now();
      const native = this.runtimes.get(this.scopeFor(entry.options).key);
      if (!native) return this.read({ ...entry.options, signal: abort.signal });
      const limits = await native.read();
      if (abort.signal.aborted) return null;
      const buckets = Object.values(limits.limitsById || {}), first = buckets[0] || {};
      return accountResult({ rateLimitResetCredits: limits.resetCredits,
        rateLimits: Object.fromEntries(['primary', 'secondary'].map(name => [name, first[name] ? {
          ...first[name], resetsAt: first[name].resetsAtMs == null ? null : first[name].resetsAtMs / 1000 } : null])) }, limits.observedAtMs);
    }).catch(() => ({ resets: null, resetQuery: { state: 'error', reason: 'query' } })).then(value => {
      if (entry.generation !== generation) return;
      entry.pending = false;
      const invalidated = entry.invalidated; entry.invalidated = false;
      if (!entry.listeners.size && !entry.checks.size) return;
      if (invalidated) { this.refresh(entry, true); return; }
      // Older accounts can report limits without the optional reset-credit counter.
      const failed = value.resetQuery.state !== 'ready' && !value.limits?.length && !['api', 'none'].includes(value.connection?.kind);
      entry.failures = failed ? entry.failures + 1 : 0;
      const delay = failed ? Math.min(300000, this.interval * 2 ** Math.min(entry.failures, 4)) : this.interval;
      entry.retryAt = failed ? Date.now() + delay : 0;
      entry.nextReadAt = Date.now() + delay;
      this.#publish(entry, value);
      if (entry.queued) this.refresh(entry, true);
      else if (entry.listeners.size) this.schedule(entry, entry.nextReadAt);
    });
  }
  dispose() {
    this.#disposed = true;
    for (const abort of this.resetAborts) abort.abort(); this.resetAborts.clear();
    for (const project of this.#projects.values()) project.finish(null);
    this.#projects.clear(); this.#projectQueue.length = 0;
    for (const entry of this.entries.values()) { entry.listeners.clear(); entry.checks.clear(); ++entry.generation; clearTimeout(entry.timer); entry.abort?.abort(); }
    this.entries.clear(); this.runtimes.clear();
  }
}

module.exports = { CodexAccountUsage, readCodexAccount, accountScopeId, consumeCodexResetCredit, usageAtLimit, resetCreditMessage, accountResult, usageScope, codexExecutable, configScope, accountConfigScope, scopePathKey };
