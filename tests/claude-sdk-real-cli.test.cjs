// Fake CLIs answer as we assume the real one does. These checks once passed while no owner session could run a tool or show a reply.
// Opt-in, because they need an installed CLI: AGENTRIX_REAL_CLAUDE=<path to claude> node --test tests/claude-sdk-real-cli.test.cjs
// A fake key, a throwaway profile and a local stub; nothing reaches an account.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { createNormalizer } = require('../electron/features/claude-sdk/normalize.cjs');
const cli = process.env.AGENTRIX_REAL_CLAUDE;
const skip = !cli && 'set AGENTRIX_REAL_CLAUDE';

const stream = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
const finish = reason => [{ type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 1 } }, { type: 'message_stop' }];
const opening = data => ({ type: 'message_start', message: { id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', model: data.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
const textBlock = (index, text) => [{ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }, { type: 'content_block_stop', index }];
const toolThenDone = data => JSON.stringify(data.messages).includes('tool_result')
  ? [opening(data), ...textBlock(0, 'DONE'), ...finish('end_turn')]
  : [opening(data), { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${randomUUID().replaceAll('-', '')}`, name: 'Bash', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: 'echo probe', description: 'probe' }) } }, { type: 'content_block_stop', index: 0 }, ...finish('tool_use')];
const thinkingThenText = data => [opening(data), { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'considering' } }, { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'c2ln' } }, { type: 'content_block_stop', index: 0 },
  ...textBlock(1, 'THE VISIBLE ANSWER'), ...finish('end_turn')];

async function harness(t, respond) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-real-cli-')), home = path.join(directory, 'home'), cwd = path.join(directory, 'project');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT']) { const key = Object.keys(process.env).find(item => item.toLowerCase() === name.toLowerCase()); if (key) env[key] = process.env[key]; }
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'r'), LOCALAPPDATA: path.join(home, 'l'), TEMP: path.join(directory, 't'), TMP: path.join(directory, 't'), TMPDIR: path.join(directory, 't'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ANTHROPIC_API_KEY: 'sk-ant-offline-not-a-real-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CI: '1' });
  for (const folder of [cwd, env.APPDATA, env.LOCALAPPDATA, env.TEMP, env.CLAUDE_CONFIG_DIR]) fs.mkdirSync(folder, { recursive: true });
  const stats = { requests: 0 };
  const server = http.createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (/count_tokens/.test(request.url)) return response.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":1}');
      if (!/\/messages/.test(request.url)) return response.writeHead(404).end();
      stats.requests++;
      const value = respond(JSON.parse(body));
      if (Array.isArray(value)) response.writeHead(200, { 'content-type': 'text/event-stream' }).end(stream(value));
      else if (value.events) { response.writeHead(200, { 'content-type': 'text/event-stream', ...value.headers }); if (value.hold) response.write(stream(value.events)); else response.end(stream(value.events)); }
      else response.writeHead(value.status, { 'content-type': 'application/json', 'x-should-retry': 'false', ...value.headers }).end(JSON.stringify(value.body));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const sdk = await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href);
  return { stats, cwd, run: async (options, onMessage = () => {}) => {
    stats.requests = 0; const abort = new AbortController();
    try {
      const query = sdk.query({ prompt: 'go', options: { cwd, env, model: 'claude-sonnet-4-5', pathToClaudeCodeExecutable: cli, permissionMode: 'default', settingSources: [], abortController: abort, ...options } });
      for await (const message of query) {
        onMessage(message, query);
        if (message.type === 'result') return message;
      }
    } finally { abort.abort(); }
    throw new Error('no result');
  } };
}

test('G4 the real CLI reports its interrupted streaming result instead of a completed task', { skip, timeout: 60000 }, async t => {
  const { run } = await harness(t, data => ({ hold: true, events: [opening(data), ...textBlock(0, 'PARTIAL')] }));
  let interrupted = false;
  const result = await run({ includePartialMessages: true, tools: [] }, (message, query) => {
    if (!interrupted && message.type === 'stream_event' && message.event.type === 'content_block_delta') { interrupted = true; void query.interrupt(); }
  });
  assert.equal(interrupted, true); assert.ok(['aborted_streaming', 'aborted_tools'].includes(result.terminal_reason));
  const normalized = require('../electron/features/claude-sdk/result.cjs').turnResult(result, { interrupted: true }); assert.equal(normalized.status, 'interrupted');
  t.diagnostic(JSON.stringify({ subtype: result.subtype, is_error: result.is_error, terminal_reason: result.terminal_reason }));
});

for (const [status, message] of [[429, 'enforced_spend_limit_reached'], [400, 'You have reached your specified API usage limits']]) {
  test(`G7 real API-key CLI maps HTTP ${status} spend rejection from a local stub`, { skip, timeout: 60000 }, async t => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const { run } = await harness(t, () => ({ status, headers: { 'anthropic-ratelimit-requests-reset': new Date(reset * 1000).toISOString(),
      'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': String(reset) }, body: { type: 'error', error: { type: 'rate_limit_error', message } } }));
    const events = [], records = [], rateLimits = require('../electron/features/claude-sdk/limits.cjs').rateLimits;
    const result = await run({ tools: [] }, item => { records.push(item); const limit = rateLimits(item, events.at(-1), 'offline', Date.now()); if (limit) events.push(limit); });
    assert.equal(result.is_error, true); assert.ok(events.some(limit => limit.notice?.code === 'spend_limit'));
    t.diagnostic(JSON.stringify({ status, subtype: result.subtype, terminal_reason: result.terminal_reason,
      rateEvents: records.filter(item => item.type === 'rate_limit_event').map(item => item.rate_limit_info), notices: events.map(item => item.notice) }));
  });
}
test('G7 real API-key CLI reports whether successful response headers produce rate-limit events', { skip, timeout: 60000 }, async t => {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const { run } = await harness(t, data => ({ headers: { 'anthropic-ratelimit-unified-status': 'allowed_warning',
    'anthropic-ratelimit-unified-5h-utilization': '0.8', 'anthropic-ratelimit-unified-5h-reset': String(reset) }, events: [opening(data), ...textBlock(0, 'DONE'), ...finish('end_turn')] }));
  const rates = []; const result = await run({ tools: [] }, item => { if (item.type === 'rate_limit_event') rates.push(item.rate_limit_info); });
  assert.equal(result.terminal_reason, 'completed'); t.diagnostic(JSON.stringify({ rateEvents: rates }));
});
test('G7 real API-key CLI reports a credit-balance rejection without inventing reset credits', { skip, timeout: 60000 }, async t => {
  const { run } = await harness(t, () => ({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } } }));
  const notices = [], frames = [];
  await run({ tools: [] }, item => { if (item.type === 'assistant' && item.error || item.type === 'rate_limit_event') frames.push({ type: item.type, error: item.error, rate_limit_info: item.rate_limit_info });
    const value = require('../electron/features/claude-sdk/limits.cjs').rateLimits(item, notices.at(-1), 'offline', Date.now()); if (value) notices.push(value); });
  assert.ok(notices.some(value => value.notice?.code === 'credits_required')); assert.ok(notices.every(value => value.resetCredits === null));
  t.diagnostic(JSON.stringify({ frames, notices: notices.map(value => value.notice) }));
});

test('the real CLI pauses a tool on a hook defer and runs it when the hook answers nothing', { skip, timeout: 180000 }, async t => {
  const { run, stats } = await harness(t, toolThenDone);
  const options = answer => ({ hooks: { PreToolUse: [{ hooks: [async () => answer] }] }, canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }) });
  const paused = await run(options({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer', permissionDecisionReason: 'x' } }));
  assert.ok(paused.deferred_tool_use); assert.equal(stats.requests, 1); assert.equal(paused.subtype, 'success');
  const ran = await run(options({}));
  assert.equal(ran.deferred_tool_use, undefined); assert.equal(stats.requests, 2); assert.equal(ran.result, 'DONE');
});

test('a real reply with thinking before its text reaches the view whole', { skip, timeout: 120000 }, async t => {
  const { run } = await harness(t, thinkingThenText);
  const events = [], records = [], normalize = createNormalizer((type, payload, extra) => events.push({ type, payload, itemId: extra?.itemId }));
  await run({ includePartialMessages: true }, message => { if (message.type === 'assistant') records.push(message.message.id); normalize(message); });
  const answers = events.filter(event => event.type === 'item.upsert' && event.payload.kind === 'agent-message');
  assert.equal(answers.length, 1); assert.equal(answers[0].payload.content.text, 'THE VISIBLE ANSWER');
  const live = events.filter(event => event.type === 'item.delta' && event.payload.channel === 'text');
  assert.equal(live.map(event => event.payload.text).join(''), 'THE VISIBLE ANSWER'); assert.equal(live[0].itemId, answers[0].itemId, 'the snapshot replaces its own deltas');
  t.diagnostic(`assistant records for the message: ${records.length}`);
});

// The tool the model asks for first, then a closing answer that says whether the tool's result reported a refusal.
const useTool = (name, input) => data => {
  const sent = JSON.stringify(data.messages);
  if (sent.includes('tool_result')) return [opening(data), ...textBlock(0, /tool_use_error|is_error":true/.test(sent) ? 'REFUSED' : 'DONE'), ...finish('end_turn')];
  return [opening(data), { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${randomUUID().replaceAll('-', '')}`, name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }, { type: 'content_block_stop', index: 0 }, ...finish('tool_use')];
};
const bypass = { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true };

test('bypass runs a tool without asking', { skip, timeout: 120000 }, async t => {
  const marker = path.join(os.tmpdir(), `agx-bypass-${randomUUID()}.txt`); t.after(() => fs.rmSync(marker, { force: true }));
  let asked = 0;
  const { run } = await harness(t, useTool('Write', { file_path: marker, content: 'written' }));
  const result = await run({ ...bypass, canUseTool: async () => { asked++; return { behavior: 'deny', message: 'no' }; } });
  assert.equal(asked, 0); assert.equal(fs.readFileSync(marker, 'utf8'), 'written'); assert.equal(result.result, 'DONE');
});

test('under bypass a PreToolUse deny still stops the tool, so the worker policy holds', { skip, timeout: 120000 }, async t => {
  const marker = path.join(os.tmpdir(), `agx-bypass-${randomUUID()}.txt`); t.after(() => fs.rmSync(marker, { force: true }));
  const { run } = await harness(t, useTool('Write', { file_path: marker, content: 'written' }));
  const hooks = { PreToolUse: [{ hooks: [async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'policy says no' } })] }] };
  const result = await run({ ...bypass, hooks });
  assert.equal(fs.existsSync(marker), false); assert.equal(result.result, 'REFUSED');
});

test('under bypass a question still reaches the owner through canUseTool', { skip, timeout: 120000 }, async t => {
  const questions = [{ question: 'Which one?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }] }];
  const asked = [];
  const { run } = await harness(t, useTool('AskUserQuestion', { questions }));
  const result = await run({ ...bypass, canUseTool: async (name, input) => { asked.push(name); return { behavior: 'allow', updatedInput: { ...input, answers: { 'Which one?': 'A' } } }; } });
  assert.deepEqual(asked, ['AskUserQuestion']); assert.equal(result.result, 'DONE');
});
