const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { TextDecoder } = require('node:util');

// Claude Code 2.1.312's plain usage read. Never run its refresh/auth recovery path.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const POLL_INTERVAL = 60000;
const DIRECT_USAGE_FRESH_MS = 2 * POLL_INTERVAL;
const MAX_OUTPUT = 1024 * 1024;
const ROUTE_ENV = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_UNIX_SOCKET',
  'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN', 'ANTHROPIC_AWS_API_KEY',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN', 'CLAUDE_CODE_SESSIONS_OAUTH_TOKEN', 'CCR_OAUTH_TOKEN_FILE',
  'CLAUDE_CODE_PROFILE', 'ANTHROPIC_PROFILE', 'CLAUDE_CODE_CUSTOM_OAUTH_URL', 'CLAUDE_CODE_OAUTH_CLIENT_ID',
]);
const routeOverride = env => Object.keys(env || {}).some(key => ROUTE_ENV.has(key.toUpperCase()));
const skipped = reason => ({ state: 'skipped', reason });

// Static code only; stdin contains named targets, never credential values. The
// child exposes only CredReadW/CredFree and exits without persisting its output.
const WINDOWS_READ_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AgentrixCredentialReader {
  [StructLayout(LayoutKind.Sequential)]
  struct Credential {
    public uint Flags, Type;
    public IntPtr TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes, TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", ExactSpelling = true)]
  static extern void CredFree(IntPtr credential);
  public static string Read(string target) {
    IntPtr pointer;
    if (!CredReadW(target, 1, 0, out pointer)) return Marshal.GetLastWin32Error() == 1168 ? "missing" : "unavailable";
    try {
      Credential item = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      if (item.CredentialBlobSize > 16384 || (item.CredentialBlobSize > 0 && item.CredentialBlob == IntPtr.Zero)) return "unavailable";
      byte[] bytes = new byte[(int)item.CredentialBlobSize];
      try {
        if (bytes.Length > 0) Marshal.Copy(item.CredentialBlob, bytes, 0, bytes.Length);
        return "present:" + Convert.ToBase64String(bytes);
      } finally { Array.Clear(bytes, 0, bytes.Length); }
    } finally { CredFree(pointer); }
  }
}
'@ | Out-Null
  $request = ConvertFrom-Json ([Console]::In.ReadToEnd())
  $targets = $request.targets
  if ($targets -isnot [array] -or $targets.Count -lt 1 -or $targets.Count -gt 256) { exit 1 }
  $values = @(foreach ($target in $targets) {
    if ($target -isnot [string] -or $target.Length -gt 2048 -or $target.IndexOf([char]0) -ge 0) { throw 'target' }
    [AgentrixCredentialReader]::Read($target)
  })
  [Console]::Write((ConvertTo-Json -InputObject $values -Compress))
} catch { exit 1 }`;

function decodeSecret(value) {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('credential-format');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function readWindowsCredentials(targets, { signal, execute, env }) {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    let child;
    try {
      const executable = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
      child = execute(executable, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(WINDOWS_READ_SCRIPT, 'utf16le').toString('base64')],
        { encoding: 'utf8', windowsHide: true, shell: false, timeout: 2000, maxBuffer: MAX_OUTPUT, signal }, (error, stdout) => {
          if (error || signal.aborted || typeof stdout !== 'string' || stdout.length > MAX_OUTPUT) { resolve(null); return; }
          try {
            const values = JSON.parse(stdout);
            if (!Array.isArray(values) || values.length !== targets.length) { resolve(null); return; }
            resolve(values.map(value => value === 'missing' ? { state: 'missing' } : typeof value === 'string' && value.startsWith('present:')
              ? { state: 'present', value: decodeSecret(value.slice(8)) } : { state: 'unavailable' }));
          } catch { resolve(null); }
        });
      child?.stdin?.on('error', () => {});
      child?.stdin?.end(JSON.stringify({ targets }));
    } catch { child?.kill(); resolve(null); }
  });
}

async function windowsCredential(service, options, nativeRead) {
  const target = `${service}/claude-code-user`, metadata = (await nativeRead([`${target}#m`], options))?.[0];
  if (options.signal.aborted || !metadata || !['missing', 'present'].includes(metadata.state)) return null;
  let manifest;
  if (metadata.state === 'present') try { manifest = JSON.parse(metadata.value); } catch { }
  const chunked = Number.isInteger(manifest?.n) && manifest.n >= 1 && manifest.n <= 256 &&
    Number.isInteger(manifest.l) && manifest.l > 0 && manifest.l <= manifest.n * 2400;
  let text;
  if (chunked) {
    const chunks = await nativeRead(Array.from({ length: manifest.n }, (_, i) => `${target}#${i}`), options);
    if (options.signal.aborted || chunks?.length !== manifest.n || chunks.some(item => item?.state !== 'present' || typeof item.value !== 'string' || item.value.length > 2400)) return null;
    text = chunks.map(item => item.value).join('');
    if (text.length !== manifest.l) return null;
    try { text = decodeSecret(text); } catch { return null; }
  } else {
    const item = (await nativeRead([target], options))?.[0];
    if (item?.state === 'missing') return { missing: true };
    if (item?.state !== 'present') return null;
    text = item.value;
  }
  try { return { credentials: JSON.parse(text) }; } catch { return null; }
}

function claudeUsageResult(body, at) {
  const limits = [['five_hour', 300], ['seven_day', 10080]].flatMap(([key, minutes]) => {
    const value = body?.[key];
    if (!value || !Number.isFinite(value.utilization) || value.utilization < 0) return [];
    const reset = typeof value.resets_at === 'string' ? Date.parse(value.resets_at) : NaN;
    return [{ minutes, percent: value.utilization, resetsAt: Number.isFinite(reset) ? reset : null }];
  });
  return limits.length && Number.isFinite(at) ? { limits, at, source: 'Claude' } : null;
}

async function readJson(file, readFile, signal) {
  try {
    const text = await readFile(file, { encoding: 'utf8', signal });
    if (text === '') return undefined;
    if (text.length > MAX_OUTPUT) return null;
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (error) {
    return ['ENOENT', 'ENOTDIR'].includes(error?.code) ? undefined : null;
  }
}

async function officialRoute(env, home, routes, readFile, signal) {
  if ([env.CLAUDE_CONFIG_DIR, env.CLAUDE_SECURESTORAGE_CONFIG_DIR].some(folder => folder && !path.isAbsolute(folder))) return false;
  const config = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const files = new Set([path.join(config, 'settings.json')]);
  for (const route of routes) {
    const inherited = route.env || env;
    if (routeOverride(inherited) || (inherited.CLAUDE_CONFIG_DIR || '') !== (env.CLAUDE_CONFIG_DIR || '') ||
      (inherited.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? '') !== (env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? '')) return false;
    if (route.cwd) for (const name of ['settings.json', 'settings.local.json']) files.add(path.join(route.cwd, '.claude', name));
  }
  for (const file of files) {
    if (signal.aborted) return false;
    const settings = await readJson(file, readFile, signal);
    if (settings === undefined) continue;
    if (!settings || routeOverride(settings.env) || settings.apiKeyHelper != null || settings.inferenceCredentialHelper != null ||
      (settings.forceLoginMethod && settings.forceLoginMethod !== 'claudeai')) return false;
  }
  return true;
}

function keychainCredential(service, signal, execute) {
  return new Promise(resolve => {
    try {
      execute('/usr/bin/security', ['find-generic-password', '-a', 'claude-code-user', '-w', '-s', service],
        { encoding: 'utf8', windowsHide: true, timeout: 2000, maxBuffer: 1024 * 1024, signal }, (error, stdout) => {
          if (error) { resolve(error.code === 44 ? { missing: true } : null); return; }
          try { resolve({ credentials: JSON.parse(stdout) }); } catch { resolve(null); }
        });
    } catch { resolve(null); }
  });
}

async function credentialsFrom({ env, home, platform, readFile, execute, nativeRead, signal }) {
  const config = (env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')).normalize('NFC');
  const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const folder = secure === undefined ? config : (secure || path.join(home, '.claude')).normalize('NFC');
  let windowsSecure = platform === 'win32' && env.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN === '1';
  if (platform === 'win32' && !windowsSecure) {
    const legacy = await readJson(path.join(config, '.config.json'), readFile, signal);
    if (signal.aborted) return null;
    const state = legacy === undefined ? await readJson(path.join(env.CLAUDE_CONFIG_DIR || home, '.claude.json'), readFile, signal) : legacy;
    if (state === null) return null;
    windowsSecure = state?.cachedGrowthBookFeatures?.tengu_windows_credman === true;
  }
  if (signal.aborted) return null;
  if (platform === 'darwin' || windowsSecure) {
    const custom = secure === undefined ? !!env.CLAUDE_CONFIG_DIR : !!secure;
    const suffix = custom ? '-' + createHash('sha256').update(secure === undefined ? config : secure.normalize('NFC')).digest('hex').slice(0, 8) : '';
    const service = `Claude Code-credentials${suffix}`;
    const stored = windowsSecure ? await windowsCredential(service, { env, signal, execute }, nativeRead) : await keychainCredential(service, signal, execute);
    if (!stored || !stored.missing) return stored?.credentials || null;
  }
  return signal.aborted ? null : readJson(path.join(folder, '.credentials.json'), readFile, signal);
}

function retryAfter(value, now) {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
}

// Only sanitized outcomes leave this function, including errors thrown by fetch,
// body parsing, files or Keychain. A fresh token is read for each attempt.
async function readClaudeAccount({ env = process.env, home = os.homedir(), platform = process.platform, cwd,
  routes = [{ cwd, env }], readFile = fs.readFile, execute = execFile, nativeRead = readWindowsCredentials, fetch = globalThis.fetch, now = Date.now,
  signal, timeout = 5000, setTimeout: later = setTimeout, clearTimeout: clear = clearTimeout, beforeRequest = () => true } = {}) {
  if (signal?.aborted) return skipped('cancelled');
  if (routeOverride(env) || !routes.length) return skipped('route');
  const controller = new AbortController();
  let timer, cancel;
  const stopped = new Promise(resolve => {
    cancel = () => { controller.abort(); resolve(skipped('cancelled')); };
    signal?.addEventListener('abort', cancel, { once: true });
    timer = later(() => { controller.abort(); resolve({ state: 'error', reason: 'timeout' }); }, timeout);
    timer.unref?.();
  });
  const query = async () => {
    try {
      if (!await officialRoute(env, home, routes, readFile, controller.signal)) return skipped('route');
      if (controller.signal.aborted) return skipped('cancelled');
      const stored = await credentialsFrom({ env, home, platform, readFile, execute, nativeRead, signal: controller.signal });
      const oauth = stored?.claudeAiOauth;
      if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken.trim() || /[\r\n]/.test(oauth.accessToken)) return skipped('credentials');
      if (!Array.isArray(oauth.scopes) || !['user:inference', 'user:profile'].every(scope => oauth.scopes.includes(scope))) return skipped('scope');
      if (!Number.isFinite(oauth.expiresAt) || oauth.expiresAt <= now()) return skipped('expired');
      if (controller.signal.aborted) return skipped('cancelled');
      if (!beforeRequest()) return skipped('throttled');
      const response = await fetch(USAGE_URL, { method: 'GET', redirect: 'error', signal: controller.signal, headers: {
        Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-cli/2.1.312 (external, cli)', 'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
      } });
      if (controller.signal.aborted) return skipped('cancelled');
      const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
      if (status == null || status < 200 || status >= 300) {
        void response.body?.cancel().catch(() => {});
        return { state: 'error', reason: 'http', status,
          retryAfterMs: status === 429 || status >= 500 ? retryAfter(response.headers?.get('retry-after'), now()) : 0 };
      }
      const account = claudeUsageResult(await response.json(), now());
      if (controller.signal.aborted) return skipped('cancelled');
      return account ? { state: 'ready', status, account } : { state: 'error', reason: 'response', status };
    } catch { return { state: 'error', reason: controller.signal.aborted ? 'cancelled' : 'query' }; }
  };
  try { return await Promise.race([query(), stopped]); }
  finally { clear(timer); signal?.removeEventListener('abort', cancel); }
}

class ClaudeAccountUsage {
  constructor({ read = readClaudeAccount, changed = () => {}, now = Date.now, setTimeout: later = setTimeout, clearTimeout: clear = clearTimeout } = {}) {
    this.read = read; this.changed = changed; this.now = now; this.later = later; this.clear = clear;
    this.active = false; this.disposed = false; this.generation = 0; this.timer = null; this.controller = null;
    this.nextAt = 0; this.requestAt = -Infinity; this.failures = 0; this.account = null;
  }
  setActive(active) {
    if (this.disposed || this.active === active) return;
    this.active = active;
    if (active) { this.refresh(); return; }
    ++this.generation;
    this.clear(this.timer); this.timer = null;
    this.controller?.abort(); this.controller = null;
  }
  refresh() {
    if (!this.active || this.disposed || this.controller || this.timer !== null) return;
    this.timer = this.later(() => { this.timer = null; void this.poll(); }, Math.min(2147483647, Math.max(250, this.nextAt - this.now())));
    this.timer.unref?.();
  }
  async poll() {
    if (!this.active || this.disposed || this.controller) return;
    if (this.now() < this.nextAt) { this.refresh(); return; }
    const generation = this.generation, controller = this.controller = new AbortController();
    this.nextAt = this.now() + POLL_INTERVAL;
    try {
      const result = await Promise.resolve().then(() => this.read({ signal: controller.signal, beforeRequest: () => {
        if (controller.signal.aborted || generation !== this.generation || !this.active || this.disposed || this.now() - this.requestAt < POLL_INTERVAL) return false;
        this.requestAt = this.now(); this.nextAt = Math.max(this.nextAt, this.requestAt + POLL_INTERVAL);
        return true;
      } })).catch(() => ({ state: 'error', reason: 'query' }));
      if (generation !== this.generation || controller.signal.aborted || !this.active || this.disposed) return;
      const transient = result?.state === 'error' && (result.status === 429 || result.status >= 500 || ['query', 'timeout'].includes(result.reason));
      this.failures = transient ? this.failures + 1 : 0;
      const delay = Math.max(Math.min(900000, POLL_INTERVAL * 2 ** Math.min(this.failures ? this.failures - 1 : 0, 4)), result?.retryAfterMs || 0);
      this.nextAt = Math.max(this.nextAt, this.now() + delay);
      if (result?.state === 'ready' && result.account) { this.account = result.account; this.changed(this.account); }
    } finally {
      if (this.controller === controller) { this.controller = null; this.refresh(); }
    }
  }
  dispose() { this.setActive(false); this.disposed = true; }
}

module.exports = { ClaudeAccountUsage, readClaudeAccount, claudeUsageResult, POLL_INTERVAL, DIRECT_USAGE_FRESH_MS };
