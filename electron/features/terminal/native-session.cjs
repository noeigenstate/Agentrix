const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { WebSocketServer } = require('ws');
const { NativeApprovals, MAX_BYTES } = require('./native-approvals.cjs');
const { JsonLines, CodexProtocol, ClaudeProtocol, writeJson } = require('./native-protocol.cjs');

// Resolve argv without invoking a shell or reading account files. Windows npm shims require their JS entrypoint.
function resolveCli(provider, env = process.env, platform = process.platform, node = process.execPath) {
  const folders = String(Object.entries(env).find(([k]) => k.toLowerCase() === 'path')?.[1] || '').split(platform === 'win32' ? ';' : ':');
  for (const folder of folders.filter(Boolean)) {
    const base = folder.replace(/"/g, '');
    if (platform === 'win32') {
      for (const file of [path.join(base, provider + '.exe'), path.join(base, 'node_modules', provider === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code', provider === 'codex' ? 'bin/codex.js' : 'cli.js')]) {
        if (fs.existsSync(file)) return file.endsWith('.js') ? { file: node, prefix: [file], node: true } : { file, prefix: [] };
      }
    } else {
      const file = path.join(base, provider);
      try { fs.accessSync(file, fs.constants.X_OK); return { file, prefix: [] }; } catch { }
    }
  }
  throw new Error(`Native ${provider} launch requires an executable in PATH (or a standard npm installation). Use legacy terminal mode for custom wrappers.`);
}

function createNativeSession({ binding, mode, cwd, env, pty, changed = () => {}, event = () => {}, launch = spawn, cli = resolveCli(binding.provider, env) }) {
  if (!['codex-native', 'claude-sdk'].includes(mode) || binding.provider !== (mode === 'claude-sdk' ? 'claude' : 'codex')) throw new Error('Invalid native provider/mode binding');
  const events = new EventEmitter();
  let child, tui, server, socket, ended = false, connected = false, sdkReady = false, managedBusy = false;
  const cleanEnv = { ...env }; delete cleanEnv.ELECTRON_RUN_AS_NODE; delete cleanEnv.AGENTRIX_NATIVE_REMOTE_TOKEN;
  const cliEnv = cli.node ? { ...cleanEnv, ELECTRON_RUN_AS_NODE: '1' } : cleanEnv;
  const output = text => { if (!ended) events.emit('data', text); };
  const finish = (reason, exitCode = 1) => {
    if (ended) return;
    ended = true; clearTimeout(connectTimer); registry.close();
    socket?.terminate(); server?.close(); child?.stdin.destroy(); child?.kill(); tui?.kill();
    if (reason) terminal.error = reason; events.emit('exit', { exitCode }); changed();
  };
  const write = message => writeJson(child.stdin, message, reason => finish(reason));
  const registry = new NativeApprovals(binding, { changed, write, fail: reason => finish(reason) });
  const terminal = {
    registry, mode,
    onData: callback => { events.on('data', callback); return { dispose: () => events.off('data', callback) }; },
    onExit: callback => { events.on('exit', callback); return { dispose: () => events.off('exit', callback) }; },
    resize: (cols, rows) => tui?.resize(cols, rows), kill: () => finish(null, 0),
    answer: answer => registry.answer(binding, answer, write),
    answerQuestion: answer => registry.answer(binding, answer, write, true),
    prompt: text => {
      if (mode !== 'claude-sdk' || ended || !sdkReady || managedBusy || registry.tokens.size || typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 65536) throw new Error('Managed session is not ready for this prompt');
      managedBusy = true;
      try { write({ type: 'user', message: { role: 'user', content: text } }); event({ type: 'managed-prompt', text }); }
      catch (error) { finish('managed-prompt-write-failed'); throw error; }
    },
    write: data => {
      if (mode === 'codex-native') { if (tui && !ended) tui.write(data); return; }
      // Managed Claude is deliberately not a TUI. Only its dedicated composer accepts prompts.
    },
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
      if (mode === 'claude-sdk') {
        child = spawnCli(['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--verbose',
          ...(env.AGENTRIX_READING_NOTE ? ['--append-system-prompt', env.AGENTRIX_READING_NOTE] : [])]);
        const protocol = new ClaudeProtocol(registry), initializeId = `agentrix-initialize-${binding.sessionId}`;
        readStdout(message => {
          if (message.type === 'control_response') {
            if (!sdkReady && message.response?.request_id === initializeId && message.response.subtype === 'success') { sdkReady = true; clearTimeout(connectTimer); output('Claude SDK managed session. Use the managed Reading composer; terminal input is disabled.\r\n'); event({ type: 'managed-ready' }); changed(); }
            else finish('unexpected-control-response');
            return;
          }
          if (!sdkReady && message.type === 'control_request') { finish('control-before-initialize'); return; }
          protocol.server(message); if (ended) return;
          if (message.type === 'result') managedBusy = false;
          event(message);
          if (message.type === 'assistant') {
            const text = message.message?.content?.filter(p => p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
            if (text) output(text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '') + '\r\n');
          }
        });
        write({ type: 'control_request', request_id: initializeId, request: { subtype: 'initialize', hooks: null } });
        return;
      }
      const token = randomBytes(32).toString('hex');
      server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: MAX_BYTES, perMessageDeflate: false,
        verifyClient: ({ req }, done) => {
          const value = Buffer.from(req.headers.authorization || ''); const expected = Buffer.from(`Bearer ${token}`);
          done(!connected && !req.headers.origin && value.length === expected.length && timingSafeEqual(value, expected), 401);
        } });
      server.on('error', () => finish('native-proxy-error'));
      await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
      if (ended) { server.close(); return; }
      const protocol = new CodexProtocol(registry);
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
            if (protocol.client(message) && !ended) write(message);
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
    } catch { finish('native-launch-failed'); }
  });
  return terminal;
}

module.exports = { createNativeSession, resolveCli };
