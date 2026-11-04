// Two offline wire peers. The installed SDK and packaged main remain real; only the provider executables are fake.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const mode = process.argv[2], args = process.argv.slice(3);
if (mode === 'tool') {
  process.stdout.write(JSON.stringify({ keyPresent: Object.keys(process.env).some(name => /^(ANTHROPIC_|CLAUDE_CODE_OAUTH)/i.test(name)) }));
  process.exit(0);
}
if (args.includes('--version')) {
  console.log(mode === 'claude' ? '2.1.317 (Claude Code)' : 'codex-cli 0.166.0'); process.exit(0);
}
const output = process.env.AGENTRIX_FAKE_OUTPUT;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const append = value => fs.appendFileSync(path.join(output, `${mode}-wire.jsonl`), JSON.stringify(value) + '\n');
const resume = args.find(value => value.startsWith('--resume='))?.slice('--resume='.length)
  || (args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null);
let sessionId = resume || randomUUID();
const costsFile = path.join(output, 'fake-costs.json');
const costs = fs.existsSync(costsFile) ? JSON.parse(fs.readFileSync(costsFile, 'utf8')) : {};
let total = costs[sessionId] || 0, turns = 0, activeTurn;
const baseline = total, budgetIndex = args.indexOf('--max-budget-usd');
const budgetValue = args.find(arg => arg.startsWith('--max-budget-usd='))?.split('=')[1] ?? (budgetIndex < 0 ? undefined : args[budgetIndex + 1]);
const budget = budgetValue === undefined ? Infinity : Number(budgetValue);
append({ spawn: true, pid: process.pid, parentPid: process.ppid, node: process.execPath, args, scrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB === '1',
  configDir: process.env.CLAUDE_CONFIG_DIR || null, hasBootstrap: !!process.env.AGENTRIX_BOOTSTRAP });
process.once('exit', code => append({ exit: true, pid: process.pid, code }));
function toolEnvironment() {
  const env = { ...process.env };
  if (env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB === '1') for (const name of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH)/i.test(name)) delete env[name];
  }
  return env;
}
function transcriptFile() {
  const key = process.cwd().replace(/[^A-Za-z0-9]/g, '-');
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || process.env.USERPROFILE, '.claude'), 'projects', key, sessionId + '.jsonl');
}
if (mode === 'claude' && !args.some(arg => arg === '--input-format' || arg.startsWith('--input-format='))) {
  const transcript = transcriptFile();
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  if (!fs.existsSync(transcript)) fs.writeFileSync(transcript, '');
  const bootstrap = JSON.parse(fs.readFileSync(process.env.AGENTRIX_BOOTSTRAP, 'utf8'));
  const socket = process.platform === 'win32' && !bootstrap.pipeName.startsWith('\\') ? '\\\\.\\pipe\\' + bootstrap.pipeName : bootstrap.pipeName;
  const connection = require('node:net').connect(socket);
  connection.on('error', error => { throw error; });
  connection.on('connect', () => connection.end(JSON.stringify({ projectId: bootstrap.projectId, sessionKey: bootstrap.sessionKey, type: 'agent-activity',
    agent: 'claude', state: 'session', sessionId, eventId: randomUUID(), sentAt: Date.now(), sessionSource: resume ? 'resume' : 'startup', transcriptPath: transcript }) + '\n'));
  console.log('OFFLINE_TERMINAL_READY'); process.stdin.resume();
  return;
}
function claudeUser(message) {
  const childResults = ['bash', 'hook', 'mcp'].map(kind => {
    const child = spawnSync(process.execPath, [__filename, 'tool'], { env: toolEnvironment(), windowsHide: true, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
    if (child.status !== 0) throw new Error('fake tool failed');
    return { kind, ...JSON.parse(child.stdout) };
  });
  append({ user: true, pid: process.pid, sessionId, childResults });
  const transcript = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || process.env.USERPROFILE, '.claude'), 'projects', 'fake-session.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.appendFileSync(transcript, JSON.stringify({ sessionId, childResults }) + '\n');
  const history = transcriptFile(), answerId = randomUUID(); fs.mkdirSync(path.dirname(history), { recursive: true });
  for (const entry of [{ type: 'user', uuid: message.uuid, parentUuid: null, message: message.message },
    { type: 'assistant', uuid: answerId, parentUuid: message.uuid, message: { role: 'assistant', content: [{ type: 'text', text: 'PACKAGED_CLAUDE_OK' }] } }]) {
    fs.appendFileSync(history, JSON.stringify({ ...entry, sessionId, cwd: process.cwd(), timestamp: new Date().toISOString(), isSidechain: false, userType: 'external' }) + '\n');
  }
  for (const state of ['queued', 'started']) send({ type: 'command_lifecycle', command_uuid: message.uuid, state, uuid: randomUUID(), session_id: sessionId });
  send({ type: 'system', subtype: 'init', session_id: sessionId, apiKeySource: 'ANTHROPIC_API_KEY', model: 'fake-claude',
    tools: ['Read'], mcp_servers: [], permissionMode: 'default', slash_commands: [], claude_code_version: '2.1.317', uuid: randomUUID() });
  const text = typeof message.message?.content === 'string' ? message.message.content : 'image';
  if (text === 'HOLD') return;
  send({ type: 'assistant', session_id: sessionId, parent_tool_use_id: null, uuid: randomUUID(), user_message_uuid: message.uuid,
    message: { id: randomUUID(), type: 'message', role: 'assistant', model: 'fake-claude', content: [{ type: 'text', text: 'PACKAGED_CLAUDE_OK' }], usage: { input_tokens: 1, output_tokens: 2 } } });
  total += text === 'BUDGET_TURN' ? 2 : 0.01;
  const limited = total - baseline >= budget;
  costs[sessionId] = total; fs.writeFileSync(costsFile, JSON.stringify(costs));
  send({ type: 'result', session_id: sessionId, uuid: randomUUID(), subtype: limited ? 'error_max_budget_usd' : 'success', is_error: limited, result: 'PACKAGED_CLAUDE_OK',
    user_message_uuid: message.uuid, user_message_uuids: [message.uuid], queued_turn_count: 0, total_cost_usd: total,
    duration_ms: 1, duration_api_ms: 1, num_turns: 1, permission_denials: [], usage: { input_tokens: 1, output_tokens: 2 },
    modelUsage: { 'fake-claude': { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 100 } } });
}
const reader = readline.createInterface({ input: process.stdin });
reader.on('line', line => {
  const message = JSON.parse(line);
  if (mode === 'claude') {
    if (message.type === 'control_request') {
      append({ control: message.request?.subtype });
      if (process.env.AGENTRIX_FAKE_INIT_FAILURE === '1') return process.exit(7);
      send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {
        commands: [], models: [], agents: [], output_style: 'default', available_output_styles: ['default'],
        account: process.env.AGENTRIX_FAKE_OMIT_BILLING === '1' ? {} : { apiKeySource: process.env.AGENTRIX_FAKE_API_SOURCE || 'ANTHROPIC_API_KEY', tokenSource: process.env.AGENTRIX_FAKE_TOKEN_SOURCE || 'none' },
        hook_on_failure_supported: true, hooks_applied: true,
      } } });
    } else if (message.type === 'user') claudeUser(message);
    return;
  }
  const params = message.params || {};
  append({ rpc: message.method, pid: process.pid });
  if (['thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt'].includes(message.method)
      && !params.threadId) {
    send({ id: message.id, error: { code: -32602, message: 'Missing required threadId' } });
    return;
  }
  let result = {};
  if (message.method === 'initialize') result = { userAgent: 'codex/0.166.0' };
  else if (message.method === 'thread/start' || message.method === 'thread/resume') {
    sessionId = params.threadId || sessionId;
    result = { thread: { id: sessionId, turns: [] }, cwd: params.cwd, model: params.model, reasoningEffort: 'high',
      serviceTier: params.serviceTier, sandbox: { type: 'workspaceWrite' } };
  } else if (message.method === 'turn/start') {
    activeTurn = `turn-${++turns}`; result = { turn: { id: activeTurn, status: 'inProgress', items: [] } };
    send({ id: message.id, result });
    send({ method: 'turn/started', params: { threadId: sessionId, turn: result.turn } });
    append({ user: true, sessionId });
    if (params.input?.[0]?.text === 'HOLD') return;
    send({ method: 'item/completed', params: { threadId: sessionId, turnId: activeTurn,
      item: { id: `item-${turns}`, type: 'agentMessage', phase: 'final_answer', text: 'PACKAGED_CODEX_OK' } } });
    send({ method: 'turn/completed', params: { threadId: sessionId, turn: { id: activeTurn, status: 'completed' } } });
    return;
  } else if (message.method === 'turn/interrupt') {
    send({ method: 'turn/completed', params: { threadId: sessionId, turn: { id: activeTurn, status: 'interrupted' } } });
  } else if (message.method === 'account/read') result = { account: { type: 'chatgpt', email: 'private-offline-fixture' } };
  else if (message.method === 'account/rateLimits/read') result = {};
  if (message.id !== undefined) send({ id: message.id, result });
});
reader.on('close', () => process.exit(0));
