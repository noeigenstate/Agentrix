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

// An environment without any Agentrix instance's shims: no shim folder on PATH, the user's own start-up hooks back, and
// no depth, run identity or shim variables. An owner's terminal or typed command starts from it, inside a planner too.
function withoutShims(source, { exists = fs.existsSync } = {}) {
  const env = { ...source };
  if (env.AGENTRIX_SHIMS !== undefined) for (const name of SHIM_HOOKS) {
    const own = env[`AGENTRIX_SHIM_USER_${name}`];
    if (own) env[name] = own; else delete env[name];
  }
  for (const name of Object.keys(env)) {
    if (/^AGENTRIX_(?:SHIMS|SHIM_USER_[A-Z_]+|SHIM_NODE|DISPATCH_DEPTH|RUN_ID|RUN_PROOF)$/i.test(name)) delete env[name];
    else if (name.toUpperCase() === 'PATH' && typeof env[name] === 'string') env[name] = env[name].split(path.delimiter)
      .filter(folder => !folder || !exists(path.join(folder.replace(/^"|"$/g, ''), SHIM_MARKER))).join(path.delimiter);
  }
  return env;
}

module.exports = { SHIM_MARKER, STAND_IN_MARKER, SHIM_HOOKS, withoutShims };
