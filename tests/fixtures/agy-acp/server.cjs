const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { spawn } = require('node:child_process');

const [trace, scenario, acp, flag, profile] = process.argv.slice(2);
const sessionId = '670f1895-da18-4940-b596-4e80e0c3c387';
const neon = 'gemini-4-neon', flash = 'gemini-3.8-flash', fixed = 'gpt-oss-120b-medium';
const modelOptions = [{ value: neon, name: 'Gemini 4 Neon' }, { value: flash, name: 'Gemini 3.8 Flash' }, { value: fixed, name: 'GPT-OSS 120B (Medium)' }];
let model = neon, effort = 'high', mode = scenario === 'unsafe-mode' ? 'accept-edits' : 'default';
let turn, nextApproval = 0, stop = false;
const approvals = new Map();
let roleServer;
const options = [{ optionId: scenario === 'owner' ? 'permit-once' : 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: scenario === 'owner' ? 'reject-once' : 'deny', name: 'Deny', kind: 'reject_once' }];
const usage = { inputTokens: 4274, outputTokens: 66, cachedReadTokens: 15976, cachedWriteTokens: 0, thoughtTokens: 1, totalTokens: 20317 };
const log = value => fs.appendFileSync(trace, JSON.stringify(value) + '\n');
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const sendResult = (id, result) => send({ id, result });
const update = (sessionUpdate, fields) => send({ method: 'session/update', params: { sessionId, update: { sessionUpdate, ...fields } } });
const selection = (id, currentValue, options) => ({ id, type: 'select', currentValue, options });
const text = value => ({ type: 'text', text: value });
const output = value => ({ rawOutput: value, content: [{ type: 'content', content: text(value) }] });

log({ launch: { acp, flag, profile, autoUpdate: process.env.AGY_CLI_DISABLE_AUTO_UPDATE } });

function configOptions() {
  const levels = ['low', 'medium', 'high', ...(model === neon ? ['xhigh'] : [])];
  return [selection('model', model, modelOptions),
    ...(model === fixed ? [] : [selection('thought_level', effort, levels.map(value => ({ value, name: value })))]),
    selection('mode', mode, ['default', 'accept-edits', 'plan'].map(value => ({ value })))];
}

function completeTurn(stopReason = 'end_turn') {
  if (stopReason === 'end_turn' && turn.text !== 'NO_TRANSCRIPT') {
    const folder = path.join(profile, 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs');
    fs.mkdirSync(folder, { recursive: true });
    fs.appendFileSync(path.join(folder, 'transcript_full.jsonl'), JSON.stringify({
      type: 'PLANNER_RESPONSE', model: model === fixed ? model : `${model}-${effort}`,
    }) + '\n');
  }
  update('usage_update', { used: 10220, size: 1048576 });
  sendResult(turn.id, { stopReason, usage });
  turn = null;
  approvals.clear();
}

function permission(name, args, kind, title) {
  const toolCallId = `call_${++nextApproval}`, rawInput = args;
  const tool = { toolCallId, name, args, kind, title, rawInput };
  const id = `jetski-acp-front:${nextApproval}`;
  update('tool_call', { ...tool, status: 'in_progress' });
  update('tool_call_update', { ...tool, status: 'pending' });
  send({ method: 'session/request_permission', id, params: { sessionId,
    toolCall: { sessionUpdate: 'tool_call', ...tool, status: 'pending' }, options } });
  approvals.set(id, tool);
}

function prompt(id, params) {
  const input = params.prompt[0].text;
  turn = { id, text: input };
  update('usage_update', { used: 10096, size: 1048576 });
  if (scenario === 'ssh-role') {
    if (input.startsWith('Agentrix denied this operation:')) permission('mcp_agentrix_role_finish_role', {}, 'other', 'Finish role');
    else permission('write_file', { FilePath: path.join(process.cwd(), 'outside.txt') }, 'edit', 'Out-of-scope write');
    return;
  }
  switch (input) {
    case 'CANCEL_MULTIPLE':
      for (const file of ['one.txt', 'two.txt']) permission('replace_file_content', { TargetFile: file }, 'edit', 'Pending edit');
      break;
    case 'ALLOW':
    case 'CANCEL':
    case 'EXIT':
      permission('run_command', { CommandLine: 'echo ACP_MARK', WaitMsBeforeAsync: 5000, toolSummary: 'Echo mark test' }, 'execute', 'untrusted title');
      if (input === 'EXIT') process.stdout.write('', () => process.exit(17));
      break;
    case 'DENY':
      permission('replace_file_content', { TargetFile: 'result.txt' }, 'edit', 'untrusted title');
      break;
    case 'ROLE':
      permission('mcp_agentrix_role_finish_role', { answer: 'OK' }, 'other', 'Run role tool');
      break;
    case 'UNKNOWN':
      permission('mcp_agentrix_role_finish_role_copy', {}, 'other', 'Run role tool with a confusing name');
      break;
    default:
      update('agent_message_chunk', { content: text('OK') });
      completeTurn();
      if (input === 'EXIT_AFTER_REPLY') process.stdout.write('', () => process.exit(17));
  }
}

function onApproval(message) {
  const tool = approvals.get(message.id);
  assert.ok(tool, 'reply must carry a pending approval ID');
  approvals.delete(message.id);
  if (turn.cancelling) {
    assert.deepEqual(message.result, { outcome: { outcome: 'cancelled' } });
    update('tool_call_update', { ...tool, status: 'failed' });
    if (!approvals.size) completeTurn('cancelled');
    return;
  }
  const allowed = message.result.outcome.optionId === options[0].optionId;
  update('tool_call_update', { ...tool, status: 'in_progress' });
  update('tool_call_update', { toolCallId: tool.toolCallId, status: allowed ? 'completed' : 'failed',
    ...output(allowed ? 'PROBE_TOOL_RESULT_719' : 'user denied permission') });
  if (allowed) {
    update('agent_thought_chunk', { content: text('Thought') });
    update('agent_message_chunk', { content: text('O') });
    update('agent_message_chunk', { content: text('K') });
  }
  if (scenario === 'ssh-role' && allowed && tool.name === 'mcp_agentrix_role_finish_role') return finishRole();
  completeTurn(scenario === 'ssh-role' && !allowed ? 'refusal' : 'end_turn');
}

function finishRole() {
  const env = Object.fromEntries(roleServer.env.map(({ name, value }) => [name, value]));
  const tool = spawn(roleServer.command, roleServer.args, { env: { ...process.env, ...env }, windowsHide: true });
  let output = '', stderr = '';
  tool.stdout.on('data', chunk => { output += chunk; });
  tool.stderr.on('data', chunk => { stderr += chunk; });
  tool.once('close', code => {
    log({ finishRole: { code, output, stderr } });
    assert.equal(code, 0);
    const reply = JSON.parse(output);
    assert.equal(reply.result.isError, undefined, output);
    assert.equal(JSON.parse(reply.result.content[0].text).saved, true);
    completeTurn();
  });
  tool.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'finish_role', arguments: { answer: 'Finished through the carried role tool.' } } }) + '\n');
}

function onMessage(message) {
  log(message);
  assert.equal(message.jsonrpc, '2.0');
  const { id, method, params } = message;
  if (!method) return onApproval(message);
  if (method !== 'session/cancel') assert.equal(typeof id, 'string');
  switch (method) {
    case 'initialize':
      sendResult(id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } }, agentInfo: { version: '1.5.18' } });
      break;
    case 'session/new':
    case 'session/resume':
      if (method === 'session/resume') assert.equal(params.sessionId, sessionId);
      if (scenario === 'auth') return send({ id, error: { code: -32000, message: 'Authentication required' } });
      if (scenario === 'ssh-role') roleServer = params.mcpServers[0];
      sendResult(id, { ...(method === 'session/new' && { sessionId }), configOptions: configOptions() });
      break;
    case 'session/load':
      assert.equal(params.sessionId, sessionId);
      assert.equal(params._meta, undefined);
      update('user_message_chunk', { content: text('Previous question') });
      update('agent_message_chunk', { content: text('Previous ') });
      update('agent_message_chunk', { content: text('answer') });
      update('usage_update', { used: 111, size: 1048576 });
      sendResult(id, { configOptions: configOptions() });
      break;
    case 'session/list': {
      const cwd = process.platform === 'win32' ? `/${params.cwd.replaceAll('\\', '/')}` : params.cwd;
      const match = { sessionId, cwd, title: 'Previous session', updatedAt: '2026-11-26T16:36:09Z' };
      const other = { ...match, sessionId: '3fae06d2-2995-4784-a0a0-2ea80260aa02', cwd: `${cwd}/other` };
      sendResult(id, params.cursor ? { sessions: [match] } : { sessions: [other], nextCursor: 'next' });
      break;
    }
    case 'session/set_config_option':
      if (params.configId === 'model') { model = params.value; effort = 'high'; }
      if (params.configId === 'thought_level') effort = params.value;
      if (params.configId === 'mode') mode = params.value;
      sendResult(id, { configOptions: configOptions() });
      break;
    case 'session/prompt': prompt(id, params); break;
    case 'session/cancel':
      assert.equal(id, undefined);
      turn.cancelling = true;
      if (!approvals.size) completeTurn('cancelled');
      break;
    case 'session/close': sendResult(id, {}); stop = true; break;
    default: throw new Error('Unexpected ACP method ' + method);
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', line => { if (!stop) onMessage(JSON.parse(line)); });
