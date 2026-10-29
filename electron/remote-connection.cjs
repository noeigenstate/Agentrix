const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const { sshArguments, readSSHSettings } = require('./ssh-config.cjs');

// One SSH connection to a host carries every terminal opened there: the first one starts the worker on the server
// (integration/remote-worker.py) and each terminal is a channel of it, with its own folder, shell and requests. A
// terminal after the first opens without another handshake, login or password.
const links = new Map();

class RemoteLink {
  constructor(key, ssh, { integrationDir, auth, sshPath, askpassPath }) {
    this.key = key; this.auth = auth; this.channels = new Map(); this.nextChannel = 0; this.buffer = ''; this.closed = false;
    this.decoder = new StringDecoder('utf8'); this.errorDecoder = new StringDecoder('utf8');
    this.authId = randomUUID();
    const authEnv = auth.register(this.authId, ssh.host, () => this.fail(new Error('已取消 SSH 连接。')));
    const env = { ...process.env, ...authEnv, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || 'agentrix:0' };
    const askpass = askpassPath || path.join(integrationDir, process.platform === 'win32' ? 'ssh-askpass.exe' : 'ssh-askpass.sh');
    env.SSH_ASKPASS = process.platform === 'win32' ? '"' + askpass.replace(/\\/g, '/') + '"' : askpass;
    env.AGENTRIX_ASKPASS_NODE = process.execPath;
    env.AGENTRIX_ASKPASS_SCRIPT = path.join(integrationDir, 'ssh-askpass.cjs');
    // Never inherit a different application's askpass implementation.
    delete env.ELECTRON_RUN_AS_NODE;
    this.child = spawn(sshPath || readSSHSettings().sshPath, sshArguments(ssh), { env, cwd: os.homedir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('error', error => this.fail(new Error(`无法启动 SSH：${error.message}`)));
    this.child.stdout.on('data', data => this.receive(this.decoder.write(data)));
    this.child.stderr.on('data', data => {
      const text = this.errorDecoder.write(data);
      this.lastError = ((this.lastError || '') + text).slice(-4000);
      this.output(text.replace(/\r?\n/g, '\r\n'));
    });
    this.child.stdin.on('error', () => {});
    this.child.on('close', code => {
      if (!this.closed) this.fail(new Error(this.lastError?.trim() || `SSH 已断开（${code ?? '连接关闭'}），可重新连接。`));
    });
    this.child.stdin.write(zlib.deflateSync(fs.readFileSync(path.join(integrationDir, 'remote-worker.py'))).toString('base64') + '\n');
  }
  attach(connection) { const name = ++this.nextChannel; this.channels.set(name, connection); return name; }
  detach(name) {
    if (!this.channels.delete(name)) return;
    this.send({ op: 'shutdown', channel: name });
    if (!this.channels.size) this.close();
  }
  // What SSH itself says (a banner, a warning, why it failed) is shown in every terminal it carries.
  output(text) { for (const channel of this.channels.values()) channel.events.emit('data', text); }
  send(message) {
    // Put channel first so the worker can reject an oversized line before parsing the full payload.
    if (!this.closed && this.child.stdin.writable) this.child.stdin.write(JSON.stringify({ channel: message.channel, ...message }) + '\n');
  }
  open(message) {
    const skillsKey = message.skills?.key || null;
    this.send({ ...message, skillsKey, skills: skillsKey && skillsKey === this.skillsKey ? null : message.skills });
    this.skillsKey = skillsKey;
  }
  receive(text) {
    this.buffer += text;
    let index;
    while (!this.closed && (index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 2 * 1024 * 1024) { this.fail(new Error('远程连接返回的数据过大。')); return; }
      if (!line.startsWith('PGW1 ')) { if (line) this.output(line + '\r\n'); continue; }
      let message;
      try { message = JSON.parse(line.slice(5)); } catch { this.fail(new Error('远程连接返回了无效的数据。')); return; }
      if (message.channel === undefined) { if (message.type === 'error') this.fail(new Error(String(message.error || '远程连接失败。'))); }
      else this.channels.get(message.channel)?.receive(message);
    }
    if (this.buffer.length > 2 * 1024 * 1024) this.fail(new Error('远程连接返回的数据过大。'));
  }
  fail(error) {
    if (this.closed) return;
    for (const channel of [...this.channels.values()]) channel.fail(error);
    this.close();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (links.get(this.key) === this) links.delete(this.key);
    this.auth.unregister(this.authId);
    this.child.stdin.end();
    const child = this.child;
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 1000);
    timer.unref?.(); child.once('close', () => clearTimeout(timer));
  }
}

function linkFor(ssh, options) {
  const key = JSON.stringify([options.sshPath || '', ssh.configFile || '', ssh.host, options.askpassPath || '']);
  if (!links.get(key)) links.set(key, new RemoteLink(key, ssh, options));
  return links.get(key);
}

// A terminal of an SSH project, with its requests for the files, Git and conversations there.
class RemoteConnection {
  constructor(project, options) {
    const { auth, sessionKey, onEvent, onReady, codingPath, readingNote = '', skills = null } = options;
    this.project = project; this.events = new EventEmitter();
    this.pending = new Map(); this.nextId = 0; this.connected = false; this.closed = false;
    this.terminalDecoder = new StringDecoder('utf8');
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => {});
    this.onEvent = onEvent; this.onReady = onReady;
    this.link = linkFor(project.ssh, options);
    this.channel = this.link.attach(this);
    let seconds = 0;
    this.connectTimer = setInterval(() => {
      if (!auth.hasPending(this.link.authId)) seconds++;
      if (seconds > 60) this.fail(new Error('SSH 连接超时。请确认主机可连接，且远端已安装 Python 3 和 Bash。'));
    }, 1000);
    this.connectTimer.unref?.();
    this.link.open({ channel: this.channel, op: 'open', path: project.path, codingPath, projectId: project.id, token: sessionKey, cols: 90, rows: 24, readingNote, skills,
      dispatchHelper: fs.readFileSync(path.join(options.integrationDir, 'dispatch.cjs'), 'utf8'),
      dispatchModules: require(path.join(options.integrationDir, 'dispatch.cjs')).runtimeFiles() });
  }
  onData(callback) { this.events.on('data', callback); return { dispose: () => this.events.off('data', callback) }; }
  onExit(callback) { this.events.on('exit', callback); return { dispose: () => this.events.off('exit', callback) }; }
  emitExit(code) { if (!this.exited) { this.exited = true; this.events.emit('exit', { exitCode: code }); } }
  receive(message) {
    if (this.closed) return;
    switch (message.type) {
      case 'ready':
        if (typeof message.info?.root !== 'string' || !message.info.root.startsWith('/')) { this.fail(new Error('远程目录无效。')); return; }
        clearInterval(this.connectTimer);
        this.connected = true; this.info = message.info;
        this.resolveReady(message.info); this.onReady?.(message.info);
        if (this.dimensions) this.send({ op: 'resize', ...this.dimensions });
        return;
      case 'data':
        if (typeof message.data === 'string') this.events.emit('data', this.terminalDecoder.write(Buffer.from(message.data, 'base64')));
        return;
      case 'event':
        if (message.event && typeof message.event === 'object') this.onEvent?.(message.event);
        return;
      case 'exit':
        this.emitExit(Number.isInteger(message.code) ? message.code : 1);
        return;
      case 'error':
        this.fail(new Error(String(message.error || '远程连接失败。')));
        return;
      case 'response': {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id); clearTimeout(request.timer);
        if (message.ok === true) request.resolve(message.value);
        else request.reject(new Error(String(message.error || '远程请求失败。')));
      }
    }
  }
  send(message) {
    if (!this.closed) this.link.send({ ...message, channel: this.channel });
  }
  async request(op, data = {}) {
    await this.ready;
    if (this.closed) throw new Error('SSH 连接已断开，请重新连接。');
    if (this.pending.size >= 64) throw new Error('远程请求较多，请稍后重试。');
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('读取远程文件超时，请重试。')); }, 30000);
      timer.unref?.(); this.pending.set(id, { resolve, reject, timer });
      this.send({ ...data, op, id });
    });
  }
  write(data) {
    if (this.connected && !this.exited) this.send({ op: 'input', data: Buffer.from(data).toString('base64') });
  }
  resize(cols, rows) {
    this.dimensions = { cols, rows };
    if (this.connected && !this.exited) this.send({ op: 'resize', cols, rows });
  }
  fail(error) {
    if (this.closed) return;
    this.error = error.message;
    this.events.emit('data', `\r\n[SSH] ${error.message}\r\n`);
    this.close(error); this.emitExit(255);
  }
  close(error = new Error('SSH 连接已关闭。')) {
    if (this.closed) return;
    this.closed = true; this.connected = false;
    clearInterval(this.connectTimer); this.rejectReady(error);
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    this.link.detach(this.channel);
  }
  kill() { this.close(); }
}

module.exports = { RemoteConnection };
