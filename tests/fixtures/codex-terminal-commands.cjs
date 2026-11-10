// The Codex CLI's own management runs: the first words after which a shell wrapper runs the CLI in the terminal
// instead of asking the host for a native session (`codex --help` of 0.167.0). Each wrapper carries the words in its
// own language; wrapperCommands reads them back from its source.
const fs = require('node:fs'), path = require('node:path');

const TERMINAL_COMMANDS = ['--version', '-V', '--help', '-h', 'help', 'login', 'logout', 'mcp', 'plugin', 'app-server', 'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'archive', 'delete', 'unarchive', 'migrate-rollouts', 'migrate-nfs-db', 'exec-server', 'features'];
const SHELL_LIST = /__pg_codex_terminal\(\) \{[^}]*?case \$\{1-\} in ([^)]+)\) return 0;;/;
const WRAPPERS = {
  'bootstrap.ps1': /\$args\[0\] -cin @\(([^)]+)\)/,
  'bash-integration.bash': SHELL_LIST,
  'zsh-integration.zsh': SHELL_LIST,
  'remote-worker.py': SHELL_LIST,
};

function wrapperCommands(file) {
  const list = WRAPPERS[file].exec(fs.readFileSync(path.join(__dirname, '../../integration', file), 'utf8'))?.[1];
  return list ? list.split(/[|,]/).map(word => word.trim().replace(/^'|'$/g, '')) : null;
}

module.exports = { TERMINAL_COMMANDS, WRAPPERS, wrapperCommands };
