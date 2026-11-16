const fs = require('node:fs');
const path = require('node:path');
const { createHmac, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { withoutShims } = require('../../shared/agentrix-shims.cjs');
const { TranscriptTail } = require('../../transcript-tail.cjs');
const { findClaudeSession } = require('../../claude-sessions.cjs');

const START_NOTICE_MS = 15000, POLL_MS = 1000, ENTER_DELAY_MS = 100, SCROLLBACK = 512 * 1024, KEYS_LIMIT = 65536;
const TEXT_LIMIT = 256, MODEL_LIMIT = 200, SETTLE_TRIES = 5, SETTLE_MS = 200;
// The parent terminal's variables a worker never inherits: its reporting and control credentials, the reading note, the
// shell integration's event wiring (main.cjs startTerminal, zsh-terminal.cjs), and an entrypoint naming another client.
const PRIVATE = /^AGENTRIX_(?:BOOTSTRAP|CONTROL|CAPABILITY|READING_NOTE|SOCKET|PROJECT_ID|HOOK_|EVENT_HELPER|START_DIR|NODE$|USER_ZDOTDIR$)|^AGENTRIX_.*SESSION_KEY$|^CLAUDE_CODE_ENTRYPOINT$/i;
// Hooks that mean the CLI asks the owner, and the ones that mean it went on.
const ASKS = new Set(['PermissionRequest', 'Elicitation']);
const ASK_NOTICES = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog']);
const PROGRESS = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'ElicitationResult', 'Stop', 'StopFailure', 'SessionEnd']);
const PROVENANCE = ['isMeta', 'isCompactSummary', 'isVisibleInTranscriptOnly', 'queueTranscriptOnly', 'promptSource', 'turnOrigin', 'humanTurn', 'commandMode'];
const ATTACHMENTS = ['image', 'input_image', 'file', 'input_file'];
const string = (value, limit) => typeof value === 'string' && value.length <= limit;

// What the dispatch helper's meter takes of a transcript record (the JS form of remote-worker.py compact_subagent_record):
// its place in the conversation, a reply's identity, model, output tokens, effort and speed, tool calls and results, and
// for a user message its provenance and each text block's first words. Nothing else of the work leaves main.
function meterRecord(record) {
  if (!record || !['user', 'assistant'].includes(record.type)) return null;
  const message = record.message && typeof record.message === 'object' ? record.message : {};
  const blocks = Array.isArray(message.content) ? message.content.filter(block => block && typeof block === 'object') : [];
  let content = record.type === 'assistant'
    ? blocks.filter(block => block.type === 'tool_use' && typeof block.id === 'string').map(block => ({ type: 'tool_use', id: block.id }))
    : blocks.filter(block => block.type === 'tool_result' && typeof block.tool_use_id === 'string').map(block => ({ type: 'tool_result', tool_use_id: block.tool_use_id }));
  if (record.type === 'user' && !content.length) {
    content = typeof message.content === 'string' ? [{ type: 'text', text: message.content.slice(0, TEXT_LIMIT) }]
      : blocks.filter(block => typeof block.text === 'string' || ATTACHMENTS.includes(block.type))
        .map(block => typeof block.text === 'string' ? { type: 'text', text: block.text.slice(0, TEXT_LIMIT) } : { type: block.type });
  }
  const kept = Object.fromEntries([...PROVENANCE, 'type', 'uuid', 'parentUuid', 'timestamp', 'isSidechain']
    .filter(key => key in record && (record[key] === null || ['string', 'number', 'boolean'].includes(typeof record[key]))).map(key => [key, record[key]]));
  if (typeof record.origin?.kind === 'string') kept.origin = { kind: record.origin.kind };
  for (const key of ['effort', 'perTurnEffort']) if (string(record[key], MODEL_LIMIT)) kept[key] = record[key];
  kept.message = { content };
  if (typeof message.id === 'string') kept.message.id = message.id;
  if (string(message.model, MODEL_LIMIT)) kept.message.model = message.model;
  const usage = {};
  if (Number.isSafeInteger(message.usage?.output_tokens)) usage.output_tokens = message.usage.output_tokens;
  if (['fast', 'standard'].includes(message.usage?.speed)) usage.speed = message.usage.speed;
  if (Object.keys(usage).length) kept.message.usage = usage;
  return kept;
}

const textsOf = record => (Array.isArray(record.message?.content) ? record.message.content : [])
  .filter(block => block?.type === 'text' && typeof block.text === 'string' && block.text.trim()).map(block => block.text);
const isPrompt = record => record.type === 'user' && !record.isSidechain && !record.isMeta && (typeof record.message?.content === 'string'
  || Array.isArray(record.message?.content) && record.message.content.some(block => block?.type === 'text')
    && !record.message.content.some(block => block?.type === 'tool_result'));

// The parent terminal's own environment as a worker's: no Agentrix credentials or shell wiring, the user's own zsh folder
// back, then the shims at depth 1 with this run's identity and a private copy of the Claude Code start-up hook.
function workerEnvironment(parentEnv, { shims, runId, sessionKey, claudeEnvFile }) {
  const source = { ...parentEnv };
  if (Object.hasOwn(source, 'AGENTRIX_USER_ZDOTDIR')) {
    if (source.AGENTRIX_USER_ZDOTDIR) source.ZDOTDIR = source.AGENTRIX_USER_ZDOTDIR; else delete source.ZDOTDIR;
  }
  const env = withoutShims(source);
  for (const name of Object.keys(env)) if (PRIVATE.test(name)) delete env[name];
  const proof = createHmac('sha256', sessionKey).update(`agentrix-run:${runId}`).digest('hex');
  const shimmed = require(path.join(shims, 'intercept.cjs')).withShims(env, { depth: 1, runId, proof });
  const hook = path.join(shims, 'hooks', 'claude-env.sh');
  if (shimmed.AGENTRIX_SHIMS && fs.existsSync(hook)) {
    fs.writeFileSync(claudeEnvFile, fs.readFileSync(hook), { mode: 0o600 });
    shimmed.CLAUDE_ENV_FILE = claudeEnvFile;
  }
  return shimmed;
}

// cmd.exe expands % and ends a quoted word at ", so a cmd-shim Claude Code runs only with words free of both.
function launchCommand(file, args, { platform, cmdPath, powershellPath }) {
  if (platform !== 'win32') return { file, args };
  if (/\.(?:cmd|bat)$/i.test(file)) {
    const words = [file, ...args];
    if (words.some(word => /["%\r\n]/.test(word))) throw new Error('worker_launch_unquotable');
    return { file: cmdPath, args: `/d /s /c "${words.map(word => `"${word}"`).join(' ')}"` };
  }
  if (/\.ps1$/i.test(file)) return { file: powershellPath, args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args] };
  return { file, args };
}

function killTree(pty, platform = process.platform) {
  const end = () => { try { pty.kill(); } catch {} };
  if (platform === 'win32' && pty.pid) {
    execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(pty.pid), '/t', '/f'], { windowsHide: true, timeout: 5000 }, end);
    return;
  }
  try { process.kill(-pty.pid, 'SIGTERM'); } catch {}
  end();
}

// A terminal lead's Claude workers, each a hidden interactive `claude` in a PTY of its own (worker-terminals/BOUNDARY.md).
// deps: spawn (pty.spawn), claudeFile(), parent(run) → { env, sessionKey, bootstrapFile } | null, calls(run) → the
// parent's AgentCalls | null, hooks({ terminalId, sessionKey, env, cwd }) → terminalHooks(), runtimeDir(), claudeHome(), send.
function createWorkerTerminals({ spawn, claudeFile, parent, calls, hooks, runtimeDir, claudeHome, send = () => {},
  schedule = (fn, ms) => setTimeout(fn, ms), cancel = clearTimeout, kill = killTree, platform = process.platform,
  cmdPath = process.env.ComSpec || 'cmd.exe', powershellPath = 'powershell.exe' } = {}) {
  const workers = new Map();
  const byId = id => workers.get(id) || null;
  const byCall = (terminalId, callId) => [...workers.values()].find(w => w.parent === terminalId && `dispatch:${w.runId}` === callId) || null;

  function setAwaiting(w, value) {
    if (w.awaiting === value) return;
    w.awaiting = value;
    try { calls(w.run)?.setAwaiting(w.runId, value); } catch {}
  }
  function publish(w, type, payload, options) { if (!w.closed) w.stream.publish(type, payload, options); }

  function launch(w, prompt, clientMessageId) {
    const env0 = parent(w.run);
    if (!env0?.env || !env0.sessionKey || !env0.bootstrapFile) throw new Error('worker_parent_unavailable');
    const file = claudeFile();
    if (!file) throw Object.assign(new Error('Claude Code was not found for the worker terminal'), { code: 'native_cli_required' });
    const { shims } = JSON.parse(fs.readFileSync(env0.bootstrapFile, 'utf8').replace(/^\uFEFF/, ''));
    if (!shims) throw new Error('worker_shims_unavailable');
    fs.mkdirSync(w.folder, { recursive: true, mode: 0o700 });
    const brief = path.join(w.folder, 'brief.md'), settings = path.join(w.folder, 'settings.json');
    fs.writeFileSync(brief, prompt, { mode: 0o600 });
    w.env = workerEnvironment(env0.env, { shims, runId: w.runId, sessionKey: env0.sessionKey, claudeEnvFile: path.join(w.folder, 'claude-env.sh') });
    w.hooks = hooks({ terminalId: w.id, sessionKey: w.key, env: w.env, cwd: w.spec.cwd });
    fs.writeFileSync(settings, w.hooks.channel === 'http' ? w.hooks.settings.http : w.hooks.settings.fallback, { mode: 0o600 });
    const args = [...(w.resume ? ['--resume', w.resume] : []), '--settings', settings, '--add-dir', w.folder, '--permission-mode', w.spec.permission,
      ...(w.spec.model ? ['--model', w.spec.model] : []), ...(w.spec.effort ? ['--effort', w.spec.effort] : []),
      `Read the task brief in ${brief} and carry it out.`];
    const command = launchCommand(file, args, { platform, cmdPath, powershellPath });
    w.pty = spawn(command.file, command.args, { name: 'xterm-256color', cols: w.cols, rows: w.rows, cwd: w.spec.cwd, env: w.env,
      ...(platform === 'win32' ? { useConpty: true, useConptyDll: true } : {}) });
    w.epoch = randomUUID(); w.launchedAt = Date.now(); w.tag = clientMessageId;
    w.pty.onData(data => receive(w, data));
    w.pty.onExit(({ exitCode } = {}) => exited(w, exitCode));
    w.notice = schedule(() => { w.noticeDue = true; startNotice(w); }, START_NOTICE_MS);
  }
  // A start-up dialog fires no hook: drawn output with no prompt submitted after 15 s shows as waiting (display only).
  function startNotice(w) { if (w.noticeDue && w.drawn && !w.prompted && !w.exited) setAwaiting(w, 'owner'); }
  function receive(w, data) {
    w.drawn = true; w.chunks.push(data); w.bytes += data.length; w.seq++;
    while (w.bytes > SCROLLBACK && w.chunks.length > 1) w.bytes -= w.chunks.shift().length;
    if (w.attached) send('worker-terminal:data', { terminalId: w.parent, callId: `dispatch:${w.runId}`, epoch: w.epoch, seq: w.seq, data });
    startNotice(w);
  }
  function exited(w, exitCode) {
    if (w.exited) return;
    w.exited = true; cancel(w.notice); clearInterval(w.poll); setAwaiting(w, null);
    if (w.attached) send('worker-terminal:data', { terminalId: w.parent, callId: `dispatch:${w.runId}`, epoch: w.epoch, exited: true, exitCode: exitCode ?? null });
    publish(w, 'session.state', { state: 'stopped' });
  }

  // Written once while the CLI waits for a prompt: a bracketed paste, then Enter. UserPromptSubmit confirms it.
  function write(w, input) {
    w.idle = false; w.inFlight = input;
    w.pty.write(`\x1b[200~${input.text}\x1b[201~`);
    schedule(() => { if (!w.exited) w.pty.write('\r'); }, ENTER_DELAY_MS);
  }

  // The transcript, found by the session the hooks name under the worker's own Claude home, never by a path a hook gives.
  async function read(w) {
    if (!w.sessionId) return;
    if (!w.tail) {
      const home = w.env.CLAUDE_CONFIG_DIR || claudeHome();
      const filename = await findClaudeSession(w.spec.cwd, w.sessionId, home, { strict: true });
      if (!filename || w.tail) return;
      w.tail = new TranscriptTail(filename);
    }
    await w.tail.read(record => {
      if (record.isSidechain || w.resume && Date.parse(record.timestamp) < w.launchedAt - 2000) return;
      if (isPrompt(record)) {
        w.final = { id: null, texts: [] };
        // The input that made this prompt is named before its record, so its origin is the channel's, not the planner's.
        if (w.tag !== undefined && typeof record.uuid === 'string') {
          publish(w, 'item.upsert', { kind: 'user-message', status: 'completed', content: { clientMessageId: w.tag } }, { itemId: record.uuid });
          w.tag = undefined;
        }
      } else if (record.type === 'assistant' && textsOf(record).length) {
        if (record.message?.id !== w.final.id) w.final = { id: record.message?.id ?? null, texts: [] };
        w.final.texts.push(...textsOf(record));
      }
      const kept = meterRecord(record);
      if (kept) publish(w, 'transcript.record', kept);
    });
  }

  async function onHook(w, name, { sessionId, payload = {} }) {
    if (w.closed) return;
    if (typeof sessionId === 'string' && /^[\w-]{1,160}$/.test(sessionId) && !w.sessionId) { w.sessionId = sessionId; w.stream.provider(sessionId); }
    if (ASKS.has(name) || name === 'Notification' && ASK_NOTICES.has(payload.notification_type)) { setAwaiting(w, 'owner'); return; }
    if (PROGRESS.has(name)) setAwaiting(w, null);
    if (name === 'UserPromptSubmit') {
      w.prompted = true; w.running = true; w.idle = false;
      const input = w.inFlight; w.inFlight = null;
      if (input) w.tag = input.clientMessageId;
      w.stream.turn(randomUUID());
      if (input) publish(w, 'input.receipt', { clientMessageId: input.clientMessageId, status: 'consumed' });
      publish(w, 'turn.started', { clientMessageId: input?.clientMessageId ?? null });
      publish(w, 'session.state', { state: 'running' });
      clearInterval(w.poll);
      w.poll = setInterval(() => { void w.queue.then(() => read(w)).catch(() => {}); }, POLL_MS); w.poll.unref?.();
    } else if ((name === 'Stop' || name === 'StopFailure') && w.running) {
      clearInterval(w.poll); w.running = false;
      // The final text can be written a moment after Stop: read until the turn has one, a bounded number of times.
      for (let tries = 0; ; tries++) {
        await read(w).catch(() => {});
        if (name !== 'Stop' || w.final.texts.length || tries >= SETTLE_TRIES) break;
        await new Promise(resolve => schedule(resolve, SETTLE_MS));
      }
      if (name === 'Stop' && w.final.texts.length) publish(w, 'item.upsert', { kind: 'agent-message', status: 'completed', content: { text: w.final.texts.join('\n\n') } }, { itemId: `final:${randomUUID()}` });
      publish(w, 'turn.completed', { status: name === 'Stop' ? 'completed' : 'failed' });
      const next = w.pending.shift();
      if (next) write(w, next); else { w.idle = true; publish(w, 'session.state', { state: 'idle' }); }
      return;
    }
    await read(w).catch(() => {});
  }
  const deliver = (w, name, facts) => { w.queue = w.queue.then(() => onHook(w, name, facts)).catch(() => {}); };

  function create(run, spec, stream) {
    if (workers.has(`worker-${run.runId}`)) throw new Error('worker_terminal_exists');
    const w = { run, runId: run.runId, parent: run.projectId, id: `worker-${run.runId}`, key: randomUUID(), spec, stream,
      folder: path.join(runtimeDir(), `worker-${run.runId}`), cols: 120, rows: 30, chunks: [], bytes: 0, seq: 0, pending: [],
      final: { id: null, texts: [] }, awaiting: null, queue: Promise.resolve() };
    workers.set(w.id, w);
    stream.publish('path.changed', { previous: null, selected: 'terminal-worker', reason: 'terminal lead (subscription)' });
    const close = async () => {
      if (w.closed) return;
      w.closed = true; cancel(w.notice); clearInterval(w.poll); setAwaiting(w, null);
      if (w.pty && !w.exited) kill(w.pty, platform);
      workers.delete(w.id);
      fs.rmSync(w.folder, { recursive: true, force: true });
    };
    w.close = close;
    return {
      start: async () => {}, resume: async () => { w.resume = spec.providerSessionId; },
      get pid() { return w.pty?.pid ?? null; },
      async send({ clientMessageId, text }) {
        if (w.closed || w.exited) return { status: 'rejected', reason: 'worker_ended' };
        if (!w.pty) { launch(w, text, clientMessageId); return { status: 'delivered' }; }
        if (w.idle && !w.inFlight) { write(w, { clientMessageId, text }); return { status: 'delivered' }; }
        w.pending.push({ clientMessageId, text }); return { status: 'queued' };
      },
      close,
    };
  }

  return {
    create,
    keyOf: id => byId(id)?.hooks?.key,
    // A hook-ingest event for a worker terminal (true when it is one; never reaches a project terminal).
    hook(event) {
      const w = byId(event?.terminalId);
      if (!w) return false;
      deliver(w, event.event, { sessionId: event.sessionId, payload: event.payload });
      return true;
    },
    // An event-pipe event from a worker's command hooks; anything else naming a worker is dropped here.
    event(event) {
      const w = byId(event?.projectId);
      if (!w) return false;
      if (event.sessionKey === w.key && event.type === 'agent-activity' && typeof event.hookEvent === 'string') {
        deliver(w, event.hookEvent, { sessionId: event.sessionId, payload: event.state === 'attention' && event.hookEvent === 'Notification' ? { notification_type: 'permission_prompt' } : {} });
      }
      return true;
    },
    register({ handle, listen }) {
      handle('worker-terminal:attach', (terminalId, callId) => {
        const w = byCall(terminalId, callId);
        if (!w?.pty) return null;
        w.attached = true;
        return { epoch: w.epoch, seq: w.seq, data: w.chunks.join(''), cols: w.cols, rows: w.rows, awaiting: w.awaiting, exited: !!w.exited };
      });
      listen('worker-terminal:keys', (terminalId, callId, epoch, data) => {
        const w = byCall(terminalId, callId);
        if (w?.pty && !w.exited && w.epoch === epoch && w.awaiting === 'owner' && typeof data === 'string' && data.length <= KEYS_LIMIT) w.pty.write(data);
      });
      listen('worker-terminal:resize', (terminalId, callId, epoch, cols, rows) => {
        const w = byCall(terminalId, callId);
        if (!w?.pty || w.exited || w.epoch !== epoch || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 500 || rows > 250) return;
        w.cols = cols; w.rows = rows; w.pty.resize(cols, rows);
      });
      listen('worker-terminal:detach', (terminalId, callId) => { const w = byCall(terminalId, callId); if (w) w.attached = false; });
    },
    closeAll() { for (const w of [...workers.values()]) void w.close(); },
  };
}

module.exports = { createWorkerTerminals, meterRecord };
