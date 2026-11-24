const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHmac } = require('node:crypto');
const { reason } = require('../../shared/reason.cjs');

// The events Claude Code posts to main (hook-server.cjs). SessionStart cannot be an HTTP hook and stays the command that
// delivers skills; MessageDisplay holds the screen until it is answered and waits for the T6 rendering.
const HTTP_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch',
  'PermissionDenied', 'Notification', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'SessionEnd',
  'Elicitation', 'ElicitationResult'];
// A dialog's hook may stay open as long as the dialog does; the CLI gives up on every other hook after 10 s.
const DIALOGS = ['PermissionRequest', 'Elicitation'];
// The command hooks command-async runs without waiting: the status kinds K0b proved silent and out of the proxy's reach
// (items 3 and 7). A dialog's hook stays synchronous, so its waiting light comes before the owner can answer.
const ASYNC_KINDS = ['start', 'stop', 'notify', 'progress'];
// The command hooks, by the kind claude-hook.ps1 and agent-event.cjs take: the fallback, and SessionStart always.
// StopFailure (the turn ended in an API error) stays synchronous: K0b never proved it async.
const COMMAND_KINDS = { UserPromptSubmit: 'start', Stop: 'stop', StopFailure: 'stop-failed', Notification: 'notify', SessionStart: 'session', PreToolUse: 'progress',
  PostToolUse: 'progress', PostToolUseFailure: 'progress', PermissionDenied: 'progress', ElicitationResult: 'progress',
  PermissionRequest: 'permission', Elicitation: 'permission' };
// The hook client sends through HTTPS_PROXY or HTTP_PROXY, in either letter case, and ignores ALL_PROXY (K0b item 5).
const PROXIES = ['HTTPS_PROXY', 'HTTP_PROXY'];

// The values env sets for a variable: on Windows every spelling is the one variable, elsewhere the upper- and lower-case ones.
function valuesOf(env, name, platform) {
  const names = platform === 'win32' ? Object.keys(env).filter(key => key.toUpperCase() === name) : [name, name.toLowerCase()];
  return names.map(key => env[key]).filter(value => typeof value === 'string' && value !== '');
}

// Whether one NO_PROXY value exempts the hook URL by the CLI's own rule: `*`, the exact host, host:port, or a .suffix.
const exempts = (value, port) => value.split(/[\s,]+/).some(entry => entry === '*' || entry === '127.0.0.1' || entry === `127.0.0.1:${port}`
  || entry.startsWith('.') && '127.0.0.1'.endsWith(entry));

// The proxy variable that would carry HTTP hooks to this port, or null. When NO_PROXY and no_proxy are both set, both must
// exempt the URL: in doubt, command hooks. bootstrap.ps1, bash-integration.bash and zsh-integration.zsh apply the same rule.
function proxyOf(env, port, platform = process.platform) {
  const variable = PROXIES.find(name => valuesOf(env, name, platform).length);
  if (!variable) return null;
  const exemptions = valuesOf(env, 'NO_PROXY', platform);
  return exemptions.length && exemptions.every(value => exempts(value, port)) ? null : variable;
}

// The env of Claude Code's own settings files, lowest precedence first, the way the CLI lays them over its environment.
function settingsEnvs({ env, cwd, platform, home, read }) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const managed = platform === 'win32' ? 'C:\\Program Files\\ClaudeCode' : platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : '/etc/claude-code';
  const files = { user: paths.join(env.CLAUDE_CONFIG_DIR || paths.join(home, '.claude'), 'settings.json'), project: paths.join(cwd, '.claude', 'settings.json'),
    local: paths.join(cwd, '.claude', 'settings.local.json'), managed: paths.join(managed, 'managed-settings.json') };
  return Object.entries(files).map(([source, file]) => {
    let value;
    try { value = JSON.parse(read(file))?.env; } catch { }
    return { source, env: value && typeof value === 'object' && !Array.isArray(value) ? value : {} };
  });
}

// The hook command of a PowerShell terminal. PowerShell or Git Bash may run it, so the executable path has no spaces and
// stays unquoted (a quoted first word is only a string in PowerShell), the script is quoted, and paths use forward slashes.
const powershellHook = ({ powershellPath, script, pipeName, projectId, sessionKey, node }) => kind => [powershellPath.replace(/\\/g, '/'),
  '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `"${script.replace(/\\/g, '/')}"`,
  '-PipeName', pipeName, '-ProjectId', projectId, '-SessionKey', sessionKey, '-Kind', kind,
  ...(['seat-routing', 'worker-permission'].includes(kind) ? ['-NodePath', `"${node.replace(/\\/g, '/')}"`] : [])].join(' ');
// The hook command of a zsh or Bash terminal, which Claude Code runs with sh: every word is quoted for it.
const shQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
const posixHook = ({ node, helper, socket, projectId, sessionKey, noteFile }) => kind => ['ELECTRON_RUN_AS_NODE=1',
  ...[node, helper, 'claude-hook', socket, projectId, sessionKey].map(shQuote), kind, ...(kind === 'session' ? [shQuote(noteFile || '')] : [])].join(' ');

// The --settings a terminal's wrapper passes Claude Code, which merge with the user's own: HTTP hooks for every event but
// SessionStart, or command hooks for all of them. Hidden roles use a synchronous permission decision on both channels.
function settings(channel, { url, key, command, seatRouting, workerPermission }) {
  const async = kind => kind === 'progress' || channel === 'command-async' && ASYNC_KINDS.includes(kind);
  const entry = hook => [{ hooks: [hook] }];
  const commandHook = event => ({ type: 'command', command: command(COMMAND_KINDS[event]), timeout: 10,
    ...(async(COMMAND_KINDS[event]) ? { async: true } : {}) });
  const hooks = channel === 'http'
    ? Object.fromEntries([...HTTP_EVENTS.map(event => [event, entry({ type: 'http', url: `${url}/${event}`, headers: { 'X-Agentrix-Key': key },
      timeout: DIALOGS.includes(event) ? 600 : 10 })]), ['SessionStart', entry(commandHook('SessionStart'))]])
    : Object.fromEntries(Object.keys(COMMAND_KINDS).map(event => [event, entry(commandHook(event))]));
  if (workerPermission) hooks.PermissionRequest = entry({ type: 'command', command: command('worker-permission'), timeout: 10 });
  if (seatRouting) for (const event of ['PreToolUse', 'PostToolUse']) {
    hooks[event].push({ matcher: 'Agent|Task', hooks: [{ type: 'command', command: command('seat-routing'), timeout: 5 }] });
  }
  return JSON.stringify({ hooks });
}

// How a terminal's Claude Code reports to main (C-2), decided when the terminal starts: HTTP hooks to the hook server on
// `port`, unless a proxy in its environment or in Claude Code's settings would carry them, or there is no server. Then
// command hooks: the status ones async on Windows (ASYNC_KINDS), synchronous elsewhere until a capture covers bash and
// zsh. The wrapper re-checks its live environment and may only fall back (downgradeHooks).
function terminalHooks({ port, terminalId, sessionKey, eventServer, env, cwd, shell, platform = process.platform, home = os.homedir(),
  read = file => fs.readFileSync(file, 'utf8'), seatRouting = false, workerPermission = false }) {
  const fallback = platform === 'win32' ? 'command-async' : 'command';
  const url = port ? `http://127.0.0.1:${port}/h/${encodeURIComponent(terminalId)}` : null;
  const key = createHmac('sha256', sessionKey).update(`hook:${terminalId}`).digest('hex');
  const layers = settingsEnvs({ env, cwd, platform, home, read });
  const variable = port && proxyOf(Object.assign({}, env, ...layers.map(layer => layer.env)), port, platform);
  const layer = variable && layers.findLast(({ env: values }) => Object.keys(values).some(name => name.toUpperCase() === variable && values[name]));
  const channelReason = !port ? reason('term.hooks_down', { source: 'hook-channel' })
    : variable ? reason('term.hooks_command_proxy', { source: 'hook-channel', params: { variable, source: layer?.source || 'environment' } }) : null;
  const command = shell.posix ? posixHook({ ...shell, socket: eventServer.address, projectId: terminalId, sessionKey })
    : powershellHook({ ...shell, pipeName: eventServer.name, projectId: terminalId, sessionKey });
  return { url, port: port || null, key, channel: channelReason ? fallback : 'http', fallback, channelReason, settings: {
    http: url && settings('http', { url, key, command, seatRouting, workerPermission }),
    fallback: settings(fallback, { command, seatRouting, workerPermission }),
  } };
}

// The wrapper found a proxy in its live environment and launched Claude Code with the fallback (the hook-channel shell
// event); the terminal never goes back to HTTP on its word.
function downgradeHooks(hooks, variable) {
  if (hooks?.channel !== 'http' || !PROXIES.includes(variable)) return hooks;
  return { ...hooks, channel: hooks.fallback,
    channelReason: reason('term.hooks_command_proxy', { source: 'wrapper', params: { variable, source: 'terminal' } }) };
}

// The hook events the pipe's claude-hook.ps1 kinds stood for (C-2), by the state claudeActivity takes.
const HOOK_STATES = { UserPromptSubmit: 'working', Stop: 'complete', StopFailure: 'failed', Notification: 'attention', PermissionRequest: 'attention',
  Elicitation: 'attention', PreToolUse: 'progress', PostToolUse: 'progress', PostToolUseFailure: 'progress', PermissionDenied: 'progress',
  ElicitationResult: 'progress' };
// The notifications that mean Claude waits for an answer; an idle one must not turn a finished round back into a waiting one.
const ATTENTION_NOTICES = ['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog'];
const SUBAGENT_KINDS = new Map([['SubagentStart', 'start'], ['SubagentStop', 'stop'], ['PreToolUse', 'continue']]);
const RECEIPTS = new Map([['PostToolUse', false], ['PostToolUseFailure', true], ['PermissionDenied', true]]);
const isNotice = name => name === 'Notification';

function signal(name, payload = {}, { agentId = payload.agent_id, toolUseId = payload.tool_use_id } = {}) {
  const state = Object.hasOwn(HOOK_STATES, name) ? HOOK_STATES[name] : null;
  if (name === 'SessionEnd') return { end: true };
  const kind = name === 'PreToolUse' && (payload.tool_name !== 'SendMessage' || agentId) ? null : SUBAGENT_KINDS.get(name);
  const subagent = kind && {
    kind, agentId: kind === 'continue' ? payload.tool_input?.to || payload.tool_input?.recipient : agentId, agentType: payload.agent_type || '',
    transcriptPath: typeof payload.agent_transcript_path === 'string' ? payload.agent_transcript_path : null, toolUseId: toolUseId || null,
  };
  const receipt = !agentId && toolUseId && RECEIPTS.has(name) ? { toolUseId, failed: RECEIPTS.get(name) } : null;
  const activity = state && (!isNotice(name) || ATTENTION_NOTICES.includes(payload.notification_type)) ? {
    state, hookEvent: name,
    message: state === 'attention' ? String(payload.message ?? payload.tool_name ?? '').slice(0, 300) : null,
    ...(state === 'attention' ? { dialog: name === 'Elicitation' || /^elicitation/.test(payload.notification_type || '') ? 'question' : 'permission' } : {}),
    prompt: state === 'working' && payload.prompt ? payload.prompt : null,
    ...(toolUseId ? { requestId: toolUseId } : {}),
  } : null;
  return { subagent, receipt, activity };
}

module.exports = { settings, signal, isNotice, HTTP_EVENTS, COMMAND_KINDS, proxyOf, terminalHooks, downgradeHooks };
