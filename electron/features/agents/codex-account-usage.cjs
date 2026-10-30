const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { createHash } = require('node:crypto');

// Codex 0.163's generated GetAccountRateLimitsResponse/Params contract. This is an
// owned stdio client, never the person's PTY. No threads, turns, login or reset RPCs.
const MAX_OUTPUT = 256 * 1024;
const unavailable = reason => ({ resets: null, resetQuery: { state: 'unavailable', reason } });
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
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

function accountResult(result, at = Date.now()) {
  const left = result?.rateLimitResetCredits?.availableCount;
  // JSON's integer representation must be safe before crossing Electron IPC.
  if (left != null && (!Number.isSafeInteger(left) || left < 0)) throw new Error('invalid-count');
  const limits = [result?.rateLimits?.primary, result?.rateLimits?.secondary]
    .filter(value => value && Number.isFinite(value.usedPercent))
    .map(value => ({ minutes: value.windowDurationMins ?? null, percent: value.usedPercent,
      resetsAt: Number.isFinite(value.resetsAt) ? value.resetsAt * 1000 : null }));
  if (left == null) return { ...unavailable('unsupported'), ...(limits.length ? { limits, at, source: 'Codex' } : {}) };
  return { resets: { left, total: null }, limits, at, source: 'Codex', resetQuery: { state: 'ready', at } };
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
    let child, timer, limitsReadAt, done = false, pending = '', bytes = 0, stage = 1;
    const finish = value => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      child?.stdout?.removeListener('data', read);
      try { child?.stdin?.end(); } catch { }
      stop(child);
      resolve(value);
    };
    const fail = reason => finish({ resets: null, resetQuery: { state: 'error', reason } });
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
        if (message.error) { if (message.error.code === -32601) finish(unavailable('unsupported')); else fail('query'); return; }
        if (!Object.hasOwn(message, 'result')) continue;
        if (stage === 1) {
          stage = 2;
          write({ method: 'initialized' });
          // A reply delayed in transit must not supersede a rollout written after this read began.
          limitsReadAt = Date.now();
          write({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } });
        } else {
          try { finish(accountResult(message.result, limitsReadAt)); } catch { fail('query'); }
        }
      }
    };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => fail('timeout'), timeout);
    timer.unref?.();
    const start = file => {
      if (done) return;
      if (!file) { finish(unavailable('unsupported')); return; }
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
  if (recordedCwd === null || recordedCwd && scopePathKey(recordedCwd) !== scopePathKey(directory)) return { reason: 'scope' };
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
  constructor({ read = readCodexAccount, scope = accountConfigScope, interval = 30000 } = {}) {
    this.read = read; this.scope = scope; this.interval = interval; this.entries = new Map(); this.projects = new Map();
  }
  check(options) {
    return this.watch({ ...options, accountLaunch: 'project-open-v1' }, () => {}, true);
  }
  scopeFor(options) {
    // Only the project's own preflight can bridge the gap before session_meta.
    // Missing metadata that was actually reported must remain unproven.
    if (!options.scopeReported && options.accountLaunch === 'model-only-v1') {
      const opening = { ...options, recordedCwd: undefined, accountLaunch: 'project-open-v1' };
      const scope = usageScope(opening), check = this.projects.get(options.projectId);
      if (check?.key && check.key === scope.key) return { ...scope, options: opening };
    }
    return { ...usageScope(options), options };
  }
  watch(options, changed, once = false) {
    const scope = this.scopeFor(options); options = scope.options;
    if (scope.reason) { changed(unavailable(scope.reason)); return { dispose() {}, refresh() {}, output() {} }; }
    // A quick rebind must retain the old read and throttle, even after its last listener leaves.
    for (const [key, entry] of this.entries) if (!entry.listeners.size && !entry.checks.size && !entry.pending &&
      Date.now() >= Math.max((entry.lastReadAt ?? entry.lastAttemptAt ?? 0) + 5000, entry.retryAt || 0)) this.entries.delete(key);
    let entry = this.entries.get(scope.key);
    if (!entry) {
      entry = { options: { ...options, codexHome: scope.home, cwd: scope.cwd }, listeners: new Set(), checks: new Set(), failures: 0, generation: 0 };
      this.entries.set(scope.key, entry);
    }
    const listeners = once ? entry.checks : entry.listeners;
    listeners.add(changed);
    if (entry.value) changed(entry.value);
    if (!entry.pending && !entry.timer) {
      if (entry.value && Date.now() < entry.nextReadAt) {
        if (!once) this.schedule(entry, entry.nextReadAt);
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
        listeners.delete(changed);
        if (entry.listeners.size) return;
        clearTimeout(entry.timer); entry.timer = null; entry.queued = false;
        if (entry.checks.size) return;
        entry.value = null;
        if (entry.pending) { entry.invalidated = true; entry.abort?.abort(); }
      },
    };
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
    const publish = value => { entry.value = value; for (const changed of entry.listeners) changed(value); };
    entry.pending = true; entry.queued = false; entry.lastAttemptAt = now;
    publish({ resets: null, resetQuery: { state: 'loading' } });
    Promise.resolve().then(async () => {
      const reason = await this.scope(entry.options);
      if (abort.signal.aborted) return null;
      if (reason) return unavailable(reason);
      entry.lastReadAt = Date.now();
      return this.read({ ...entry.options, signal: abort.signal });
    }).catch(() => ({ resets: null, resetQuery: { state: 'error', reason: 'query' } })).then(value => {
      if (entry.generation !== generation) return;
      entry.pending = false;
      const invalidated = entry.invalidated; entry.invalidated = false;
      if (!entry.listeners.size && !entry.checks.size) return;
      if (invalidated) { this.refresh(entry, true); return; }
      // Older accounts can report limits without the optional reset-credit counter.
      const failed = value.resetQuery.state !== 'ready' && !value.limits?.length;
      entry.failures = failed ? entry.failures + 1 : 0;
      const delay = failed ? Math.min(300000, this.interval * 2 ** Math.min(entry.failures, 4)) : this.interval;
      entry.retryAt = failed ? Date.now() + delay : 0;
      entry.nextReadAt = Date.now() + delay;
      publish(value);
      if (entry.queued) this.refresh(entry, true);
      else if (entry.listeners.size) this.schedule(entry, entry.nextReadAt);
    });
  }
  dispose() {
    for (const entry of this.entries.values()) { entry.listeners.clear(); entry.checks.clear(); ++entry.generation; clearTimeout(entry.timer); entry.abort?.abort(); }
    this.entries.clear();
    this.projects.clear();
  }
}

module.exports = { CodexAccountUsage, readCodexAccount, accountResult, usageScope, codexExecutable, configScope, accountConfigScope, scopePathKey };
