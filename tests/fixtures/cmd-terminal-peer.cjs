// Owns the pseudoterminal in a separate process so Windows console handles cannot keep the test runner open.
const { spawn } = require('node-pty');
const [, , cmd, bootstrap, ...lines] = process.argv;
const terminal = spawn(cmd, ['/d', '/q', '/k', bootstrap], { cwd: process.cwd(), env: process.env, cols: 180, rows: 40 });
const marker = 'Agentrix;prompt;';
lines.push('exit 0');
let output = '', prompt = 0;
terminal.onData(data => {
  output += data;
  const next = output.indexOf(marker, prompt);
  if (next < 0 || !lines.length) return;
  prompt = next + marker.length;
  terminal.write(lines.shift() + '\r');
});
terminal.onExit(({ exitCode }) => {
  if (!exitCode && !lines.length) process.exit(0);
  process.stderr.write(output, () => process.exit(exitCode || 1));
});
