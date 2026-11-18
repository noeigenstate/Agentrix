const fs = require('node:fs');
const path = require('node:path');
const { createHmac, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { withoutShims } = require('../../shared/agentrix-shims.cjs');
const { claudeBackgroundEnvironment } = require('../../shared/claude-background.cjs');
const { TranscriptTail } = require('../../transcript-tail.cjs');
const { findClaudeSession } = require('../../claude-sessions.cjs');

const START_NOTICE_MS = 15000, POLL_MS = 1000, ENTER_DELAY_MS = 100, SETTLE_MS = 200, SETTLE_TRIES = 5, EXIT_WAIT_MS = 5000, REMOVE_TRIES = 5;
const SCROLLBACK = 512 * 1024, KEYS_LIMIT = 65536, TEXT_LIMIT = 256, FIELD_LIMIT = 200, RECORD_LIMIT = 16384;
// The parent terminal's variables a worker never inherits: its reporting and control credentials, the reading note, the
// shell integration's event wiring (main.cjs startTerminal, zsh-terminal.cjs), and an entrypoint naming another client.
const PRIVATE = /^AGENTRIX_(?:BOOTSTRAP|CONTROL|CAPABILITY|READING_NOTE|SOCKET|PROJECT_ID|HOOK_|EVENT_HELPER|START_DIR|NODE$|USER_ZDOTDIR$)|^AGENTRIX_.*SESSION_KEY$|^CLAUDE_CODE_ENTRYPOINT$/i;
// Hooks that mean the CLI asks the owner, and the ones that mean it went on.
const ASKS = new Set(['PermissionRequest', 'Elicitation']);
const ASK_NOTICES = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog']);
const ANSWERS = new Set(['PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'ElicitationResult']);
const CLEAR_ASKS = new Set(['UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd']);
const CLOSED_ASKS_LIMIT = 512;
const PROGRESS = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'ElicitationResult', 'Stop', 'StopFailure', 'SessionEnd']);
const STOPS = new Set(['Stop', 'StopFailure']);
const PROVENANCE = ['isMeta', 'isCompactSummary', 'isVisibleInTranscriptOnly', 'queueTranscriptOnly', 'promptSource', 'turnOrigin', 'humanTurn', 'commandMode'];
const ATTACHMENTS = ['image', 'input_image', 'file', 'input_file'];
// The reasons a reply ends its turn; a reply without one is final only when it calls no tool.
const FINAL_REASONS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);
// The user record Claude Code writes when a turn ends without Stop: the owner pressed Esc or rejected a tool.
const INTERRUPTED = /^\[Request interrupted by user/;
const CONTROL = /[\0-\x1f\x7f]/;
const short = (value, limit = FIELD_LIMIT) => typeof value === 'string' && value.length <= limit;
const plain = text => text.replace(/\s+/g, ' ').trim();

// What the dispatch helper's meter takes of a transcript record (the JS form of remote-worker.py compact_subagent_record):
// its place in the conversation, a reply's identity, model, output tokens, effort and speed, tool calls and results, and
// for a user message its provenance and each text block's first words. Nothing else of the work leaves main, and the
// result stays within the helper's bound: text goes first, then trailing blocks; ids and usage stay.
function meterRecord(record) {
  if (!record || !['user', 'assistant'].includes(record.type)) return null;
  const message = record.message && typeof record.message === 'object' ? record.message : {};
  const blocks = Array.isArray(message.content) ? message.content.filter(block => block && typeof block === 'object') : [];
  let content = record.type === 'assistant'
    ? blocks.filter(block => block.type === 'tool_use' && short(block.id)).map(block => ({ type: 'tool_use', id: block.id }))
    : blocks.filter(block => block.type === 'tool_result' && short(block.tool_use_id)).map(block => ({ type: 'tool_result', tool_use_id: block.tool_use_id }));
  if (record.type === 'user' && !content.length) {
    content = typeof message.content === 'string' ? [{ type: 'text', text: message.content.slice(0, TEXT_LIMIT) }]
      : blocks.filter(block => typeof block.text === 'string' || ATTACHMENTS.includes(block.type))
        .map(block => typeof block.text === 'string' ? { type: 'text', text: block.text.slice(0, TEXT_LIMIT) } : { type: block.type });
  }
  const kept = Object.fromEntries([...PROVENANCE, 'type', 'uuid', 'parentUuid', 'timestamp', 'isSidechain']
    .filter(key => key in record && (record[key] === null || ['number', 'boolean'].includes(typeof record[key]) || short(record[key]))).map(key => [key, record[key]]));
  if (short(record.origin?.kind)) kept.origin = { kind: record.origin.kind };
  for (const key of ['effort', 'perTurnEffort']) if (short(record[key])) kept[key] = record[key];
  kept.message = { content };
  if (short(message.id)) kept.message.id = message.id;
  if (short(message.model)) kept.message.model = message.model;
  const usage = {};
  if (Number.isSafeInteger(message.usage?.output_tokens)) usage.output_tokens = message.usage.output_tokens;
  if (['fast', 'standard'].includes(message.usage?.speed)) usage.speed = message.usage.speed;
  if (Object.keys(usage).length) kept.message.usage = usage;
  const fits = () => JSON.stringify(kept).length <= RECORD_LIMIT;
  if (!fits()) {
    const first = content.find(block => block.type === 'text');
    kept.message.content = [...(first ? [{ type: 'text', text: first.text.slice(0, 32) }] : []), ...content.filter(block => block.type !== 'text')];
  }
  while (!fits() && kept.message.content.length > 1) kept.message.content = kept.message.content.slice(0, Math.ceil(kept.message.content.length / 2));
  return kept;
}

const textsOf = record => (Array.isArray(record.message?.content) ? record.message.content : [])
  .filter(block => block?.type === 'text' && typeof block.text === 'string' && block.text.trim()).map(block => block.text);
const userText = record => typeof record.message?.content === 'string' ? record.message.content
  : Array.isArray(record.message?.content) && !record.message.content.some(block => block?.type === 'tool_result')
    ? record.message.content.filter(block => block?.type === 'text').map(block => block.text).join('') : null;

// The parent terminal's own environment as a worker's: no Agentrix credentials or shell wiring, the user's own zsh folder
// back, then the shims at depth 1 with this run's identity and a private copy of the Claude Code start-up hook.
function workerEnvironment(parentEnv, { shims, runId, sessionKey, claudeEnvFile, allowBackgroundTasks }) {
  const source = { ...parentEnv };
  if (Object.hasOwn(source, 'AGENTRIX_USER_ZDOTDIR')) {
    if (source.AGENTRIX_USER_ZDOTDIR) source.ZDOTDIR = source.AGENTRIX_USER_ZDOTDIR; else delete source.ZDOTDIR;
  }
  const env = claudeBackgroundEnvironment(withoutShims(source), allowBackgroundTasks);
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
    return { file: cmdPath, args: `/d /v:off /s /c "${words.map(word => `"${word}"`).join(' ')}"` };
  }
  if (/\.ps1$/i.test(file)) return { file: powershellPath, args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args] };
  return { file, args };
}

function killTree(pty, platform = process.platform) {
  const end = () => { try { pty.kill(); } catch {} };
  if (platform === 'win32') {
    if (!pty.pid) { end(); return; }
    return new Promise(resolve => {
      execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(pty.pid), '/t', '/f'],
        { windowsHide: true, timeout: EXIT_WAIT_MS }, () => { end(); resolve(); });
    });
  }
  if (Number.isInteger(pty.pid) && pty.pid > 0) {
    try { process.kill(-pty.pid, 'SIGTERM'); } catch {}
  }
  end();
}

// node-pty 1.2.0-beta.15's DLL path disposes its ConoutConnection only on output *after* kill. A quiet CLI leaves
// that worker's pipe server alive forever. The public kill also defers until first output, so an unopened PTY needs
// the agent kill directly. Keep this compatibility cleanup with the pinned node-pty version, not in its dependency.
async function disposeWindowsPty(pty, deadline) {
  const agent = pty?._agent;
  if (!agent?._useConptyDll) return;
  if (pty._isReady === false) { try { agent.kill(); } catch {} }
  const output = agent._conoutSocketWorker;
  try { output?.dispose(); } catch {}
  clearTimeout(output?._drainTimeout);
  clearTimeout(agent._connectionTimeout); clearTimeout(agent._closeTimeout);
  try { agent._inSocket?.destroy(); } catch {}
  // Destroy the out socket before terminating its conout worker: this order is load-bearing. WindowsTerminal
  // rethrows non-EIO socket errors with fewer than two PTY error listeners; launch adds the second listener.
  try { agent._outSocket?.destroy(); } catch {}
  try { await Promise.race([output?._worker?.terminate(), deadline]); } catch {}
}

// A terminal lead's Claude workers, each a hidden interactive `claude` in a PTY of its own (worker-terminals/BOUNDARY.md).
// deps: spawn (pty.spawn), claudeFile(), parent(run) → { env, sessionKey, bootstrapFile } | null, calls(run) → the
// parent's AgentCalls | null, hooks({ terminalId, sessionKey, env, cwd }) → terminalHooks(), runtimeDir(), claudeHome(), send.
// now/schedule/cancel are the one clock (tests inject it); remove deletes a folder.
function createWorkerTerminals({ spawn, claudeFile, parent, calls, hooks, runtimeDir, claudeHome, send = () => {}, allowBackgroundTasks = () => false,
  schedule = (fn, ms) => setTimeout(fn, ms), cancel = clearTimeout, now = Date.now, kill = killTree, platform = process.platform,
  remove = folder => fs.rmSync(folder, { recursive: true, force: true }), cmdPath = process.env.ComSpec || 'cmd.exe', powershellPath = 'powershell.exe' } = {}) {
  const workers = new Map();
  const byId = id => workers.get(id) || null;
  const byCall = (terminalId, callId) => [...workers.values()].find(w => w.parent === terminalId && `dispatch:${w.runId}` === callId) || null;
  function trackTimer(timers, fn, ms, resolve = null) {
    const timer = schedule(() => { timers.delete(timer); fn(); }, ms);
    timers.set(timer, resolve);
    // Notices, polling and automatic Enter must never keep the app alive. Awaited cleanup waits stay referenced.
    if (!resolve) timer?.unref?.();
    return timer;
  }
  function later(w, fn, ms, resolve = null) {
    if (w.closed || w.exited) { resolve?.(); return null; }
    return trackTimer(w.timers, fn, ms, resolve);
  }
  function clearTimer(w, timer) {
    const timers = w.timers.has(timer) ? w.timers : w.cleanupTimers;
    if (!timers.has(timer)) return;
    const resolve = timers.get(timer);
    timers.delete(timer); cancel(timer); resolve?.();
  }
  const clearTimers = w => { for (const timer of w.timers.keys()) clearTimer(w, timer); };
  const delay = (w, ms) => new Promise(resolve => later(w, resolve, ms, resolve));

  function setAwaiting(w, value) {
    if (w.awaiting === value) return;
    w.awaiting = value;
    try { calls(w.run)?.setAwaiting(w.runId, value); } catch {}
  }
  function closeAsks(w, asks = w.asks) {
    for (const ask of asks) {
      w.asks.delete(ask);
      w.closedAsks.delete(ask);
      w.closedAsks.add(ask);
    }
    while (w.closedAsks.size > CLOSED_ASKS_LIMIT) w.closedAsks.delete(w.closedAsks.values().next().value);
  }
  function publish(w, type, payload, options) { if (!w.closed) w.stream.publish(type, payload, options); }
  // A sentence the worker reads, naming a file in its brief folder; no part of a brief or message is ever typed.
  function sentence(text) {
    if (CONTROL.test(text)) throw new Error('worker_prompt_unsafe');
    return text;
  }

  function launch(w, prompt, clientMessageId) {
    const env0 = parent(w.run);
    if (!env0?.env || !env0.sessionKey || !env0.bootstrapFile) throw new Error('worker_parent_unavailable');
    let file = claudeFile();
    if (!file) {
      const used = env0.env.AGENTRIX_CLAUDE_EXECUTABLE;
      try { if (typeof used === 'string' && path.isAbsolute(used) && fs.statSync(used).isFile()) file = used; } catch {}
    }
    if (!file) throw Object.assign(new Error('Claude Code was not found for the worker terminal'), { code: 'native_cli_required' });
    const { shims } = JSON.parse(fs.readFileSync(env0.bootstrapFile, 'utf8').replace(/^\uFEFF/, ''));
    if (!shims) throw new Error('worker_shims_unavailable');
    // The worker's only added directory holds its brief and the owner's messages; its settings and start-up hook stay
    // beside it, out of that directory's reach.
    fs.mkdirSync(w.briefs, { recursive: true, mode: 0o700 });
    const brief = path.join(w.briefs, 'brief.md'), settings = path.join(w.folder, 'settings.json');
    fs.writeFileSync(brief, prompt, { mode: 0o600 });
    w.env = workerEnvironment(env0.env, { shims, runId: w.runId, sessionKey: env0.sessionKey, claudeEnvFile: path.join(w.folder, 'claude-env.sh'), allowBackgroundTasks: allowBackgroundTasks() });
    w.hooks = hooks({ terminalId: w.id, sessionKey: w.key, env: w.env, cwd: w.spec.cwd });
    fs.writeFileSync(settings, w.hooks.channel === 'http' ? w.hooks.settings.http : w.hooks.settings.fallback, { mode: 0o600 });
    const args = [...(w.resume ? ['--resume', w.resume] : []), '--settings', settings, '--add-dir', w.briefs, '--permission-mode', w.spec.permission,
      ...(w.spec.model ? ['--model', w.spec.model] : []), ...(w.spec.effort ? ['--effort', w.spec.effort] : []),
      sentence(`Read the task brief in ${brief} and carry it out.`)];
    const command = launchCommand(file, args, { platform, cmdPath, powershellPath });
    w.pty = spawn(command.file, command.args, { name: 'xterm-256color', cols: w.cols, rows: w.rows, cwd: w.spec.cwd, env: w.env,
      ...(platform === 'win32' ? { useConpty: true, useConptyDll: true } : {}) });
    w.pty.on?.('error', () => {});
    w.epoch = randomUUID(); w.launchedAt = now(); w.tag = clientMessageId;
    w.listeners.push(w.pty.onData(data => receive(w, data)), w.pty.onExit(({ exitCode } = {}) => exited(w, exitCode)));
    w.notice = later(w, () => { w.noticeDue = true; startNotice(w); }, START_NOTICE_MS);
  }
  // A start-up dialog fires no hook: drawn output with no prompt submitted after 15 s shows as waiting (display only).
  function startNotice(w) {
    if (w.noticeDue && w.drawn && !w.prompted && !w.exited && !w.closed) { w.promptWait = true; setAwaiting(w, 'owner'); }
  }
  function receive(w, data) {
    if (w.closed || w.exited) return;
    w.drawn = true; w.chunks.push(data); w.bytes += data.length; w.seq++;
    while (w.bytes > SCROLLBACK && w.chunks.length > 1) w.bytes -= w.chunks.shift().length;
    if (w.attachments.size) send('worker-terminal:data', { terminalId: w.parent, callId: `dispatch:${w.runId}`, epoch: w.epoch, seq: w.seq, data });
    startNotice(w);
  }
  function exited(w, exitCode) {
    if (w.exited) return;
    w.exited = true; w.running = false; clearTimers(w); setAwaiting(w, null);
    if (w.attachments.size) send('worker-terminal:data', { terminalId: w.parent, callId: `dispatch:${w.runId}`, epoch: w.epoch, exited: true, exitCode: exitCode ?? null });
    w.onExited?.();
    publish(w, 'session.state', { state: 'stopped' });
    if (!w.closed) void w.close();
  }

  // An owner's message goes in as the brief does: a file in the brief folder, named by one typed sentence, written once
  // while the CLI waits for a prompt. UserPromptSubmit confirms it.
  function write(w, input) {
    w.idle = false; w.inFlight = input;
    const file = path.join(w.briefs, `message-${++w.messages}.md`);
    fs.writeFileSync(file, input.text, { mode: 0o600 });
    w.pty.write(sentence(`Read the owner's message in ${file} and act on it.`));
    w.enterTimer = later(w, () => {
      if (!w.closed && !w.exited && !w.asks.size && !w.ownerDraft && w.inFlight === input) w.pty.write('\r');
    }, ENTER_DELAY_MS);
  }
  // A pause says nothing about a half-written prompt: leave it alone until submission or an explicit clear.
  function flushInput(w) {
    if (w.closed || w.exited || !w.idle || w.inFlight || w.asks.size || w.ownerDraft || !w.pending.length) return;
    write(w, w.pending.shift());
  }
  // The CLI waits for a prompt: deliver a queued intervention when the owner has no draft.
  function idle(w) {
    if (w.closed || w.exited) return;
    w.idle = true;
    flushInput(w);
    if (w.idle && !w.pending.length) publish(w, 'session.state', { state: 'idle' });
  }
  function poll(w) {
    clearTimer(w, w.poll);
    if (!w.running || w.closed || w.exited) return;
    w.poll = later(w, () => { if (w.running && !w.closed && !w.exited) { void read(w); poll(w); } }, POLL_MS);
  }

  // The transcript, found by the session the hooks name under the worker's own Claude home, never by a path a hook
  // gives. One read at a time: a tail is not re-entrant, and two reads would repeat or skip records.
  function read(w) { return w.reading = w.reading.then(() => readTail(w)).catch(() => {}); }
  async function readTail(w) {
    if (!w.sessionId || w.closed || w.exited) return;
    if (!w.tail) {
      const filename = await findClaudeSession(w.spec.cwd, w.sessionId, w.env.CLAUDE_CONFIG_DIR || claudeHome(), { strict: true });
      if (!filename || w.closed || w.exited) return;
      w.tail = new TranscriptTail(filename);
    }
    await w.tail.read(record => {
      if (w.closed || w.exited) return;
      if (record.isSidechain || w.resume && Date.parse(record.timestamp) < w.launchedAt - 2000) return;
      if (record.type === 'user') {
        const text = userText(record);
        // Any user record follows the latest reply: its tools ran, or a new prompt or an interruption came.
        w.last = null;
        if (text !== null && INTERRUPTED.test(text.trim())) interrupted(w);
        else if (text !== null && !record.isMeta && w.tag !== undefined && short(record.uuid)) {
          // The input that made this prompt is named before its record, so its origin is the channel's, not the planner's.
          publish(w, 'item.upsert', { kind: 'user-message', status: 'completed', content: { clientMessageId: w.tag } }, { itemId: record.uuid });
          w.tag = undefined;
        }
      } else if (record.type === 'assistant') {
        const id = record.message?.id ?? null;
        if (!w.last || w.last.id !== id) w.last = { id, texts: [], tool: false, reason: null };
        w.last.texts.push(...textsOf(record));
        w.last.tool ||= Array.isArray(record.message?.content) && record.message.content.some(block => block?.type === 'tool_use');
        w.last.reason = record.message?.stop_reason || w.last.reason;
      }
      const kept = meterRecord(record);
      if (kept) publish(w, 'transcript.record', kept);
    });
  }
  // Esc or a rejected tool ends the turn without Stop: the CLI waits for the owner's prompt, so the row waits for the
  // owner and a queued message can go in. The turn itself stays open; the next prompt starts a new one.
  function interrupted(w) {
    closeAsks(w);
    if (!w.running) return;
    w.running = false; clearTimer(w, w.poll);
    w.promptWait = true; setAwaiting(w, 'owner');
    idle(w);
  }
  // The turn's final reply: the latest reply when it has text and ends the turn (a final stop reason, or no tool call).
  const finalText = w => w.last?.texts.length && (FINAL_REASONS.has(w.last.reason) || !w.last.tool) ? w.last.texts.join('\n\n') : null;

  async function onHook(w, name, { sessionId, sentAt, toolUseId, agentId, requestId, elicitationId, payload = {} }) {
    if (w.closed || w.exited) return;
    if (typeof sessionId === 'string' && /^[\w-]{1,160}$/.test(sessionId) && !w.sessionId) { w.sessionId = sessionId; w.stream.provider(sessionId); }
    const timed = Number.isFinite(sentAt);
    const notice = name === 'Notification' && ASK_NOTICES.has(payload.notification_type);
    const elicitation = name.startsWith('Elicitation') || notice && payload.notification_type !== 'permission_prompt';
    const id = elicitation ? elicitationId || payload.elicitation_id || requestId : toolUseId || payload.tool_use_id || requestId;
    // Missing identity cannot prove that a different tool answered a question. Unkeyed notices add no new wait.
    const key = id ? `${elicitation ? 'elicitation' : 'tool'}:${id}` : null;
    if (ASKS.has(name) || notice) {
      if (key && !w.closedAsks.has(key)) w.asks.add(key);
      else if (!notice && !key) w.asks.add(`unknown:${agentId || payload.agent_id || ''}`);
      if (w.asks.size) clearTimer(w, w.enterTimer);
      setAwaiting(w, w.asks.size || w.promptWait ? 'owner' : null); return;
    }
    // A Stop from an earlier turn cannot clear this turn's questions.
    if (STOPS.has(name) && timed && sentAt < w.startAt) return;
    if (CLEAR_ASKS.has(name)) closeAsks(w);
    else if (ANSWERS.has(name) && key) closeAsks(w, [key]);
    if (PROGRESS.has(name)) {
      w.promptWait = false;
      setAwaiting(w, w.asks.size ? 'owner' : null);
    }
    if (name === 'UserPromptSubmit') {
      w.ownerDraft = false; clearTimer(w, w.enterTimer); clearTimer(w, w.notice);
      if (timed) w.startAt = sentAt;
      w.prompted = true; w.running = true; w.idle = false; w.last = null;
      const input = w.inFlight; w.inFlight = null;
      if (input) w.tag = input.clientMessageId;
      w.stream.turn(randomUUID());
      if (input) publish(w, 'input.receipt', { clientMessageId: input.clientMessageId, status: 'consumed' });
      publish(w, 'turn.started', { clientMessageId: input?.clientMessageId ?? null });
      publish(w, 'session.state', { state: 'running' });
      poll(w);
      await read(w);
      if (w.closed || w.exited) return;
      const early = w.earlyStop; w.earlyStop = null;
      if (early && early.sentAt >= sentAt) await onHook(w, early.name, early.facts);
      return;
    }
    if (STOPS.has(name)) {
      if (!w.running) { if (timed) w.earlyStop = { name, sentAt, facts: { sessionId, sentAt, payload } }; return; }
      clearTimer(w, w.poll); w.running = false;
      await settle(w, name, payload);
      return;
    }
    await read(w);
    flushInput(w);
  }
  // The final reply can be written a moment after Stop: read until the turn's final record agrees with the Stop hook's
  // text (when it carries one), a bounded number of times. --out gets that record's whole text; without it, the hook's
  // text (cut to 2000 characters by hook-ingest); with neither, no text.
  async function settle(w, name, payload) {
    const hookText = typeof payload.last_assistant_message === 'string' && payload.last_assistant_message.trim() ? payload.last_assistant_message : null;
    const agreed = () => { const text = finalText(w); return text !== null && (!hookText || plain(text).startsWith(plain(hookText))) ? text : null; };
    for (let tries = 0; name === 'Stop'; tries++) {
      await read(w);
      if (agreed() !== null || tries >= SETTLE_TRIES || w.closed || w.exited) break;
      await delay(w, SETTLE_MS);
    }
    if (w.closed || w.exited) return;
    const text = name === 'Stop' ? agreed() ?? hookText : null;
    if (text !== null) publish(w, 'item.upsert', { kind: 'agent-message', status: 'completed', content: { text } }, { itemId: `final:${randomUUID()}` });
    publish(w, 'turn.completed', { status: name === 'Stop' ? 'completed' : 'failed' });
    idle(w);
  }
  const deliver = (w, name, facts) => { w.queue = w.queue.then(() => onHook(w, name, facts)).catch(() => {}); };

  function create(run, spec, stream) {
    if (workers.has(`worker-${run.runId}`)) throw new Error('worker_terminal_exists');
    const folder = path.join(runtimeDir(), `worker-${run.runId}`);
    const w = { run, runId: run.runId, parent: run.projectId, id: `worker-${run.runId}`, key: randomUUID(), spec, stream, folder,
      briefs: path.join(folder, 'brief'), cols: 120, rows: 30, chunks: [], bytes: 0, seq: 0, pending: [], messages: 0, last: null,
      awaiting: null, asks: new Set(), closedAsks: new Set(), attachments: new Map(), ownerDraft: false,
      timers: new Map(), cleanupTimers: new Map(), listeners: [],
      startAt: -Infinity, queue: Promise.resolve(), reading: Promise.resolve() };
    workers.set(w.id, w);
    stream.publish('path.changed', { previous: null, selected: 'terminal-worker', reason: 'terminal lead (subscription)' });
    // Never rejects: the run always finishes. The folder goes once the PTY's exit is seen, retried while Windows holds it.
    w.close = () => w.closing ||= (async () => {
      w.closed = true; w.running = false; clearTimers(w); setAwaiting(w, null);
      try {
        if (w.pty) {
          const exit = new Promise(resolve => { w.onExited = resolve; });
          let timeout;
          // Only close cancels cleanup waits: PTY exit must not release conout termination early.
          const deadline = new Promise(resolve => { timeout = trackTimer(w.cleanupTimers, resolve, EXIT_WAIT_MS, resolve); });
          try {
            try {
              if (!w.exited) await kill(w.pty, platform);
              else if (platform === 'win32') { try { w.pty.kill(); } catch {} }
            } finally { if (platform === 'win32') await disposeWindowsPty(w.pty, deadline); }
            if (!w.exited) await Promise.race([exit, deadline]);
          } finally { clearTimer(w, timeout); w.onExited = null; }
        }
      } catch {}
      // A Stop may be asleep in settle or a tail may still hold a file. Cancel its wait and drain both before removal.
      clearTimers(w);
      await w.queue; await w.reading;
      for (const listener of w.listeners) { try { listener?.dispose(); } catch {} }
      for (let tries = 1; ; tries++) {
        try { remove(w.folder); break; } catch { if (tries >= REMOVE_TRIES) break; }
        await new Promise(resolve => trackTimer(w.cleanupTimers, resolve, SETTLE_MS * tries, resolve));
      }
      workers.delete(w.id);
    })();
    return {
      start: async () => {}, resume: async () => { w.resume = spec.providerSessionId; },
      get pid() { return w.pty?.pid ?? null; },
      async send({ clientMessageId, text }) {
        if (w.closed || w.exited) return { status: 'rejected', reason: 'worker_ended' };
        if (!w.pty) {
          try { launch(w, text, clientMessageId); }
          catch (error) { error.beforeInput = !w.pty; throw error; }
          return { status: 'delivered' };
        }
        const input = { clientMessageId, text };
        w.pending.push(input); flushInput(w);
        return { status: w.inFlight === input ? 'delivered' : 'queued' };
      },
      close: () => w.close(),
    };
  }

  return {
    create,
    keyOf: id => byId(id)?.hooks?.key,
    // A hook-ingest event for a worker terminal (true when it is one; never reaches a project terminal).
    hook(event) {
      const w = byId(event?.terminalId);
      if (!w) return false;
      deliver(w, event.event, { sessionId: event.sessionId, toolUseId: event.toolUseId, agentId: event.agentId,
        requestId: event.requestId, elicitationId: event.elicitationId, payload: event.payload });
      return true;
    },
    // An event-pipe event from a worker's command hooks, ordered by when the hook sent it; anything else naming a
    // worker is dropped here.
    event(event) {
      const w = byId(event?.projectId);
      if (!w) return false;
      if (event.sessionKey === w.key && event.type === 'agent-activity' && typeof event.hookEvent === 'string') {
        deliver(w, event.hookEvent, { sessionId: event.sessionId, sentAt: Number.isFinite(event.sentAt) ? event.sentAt : undefined,
          toolUseId: event.toolUseId, agentId: event.agentId, requestId: event.requestId, elicitationId: event.elicitationId,
          payload: event.state === 'attention' && event.hookEvent === 'Notification' ? { notification_type: 'permission_prompt' } : {} });
      }
      return true;
    },
    register({ handle, listen }) {
      handle('worker-terminal:attach', (terminalId, callId, viewId = 'owner') => {
        const w = byCall(terminalId, callId);
        if (!w?.pty || w.closed) return null;
        w.attachments.set(viewId, (w.attachments.get(viewId) || 0) + 1);
        return { epoch: w.epoch, seq: w.seq, data: w.chunks.join(''), cols: w.cols, rows: w.rows, awaiting: w.awaiting, exited: !!w.exited };
      });
      // Keys only from an attached split, only while the worker waits for the owner.
      listen('worker-terminal:keys', (terminalId, callId, epoch, data, viewId = 'owner') => {
        const w = byCall(terminalId, callId);
        if (w?.pty && w.attachments.has(viewId) && !w.exited && !w.closed && w.epoch === epoch && w.awaiting === 'owner' && typeof data === 'string' && data.length <= KEYS_LIMIT) {
          if (data) {
            // Ctrl+C and Ctrl+U clear the prompt; text following that clear starts a new draft. Enter waits for its hook.
            const cleared = Math.max(data.lastIndexOf('\x03'), data.lastIndexOf('\x15'));
            w.ownerDraft = cleared < 0 || cleared < data.length - 1;
            clearTimer(w, w.enterTimer);
          }
          w.pty.write(data); flushInput(w);
        }
      });
      listen('worker-terminal:resize', (terminalId, callId, epoch, cols, rows) => {
        const w = byCall(terminalId, callId);
        if (!w?.pty || w.exited || w.epoch !== epoch || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 500 || rows > 250) return;
        w.cols = cols; w.rows = rows; w.pty.resize(cols, rows);
      });
      listen('worker-terminal:detach', (terminalId, callId, viewId = 'owner') => {
        const w = byCall(terminalId, callId), count = w?.attachments.get(viewId) || 0;
        if (count > 1) w.attachments.set(viewId, count - 1); else w?.attachments.delete(viewId);
      });
    },
    closeAll: () => Promise.all([...workers.values()].map(w => w.close())),
  };
}

module.exports = { createWorkerTerminals, meterRecord };
