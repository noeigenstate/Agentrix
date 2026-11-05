const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { WebSocketServer } = require('ws');
const { JsonLines, CodexProtocol, writeJson, MAX_BYTES } = require('./codex-protocol.cjs');

// Explicit standalone terminal probes only; the product refuses Codex TUI launches.
const { resolveCli } = require('./codex-cli-resolution.cjs');

function createNativeSession({ binding, mode, cwd, env, pty, changed = () => {}, event = () => {}, launch = spawn, cli }) {
  if (mode !== 'codex-native' || binding.provider !== 'codex') throw new Error('Invalid native provider/mode binding');
  cli ??= resolveCli('codex', env);
  const events = new EventEmitter();
  let child, tui, server, socket, ended = false, connected = false;
  const cleanEnv = { ...env }; delete cleanEnv.ELECTRON_RUN_AS_NODE; delete cleanEnv.AGENTRIX_NATIVE_REMOTE_TOKEN;
  const cliEnv = cli.node ? { ...cleanEnv, ELECTRON_RUN_AS_NODE: '1' } : cleanEnv;
  const output = text => { if (!ended) events.emit('data', text); };
  const finish = (reason, exitCode = 1) => {
    if (ended) return;
    ended = true; clearTimeout(connectTimer); protocol.close();
    socket?.terminate(); server?.close(); child?.stdin.destroy(); child?.kill(); tui?.kill();
    if (reason) terminal.error = reason; events.emit('exit', { exitCode }); changed();
  };
  const write = message => writeJson(child.stdin, message, reason => finish(reason));
  const protocol = new CodexProtocol(reason => finish(reason));
  const terminal = {
    mode,
    onData: callback => { events.on('data', callback); return { dispose: () => events.off('data', callback) }; },
    onExit: callback => { events.on('exit', callback); return { dispose: () => events.off('exit', callback) }; },
    resize: (cols, rows) => tui?.resize(cols, rows), kill: () => finish(null, 0),
    write: data => { if (tui && !ended) tui.write(data); },
  };
  const connectTimer = setTimeout(() => finish('native-startup-timeout'), 30000); connectTimer.unref();
  const spawnCli = args => {
    const process = launch(cli.file, [...cli.prefix, ...args], { cwd, env: cliEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    process.on('error', () => finish('native-process-error'));
    process.on('exit', code => finish('native-process-exit', code ?? 1));
    process.stdin.on('error', () => finish('native-stdin-error'));
    process.stderr.on('data', () => {}); // do not expose diagnostics that may contain account/config data
    return process;
  };
  const readStdout = receive => {
    const lines = new JsonLines(receive, reason => finish(reason));
    child.stdout.on('data', bytes => lines.push(bytes));
    child.stdout.on('end', () => { lines.end(); finish('native-stream-ended'); });
  };
  // Defer until the caller installed all terminal listeners and session binding.
  queueMicrotask(async () => {
    try {
      if (ended) return;
      const token = randomBytes(32).toString('hex');
      server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: MAX_BYTES, perMessageDeflate: false,
        verifyClient: ({ req }, done) => {
          const value = Buffer.from(req.headers.authorization || ''); const expected = Buffer.from(`Bearer ${token}`);
          done(!connected && !req.headers.origin && value.length === expected.length && timingSafeEqual(value, expected), 401);
        } });
      server.on('error', () => finish('native-proxy-error'));
      await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
      if (ended) { server.close(); return; }
      server.on('connection', client => {
        try {
        if (ended || connected) { client.terminate(); return; }
        connected = true; socket = client; clearTimeout(connectTimer);
        child = spawnCli(['app-server', '--listen', 'stdio://', ...(env.AGENTRIX_READING_NOTE ? ['-c', `developer_instructions=${JSON.stringify(env.AGENTRIX_READING_NOTE)}`] : [])]);
        readStdout(message => {
          if (protocol.server(message) && !ended) {
            if (client.bufferedAmount > MAX_BYTES) { finish('native-websocket-backpressure'); return; }
            client.send(JSON.stringify(message), error => { if (error) finish('native-websocket-write-error'); });
          }
          if (!ended) event(message);
        });
        client.on('message', (data, binary) => {
          try {
            if (binary) throw new Error();
            const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
            if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error();
            if (!protocol.client(message) || ended) return;
            write(message);
          } catch { finish('malformed-client-stream'); }
        });
        client.on('close', () => finish('native-disconnected')); client.on('error', () => finish('native-websocket-error'));
        } catch { finish('native-server-launch-failed'); }
      });
      const address = `ws://127.0.0.1:${server.address().port}`;
      const tokenEnv = 'AGENTRIX_NATIVE_REMOTE_TOKEN';
      tui = pty.spawn(cli.file, [...cli.prefix, '--remote', address, '--remote-auth-token-env', tokenEnv], {
        name: 'xterm-256color', cols: 90, rows: 22, cwd, env: { ...cliEnv, [tokenEnv]: token },
        ...(process.platform === 'win32' ? { useConpty: true, useConptyDll: true } : {}),
      });
      tui.onData(output); tui.onExit(({ exitCode }) => finish(null, exitCode));
      tui.on?.('error', () => finish('native-tui-stream-error'));
    } catch { finish('native-launch-failed'); }
  });
  return terminal;
}

module.exports = { createNativeSession, resolveCli };
