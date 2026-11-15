// Offline child used by packaged provider smokes. It cannot discover credentials or call a network API.
// Stand-in contract (tests/fake-cli-contract.test.cjs): --version answers at once and writes nothing; AGENTRIX_STAND_IN_ECHO names the file that gets the arguments, --settings and hooks it was given.
if (process.env.AGENTRIX_STAND_IN_ECHO) require('./stand-in-echo.cjs')();
if (process.argv.includes('--version')) { console.log(process.argv[2] === 'claude' ? '2.1.317 (Claude Code)' : 'codex-cli 0.166.0'); process.exit(0); }
const readline = require('node:readline');
const mode = process.argv[2];
readline.createInterface({ input: process.stdin }).on('line', line => {
  const input = JSON.parse(line);
  if (input.type === 'stop') return process.exit(0);
  if (mode === 'claude') {
    console.log(JSON.stringify({ provider: 'claude', sessionId: input.resume || 'fake-claude-session', text: `fake Claude: ${input.text}` }));
  } else {
    console.log(JSON.stringify({ provider: 'codex', threadId: input.resume || 'fake-codex-thread', text: `fake Codex: ${input.text}` }));
  }
});
