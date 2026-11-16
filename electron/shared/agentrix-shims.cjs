// The folder of Agentrix's own codex and claude shims (C-8) holds this file. A CLI locator never searches a folder that
// holds it: a shim found there would run the dispatcher instead of the CLI it stands for. Plain Node: the dispatch
// helper carries this file.
const fs = require('node:fs');
const path = require('node:path');
const SHIM_MARKER = '.agentrix-shims';
// The folder of a stand-in CLI that Agentrix's own tests build (scripts/gui-codex-env.mjs) holds this file. The Codex
// drive scan never takes a file there: the stand-in answers --version as Codex does.
const STAND_IN_MARKER = '.agentrix-stand-in';
// The start-up hooks a planner's environment replaces (integration/shims/intercept.cjs withShims); each keeps the user's
// own value as AGENTRIX_SHIM_USER_<name>.
const SHIM_HOOKS = ['BASH_ENV', 'CLAUDE_ENV_FILE', 'ZDOTDIR'];

// Whether a hook variable's value is an Agentrix hook, by where it is: in a shim folder (its folder, or one or two above,
// holds the marker: hooks/bash-env.sh, hooks/zsh), or a session's private copy of the Claude Code hook
// (bootstrap-file.cjs). integration/shims/hooks/path.sh applies the same rule in the shell.
function shimHook(value) {
  if (typeof value !== 'string' || !value) return false;
  const file = process.platform === 'win32' ? value.replace(/^\/([A-Za-z])(?=\/)/, '$1:') : value;
  const folder = path.dirname(file);
  if ([folder, path.dirname(folder), path.dirname(path.dirname(folder))].some(dir => fs.existsSync(path.join(dir, SHIM_MARKER)))) return true;
  if (!file.endsWith('-claude-env.sh')) return false;
  try { return fs.readFileSync(file, 'utf8').startsWith('# Agentrix hook'); } catch { return false; }
}

// An environment without any Agentrix instance's shims: no shim folder on PATH, the user's own start-up hooks back, and
// no depth, run identity or shim variables. An owner's terminal or typed command starts from it, inside a planner too.
// A hook variable that still names an Agentrix hook after AGENTRIX_SHIMS was lost is put back or dropped all the same.
function withoutShims(source, { exists = fs.existsSync } = {}) {
  const env = { ...source };
  for (const name of SHIM_HOOKS) {
    if (env.AGENTRIX_SHIMS === undefined && !shimHook(env[name])) continue;
    const own = env[`AGENTRIX_SHIM_USER_${name}`];
    if (own && !shimHook(own)) env[name] = own; else delete env[name];
  }
  for (const name of Object.keys(env)) {
    if (/^AGENTRIX_(?:SHIMS|SHIM_USER_[A-Z_]+|SHIM_NODE|DISPATCH_DEPTH|RUN_ID|RUN_PROOF)$/i.test(name)) delete env[name];
    else if (name.toUpperCase() === 'PATH' && typeof env[name] === 'string') env[name] = env[name].split(path.delimiter)
      .filter(folder => !folder || !exists(path.join(folder.replace(/^"|"$/g, ''), SHIM_MARKER))).join(path.delimiter);
  }
  return env;
}

// An owner's own ! command in a native Codex session: thread/shellCommand runs it in the thread's shell, which the
// app-server starts with the planner's env, and the protocol takes no env. This line runs first in that shell and applies
// withoutShims' rules there: PowerShell on Windows (inline, since Codex runs it with -Command under any execution
// policy), a POSIX shell (bash, zsh, sh) elsewhere. The owner's text follows on its own line, unchanged; Codex reports
// the text it ran as the command's one action, from which typedCommand reads back what the owner typed.
const OWNER_PREFIX = {
  win32: '& { $env:Path = ($env:Path -split ";" | Where-Object { $_ -and -not [IO.File]::Exists($_.Trim([char]34).TrimEnd([char]92) + "\\.agentrix-shims") }) -join ";";'
    + ' if ($env:AGENTRIX_SHIMS) { foreach ($name in "BASH_ENV", "CLAUDE_ENV_FILE", "ZDOTDIR") { [Environment]::SetEnvironmentVariable($name, [Environment]::GetEnvironmentVariable("AGENTRIX_SHIM_USER_" + $name)) } };'
    + ' Get-ChildItem Env: | Where-Object { $_.Name -match "^AGENTRIX_(?:SHIMS|SHIM_USER_[A-Z_]+|SHIM_NODE|DISPATCH_DEPTH|RUN_ID|RUN_PROOF)$" } | Remove-Item }',
  posix: '[ ! -r "${AGENTRIX_SHIMS-}/hooks/owner.sh" ] || . "$AGENTRIX_SHIMS/hooks/owner.sh"',
};
function ownerShellCommand(command, env, platform = process.platform) {
  if (!env || env.AGENTRIX_SHIMS === undefined) return command;
  return `${OWNER_PREFIX[platform === 'win32' ? 'win32' : 'posix']}\n${command}`;
}
// What the owner typed, when the text Codex ran is an ownerShellCommand; otherwise null.
function typedCommand(text) {
  const prefix = typeof text === 'string' && Object.values(OWNER_PREFIX).find(value => text.startsWith(value + '\n'));
  return prefix ? text.slice(prefix.length + 1) : null;
}

module.exports = { SHIM_MARKER, STAND_IN_MARKER, SHIM_HOOKS, shimHook, withoutShims, ownerShellCommand, typedCommand };
