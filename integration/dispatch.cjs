// A command-line worker declares its assignment here; Agentrix never infers it from shell commands.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { constants: { signals } } = require('node:os');

const START_TIMEOUT = 30000;
const LIMIT = 4 * 1024 * 1024;
const word = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function argumentsOf(argv) {
  const [agent, ...flags] = argv;
  if (!['codex', 'claude'].includes(agent)) throw new Error('Expected codex or claude');
  const options = { agent, images: [], fast: false, readOnly: false };
  const names = new Map(['role', 'title', 'model', 'effort', 'cwd', 'brief', 'out', 'permission'].map(key => [`--${key}`, key]));
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === '--fast' || flag === '--read-only') { options[flag === '--fast' ? 'fast' : 'readOnly'] = true; continue; }
    if (!names.has(flag) && flag !== '--image') throw new Error(`Unknown option ${flag}`);
    const value = flags[++i];
    if (!value || value.startsWith('--') || /[\0\r\n]/.test(value)) throw new Error(`Expected one-line value for ${flag}`);
    if (flag === '--image') options.images.push(value);
    else {
      if (options[names.get(flag)] !== undefined) throw new Error(`Repeated option ${flag}`);
      options[names.get(flag)] = value;
    }
  }
  for (const key of ['role', 'title', 'model', 'effort', 'cwd', 'brief', 'out']) if (!options[key]) throw new Error(`Missing --${key}`);
  if (!['执行', '调查', '审查'].includes(options.role)) throw new Error('Expected --role 执行, 调查 or 审查');
  if (options.title.length > 1024 || options.model.length > 160 || options.effort.length > 32) throw new Error('Assignment is too long');
  if (agent === 'claude' && (options.fast || options.readOnly || options.images.length)) throw new Error('Claude supports --permission, not Codex options');
  if (agent === 'claude' && !['plan', 'acceptEdits'].includes(options.permission)) throw new Error('Expected --permission plan or acceptEdits');
  if (agent === 'codex' && options.permission) throw new Error('--permission is only for Claude');
  options.cwd = path.resolve(options.cwd);
  for (const key of ['brief', 'out']) options[key] = path.resolve(options.cwd, options[key]);
  options.images = options.images.map(file => path.resolve(options.cwd, file));
  for (const file of [options.cwd, options.brief, options.out, ...options.images]) if (file.length > 4096) throw new Error('Path is too long');
  return options;
}

function commandOf(options) {
  if (options.agent === 'claude') return ['-p', '--model', options.model, '--effort', options.effort,
    '--permission-mode', options.permission, '--output-format', 'json'];
  return ['exec', '-m', options.model, '-c', `model_reasoning_effort=${options.effort}`,
    ...(options.fast ? ['-c', 'service_tier="fast"'] : []), '--json', '-C', options.cwd, '-o', options.out,
    ...options.images.flatMap(file => ['-i', file]), ...(options.readOnly ? ['-s', 'read-only'] : []), '-'];
}

// Serialize sends to preserve start/rate/end order. No pipe callback delays the worker or its output.
function eventSink(filename) {
  let bootstrap;
  try {
    if (!filename || fs.statSync(filename).size > 16384) return () => {};
    bootstrap = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
    if (![bootstrap.pipeName, bootstrap.projectId, bootstrap.sessionKey].every(word)) return () => {};
  } catch { return () => {}; }
  const address = process.platform === 'win32' && !bootstrap.pipeName.startsWith('\\\\') ? `\\\\.\\pipe\\${bootstrap.pipeName}` : bootstrap.pipeName;
  let sending = false;
  const queue = [];
  function drain() {
    if (sending || !queue.length) return;
    sending = true;
    const event = queue.shift(), socket = net.connect(address);
    socket.setTimeout(250, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.once('close', () => { sending = false; drain(); });
    socket.once('connect', () => socket.end(JSON.stringify({ ...event, projectId: bootstrap.projectId, sessionKey: bootstrap.sessionKey }) + '\n'));
  }
  return event => {
    // A slow/disappeared app cannot retain unlimited rate reports.
    if (event.type === 'dispatch-rate') {
      const index = queue.findIndex(value => value.type === 'dispatch-rate');
      if (index >= 0) queue.splice(index, 1);
    }
    queue.push(event); drain();
  };
}

// Settings are read only from worker records/headers. A missing value remains unreported.
class WorkerOutput {
  constructor(agent, changed = () => {}, response = () => {}) {
    this.agent = agent; this.changed = changed; this.response = response;
    this.model = null; this.effort = null; this.fast = null; this.sessionId = null;
    this.outputTokens = null; this.activeMs = null; this.turnAt = null; this.failed = false; this.capacity = false;
    this.tools = new Set(); this.waitAt = null; this.waitMs = 0; this.responses = new Set(); this.turnOutput = 0;
  }
  settings(value) {
    this.model = word(value.model) || this.model;
    this.effort = word(value.perTurnEffort ?? value.reasoning_effort ?? value.reasoningEffort ?? value.effort ?? value.reasoning?.effort) || this.effort;
    const tier = value.service_tier ?? value.serviceTier ?? value.speed ?? value.usage?.speed;
    if (typeof value.fast === 'boolean') this.fast = value.fast;
    else if (typeof value.fast_mode === 'boolean') this.fast = value.fast_mode;
    else if (['fast', 'priority', 'standard', 'default', 'flex', 'auto'].includes(tier)) this.fast = ['fast', 'priority'].includes(tier);
  }
  sample(tokens, ms, total = false) {
    if (count(tokens) === null) return;
    const measured = this.outputTokens !== null;
    const duration = Number.isFinite(ms) && ms > 0 && ms <= Number.MAX_SAFE_INTEGER ? ms : null;
    this.outputTokens = total ? tokens : (this.outputTokens || 0) + tokens;
    this.activeMs = total ? duration : duration !== null && (!measured || this.activeMs !== null) ? (this.activeMs || 0) + duration : null;
    if (this.activeMs !== null) this.response();
  }
  line(line, at = Date.now()) {
    const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    let record;
    try { record = JSON.parse(clean); } catch {
      if (/\bat capacity\b|overloaded|capacity exceeded/i.test(clean)) this.capacity = true;
      const header = /^(model|reasoning effort|service tier|speed|session id):\s*(.+)$/i.exec(clean);
      if (header) {
        const [, key, value] = header;
        if (key.toLowerCase() === 'session id') this.sessionId = word(value);
        else this.settings({ [key.toLowerCase().replace('reasoning effort', 'effort').replace('service tier', 'service_tier')]: value });
        this.changed();
      }
      return;
    }
    this.record(record, at);
  }
  record(record, at = Date.now()) {
    if (Array.isArray(record)) { for (const entry of record) this.record(entry, at); return; }
    if (!record || typeof record !== 'object') return;
    const type = record.type, timestamp = Date.parse(record.timestamp);
    if (Number.isFinite(timestamp)) at = timestamp;
    if (['error', 'turn.failed'].includes(type) || record.is_error === true || type === 'result' && /^error_/.test(record.subtype || '')) {
      this.failed = true;
      if (/\bat capacity\b|overloaded|capacity exceeded/i.test(JSON.stringify(record))) this.capacity = true;
    }
    if (this.agent === 'codex') {
      if (type === 'thread.started') { this.sessionId = word(record.thread_id); this.settings(record); }
      if (['session.started', 'turn.started', 'turn_context'].includes(type)) this.settings(record.payload || record);
      if (type === 'turn.started' || type === 'response.started' || type === 'response.created') {
        this.turnAt = at; this.waitMs = 0; this.waitAt = null; this.tools.clear(); this.turnOutput = 0;
      }
      if (['item.started', 'item.completed'].includes(type) && ['command_execution', 'mcp_tool_call', 'web_search'].includes(record.item?.type)) {
        const id = record.item.id;
        if (type === 'item.started') { if (!this.tools.size) this.waitAt = at; this.tools.add(id); }
        else if (this.tools.delete(id) && !this.tools.size) { this.waitMs += at - this.waitAt; this.waitAt = null; }
      }
      if (type === 'token_usage_record') {
        const payload = record.payload || record, id = payload.response_id;
        if (id && !this.responses.has(id)) {
          this.responses.add(id);
          if (this.responses.size > 1024) this.responses.delete(this.responses.values().next().value);
          const tokens = payload.usage?.output_tokens;
          this.sample(tokens, payload.duration_api_ms ?? payload.active_ms ?? (this.turnAt === null ? null : at - this.turnAt - this.waitMs));
          this.turnOutput += count(tokens) || 0;
          this.turnAt = at; this.waitMs = 0;
        }
      }
      if (type === 'turn.completed' || type === 'response.completed') {
        this.failed = false; this.capacity = false;
        const tokens = record.usage?.output_tokens ?? record.response?.usage?.output_tokens;
        const ms = record.duration_api_ms ?? record.active_ms ?? (this.turnAt === null || this.waitAt !== null ? null : at - this.turnAt - this.waitMs);
        if (!this.turnOutput) this.sample(tokens, ms);
        else if (count(tokens) !== null && tokens > this.turnOutput) this.sample(tokens - this.turnOutput, ms);
        this.turnAt = null;
      }
    } else {
      if (type === 'system' && record.subtype === 'init') { this.sessionId = word(record.session_id); this.settings(record); }
      if (type === 'assistant') {
        this.settings(record);
        this.settings(record.message || {});
        this.sample(record.message?.usage?.output_tokens, record.duration_api_ms);
      }
      if (type === 'result') {
        this.sessionId = word(record.session_id) || this.sessionId;
        this.settings(record);
        const models = Object.keys(record.modelUsage || {});
        if (models.length === 1) this.model = models[0];
        this.result = typeof record.result === 'string' ? record.result : null;
        if (!record.is_error && !/^error_/.test(record.subtype || '')) { this.failed = false; this.capacity = false; }
        this.sample(record.usage?.output_tokens, record.duration_api_ms, true);
      }
    }
    this.changed();
  }
  routing() { return { model: this.model || 'unreported', effort: this.effort, fast: this.fast }; }
}

// Standard Windows npm installs expose a JS entrypoint beside the shim; never invoke a shell.
function executable(agent, args, env) {
  if (process.platform !== 'win32') return { file: agent, args };
  const searchPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    const folder = directory.replace(/^"|"$/g, '');
    const native = path.join(folder, agent + '.exe');
    if (fs.existsSync(native)) return { file: native, args };
    const entry = path.join(folder, 'node_modules', agent === 'codex' ? '@openai/codex/bin/codex.js' : '@anthropic-ai/claude-code/cli.js');
    if (fs.existsSync(entry)) return { file: process.execPath, args: [entry, ...args] };
  }
  return { file: agent, args };
}

async function run(argv, { env = process.env, stdout = process.stdout, launch = spawn, startTimeout = START_TIMEOUT } = {}) {
  const id = randomUUID(), send = eventSink(env.AGENTRIX_BOOTSTRAP);
  let options, child, log, startTimer, forceTimer, started = false, unconfirmed = false, killed = false, spawnError = null, lastRate = -Infinity;
  const signal = line => stdout.write(`[dispatch] ${line}\n`);
  const failed = reason => { if (!unconfirmed && !started) { unconfirmed = true; signal(`failed to start ${id}: ${reason}`); } };
  const reported = () => `${options.agent} model ${output.model || 'unreported'} effort ${output.effort || 'unreported'} fast ${output.fast === null ? 'unreported' : output.fast ? 'on' : 'off'}`;
  const output = new WorkerOutput(argv[0], () => {
    if (started || unconfirmed || !child?.pid || child.exitCode !== null || !output.sessionId) return;
    started = true; clearTimeout(startTimer);
    const actual = output.routing(), declared = { model: options.model, effort: options.effort, fast: options.fast };
    const mismatch = Object.keys(declared).some(key => actual[key] !== declared[key]);
    const routing = mismatch ? `MISMATCH (declared ${declared.model} ${declared.effort} fast ${declared.fast ? 'on' : 'off'})` : 'ok';
    signal(`started ${id} ${reported()} · routing ${routing} · pid ${child.pid} session ${output.sessionId}`);
    send({ type: 'dispatch-start', id, agent: options.agent, role: options.role, title: options.title, ...actual,
      ...(mismatch ? { declared } : {}), cwd: options.cwd, brief: options.brief, out: options.out, sessionId: output.sessionId, startedAt: Date.now() });
  }, () => {
    if (!started || Date.now() - lastRate < 2000) return;
    lastRate = Date.now();
    send({ type: 'dispatch-rate', id, outputTokens: output.outputTokens, activeMs: output.activeMs });
  });
  const stop = (kind, requested = true) => {
    if (requested) killed = true;
    if (!child?.pid || child.exitCode !== null) return;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      killer.on('error', () => child.kill());
    } else {
      try { process.kill(-child.pid, kind); } catch { child.kill(kind); }
      clearTimeout(forceTimer);
      forceTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1000);
      forceTimer.unref();
    }
  };
  const onInterrupt = () => stop('SIGINT'), onTerminate = () => stop('SIGTERM'), onHangup = () => stop('SIGHUP');
  try {
    options = argumentsOf(argv);
    const brief = fs.readFileSync(options.brief);
    log = fs.createWriteStream(options.out + '.log');
    await new Promise((resolve, reject) => { log.once('open', resolve); log.once('error', reject); });
    const command = executable(options.agent, commandOf(options), env);
    child = launch(command.file, command.args, { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      detached: process.platform !== 'win32' });
    log.on('error', error => { spawnError = error; stop('SIGTERM', false); });
    process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate); process.on('SIGHUP', onHangup);
    startTimer = setTimeout(() => { failed('session not reported within 30 s'); stop('SIGTERM', false); }, startTimeout);
    const tails = [];
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8');
      let buffer = '', skipping = false, json = '';
      const parseLine = line => {
        // Claude's JSON result can be a pretty-printed array, or older builds can emit JSON lines.
        if (options.agent !== 'claude' || !json && !/^\s*[\[{]\s*$/.test(line)) { output.line(line); return; }
        json += line + '\n';
        if (json.length > LIMIT) { json = ''; return; }
        try { const record = JSON.parse(json); json = ''; output.record(record); } catch {}
      };
      const accept = data => {
        buffer += data;
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!skipping && line.length <= LIMIT) parseLine(line);
          skipping = false;
        }
        if (buffer.length > LIMIT) { buffer = ''; skipping = true; }
      };
      stream.on('data', chunk => { log.write(chunk); accept(decoder.write(chunk)); });
      tails.push(() => { accept(decoder.end()); if (!skipping && buffer.trim()) parseLine(buffer); });
    }
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') spawnError = error; });
    child.stdin.end(brief);
    const result = await new Promise(resolve => {
      child.once('error', error => { spawnError = error; });
      child.once('close', (code, killedBy) => resolve({ code, killedBy }));
    });
    for (const tail of tails) tail();
    clearTimeout(startTimer); clearTimeout(forceTimer);
    if (!started) failed(spawnError?.message || (output.capacity ? 'at capacity' : 'worker exited without a confirmed session'));
    if (options.agent === 'claude' && output.result !== null && output.result !== undefined) fs.writeFileSync(options.out, output.result);
    const reason = killed ? 'killed' : output.capacity ? 'capacity' : unconfirmed ? 'unconfirmed' : result.killedBy ? 'killed'
      : spawnError || output.failed || result.code !== 0 ? 'error' : 'exit';
    const exitCode = Number.isInteger(result.code) ? (result.code === 0 && unconfirmed ? 1 : result.code) : result.killedBy ? 128 + (signals[result.killedBy] || 1) : 1;
    const rate = output.outputTokens !== null && output.activeMs > 0 ? `${Math.round(output.outputTokens * 1000 / output.activeMs)} token/s (${output.outputTokens.toLocaleString('en-US')} output tokens in ${Math.round(output.activeMs / 1000)} s)` : 'token/s unreported';
    signal(`ended ${id} ${reported()} · ${rate} · exit ${exitCode} reason ${reason} · out ${options.out}`);
    send({ type: 'dispatch-end', id, ...output.routing(), exitCode, reason, outputTokens: output.outputTokens, activeMs: output.activeMs, endedAt: Date.now() });
    await new Promise(resolve => log.end(resolve));
    return exitCode;
  } catch (error) {
    failed(error.message);
    if (child?.pid) stop('SIGTERM', false);
    if (options) {
      signal(`ended ${id} ${reported()} · token/s unreported · exit 1 reason unconfirmed · out ${options.out}`);
      send({ type: 'dispatch-end', id, ...output.routing(), exitCode: 1, reason: 'unconfirmed', outputTokens: null, activeMs: null, endedAt: Date.now() });
    }
    log?.destroy();
    return 1;
  } finally {
    clearTimeout(startTimer); clearTimeout(forceTimer);
    process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate); process.removeListener('SIGHUP', onHangup);
  }
}

if (require.main === module) run(process.argv.slice(2)).then(code => { process.exitCode = code; });
module.exports = { argumentsOf, commandOf, WorkerOutput, run };
