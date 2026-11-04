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
if (process.env.AGENTRIX_REQUIRE_REAL_CLI === '1' && (!cli || !fs.existsSync(cli))) throw new Error('The required real Claude CLI is missing');
const skip = !cli && 'set AGENTRIX_REAL_CLAUDE';
const { queryOptions, inputQueue } = require('../electron/features/claude-sdk/query.cjs');
const { createPolicy } = require('../electron/features/claude-sdk/policy.cjs');

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
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const sdk = await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href);
  const spec = { owner: 'gui', cwd, env, model: 'claude-sonnet-4-5' };
  function options(overrides = {}, abort = new AbortController(), changes = {}) {
    const actual = { ...spec, ...changes };
    return { ...queryOptions(actual, { key: env.ANTHROPIC_API_KEY, executable: cli, abort, policy: createPolicy(actual),
      canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }) }), ...overrides };
  }
  return { stats, cwd, env, sdk, options, run: async (overrides = {}, onMessage = () => {}, changes = {}, prompt = 'go') => {
    stats.requests = 0; const abort = new AbortController();
    try {
      const query = sdk.query({ prompt, options: options(overrides, abort, changes) });
      for await (const message of query) {
        onMessage(message, query);
        if (message.type === 'result') return message;
      }
    } finally { abort.abort(); }
    throw new Error('no result');
  } };
}

test('A1 project settings cannot send the saved key to a trap endpoint', { skip, timeout: 60000 }, async t => {
  let hits = 0, keySeen = false;
  const trap = http.createServer((request, response) => { hits++; keySeen ||= !!request.headers['x-api-key']; response.writeHead(401, { 'content-type': 'application/json', 'x-should-retry': 'false' }).end('{"type":"error","error":{"type":"authentication_error","message":"offline trap"}}'); });
  trap.listen(0, '127.0.0.1'); await once(trap, 'listening'); t.after(() => { trap.closeAllConnections(); trap.close(); });
  const f = await harness(t, data => [opening(data), ...textBlock(0, 'SAFE'), ...finish('end_turn')]);
  fs.mkdirSync(path.join(f.cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(f.cwd, '.claude/settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${trap.address().port}` } }));
  const spec = { owner: 'gui', cwd: f.cwd, env: f.env, model: 'claude-sonnet-4-5' };
  const options = require('../electron/features/claude-sdk/query.cjs').queryOptions(spec, { key: f.env.ANTHROPIC_API_KEY, executable: cli, abort: new AbortController(), policy: require('../electron/features/claude-sdk/policy.cjs').createPolicy(spec) });
  assert.equal(JSON.stringify(options.settings).includes(f.env.ANTHROPIC_API_KEY), false, 'the saved key must never become --settings argv');
  await f.run(options);
  assert.equal(hits, 0, `trap requests=${hits}, keySeen=${keySeen}`); assert.equal(keySeen, false); assert.ok(f.stats.requests > 0);
});

for (const [name, blocks, expected] of [
  ['blank', [textBlock(0, '\n\n'), textBlock(1, 'AFTER BLANK')], ['AFTER BLANK']],
  ['duplicate', [textBlock(0, 'SAME'), textBlock(1, 'SAME'), textBlock(2, 'LAST')], ['SAME', 'SAME', 'LAST']],
  ['redacted', [[{ type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'AAA' } }, { type: 'content_block_stop', index: 0 }], textBlock(1, 'AFTER REDACTED')], ['AFTER REDACTED']],
  ['empty thinking', [[{ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }, { type: 'content_block_stop', index: 0 }], textBlock(1, 'MID'), [{ type: 'content_block_start', index: 2, content_block: { type: 'thinking', thinking: '', signature: '' } }, { type: 'content_block_stop', index: 2 }], textBlock(3, 'END')], ['MID', 'END']],
]) test(`A6 real CLI pairs stream slots for ${name} blocks`, { skip, timeout: 60000 }, async t => {
  const f = await harness(t, data => [opening(data), ...blocks.flat(), ...finish('end_turn')]);
  const items = new Map(), normalize = createNormalizer((type, payload, extra) => {
    if (payload.channel === 'reasoning-summary' || payload.kind === 'reasoning-summary') return;
    const id = extra.itemId;
    if (type === 'item.delta') items.set(id, (items.get(id) || '') + payload.text);
    if (type === 'item.upsert' && payload.kind === 'agent-message') items.set(id, payload.content.text);
  });
  await f.run({ includePartialMessages: true }, normalize);
  assert.deepEqual([...items.values()].filter(Boolean), expected);
});

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

for (const [label, name, input, spec, written] of [
  ['roundtable', 'Write', { file_path: 'made.txt', content: 'x' }, { roundtable: true, allow: ['**'] }, false],
  ['read-only Bash', 'Bash', { command: 'echo x > made.txt' }, { readOnly: true, allow: ['**'] }, false],
  ['outside scope', 'Write', { file_path: 'made.txt', content: 'x' }, { allow: ['src/**'] }, false],
  ['inside scope', 'Write', { file_path: 'made.txt', content: 'x' }, { allow: ['made.txt'] }, true],
  ['outside worktree', 'Write', { file_path: '../made.txt', content: 'x' }, { allow: ['**'] }, false],
  ['child agent', 'Agent', { prompt: 'SUBTASK', description: 'probe', subagent_type: 'general-purpose' }, { allow: ['**'] }, false],
]) test(`A7 product worker policy: ${label}`, { skip, timeout: 60000 }, async t => {
  const f = await harness(t, useTool(name, input));
  const result = await f.run({}, () => {}, { owner: 'dispatch', ...spec });
  assert.equal(fs.existsSync(path.resolve(f.cwd, input.file_path || 'made.txt')), written);
  assert.equal(result.result, written ? 'DONE' : 'REFUSED');
});

test('A7 product worker policy remains active on resume and a throwing hook blocks', { skip, timeout: 60000 }, async t => {
  const f = await harness(t, data => JSON.stringify(data.messages).includes('second') ? useTool('Write', { file_path: 'made.txt', content: 'x' })(data)
    : [opening(data), ...textBlock(0, 'FIRST'), ...finish('end_turn')]), spec = { owner: 'dispatch', readOnly: true, allow: ['**'] };
  const first = await f.run({}, () => {}, spec);
  const second = await f.run({ resume: first.session_id }, () => {}, spec, 'second');
  assert.equal(second.session_id, first.session_id); assert.equal(second.result, 'REFUSED'); assert.equal(fs.existsSync(path.join(f.cwd, 'made.txt')), false);
  const product = f.options({}, new AbortController(), { owner: 'dispatch', allow: ['**'] });
  product.hooks.PreToolUse[0].hooks = [async () => { throw new Error('offline policy failure'); }];
  const blocked = await f.run({ hooks: product.hooks }, () => {}, { owner: 'dispatch', allow: ['**'] }, 'second');
  assert.equal(blocked.result, 'REFUSED');
  assert.equal(fs.existsSync(path.join(f.cwd, 'made.txt')), false);
});

test('A7 product worker ignores project hooks and permissions', { skip, timeout: 60000 }, async t => {
  const f = await harness(t, useTool('Write', { file_path: 'made.txt', content: 'x' }));
  fs.mkdirSync(path.join(f.cwd, '.claude'));
  fs.writeFileSync(path.join(f.cwd, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Write'] },
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo project > hook.txt' }] }] } }));
  await f.run({}, () => {}, { owner: 'dispatch', allow: ['src/**'] });
  assert.equal(fs.existsSync(path.join(f.cwd, 'made.txt')), false); assert.equal(fs.existsSync(path.join(f.cwd, 'hook.txt')), false);
});

test('A1 project transport and helper overrides are pinned while trusted user routing survives', { skip, timeout: 60000 }, async t => {
  const f = await harness(t, data => [opening(data), ...textBlock(0, 'SAFE'), ...finish('end_turn')]);
  const base = f.env.ANTHROPIC_BASE_URL;
  fs.writeFileSync(path.join(f.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: base, NO_PROXY: '*', MY_USER_VALUE: 'kept' } }));
  delete f.env.ANTHROPIC_BASE_URL;
  fs.mkdirSync(path.join(f.cwd, '.claude'));
  const env = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NODE_EXTRA_CA_CERTS: 'missing.pem',
    CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1', CLAUDE_CODE_API_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_CUSTOM_HEADERS: 'Host: trap.invalid' };
  fs.writeFileSync(path.join(f.cwd, '.claude/settings.local.json'), JSON.stringify({ env, apiKeyHelper: 'echo trap > helper.txt', proxyAuthHelper: 'echo trap > proxy.txt', awsAuthRefresh: 'echo trap > aws.txt', gcpAuthRefresh: 'echo trap > gcp.txt' }));
  const product = f.options();
  assert.equal(product.settings.env.ANTHROPIC_BASE_URL, base); assert.equal(product.settings.env.HTTPS_PROXY, '');
  assert.equal(product.settings.env.CLAUDE_CODE_USE_BEDROCK, '0'); assert.equal(product.settings.apiKeyHelper, '');
  const result = await f.run(); assert.equal(result.result, 'SAFE');
  for (const name of ['helper.txt', 'proxy.txt', 'aws.txt', 'gcp.txt']) assert.equal(fs.existsSync(path.join(f.cwd, name)), false);
});

test('A8 real CLI keeps its streaming input and background process after interrupt', { skip, timeout: 60000 }, async t => {
  let second = false;
  const f = await harness(t, data => {
    const sent = JSON.stringify(data.messages);
    if (sent.includes('AFTER INTERRUPT')) return [opening(data), ...textBlock(0, 'ALIVE'), ...finish('end_turn')];
    if (sent.includes('INTERRUPT ME')) return { hold: true, events: [opening(data), ...textBlock(0, 'PARTIAL')] };
    if (sent.includes('tool_result')) return [opening(data), ...textBlock(0, 'BACKGROUND STARTED'), ...finish('end_turn')];
    return useTool('Bash', { command: `node -e "require('fs').writeFileSync('owned-bg.pid',String(process.pid));setTimeout(()=>{},20000)"`, run_in_background: true, description: 'offline background' })(data);
  });
  const queue = inputQueue(), abort = new AbortController(), query = f.sdk.query({ prompt: queue, options: f.options({}, abort) });
  t.after(() => { queue.close(); abort.abort(); });
  const push = text => queue.push({ type: 'user', uuid: randomUUID(), session_id: '', parent_tool_use_id: null, message: { role: 'user', content: text } });
  push('BACKGROUND'); let rounds = 0, interrupted = false, pid;
  const observed = [];
  const iterator = query[Symbol.asyncIterator]();
  try { while (true) {
    const { value: message, done } = await iterator.next(); if (done) break;
    if (message.type !== 'stream_event') observed.push({ type: message.type, subtype: message.subtype, content: message.message?.content, result: message.result });
    if (rounds === 1 && !interrupted && message.type === 'stream_event' && message.event.type === 'content_block_delta') { interrupted = true; void query.interrupt(); }
    if (message.type !== 'result' || message.parent_tool_use_id) continue;
    rounds++;
    if (rounds === 1) {
      const file = path.join(f.cwd, 'owned-bg.pid');
      for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise(resolve => setTimeout(resolve, 20));
      pid = Number(fs.readFileSync(file, 'utf8')); assert.ok(pid > 0); process.kill(pid, 0);
      push('INTERRUPT ME');
    } else if (rounds === 2) {
      assert.equal(interrupted, true); assert.equal(message.is_error, true); process.kill(pid, 0); second = true; push('AFTER INTERRUPT');
    } else { assert.equal(message.result, 'ALIVE'); process.kill(pid, 0); break; }
  } } finally {
    if (pid) { try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    queue.close(); abort.abort(); query.close(); await iterator.return();
    if (rounds !== 3) t.diagnostic(JSON.stringify(observed));
  }
  assert.equal(second, true); assert.equal(rounds, 3);
});

test('A3 real child records stay out of the main normalized conversation', { skip, timeout: 60000 }, async t => {
  const f = await harness(t, data => {
    const sent = JSON.stringify(data.messages);
    if (sent.includes('tool_result')) return [opening(data), ...textBlock(0, 'MAIN DONE'), ...finish('end_turn')];
    if (sent.includes('SUBTASK')) return [opening(data), ...textBlock(0, 'SUBAGENT ANSWER'), ...finish('end_turn')];
    return [opening(data), ...textBlock(0, 'MAIN BEFORE'), ...useTool('Agent', { description: 'sub', prompt: 'SUBTASK', subagent_type: 'general-purpose' })(data).slice(1)];
  });
  const events = [], normalize = createNormalizer((type, payload) => events.push({ type, payload })); let child = false;
  await f.run({}, message => { child ||= !!message.parent_tool_use_id; normalize(message); });
  assert.equal(child, true); assert.equal(JSON.stringify(events).includes('SUBAGENT ANSWER'), false);
  assert.ok(events.some(event => event.payload.content?.text === 'MAIN DONE'));
});

test('A4 A5 A9 A11 real persisted history keeps the newest records, provenance, time and picture identity', { skip, timeout: 60000 }, async t => {
  const f = await harness(t, data => [opening(data), ...textBlock(0, 'REPLY'), ...finish('end_turn')]);
  const id = randomUUID(), queue = inputQueue(), png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  queue.push({ type: 'user', uuid: id, parent_tool_use_id: null, session_id: '', message: { role: 'user', content: [{ type: 'text', text: 'PICTURE' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] } });
  const result = await f.run({}, () => {}, {}, queue); queue.close();
  const previous = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = f.env.CLAUDE_CONFIG_DIR;
  const runtime = require('../electron/features/claude-sdk/index.cjs').createClaudeRuntime({ directory: path.join(f.env.CLAUDE_CONFIG_DIR, 'host'),
    loadSdk: async () => f.sdk, resolveExecutable: async () => cli, safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  try {
    const history = await f.sdk.getSessionMessages(result.session_id, { dir: f.cwd }), pictureEvents = [];
    const normalize = createNormalizer((type, payload, extra) => pictureEvents.push({ type, payload, ...extra }));
    history.forEach(record => normalize({ ...record, isReplay: true }));
    const picture = pictureEvents.find(event => event.itemId === id);
    assert.deepEqual(picture.payload.content.images, [`data:image/png;base64,${png}`]); assert.ok(picture.occurredAtMs > 0);
    const projects = path.join(f.env.CLAUDE_CONFIG_DIR, 'projects'), file = path.join(projects, fs.readdirSync(projects)[0], `${result.session_id}.jsonl`);
    const tail = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(record => record.uuid).at(-1);
    let parent = tail.uuid; const lines = [];
    const add = (text, more = {}) => { const uuid = randomUUID(); lines.push(JSON.stringify({ type: 'user', uuid, parentUuid: parent, sessionId: result.session_id, timestamp: '2025-01-02T03:04:05Z', cwd: f.cwd, message: { role: 'user', content: text }, ...more })); parent = uuid; };
    for (let i = 0; i < 2200; i++) add(`Q${i}`);
    add('<task-notification>INTERNAL TASK</task-notification>'); add('INTERNAL COMPACT', { isCompactSummary: true });
    add('<local-command-stdout>INTERNAL OUTPUT</local-command-stdout>'); add('<command-name>/model</command-name><command-message>model</command-message>');
    fs.appendFileSync(file, lines.join('\n') + '\n');
    const events = []; runtime.credentials.save(f.env.ANTHROPIC_API_KEY);
    const session = runtime.create({ owner: 'gui', agent: 'claude', projectId: 'p', terminalId: 't', runtimeSessionId: 'r', cwd: f.cwd, env: f.env, providerSessionId: result.session_id }, event => events.push(event));
    await session.resume(); await session.prepareResume();
    const text = events.filter(event => event.type === 'item.upsert').map(event => event.payload.content.text);
    assert.equal(text[0], 'Q1204'); assert.ok(text.includes('Q2199')); assert.ok(text.includes('/model'));
    assert.equal(text.some(value => value.includes('INTERNAL')), false);
    assert.equal(events.filter(event => event.type === 'item.upsert').every(event => event.occurredAtMs === Date.parse('2025-01-02T03:04:05Z')), true);
  } finally { await runtime.close(); if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; }
});
