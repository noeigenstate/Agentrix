// Public, read-only entrypoint. It can request a bounded dispatch, but has no metering key or access to the trusted runtime.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'client.json'), 'utf8'));
const socket = net.connect(config.address);
let tail = '', ended = false;
socket.on('connect', () => socket.write(JSON.stringify({
  capability: config.capability, args: process.argv.slice(2), cwd: process.cwd(),
}) + '\n'));
socket.setEncoding('utf8');
socket.on('data', chunk => {
  tail += chunk;
  const lines = tail.split('\n'); tail = lines.pop();
  for (const line of lines) {
    let message;
    try { message = JSON.parse(line); } catch { socket.destroy(); break; }
    if (typeof message.output === 'string') process.stdout.write(message.output);
    if (Number.isInteger(message.exitCode)) {
      ended = true; process.exitCode = message.exitCode; socket.end();
    }
  }
});
socket.on('error', error => { console.error(error.message); process.exitCode = 1; });
socket.on('close', () => { if (!ended) process.exitCode = 1; });
