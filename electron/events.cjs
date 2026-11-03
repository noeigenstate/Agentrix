const net = require('node:net');
const { randomUUID, randomBytes } = require('node:crypto');

// A Unix socket path holds at most 104 bytes on macOS, and the per-user temporary folder there is already about 50.
function socketAddress(name, folder = require('node:os').tmpdir()) {
  const address = require('node:path').posix.join(folder, `${name}.sock`);
  return Buffer.byteLength(address) <= 100 ? address : `/tmp/${name}.sock`;
}

// A per-launch local pipe; the renderer never receives session credentials.
async function createEventServer(onEvent, { dispatchControl } = {}) {
  const name = process.platform === 'win32' ? `agentrix-${randomUUID()}` : `pg-${randomBytes(12).toString('hex')}`;
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : socketAddress(name);
  const connections = new Set();
  const server = net.createServer(socket => {
    connections.add(socket);
    socket.setEncoding('utf8');
    socket.setTimeout(1500, () => socket.destroy());
    let buffer = '', handled = false;
    socket.on('data', data => {
      if (handled) return;
      buffer += data;
      if (Buffer.byteLength(buffer) > 65536) return socket.destroy();
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      try {
        const event = JSON.parse(buffer.slice(0, newline));
        if (event?.type === 'dispatch-control-connect' && dispatchControl) {
          socket.removeAllListeners('data'); socket.setTimeout(0);
          dispatchControl.accept(socket, { ...event, type: 'register' });
          return;
        }
        if (event && typeof event.projectId === 'string' && typeof event.sessionKey === 'string' && typeof event.type === 'string') onEvent(event);
      } catch { /* Invalid messages never affect a terminal. */ }
      socket.end();
    });
    socket.on('error', () => {});
    socket.on('close', () => connections.delete(socket));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
  return { name, address, close() { for (const socket of connections) socket.destroy(); server.close(); } };
}

module.exports = { createEventServer, socketAddress };
