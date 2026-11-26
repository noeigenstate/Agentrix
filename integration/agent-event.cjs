// Codex notify and Claude Code hooks for macOS and Linux terminals (zsh-integration.zsh, bash-integration.bash),
// run by Agentrix's own executable as Node (ELECTRON_RUN_AS_NODE=1). It sends the same events as notify.ps1
// and claude-hook.ps1. Bash cannot open a Unix socket, so it sends its own reports through this too.
// Usage: agent-event.cjs codex-notify <socket> <projectId> <sessionKey> <payload>
//        agent-event.cjs claude-hook <socket> <projectId> <sessionKey> <kind>   (the hook's JSON on stdin)
//        agent-event.cjs shell-event v=1 type=<type> sequence=<sequence> socket=<socket> projectId=<id> sessionKey=<key> ...
// SessionStart reports the conversation path. The seat-routing hook can rewrite or deny a tool call before reporting the seat.
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const runtime = path.join(__dirname, fs.existsSync(path.join(__dirname, 'electron')) ? 'electron' : '../electron');
const { seatHookOutput, observedAgentSeat } = require(path.join(runtime, 'features/routing/agent-seat.cjs'));
const { deniedAction } = require(path.join(runtime, 'features/agents/start-failure.cjs'));
const { liveSeatMap, parseSeatMap } = require(path.join(runtime, 'features/agents/call-seat.cjs'));
const { readEnvelope, WIRE_FIELDS } = require(path.join(runtime, 'features/agents/dispatch-events.cjs'));

function send(socket, event) {
  return new Promise(resolve => {
    const connection = net.connect(socket);
    const waitsForAck = event.type === 'agent-started';
    const done = (acknowledged = false) => { clearTimeout(deadline); connection.destroy(); resolve(acknowledged); };
    const deadline = setTimeout(done, waitsForAck ? 1500 : 750);
    connection.on('error', () => done());
    connection.on('close', () => done());
    if (waitsForAck) connection.on('data', bytes => { if (bytes[0] === 1) done(true); });
    connection.on('connect', () => connection.end(JSON.stringify(event) + '\n'));
  });
}

function handOffReport(socket, event) {
  // The bridge kills the decision child after stdout is flushed. Pass the report in the reporter's private environment
  // so the handoff completes at launch, without waiting for the reporter to start reading a pipe.
  const report = JSON.stringify(event);
  if (report.length >= 32767) return;
  const reporter = spawn(process.execPath, [__filename, 'worker-report', socket], {
    detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, AGENTRIX_WORKER_REPORT: report },
  });
  reporter.on('error', () => {});
  reporter.unref();
}

function hookTrace(kind, stage) {
  if (process.env.AGENTRIX_HOOK_TRACE) process.stderr.write(`[agentrix-hook] ${new Date().toISOString()} node ${kind} ${stage}\n`);
}

function writeOutput(output) {
  const line = JSON.stringify(output) + '\n', stdout = process.stdout;
  return new Promise((resolve, reject) => {
    stdout.once('error', reject);
    stdout.write(line, error => {
      if (error) { reject(error); return; }
      stdout.off('error', reject);
      resolve();
    });
  });
}

function readInput(limit = 4 * 1024 * 1024) {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; if (data.length > limit) { data = ''; process.stdin.destroy(); resolve(''); } });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

// Codex supplies one JSON argument per completed turn. Never infer completion from process exit, terminal
// silence, or words in model output.
function codexEvent(payload, projectId, sessionKey) {
  const notification = JSON.parse(payload);
  if (notification?.type !== 'agent-turn-complete') return null;
  const threadId = String(notification['thread-id'] ?? ''), turnId = String(notification['turn-id'] ?? '');
  const eventId = threadId && turnId ? `${threadId}:${turnId}` : createHash('sha256').update(payload, 'utf8').digest('hex').toUpperCase();
  return { v: 1, projectId, sessionKey, type: 'turn-complete', eventId, threadId, turnId };
}

// Claude Code hook: UserPromptSubmit reports a working turn, Stop reports a finished one, StopFailure one that ended in an
// API error (an interrupted round, never a completed one), SessionStart the conversation Claude writes now (after /clear,
// /resume or a new start it is another file).
const CLAUDE_STATES = { start: 'working', stop: 'complete', 'stop-failed': 'failed', notify: 'attention', session: 'session', progress: 'progress', permission: 'attention' };
function claudeEvent(input, projectId, sessionKey, kind) {
  const sentAt = Date.now();
  if (!Object.hasOwn(CLAUDE_STATES, kind)) return null;
  const hook = typeof input === 'string' ? JSON.parse(input) : input;
  // Idle notifications must not turn a completed round back into a waiting one.
  if (kind === 'notify' && !['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog'].includes(hook?.notification_type)) return null;
  const sessionId = String(hook?.session_id ?? '');
  if (!sessionId) return null;
  const prompt = kind === 'start' && hook.prompt ? String(hook.prompt).slice(0, 2000) : null;
  return {
    v: 1, projectId, sessionKey, type: 'agent-activity', agent: 'claude', state: CLAUDE_STATES[kind], sessionId,
    message: ['notify', 'permission'].includes(kind) ? String(hook.message ?? hook.tool_name ?? '').slice(0, 300) : null,
    sentAt, hookEvent: String(hook.hook_event_name ?? ''), sessionSource: String(hook.source ?? ''),
    ...(['AskUserQuestion', 'ExitPlanMode'].includes(hook.tool_name) ? { menuTool: hook.tool_name } : {}),
    ...(typeof hook.turn_id === 'string' ? { turnId: hook.turn_id } : {}),
    ...(typeof hook.tool_use_id === 'string' ? { requestId: hook.tool_use_id } : {}),
    // The prompt whose turn this is: a late Stop of an older prompt cannot end a newer turn.
    ...(typeof hook.prompt_id === 'string' ? { promptId: hook.prompt_id } : {}),
    // Where Claude writes this conversation; Agentrix reads the steps of the round from it.
    transcriptPath: String(hook.transcript_path ?? ''),
    eventId: `${sessionId}:${Date.now()}${String(process.hrtime.bigint() % 10000n).padStart(4, '0')}`,
    // The submitted prompt names the work; the spoken completion notice says what finished.
    prompt,
  };
}

// A shell's own report (shell-ready, shell-prompt, agent-started, agent-exited, hook-channel), as zsh-integration.zsh writes it.
function shellEventFields(words) {
  if (!words[0]?.includes('=')) {
    // Existing terminal wrappers report up to eleven positional fields during the transition.
    const [type, sequence, exitCode, agent, codexAvailable, claudeAvailable, codexHome, cwd, command, accountLaunch, args] = words;
    return { type, sequence, exitCode, agent, codexAvailable, claudeAvailable, codexHome, cwd, command, accountLaunch, args };
  }
  const fields = Object.create(null);
  for (const word of words) {
    const equals = word.indexOf('='), key = word.slice(0, equals);
    if (equals < 1 || Object.hasOwn(fields, key)) return null;
    fields[key] = word.slice(equals + 1);
  }
  if (!Object.hasOwn(fields, 'v')) return null;
  try { return readEnvelope({ ...fields, v: fields.v === '1' ? 1 : fields.v }, { channel: 'shell-event', legacy: false }).value; }
  catch { return null; }
}

// command: the first word given to the CLI when it is a subcommand or an option (update, --version), else empty.
function shellEvent(words, projectId, sessionKey) {
  return shellReport(shellEventFields(words), projectId, sessionKey);
}

function shellReport(fields, projectId, sessionKey) {
  if (!fields) return null;
  let { type } = fields;
  const { sequence, exitCode, agent, codexAvailable, claudeAvailable, codexHome, cwd, command, accountLaunch, args: argumentsJson } = fields;
  // Remove next version. An older shell wrapper may use the updated helper.
  if (type === 'codex-started') type = 'agent-started';
  if (type === 'codex-exited') type = 'agent-exited';
  if (!Object.hasOwn(WIRE_FIELDS.shell, type) || !/^\d+$/.test(String(sequence))) return null;
  let args;
  if (type === 'agent-started' && agent === 'codex' && argumentsJson !== undefined) {
    try { args = JSON.parse(argumentsJson); } catch { return null; }
    if (!Array.isArray(args) || args.length > 64 || args.some(value => typeof value !== 'string' || value.includes('\0')) || JSON.stringify(args).length > 32768) return null;
  }
  return {
    v: 1, projectId, sessionKey, type, sequence: Number(sequence), exitCode: Number.parseInt(exitCode, 10) || 0, agent: agent === 'claude' ? 'claude' : 'codex',
    codexAvailable: codexAvailable === 'true', claudeAvailable: claudeAvailable === 'true', codexHome: String(codexHome ?? ''), cwd: String(cwd ?? ''),
    ...(command ? { command: String(command).slice(0, 24) } : {}),
    ...(args ? { args } : {}),
    ...(type === 'agent-started' && agent === 'codex' ? { accountLaunch: accountLaunch === 'model-only-v1' ? accountLaunch : 'unavailable' } : {}),
  };
}

function seatRouting(input, snapshot, bootstrap) {
  const live = liveSeatMap(bootstrap);
  const seats = live ?? parseSeatMap(snapshot);
  if (!seats) return {};
  let hook;
  try { hook = JSON.parse(input); } catch { return {}; }
  let pre;
  const output = seatHookOutput(hook, seats, value => { pre = value; });
  const observed = pre || observedAgentSeat(hook, seats);
  return { ...(Object.keys(output).length && { output }),
    ...(observed && typeof hook.session_id === 'string' && { observed: { ...observed, sessionId: hook.session_id } }) };
}

function workerPermission(input, projectId, sessionKey) {
  const hook = JSON.parse(input);
  if (hook?.hook_event_name !== 'PermissionRequest') return {};
  const event = claudeEvent(hook, projectId, sessionKey, 'permission');
  if (!event || ['AskUserQuestion', 'ExitPlanMode'].includes(hook.tool_name)) return { event };
  const tool = hook.tool_input;
  const command = typeof tool?.command === 'string' && ['Bash', 'PowerShell'].includes(hook.tool_name) ? tool.command : null;
  const paths = [tool?.file_path, tool?.path, tool?.notebook_path].filter(value => typeof value === 'string');
  const action = deniedAction({ toolName: hook.tool_name, command, paths });
  const message = 'This action is not allowed in this role. Continue without it and record it in finish_role.needsApproval.';
  return { output: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message, interrupt: false } } },
    event: { ...event, workerRefused: action } };
}

async function main([action, socket, projectId, sessionKey, argument, ...rest]) {
  if (action === 'worker-report' && socket) {
    const report = process.env.AGENTRIX_WORKER_REPORT;
    if (report) await send(socket, JSON.parse(report));
    return;
  }
  if (action === 'shell-event' && /^[a-z][a-zA-Z0-9_]*=/.test(socket ?? '')) {
    const fields = shellEventFields([socket, projectId, sessionKey, argument, ...rest].filter(value => value !== undefined));
    if (!fields?.socket || !fields.projectId || !fields.sessionKey) return;
    const event = shellReport(fields, fields.projectId, fields.sessionKey);
    if (event) await send(fields.socket, event);
    return;
  }
  if (!socket || !projectId || !sessionKey) return;
  hookTrace(argument, `start uptime-ms=${Math.round(process.uptime() * 1000)}`);
  const input = action === 'claude-hook' ? await readInput() : null;
  hookTrace(argument, 'input');
  if (action === 'claude-hook' && argument === 'worker-permission') {
    const { output, event } = workerPermission(input, projectId, sessionKey);
    hookTrace(argument, 'decision-ready');
    const bridged = process.env.AGENTRIX_WORKER_PERMISSION_BRIDGE === '1';
    if (event && bridged) {
      try {
        handOffReport(socket, event);
        hookTrace(argument, 'report-launched');
      } catch {}
    }
    if (output) await writeOutput(output);
    if (event && !bridged) await send(socket, event);
    return;
  }
  if (action === 'claude-hook' && argument === 'seat-routing') {
    const { output, observed } = seatRouting(input, process.env.AGENTRIX_SEATS, process.env.AGENTRIX_BOOTSTRAP);
    if (output) await writeOutput(output);
    if (observed) await send(socket, { v: 1, type: 'claude-seat-input', projectId, sessionKey, ...observed });
    return;
  }
  const event = action === 'codex-notify' ? codexEvent(argument, projectId, sessionKey)
    : action === 'claude-hook' ? claudeEvent(input, projectId, sessionKey, argument)
      : action === 'shell-event' ? shellEvent([argument, ...rest], projectId, sessionKey) : null;
  if (event) await send(socket, event);
}

if (require.main === module) {
  // Bound input and reporting even when a native pipe operation keeps the event loop alive.
  const bridgedDecision = process.argv[6] === 'worker-permission' && process.env.AGENTRIX_WORKER_PERMISSION_BRIDGE === '1';
  if (!bridgedDecision) setTimeout(() => process.exit(0), 1750).unref();
  // A pending Windows pipe connect can keep Node alive after its socket is destroyed.
  main(process.argv.slice(2)).catch(() => {}).finally(() => process.exit(0));
}

module.exports = { send, codexEvent, claudeEvent, shellEvent, seatRouting, workerPermission };
