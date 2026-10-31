// Codex notify and Claude Code hooks for macOS and Linux terminals (zsh-integration.zsh, bash-integration.bash),
// run by Agentrix's own executable as Node (ELECTRON_RUN_AS_NODE=1). It sends the same events as notify.ps1
// and claude-hook.ps1. Bash cannot open a Unix socket, so it sends its own reports through this too.
// Usage: agent-event.cjs codex-notify <socket> <projectId> <sessionKey> <payload>
//        agent-event.cjs claude-hook <socket> <projectId> <sessionKey> start|stop|notify|session   (the hook's JSON on stdin)
//        agent-event.cjs shell-event <socket> <projectId> <sessionKey> <type> <sequence> <exitCode> <agent>
//                        <codexAvailable> <claudeAvailable> <codexHome> <cwd>
// Only SessionStart prints instruction JSON. The other hooks stay silent, and a closed Agentrix never fails a turn.
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const runtime = path.join(__dirname, fs.existsSync(path.join(__dirname, 'electron')) ? 'electron' : '../electron');
const { sessionContext } = require(path.join(runtime, 'features/skills/session.cjs'));

function send(socket, event) {
  return new Promise(resolve => {
    const connection = net.connect(socket);
    const done = () => { connection.destroy(); resolve(); };
    connection.setTimeout(750, done);
    connection.on('error', done);
    connection.on('close', done);
    connection.on('connect', () => connection.end(JSON.stringify(event) + '\n'));
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
  return { projectId, sessionKey, type: 'turn-complete', eventId, threadId, turnId };
}

// Claude Code hook: UserPromptSubmit reports a working turn, Stop reports a finished one, SessionStart the
// conversation Claude writes now (after /clear, /resume or a new start it is another file).
const CLAUDE_STATES = { start: 'working', stop: 'complete', notify: 'attention', session: 'session' };
function claudeEvent(input, projectId, sessionKey, kind) {
  if (!Object.hasOwn(CLAUDE_STATES, kind)) return null;
  const hook = JSON.parse(input);
  // Idle notifications must not turn a completed round back into a waiting one.
  if (kind === 'notify' && !['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog'].includes(hook?.notification_type)) return null;
  const sessionId = String(hook?.session_id ?? '');
  if (!sessionId) return null;
  const prompt = kind === 'start' && hook.prompt ? String(hook.prompt).slice(0, 2000) : null;
  return {
    projectId, sessionKey, type: 'agent-activity', agent: 'claude', state: CLAUDE_STATES[kind], sessionId,
    message: kind === 'notify' ? String(hook.message ?? '').slice(0, 300) : null,
    // Where Claude writes this conversation; Agentrix reads the steps of the round from it.
    transcriptPath: String(hook.transcript_path ?? ''),
    eventId: `${sessionId}:${Date.now()}${String(process.hrtime.bigint() % 10000n).padStart(4, '0')}`,
    // The submitted prompt names the work; the spoken completion notice says what finished.
    prompt,
  };
}

// A shell's own report (shell-ready, shell-prompt, codex-started, codex-exited), as zsh-integration.zsh writes it.
const shellEvents = ['shell-ready', 'shell-prompt', 'codex-started', 'codex-exited'];
// command: the first word given to the CLI when it is a subcommand or an option (update, --version), else empty.
function shellEvent([type, sequence, exitCode, agent, codex, claude, codexHome, cwd, command, accountLaunch], projectId, sessionKey) {
  if (!shellEvents.includes(type) || !/^\d+$/.test(String(sequence))) return null;
  return {
    projectId, sessionKey, type, sequence: Number(sequence), exitCode: Number.parseInt(exitCode, 10) || 0, agent: agent === 'claude' ? 'claude' : 'codex',
    codexAvailable: codex === 'true', claudeAvailable: claude === 'true', codexHome: String(codexHome ?? ''), cwd: String(cwd ?? ''),
    ...(command ? { command: String(command).slice(0, 24) } : {}),
    ...(type === 'codex-started' && agent === 'codex' ? { accountLaunch: accountLaunch === 'model-only-v1' ? accountLaunch : 'unavailable' } : {}),
  };
}

async function main([action, socket, projectId, sessionKey, argument, ...rest]) {
  if (!socket || !projectId || !sessionKey) return;
  const input = action === 'claude-hook' ? await readInput() : null;
  if (action === 'claude-hook' && argument === 'session') {
    try {
      const noteFile = rest[0] || process.env.AGENTRIX_READING_NOTE_FILE;
      const context = noteFile && sessionContext(JSON.parse(input), fs.readFileSync(noteFile, 'utf8'));
      if (context) process.stdout.write(JSON.stringify(context) + '\n');
    } catch {}
  }
  const event = action === 'codex-notify' ? codexEvent(argument, projectId, sessionKey)
    : action === 'claude-hook' ? claudeEvent(input, projectId, sessionKey, argument)
      : action === 'shell-event' ? shellEvent([argument, ...rest], projectId, sessionKey) : null;
  if (event) await send(socket, event);
}

if (require.main === module) {
  // Whatever happens, the agent continues: no output, exit code 0, and never longer than a few seconds.
  setTimeout(() => process.exit(0), 5000).unref();
  main(process.argv.slice(2)).catch(() => {}).finally(() => { process.exitCode = 0; });
}

module.exports = { codexEvent, claudeEvent, shellEvent };
