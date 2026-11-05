// Runs only as an owned test child. Exiting explicitly releases node-pty's Windows console handles.
const pty = require('node-pty');
let terminal;
process.on('message', async message => {
  if (message.type === 'start') {
    terminal = pty.spawn(message.cli, ['--model', 'claude-sonnet-4-5', ...message.args], { cwd: message.cwd, env: message.env, cols: 120, rows: 40 });
    terminal.onData(data => { if (message.capture && process.connected) process.send({ type: 'data', data }); });
    setTimeout(() => process.send({ type: 'ready' }), 6000);
  } else if (message.type === 'input') {
    terminal.write(message.paste ? '\x1b[200~' + message.text + '\x1b[201~' : message.text);
    setTimeout(() => terminal.write('\r'), 400);
  } else if (message.type === 'stop') {
    try { terminal.kill(); } catch {}
    setTimeout(() => process.exit(0), 150);
  }
});
process.on('disconnect', () => { try { terminal?.kill(); } catch {} process.exit(0); });
