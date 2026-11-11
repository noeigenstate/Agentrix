const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { randomUUID } = require('node:crypto');

// A ChildProcess-shaped byte transport. Remote PIDs never enter local kill APIs.
function createRemoteCodexProcess(connection) {
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
    connection.events.off('codex-process', receive); connection.events.off('exit', disconnected);
    child.stdout.end(); child.stderr.end(); child.emit('exit', code, null); child.emit('close', code, null);
  };
  const receive = message => {
    if (message.processId !== processId) return;
    if (message.type === 'codex-exit') finish(message.code);
    else (message.stream === 'stderr' ? child.stderr : child.stdout).write(Buffer.from(message.data, 'base64'));
  };
  const disconnected = () => finish(255);
  connection.events.on('codex-process', receive); connection.events.on('exit', disconnected);
  // The remote looks Codex up in a login shell before starting it; a caller's handshake deadline starts after this.
  const opened = child.opened = connection.request('codex-open', { processId }, { timeout: 30000, timeoutMessage: '远端启动 Codex 超时，请重试。' });
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      void opened.then(async () => {
        for (let at = 0; at < chunk.length; at += 32768) await connection.request('codex-input', {
          processId, data: chunk.subarray(at, at + 32768).toString('base64'),
        });
      }).then(() => done(), done);
    },
    final(done) { void opened.then(() => connection.request('codex-eof', { processId })).then(() => done(), done); },
  });
  void opened.catch(error => { child.emit('error', error); finish(1); });
  child.kill = () => { void opened.then(() => connection.request('codex-close', { processId })).catch(() => finish(255)); return true; };
  return child;
}
module.exports = { createRemoteCodexProcess };
