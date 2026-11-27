const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { randomUUID } = require('node:crypto');

// A ChildProcess-shaped byte transport. Remote PIDs never enter local kill APIs.
function createRemoteProcess(connection, { protocol, timeoutMessage, openOptions }) {
  const child = new EventEmitter(), processId = randomUUID();
  child.on('error', () => {});
  child.remote = true; child.exitCode = null; child.signalCode = null;
  child.remoteScope = connection.link?.key || null;
  child.dispose = () => connection.close();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let ended = false;
  const finish = code => {
    if (ended) return;
    ended = true; child.exitCode = code;
    connection.events.off(`${protocol}-process`, receive); connection.events.off('exit', disconnected);
    child.stdout.end(); child.stderr.end(); child.emit('exit', code, null); child.emit('close', code, null);
  };
  const receive = message => {
    if (message.processId !== processId) return;
    if (message.type === `${protocol}-exit`) finish(message.code);
    else (message.stream === 'stderr' ? child.stderr : child.stdout).write(Buffer.from(message.data, 'base64'));
  };
  const disconnected = () => finish(255);
  connection.events.on(`${protocol}-process`, receive); connection.events.on('exit', disconnected);
  const request = (op, fields, options) => connection.request(`${protocol}-${op}`, { processId, ...fields }, options);
  // The login-shell lookup runs before the provider handshake.
  const opened = child.opened = request('open', openOptions, { timeout: 30000, timeoutMessage });
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      void opened.then(async () => {
        for (let at = 0; at < chunk.length; at += 32768) await request('input', {
          data: chunk.subarray(at, at + 32768).toString('base64'),
        });
      }).then(() => done(), done);
    },
    final(done) { void opened.then(() => request('eof')).then(() => done(), done); },
  });
  void opened.catch(error => { child.emit('error', error); finish(1); });
  child.stop = () => opened.then(() => request('close'));
  child.kill = () => { void child.stop().catch(() => finish(255)); return true; };
  return child;
}
function createRemoteCodexProcess(connection) {
  return createRemoteProcess(connection, { protocol: 'codex', timeoutMessage: '远端启动 Codex 超时，请重试。' });
}
function createRemoteAgyProcess(connection, options) {
  return createRemoteProcess(connection, { protocol: 'agy', timeoutMessage: '远端启动 Google Antigravity CLI（agy）超时，请重试。', openOptions: options });
}
module.exports = { createRemoteCodexProcess, createRemoteAgyProcess };
