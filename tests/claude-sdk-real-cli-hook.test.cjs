// Fake CLIs do not know what a hook's answer means to the real one: this check once passed while no owner session could run a tool.
// Opt-in, because it needs an installed CLI: AGENTRIX_REAL_CLAUDE=<path to claude> node --test tests/claude-sdk-real-cli-hook.test.cjs
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
const cli = process.env.AGENTRIX_REAL_CLAUDE;

const stream = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
function reply(data) {
  const id = `m_${randomUUID()}`, start = { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: data.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } };
  const end = reason => [{ type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 1 } }, { type: 'message_stop' }];
  if (JSON.stringify(data.messages).includes('tool_result')) return [start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'DONE' } }, ...end('end_turn')];
  return [start, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${randomUUID().replaceAll('-', '')}`, name: 'Bash', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: 'echo probe', description: 'probe' }) } }, ...end('tool_use')];
}

test('the real CLI pauses a tool on a hook defer and runs it when the hook answers nothing', { skip: !cli && 'set AGENTRIX_REAL_CLAUDE', timeout: 180000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-real-hook-')), home = path.join(directory, 'home'), cwd = path.join(directory, 'project');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT']) { const key = Object.keys(process.env).find(item => item.toLowerCase() === name.toLowerCase()); if (key) env[key] = process.env[key]; }
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'r'), LOCALAPPDATA: path.join(home, 'l'), TEMP: path.join(directory, 't'), TMP: path.join(directory, 't'), TMPDIR: path.join(directory, 't'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ANTHROPIC_API_KEY: 'sk-ant-offline-not-a-real-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CI: '1' });
  for (const folder of [cwd, env.APPDATA, env.LOCALAPPDATA, env.TEMP, env.CLAUDE_CONFIG_DIR]) fs.mkdirSync(folder, { recursive: true });
  let requests = 0;
  const server = http.createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (/count_tokens/.test(request.url)) return response.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":1}');
      if (!/\/messages/.test(request.url)) return response.writeHead(404).end();
      requests++; response.writeHead(200, { 'content-type': 'text/event-stream' }).end(stream(reply(JSON.parse(body))));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const sdk = await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href);
  const run = async answer => {
    requests = 0; const abort = new AbortController();
    try {
      for await (const message of sdk.query({ prompt: 'use bash', options: { cwd, env, model: 'claude-sonnet-4-5', pathToClaudeCodeExecutable: cli, permissionMode: 'default', settingSources: [], abortController: abort,
        hooks: { PreToolUse: [{ hooks: [async () => answer] }] }, canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }) } })) {
        if (message.type === 'result') return { result: message, requests };
      }
    } finally { abort.abort(); }
    throw new Error('no result');
  };
  const paused = await run({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer', permissionDecisionReason: 'x' } });
  assert.ok(paused.result.deferred_tool_use); assert.equal(paused.requests, 1); assert.equal(paused.result.subtype, 'success');
  const ran = await run({});
  assert.equal(ran.result.deferred_tool_use, undefined); assert.equal(ran.requests, 2); assert.equal(ran.result.result, 'DONE');
});
