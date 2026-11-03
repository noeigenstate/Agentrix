const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { command, killMarked, aborted } = require('./process.cjs');
const { inside, cleanupWorktrees } = require('./workspace.cjs');
const { removePath } = require('./disk.cjs');
const { resolveNode } = require('./runtime.cjs');
const {
  sandboxProfile, channelAddress, cliHomes, requireIsolation,
  credentialAccess, gitCredentialPaths, gitCredentialHelpers, physicalPath,
} = require('./sandbox.cjs');

async function copyHelper(helper, directory) {
  const source = await fs.readFile(helper, 'utf8'), destination = path.join(directory, 'runtime.json');
  const runtime = /const RUNTIME_FILES = (\[[\s\S]*?\]);/.exec(source);
  const modules = {};
  let instrumented = source;
  if (runtime) {
    const rate = "send({ type: 'dispatch-rate', id, ...lastRate });";
    if (!source.includes(rate)) throw new Error('The dispatch helper cannot provide authenticated live cost measurements.');
    instrumented = source.replace(rate, "send({ type: 'dispatch-rate', id, ...lastRate, ...output.usage() });");
    const meter = 'const id = randomUUID(), send = eventSink(env.AGENTRIX_BOOTSTRAP);';
    if (!instrumented.includes(meter)) throw new Error('The dispatch helper cannot isolate its metering credentials.');
    instrumented = instrumented.replace(meter, 'const id = randomUUID(), send = globalThis.__AGENTRIX_LAB_SINK;');
    instrumented = instrumented.replace(
      "path.join(__dirname, fs.existsSync(path.join(__dirname, 'electron')) ? 'electron' : '../electron')",
      "path.join(__dirname, 'electron')",
    );
    const settings = "const settings = ['-m', options.model,";
    if (!instrumented.includes(settings)) throw new Error('The dispatch helper cannot select the shared credential store.');
    instrumented = instrumented.replace(settings,
      "const settings = ['-c', 'cli_auth_credentials_store=\"file\"', '-m', options.model,");
    const root = await fs.stat(path.join(path.dirname(helper), 'electron')).catch(() => null)
      ? path.join(path.dirname(helper), 'electron') : path.resolve(path.dirname(helper), '../electron');
    for (const [, file] of runtime[1].matchAll(/'([^']+)'/g)) {
      modules['electron/' + file] = await fs.readFile(path.join(root, file), 'utf8');
    }
  }
  modules['dispatch.cjs'] = instrumented;
  await fs.writeFile(destination, JSON.stringify(modules), { mode: 0o600 });
  return destination;
}

async function localPath(file, cwd, roots, existing = false) {
  const absolute = path.resolve(cwd, file);
  let checked;
  if (existing) checked = await fs.realpath(absolute);
  else {
    const parent = await fs.realpath(path.dirname(absolute));
    const stat = await fs.lstat(absolute).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) throw new Error('A dispatch output cannot be a link.');
    checked = path.join(parent, path.basename(absolute));
  }
  if (!roots.some(root => inside(root, checked))) throw new Error('A dispatch path escapes this lab run.');
  return checked;
}

class LabSession {
  constructor(options) {
    Object.assign(this, options);
    this.privateDirectory = path.join(this.labRoot, 'private', this.runId);
    this.tools = path.join(this.labRoot, 'tools', this.runId);
    this.control = path.join(this.workspaceRoot, 'control');
    this.sockets = new Set(); this.jobs = new Set(); this.controller = new AbortController();
    this.brokerSockets = new Set(); this.brokerJobs = new Set();
    this.brokerWork = new Set();
    this.capability = randomUUID(); this.invocations = 0; this.active = false; this.closed = false; this.modelStarted = false;
  }
  async start() {
    if (this.closed || this.started) throw new Error('The lab session cannot be started again.');
    aborted(this.signal);
    await requireIsolation({ directory: this.labRoot, prompt: this.hostPrompt !== false });
    aborted(this.signal);
    this.started = true;
    this.protectedPaths = await Promise.all(this.protectedPaths.map(physicalPath));
    this.nodePath = await resolveNode({
      nodePath: this.nodePath, env: this.env, protectedPaths: this.protectedPaths, signal: this.signal, t: this.t,
    });
    this.credentialPaths = await Promise.all([
      ...gitCredentialPaths(), ...(this.credentialPaths || []),
    ].map(physicalPath));
    this.deniedExecutables = [
      ...await gitCredentialHelpers(), ...(this.deniedExecutables || []),
    ];
    for (const directory of [this.privateDirectory, this.tools, this.control]) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    }
    this.labRoot = await fs.realpath(this.labRoot);
    this.workspaceRoot = await fs.realpath(this.workspaceRoot);
    this.control = await fs.realpath(this.control); this.tools = await fs.realpath(this.tools);
    this.privateDirectory = await fs.realpath(this.privateDirectory);
    if (process.platform === 'win32') require('./sandbox-win32.cjs').register(this.runId, this.privateDirectory);
    await fs.writeFile(path.join(this.privateDirectory, 'manifest.json'), JSON.stringify({
      runId: this.runId, directory: this.directory,
    }), { mode: 0o600 });
    for (const file of ['host.cjs', 'process.cjs']) {
      await fs.copyFile(path.join(__dirname, file), path.join(this.privateDirectory, file));
    }
    if (process.platform === 'win32') {
      for (const file of ['sandbox-win32-host.cjs', 'sandbox-win32.cjs', 'sandbox-win32-native.cjs', 'sandbox-win32-preparation.cjs']) {
        await fs.copyFile(path.join(__dirname, file), path.join(this.privateDirectory, file));
      }
      await fs.copyFile(path.join(__dirname, 'sandbox-win32-executor.cjs'), path.join(this.tools, 'sandbox-win32-executor.cjs'));
    }
    this.trustedHelper = this.helper ? await copyHelper(this.helper, this.privateDirectory) : null;
    await fs.copyFile(path.join(__dirname, 'client.cjs'), path.join(this.tools, 'dispatch.cjs'));
    for (const file of ['executor.cjs', 'meter-sink.cjs']) {
      await fs.copyFile(path.join(__dirname, file), path.join(this.tools, file));
    }
    this.publicHelper = path.join(this.tools, 'dispatch.cjs');
    this.channel = await channelAddress(this.labRoot, 'rpc');
    await fs.writeFile(path.join(this.tools, 'client.json'), JSON.stringify({
      address: this.channel.address, capability: this.capability,
    }), { mode: 0o600 });
    this.server = net.createServer(socket => this.connection(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject); this.server.listen(this.channel.address, resolve);
    });
    if (process.platform !== 'win32') await fs.chmod(this.channel.address, 0o600);
    this.signalAbort = () => this.controller.abort();
    this.signal?.addEventListener('abort', this.signalAbort, { once: true });
    if (this.signal?.aborted) this.controller.abort();
    return this;
  }
  async broker(handler) {
    if (this.closed || this.brokerServer || typeof handler !== 'function') throw new Error('Invalid lab broker registration.');
    this.brokerChannel = await channelAddress(this.labRoot, 'broker');
    const capability = randomUUID();
    this.brokerEnvironment = JSON.stringify({ address: this.brokerChannel.address, capability });
    this.brokerServer = net.createServer(socket => {
      if (this.closed || this.brokerSockets.size >= 8) return socket.destroy();
      this.brokerSockets.add(socket); socket.setEncoding('utf8'); socket.setTimeout(5000, () => socket.destroy());
      const control = new AbortController();
      let buffer = '', submitted = false;
      socket.on('data', chunk => {
        if (submitted) return socket.destroy();
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 256 * 1024) return socket.destroy();
        if (!buffer.includes('\n')) return;
        submitted = true;
        const operation = (async () => {
          let timer, signal, onAbort;
          try {
            const request = JSON.parse(buffer.trim()); buffer = '';
            const { argv, stdin, timeoutMs = 120000 } = request;
            if (request.capability !== capability || this.closed || !this.active || this.controller.signal.aborted ||
              this.brokerWork.size >= 4 || !Array.isArray(argv) || !argv.length || argv.length > 256 ||
              argv.some(arg => typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg) > 8192) ||
              (stdin !== undefined && (typeof stdin !== 'string' || Buffer.byteLength(stdin) > 128 * 1024)) ||
              !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20 * 60000) throw new Error();
            socket.setTimeout(timeoutMs + 1000, () => socket.destroy());
            timer = setTimeout(() => control.abort(), timeoutMs);
            signal = AbortSignal.any([control.signal, this.controller.signal]);
            const running = Promise.resolve().then(() => handler({ argv, ...(stdin === undefined ? {} : { stdin }), timeoutMs }, { signal }));
            this.brokerWork.add(running);
            void running.finally(() => this.brokerWork.delete(running)).catch(error => {
              if (error?.infrastructure || error?.fatal) this.brokerFailure = Object.assign(new Error('Lab broker command failed.'),
                { infrastructure: true, ...(error.fatal ? { fatal: true } : {}) });
            });
            const cancelled = new Promise((resolve, reject) => {
              onAbort = () => reject(new Error('Lab broker request cancelled.'));
              signal.addEventListener('abort', onAbort, { once: true });
              if (signal.aborted) onAbort();
            });
            const result = await Promise.race([running, cancelled]);
            if (signal.aborted || !result || (result.code !== null && !Number.isInteger(result.code)) ||
              typeof result.stdout !== 'string' || typeof result.stderr !== 'string' ||
              Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 8 * 1024 * 1024) throw new Error();
            if (!socket.destroyed) socket.end(JSON.stringify({ code: result.code, stdout: result.stdout, stderr: result.stderr }) + '\n');
          } catch {
            if (!socket.destroyed) socket.end(JSON.stringify({ code: 125, stdout: '', stderr: 'Lab broker command failed.' }) + '\n');
          } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
        })();
        this.brokerJobs.add(operation); void operation.finally(() => this.brokerJobs.delete(operation));
      });
      socket.on('error', () => {});
      socket.on('close', () => { control.abort(); this.brokerSockets.delete(socket); });
    });
    await new Promise((resolve, reject) => {
      this.brokerServer.once('error', reject); this.brokerServer.listen(this.brokerChannel.address, resolve);
    });
    if (process.platform !== 'win32') await fs.chmod(this.brokerChannel.address, 0o600);
  }
  connection(socket) {
    this.sockets.add(socket); socket.setEncoding('utf8'); socket.setTimeout(30 * 60000, () => socket.destroy());
    let buffer = '', submitted = false, finished = false;
    const requestControl = new AbortController();
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 256 * 1024) return socket.destroy();
      if (submitted || !buffer.includes('\n')) return;
      submitted = true;
      void (async () => {
        try {
          const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
          if (!this.active || this.closed || !this.allowDelegation || request.capability !== this.capability) {
            throw new Error('Invalid lab dispatch request.');
          }
          const args = await this.checkArguments(request.args, request.cwd);
          const result = await this.launch(args, {
            cwd: await fs.realpath(request.cwd), signal: requestControl.signal, onLine: line => {
              if (!socket.destroyed) socket.write(JSON.stringify({ output: line + '\n' }) + '\n');
            },
          });
          finished = true;
          if (!socket.destroyed) socket.end(JSON.stringify({ exitCode: result.code ?? 1 }) + '\n');
        } catch (error) {
          finished = true;
          if (!socket.destroyed) socket.end(JSON.stringify({ output: String(error.message), exitCode: 1 }) + '\n');
        }
      })();
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      this.sockets.delete(socket);
      if (!finished) requestControl.abort();
    });
  }
  async checkArguments(args, cwd) {
    if (!Array.isArray(args) || args.length > 160 ||
      args.some(arg => typeof arg !== 'string' || arg.length > 8192 || /[\0\r\n]/.test(arg)) ||
      !['codex', 'claude', 'minutes', 'consolidate'].includes(args[0])) throw new Error('Invalid lab dispatch arguments.');
    const roots = [this.workspaceRoot];
    await localPath(cwd, cwd, roots, true);
    const inputPaths = new Set(['--cwd', '--brief', '--ledger', '--summary', '--issues', '--incidents', '--findings', '--image']);
    for (let index = 1; index < args.length; index++) {
      const option = args[index];
      if (inputPaths.has(option) || option === '--out') {
        const file = args[++index];
        if (!file) throw new Error('Missing dispatch path.');
        await localPath(file, cwd, roots, option !== '--out');
      }
      if (option === '--resume') {
        const sessionId = args[++index];
        if (![...this.usage.calls.values()].some(call => call.sessionId === sessionId)) {
          throw new Error('A lab dispatch cannot resume a session from another experiment.');
        }
      }
    }
    return args;
  }
  launch(args, options = {}) {
    aborted(this.controller.signal);
    if (this.closed || ++this.invocations > 80 || this.jobs.size >= 4) throw new Error('The lab dispatch limit was reached.');
    const running = this.launchJob(randomUUID(), args, options).finally(() => this.jobs.delete(running));
    this.jobs.add(running);
    return running;
  }
  async launchJob(job, args, {
    cwd, log, onLine, timeoutMs = 20 * 60000, command: executable, review = false, signal, network = true,
  }) {
    const root = review ? path.join(this.labRoot, 'reviews', this.runId) : this.workspaceRoot;
    await localPath(cwd, cwd, [root], true);
    const folder = review ? path.join(cwd, '.control') : path.join(this.control, job);
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const access = await credentialAccess(this.env, !executable);
    const env = await cliHomes(this.env, path.join(folder, 'home'), !executable, access);
    const search = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
    env[search] = [path.dirname(this.nodePath), env[search]].filter(Boolean).join(path.delimiter);
    Object.assign(env, { AGENTRIX_LAB_RUN: this.runId, AGENTRIX_LAB_JOB: job });
    if (!executable && this.usage?.bootstrap) env.AGENTRIX_BOOTSTRAP = this.usage.bootstrap;
    if (this.brokerEnvironment) env.AGENTRIX_LAB_BROKER = this.brokerEnvironment;
    const addresses = [this.channel.address, this.usage?.address, this.brokerChannel?.address].filter(Boolean);
    const sockets = process.platform === 'win32' ? addresses : await Promise.all(addresses.map(file => fs.realpath(file)));
    const readRoots = review ? [cwd, this.tools, ...sockets] : [
      this.workspaceRoot, this.tools, ...sockets,
    ];
    const writeRoots = review ? [cwd, ...sockets] : [this.workspaceRoot, ...sockets];
    const profile = sandboxProfile({
      labRoot: this.labRoot, readRoots, writeRoots, protectedPaths: this.protectedPaths,
      credentialPaths: this.credentialPaths, deniedExecutables: this.deniedExecutables, network, ipcPaths: sockets, ...access,
    });
    let windows;
    if (process.platform === 'win32') {
      const backend = require('./sandbox-win32.cjs');
      const runtimes = await backend.runtimeRoots({ nodePath: this.nodePath, env, command: executable, protectedPaths: this.protectedPaths });
      const physicalRead = readRoots.filter(file => !sockets.includes(file));
      const physicalWrite = writeRoots.filter(file => !sockets.includes(file));
      windows = {
        executable: backend.executable, runId: this.runId, job, labRoot: this.labRoot,
        manifest: path.join(this.privateDirectory, job + '.acl.json'), network,
        readRoots: [...physicalRead, ...runtimes], writeRoots: physicalWrite,
        credentialFiles: [access.sharedAuth, access.claudeAuth].filter(Boolean),
        blockedPaths: [this.labRoot, ...this.protectedPaths, ...this.credentialPaths,
          access.codexSource, access.claudeSource].filter(Boolean),
        pipes: sockets,
      };
      if (executable) executable = { ...executable, file: await backend.resolveExecutable(executable.file, env) };
    }
    const config = path.join(this.privateDirectory, job + '.json');
    await fs.writeFile(config, JSON.stringify({
      runId: this.runId, job, profile, helper: this.trustedHelper, args, cwd, command: executable,
      executor: path.join(this.tools, process.platform === 'win32' ? 'sandbox-win32-executor.cjs' : 'executor.cjs'), windows,
    }), { mode: 0o600 });
    const host = process.platform === 'win32' ? 'sandbox-win32-host.cjs' : 'host.cjs';
    const running = command(this.nodePath || process.execPath, [path.join(this.privateDirectory, host), config], {
      cwd, env, signal: signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal,
      timeoutMs, log, onLine, ipc: true,
      onMessage: message => { if (message?.type === 'lab-model-started') this.modelStarted = true; },
    });
    try {
      const result = await running;
      if (windows && result.code === 125 && result.stderr.includes('Windows lab isolation failed')) {
        throw Object.assign(new Error('Windows 安全实验执行不可用，未启动工作者。'), { infrastructure: true });
      }
      return result;
    }
    finally {
      await killMarked(this.runId, { job });
      await fs.rm(config, { force: true });
    }
  }
  async root(args, options) {
    if (!this.usage?.bootstrap && !(args.length === 2 && args[1] === '--help')) {
      throw new Error('Authenticated lab metering is required.');
    }
    this.active = true;
    try {
      const result = await this.launch(args, options);
      if (this.brokerFailure) throw this.brokerFailure;
      return result;
    }
    finally { this.active = false; await killMarked(this.runId); }
  }
  async execute(file, args, { network = false, ...options } = {}) {
    if (typeof network !== 'boolean' || typeof file !== 'string' || !file || file.includes('\0') || !Array.isArray(args) ||
      args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Invalid lab execution request.');
    return this.launch([], { ...options, network, command: { file, args } });
  }
  async close() {
    if (this.closed) return;
    this.closed = true; this.active = false; this.controller.abort();
    this.signal?.removeEventListener('abort', this.signalAbort);
    let failure;
    try { if (this.started) await killMarked(this.runId); } catch (error) { failure = error; }
    if (this.brokerServer) {
      await new Promise(resolve => { this.brokerServer.close(resolve); for (const socket of this.brokerSockets) socket.destroy(); });
      this.brokerServer = null;
    }
    await Promise.allSettled(this.brokerJobs);
    if (this.brokerWork.size) {
      let timer;
      try {
        await Promise.race([Promise.allSettled(this.brokerWork), new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('Lab broker did not stop. Cleanup was refused.'),
            { infrastructure: true, fatal: true })), 2000);
        })]);
      } catch (error) { failure ||= error; }
      finally { clearTimeout(timer); }
    }
    await this.brokerChannel?.close();
    await Promise.allSettled(this.jobs);
    if (this.server) {
      await new Promise(resolve => { this.server.close(resolve); for (const socket of this.sockets) socket.destroy(); });
      this.server = null;
    }
    await this.channel?.close();
    if (failure) throw failure;
    await removePath(this.tools);
    await removePath(path.join(this.labRoot, 'reviews', this.runId));
    await removePath(this.privateDirectory);
  }
}

async function recoverRuns(labRoot) {
  const directory = path.join(labRoot, 'private');
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (process.platform === 'win32' && entries.length) await require('./sandbox-win32.cjs').initialize({ directory: labRoot });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
    await killMarked(entry.name);
    if (process.platform === 'win32') await require('./sandbox-win32.cjs').release(path.join(directory, entry.name));
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(path.join(directory, entry.name, 'manifest.json'), 'utf8')); } catch {}
    if (manifest?.runId === entry.name && typeof manifest.directory === 'string' &&
      inside(path.resolve(labRoot), path.resolve(manifest.directory)) && path.resolve(manifest.directory) !== path.resolve(labRoot)) {
      await cleanupWorktrees(manifest.directory);
    }
    for (const root of ['private', 'tools', 'reviews', 'references']) {
      await removePath(path.join(labRoot, root, entry.name));
    }
  }
  // A previous cleanup can fail after its session manifest was removed. Those reference folders still need recovery.
  const references = path.join(labRoot, 'references');
  const stale = await fs.readdir(references, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of stale) if (entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name)) {
    await killMarked(entry.name);
    await removePath(path.join(references, entry.name));
  }
}

module.exports = { LabSession, recoverRuns, copyHelper };
