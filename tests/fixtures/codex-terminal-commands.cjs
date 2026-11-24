// The Codex CLI's own management runs: the first words after which a shell wrapper runs the CLI in the terminal
// instead of asking the host for a native session (`codex --help` of 0.167.0).

const TERMINAL_COMMANDS = ['--version', '-V', '--help', '-h', 'help', 'login', 'logout', 'mcp', 'plugin', 'app-server', 'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'archive', 'delete', 'unarchive', 'migrate-rollouts', 'migrate-nfs-db', 'exec-server', 'features'];
module.exports = { TERMINAL_COMMANDS };
