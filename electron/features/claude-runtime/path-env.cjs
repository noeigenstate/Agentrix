const path = require('node:path');
const { execFile } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const STORED_PATH_TIMEOUT_MS = 5000;

// An environment variable by name, in any letter case (Windows names are case-insensitive; a copied env keeps its spelling).
const variable = (env, name) => env[name] ?? Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];

// .NET's Environment.ExpandEnvironmentVariables: %NAME% of a defined variable becomes its value, anything else stays.
const expand = (value, env) => value.replace(/%([^%]+)%/g, (whole, name) => variable(env, name) ?? whole);

// The Node twin of integration/refresh-path.ps1, which terminals run: the inherited PATH first, then every entry of the
// stored machine and user PATH (each expanded against the environment) that it lacks. An entry is kept as written
// (trimmed); two are the same folder when they match without quotes, with / as \ and without a trailing \ (except
// on a drive root), letter case ignored. tests/claude-runtime-path-env.test.cjs runs both on the same inputs.
function mergePath(inherited, stored, env = {}) {
  const parts = [], seen = new Set();
  for (const source of [String(inherited ?? ''), ...stored.filter(value => typeof value === 'string').map(value => expand(value, env))]) {
    for (const part of source.split(';')) {
      const entry = part.trim();
      if (!entry) continue;
      let key = entry.replace(/^"+|"+$/g, '').replaceAll('/', '\\');
      if (key.length > 3) key = key.replace(/\\+$/, '');
      key = key.toUpperCase();
      if (!seen.has(key)) { seen.add(key); parts.push(entry); }
    }
  }
  return parts.join(';');
}

// The PATH Windows keeps for new processes, machine then user, as refresh-path.ps1 reads them. Nothing is written. It
// runs the PowerShell of the environment's own SystemRoot (an environment without one reads nothing); base64 keeps a
// non-ASCII folder intact whatever the console code page. A scope that cannot be read is left out, and a read that
// fails or takes too long gives null.
function readStoredPath(env, { run = execFile, timeoutMs = STORED_PATH_TIMEOUT_MS } = {}) {
  const root = variable(env, 'SystemRoot');
  if (!root) return Promise.resolve(null);
  const script = "$p=foreach($s in 'Machine','User'){try{[string][Environment]::GetEnvironmentVariable('Path',$s)}catch{''}};"
    + "[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($p -join [char]0))))";
  return new Promise(resolve => {
    try {
      run(path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: timeoutMs, env }, (error, stdout) => resolve(error ? null : Buffer.from(String(stdout).trim(), 'base64').toString('utf8').split('\0')));
    } catch { resolve(null); }
  });
}

// Keep locator cache publication ordered. Callers with different environments wait for their own search.
function queueSearch(answer, normalized) {
  const queue = [];
  function start() {
    const entry = queue[0];
    const finish = (settle, value) => {
      queue.shift();
      settle(value);
      if (queue.length) start();
    };
    answer(entry.options, entry.mode).then(value => finish(entry.resolve, value), error => finish(entry.reject, error));
  }
  return (input, mode) => {
    const options = normalized(input);
    const full = mode === 'refresh' || mode === 'scan';
    const last = queue.at(-1);
    if (last && isDeepStrictEqual(last.options, options) && (!full || queue.length > 1 && last.mode === mode)) return last.promise;
    const entry = { options, mode };
    entry.promise = new Promise((resolve, reject) => Object.assign(entry, { resolve, reject }));
    queue.push(entry);
    if (queue.length === 1) start();
    return entry.promise;
  };
}

module.exports = { mergePath, readStoredPath, variable, queueSearch };
