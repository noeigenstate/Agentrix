// Offline child used by packaged provider smokes. It cannot discover credentials or call a network API.
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
