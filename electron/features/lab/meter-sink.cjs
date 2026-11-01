const net = require('node:net');

function meterSink(bootstrap) {
  let pending = Promise.resolve();
  return event => {
    if (!bootstrap) return Promise.resolve();
    pending = pending.then(() => new Promise(resolve => {
      const socket = net.connect(bootstrap.pipeName);
      let answer = '', acknowledged = false;
      socket.setEncoding('utf8');
      socket.on('data', data => {
        answer += data;
        try { acknowledged = JSON.parse(answer.trim()).ok === true; } catch {}
      });
      socket.setTimeout(2000, () => socket.destroy());
      socket.on('error', () => socket.destroy());
      socket.once('close', () => resolve(acknowledged));
      socket.once('connect', () => socket.end(JSON.stringify({
        ...event, sessionKey: bootstrap.sessionKey, projectId: bootstrap.projectId,
      }) + '\n'));
    }));
    return pending;
  };
}

module.exports = { meterSink };
