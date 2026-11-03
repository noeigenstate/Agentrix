// Reuse the trusted executor with Windows' standard input pipe; no Unix fd inheritance is assumed.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const childProcess = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function launchError(error, phase) {
  return Object.assign(new Error('Windows lab child process could not start.'), {
    code: /^E[A-Z0-9_]{1,31}$/.test(error?.code) ? error.code : 'EIO', phase,
    errno: Number.isInteger(error?.errno) ? error.errno : 0,
  });
}

// libuv's automatic stdio pipes use a non-LOCAL name and retry ACCESS_DENIED forever in an AppContainer.
// Explicit LOCAL endpoints use uv_pipe_bind/connect once; spawn inherits their handles instead of creating pipes.
function localPipe(signal) {
  return new Promise((resolve, reject) => {
    const server = net.createServer({ allowHalfOpen: true, pauseOnConnect: true });
    let remote, local, connected = false, settled = false;
    const close = () => {
      remote?.destroy(); local?.destroy();
      try { server.close(); } catch {}
    };
    const finish = error => {
      if (settled) return;
      if (!error && (!local || !connected)) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (error) { close(); reject(error); }
      else { server.close(); resolve({ local, remote, close }); }
    };
    const abort = () => finish(Object.assign(new Error(), { code: 'ECANCELED' }));
    const timer = setTimeout(() => finish(Object.assign(new Error(), { code: 'ETIMEDOUT' })), 3000);
    signal.addEventListener('abort', abort, { once: true });
    server.on('error', finish);
    server.once('connection', socket => {
      if (settled) return socket.destroy();
      local = socket; local.on('error', finish); finish();
    });
    if (signal.aborted) return abort();
    server.listen('\\\\.\\pipe\\LOCAL\\agentrix-lab-stdio-' + randomUUID(), () => {
      if (settled) return close();
      try {
        remote = net.connect(server.address()); remote.pause();
        remote.on('error', finish);
        remote.once('connect', () => { connected = true; finish(); });
      } catch (error) { finish(error); }
    });
  });
}

function spawnWithLocalPipes(file, args, options = {}, trace = () => {}) {
  const launchOptions = { ...options, windowsHide: true, detached: false };
  if (process.platform !== 'win32') return childProcess.spawn(file, args, launchOptions);
  const io = Array.isArray(options.stdio) ? Array.from({ length: 3 }, (_, i) => options.stdio[i] ?? 'pipe') :
    Array(3).fill(options.stdio || 'pipe');
  const piped = value => value === 'pipe' || value === 'overlapped';
  const child = new EventEmitter(), control = new AbortController(), pairs = [];
  let actual, closed = false, failed = false, phase = 'stdio';
  child.stdio = io.map(value => piped(value) ? new PassThrough() : null);
  [child.stdin, child.stdout, child.stderr] = child.stdio;
  child.stdin?.on('error', () => {});
  child.exitCode = null; child.signalCode = null; child.killed = false;
  child.kill = signal => {
    child.killed = true;
    if (actual) return actual.kill(signal);
    control.abort(); return true;
  };
  child.ref = () => { actual?.ref(); return child; };
  child.unref = () => { actual?.unref(); return child; };
  const close = (code, signal) => {
    if (closed) return;
    closed = true; control.abort();
    for (const pair of pairs) pair?.close();
    child.stdin?.destroy(); child.stdout?.end(); child.stderr?.end();
    child.exitCode = code; child.signalCode = signal;
    child.emit('close', code, signal);
  };
  const fail = (error, at = phase) => {
    if (failed || closed) return;
    failed = true; control.abort();
    const failure = launchError(error, at);
    trace('launch error phase=' + failure.phase + ' code=' + failure.code + ' errno=' + failure.errno);
    child.emit('error', failure);
    if (actual?.pid) { actual.kill(); for (const pair of pairs) pair?.close(); }
    else close(1, null);
  };
  void (async () => {
    trace('stdio setup');
    if ((Array.isArray(options.stdio) && options.stdio.length > 3) || io.includes('ipc')) throw Object.assign(new Error(), { code: 'ENOTSUP' });
    const stdio = await Promise.all(io.map(async (value, index) => {
      if (!piped(value)) return value === 'inherit' ? index : value;
      const pair = await localPipe(control.signal);
      if (control.signal.aborted) { pair.close(); throw Object.assign(new Error(), { code: 'ECANCELED' }); }
      pairs[index] = pair; return pair.remote;
    }));
    if (control.signal.aborted) throw Object.assign(new Error(), { code: 'ECANCELED' });
    trace('stdio ready'); phase = 'spawn'; trace('spawn begin');
    actual = childProcess.spawn(file, args, { ...launchOptions, stdio });
    trace('spawn returned'); child.pid = actual.pid;
    const drained = [];
    for (const [index, pair] of pairs.entries()) {
      if (!pair) continue;
      pair.local.on('error', error => fail(error, 'stdio'));
      if (index === 0) {
        pair.local.once('finish', () => pair.local.destroy());
        child.stdin.pipe(pair.local);
      } else {
        drained.push(new Promise(resolve => pair.local.once('close', resolve)));
        pair.local.once('end', () => pair.local.destroy());
        pair.local.pipe(child.stdio[index]);
      }
      // spawn duplicated these handles. Closing our copies is necessary for the child's EOF to reach the reader.
      pair.remote.destroy();
    }
    actual.once('spawn', () => { child.pid = actual.pid; child.emit('spawn'); });
    actual.once('error', fail);
    actual.once('exit', (code, signal) => {
      child.exitCode = code; child.signalCode = signal; child.stdin?.destroy();
      child.emit('exit', code, signal);
    });
    actual.once('close', (code, signal) => { void Promise.all(drained).then(() => close(failed ? 1 : code, signal)); });
  })().catch(fail);
  return child;
}

module.exports = { spawnWithLocalPipes };
if (require.main === module) {
  let source = fs.readFileSync(path.join(__dirname, 'executor.cjs'), 'utf8');
  for (const [from, to] of [
    ["const { spawn } = require('node:child_process');",
      "const { spawnWithLocalPipes } = require('./sandbox-win32-executor.cjs'); const spawn = (file, args, options) => spawnWithLocalPipes(file, args, options, trace);"],
    ["const input = fs.createReadStream(null, { fd: 3, autoClose: false, encoding: 'utf8' });",
      "trace('input wait'); const input = process.stdin; input.setEncoding('utf8');"],
    ["input.on('data', chunk => {", "input.on('data', chunk => { if (!tracedInput) { trace('input first bytes=' + Buffer.byteLength(chunk)); tracedInput = true; }"],
    ["input.on('end', () => {", "input.on('end', () => { trace('input end chars=' + data.length);"],
    ['fs.closeSync(3);', 'input.destroy();'],
    ["fs.writeSync(4, '1')", 'fs.writeSync(2, startMarker)'],
    ['const { config, bootstrap, modules } = payload;',
      'const { config, bootstrap, modules } = payload; startMarker = config.startMarker; delete config.startMarker; ' +
      "Object.assign(process.env, config.isolatedEnvironment); delete config.isolatedEnvironment; trace('payload parsed');"],
    ['const child = spawn(file, args, { ...options, env, detached: false });',
      "const child = spawn(file, args, { ...options, env, detached: false }); " +
      "child.once('spawn', () => trace('child spawned pid=' + child.pid)); " +
      "child.once('error', error => trace('child error code=' + error.code)); " +
      "child.once('exit', code => trace('child exit code=' + code));"],
    ['void execute(payload).then(code => { process.exitCode = code; }, error => {',
      "void execute(payload).then(code => { trace('complete code=' + code); process.exitCode = code; }, error => { trace('execute failed');"],
  ]) {
    if (!source.includes(from)) throw new Error('The trusted lab executor has changed.');
    source = source.replace(from, to);
  }
  const prelude = `let startMarker, tracedInput = false;
  const diagnostic = process.env.AGENTRIX_LAB_DIAGNOSTICS === '1';
  delete process.env.AGENTRIX_LAB_DIAGNOSTICS;
  function trace(message) { if (diagnostic) process.stderr.write('[lab-win32] executor ' + message + '\\n'); }
  trace('entry');
  `;
  module._compile(prelude + source, path.join(__dirname, 'executor.cjs'));
}
