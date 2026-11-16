// The folder of Agentrix's own codex and claude shims (C-8) holds this file. A CLI locator never searches a folder that
// holds it: a shim found there would run the dispatcher instead of the CLI it stands for. Plain Node: the dispatch
// helper carries this file.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
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
// app-server starts with the planner's env, and the protocol takes no env. A line put first applies withoutShims' rules
// in that shell, then the owner's text follows on its own line, unchanged. The line is added only for a shell whose
// syntax it is written in (ownerShell); any other shell (fish, cmd) runs the text as typed, with the shims.
// PowerShell's line is inline, since Codex runs it with -Command under any execution policy, and it is skipped outside
// FullLanguage mode (AppLocker or WDAC), where its calls would only print errors. Codex reports the text it ran as the
// command's action, from which typedCommand reads back what the owner typed.
const OWNER_PREFIX = {
  powershell: 'if ($ExecutionContext.SessionState.LanguageMode -eq "FullLanguage") { & {'
    + ' $env:Path = ($env:Path -split ";" | Where-Object { $_ -and -not [IO.File]::Exists($_.Trim([char]34).TrimEnd([char]92) + "\\.agentrix-shims") }) -join ";";'
    + ' if ($env:AGENTRIX_SHIMS) { foreach ($name in "BASH_ENV", "CLAUDE_ENV_FILE", "ZDOTDIR") { [Environment]::SetEnvironmentVariable($name, [Environment]::GetEnvironmentVariable("AGENTRIX_SHIM_USER_" + $name)) } };'
    + ' Get-ChildItem Env: | Where-Object { $_.Name -match "^AGENTRIX_(?:SHIMS|SHIM_USER_[A-Z_]+|SHIM_NODE|DISPATCH_DEPTH|RUN_ID|RUN_PROOF)$" } | Remove-Item } }',
  posix: '[ ! -r "${AGENTRIX_SHIMS-}/hooks/owner.sh" ] || . "$AGENTRIX_SHIMS/hooks/owner.sh"',
};
// The POSIX shells the line is written for, named as the passwd entry Codex reads names them.
const POSIX_SHELLS = ['bash', 'zsh', 'sh', 'dash', 'ksh'];

// Which prefix the shell Codex will run an owner's command in takes, or null when that shell is not known: on Windows
// PowerShell (pwsh or powershell.exe on the session's PATH), elsewhere the user's login shell from passwd, and SHELL too.
function ownerShell({ platform = process.platform, env = process.env, userShell = () => os.userInfo().shell, exists = fs.existsSync } = {}) {
  if (platform === 'win32') {
    // Found as Codex finds it, on the session's PATH; without one there Codex falls back to cmd.
    const folders = String(Object.entries(env || {}).find(([name]) => name.toUpperCase() === 'PATH')?.[1] || '').split(';').filter(Boolean);
    return folders.some(folder => ['pwsh.exe', 'powershell.exe'].some(name => exists(path.win32.join(folder.replace(/^"|"$/g, ''), name)))) ? 'powershell' : null;
  }
  // The passwd shell decides, and a SHELL that is set must agree, in case Codex reads that instead.
  const known = shell => typeof shell === 'string' && POSIX_SHELLS.includes(path.posix.basename(shell));
  if (env?.SHELL && !known(env.SHELL)) return null;
  let shell = null;
  try { shell = userShell(); } catch { }
  return known(shell) ? 'posix' : null;
}

function ownerShellCommand(command, env, shell = ownerShell({ env })) {
  if (!env || env.AGENTRIX_SHIMS === undefined || !OWNER_PREFIX[shell]) return command;
  return `${OWNER_PREFIX[shell]}\n${command}`;
}
// What the owner typed, when a text Codex ran or rendered holds an ownerShellCommand's line; otherwise null. A rendering
// (/bin/zsh -lc '…') keeps the POSIX line verbatim, so the line is found inside it as well as at the start.
function typedCommand(text) {
  if (typeof text !== 'string') return null;
  const prefix = Object.values(OWNER_PREFIX).find(value => text.includes(value + '\n'));
  if (!prefix) return null;
  return text.startsWith(prefix + '\n') ? text.slice(prefix.length + 1) : text.replace(prefix + '\n', '');
}

module.exports = { SHIM_MARKER, STAND_IN_MARKER, SHIM_HOOKS, shimHook, withoutShims, ownerShell, ownerShellCommand, typedCommand };
