const fs = require('node:fs');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { mock } = require('node:test');

// Keep the worker and its durable outbox real. Record the advisory wake
// synchronously so pipe scheduling cannot inject a transport diagnostic.
function captureDispatchWakes(address, file) {
  const connect = net.connect;
  mock.method(net, 'connect', (...args) => {
    if (args[0] !== address) return connect(...args);
    const socket = new EventEmitter();
    socket.setTimeout = () => {};
    socket.end = (frame, written) => {
      fs.appendFileSync(file, JSON.stringify([JSON.parse(frame), Date.now()]) + '\n');
      written();
      socket.emit('close');
    };
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  });
}

module.exports = { captureDispatchWakes };
