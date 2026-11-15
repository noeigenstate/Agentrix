// What a stand-in tells a test about how it was started (tests/fake-cli-contract.test.cjs). When AGENTRIX_STAND_IN_ECHO
// names a file, the stand-in writes there, before it does anything else, the arguments it was given, the settings named
// by --settings (a file or inline JSON, as Claude Code takes it) and the hooks in them. A Codex stand-in has no hooks:
// its echo carries the arguments only. Without the variable nothing is written.
const fs = require('node:fs');

function settingsOf(argv) {
  const at = argv.findIndex(argument => argument === '--settings' || argument.startsWith('--settings='));
  if (at < 0) return null;
  const value = argv[at].includes('=') ? argv[at].slice('--settings='.length) : argv[at + 1];
  if (!value) return { error: '--settings has no value' };
  try { return JSON.parse(value.trim().startsWith('{') ? value : fs.readFileSync(value, 'utf8')); }
  catch (error) { return { error: error.message }; }
}

module.exports = function echoStartup(argv = process.argv.slice(2)) {
  const file = process.env.AGENTRIX_STAND_IN_ECHO;
  if (!file) return;
  const settings = settingsOf(argv);
  fs.writeFileSync(file, JSON.stringify({ argv, settings, hooks: settings?.hooks ?? null }));
};
