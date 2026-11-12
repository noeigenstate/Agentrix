// The three permissions a native Codex session can run with, in the order they are offered: 'full' asks nothing and uses no sandbox, 'config'
// leaves both to Codex's own config.toml, 'ask' writes only in the working directory and asks first. The window reads the same names from
// src/shared/codex-permissions.ts; the Codex runtime keeps its own table (it travels to SSH hosts alone). tests/codex-permissions.test.cjs holds
// the three equal.
const CODEX_PERMISSIONS = Object.freeze(['full', 'config', 'ask']);
module.exports = { CODEX_PERMISSIONS };
