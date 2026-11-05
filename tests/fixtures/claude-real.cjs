const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { createNormalizer } = require('../../electron/features/claude-sdk/normalize.cjs');
const cli = process.env.AGENTRIX_REAL_CLAUDE;

const skip = !cli && 'set AGENTRIX_REAL_CLAUDE';
const { queryOptions, inputQueue } = require('../../electron/features/claude-sdk/query.cjs');
const { createPolicy } = require('../../electron/features/claude-sdk/policy.cjs');
const { spawn } = require('node:child_process');

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
  const cleanup = [];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); server.closeAllConnections(); server.close(); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT']) { const key = Object.keys(process.env).find(item => item.toLowerCase() === name.toLowerCase()); if (key) env[key] = process.env[key]; }
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'r'), LOCALAPPDATA: path.join(home, 'l'), TEMP: path.join(directory, 't'), TMP: path.join(directory, 't'), TMPDIR: path.join(directory, 't'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ANTHROPIC_API_KEY: 'sk-ant-offline-not-a-real-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CI: '1' });
  for (const folder of [cwd, env.APPDATA, env.LOCALAPPDATA, env.TEMP, env.CLAUDE_CONFIG_DIR]) fs.mkdirSync(folder, { recursive: true });
  // A throwaway profile inside a worktree must also be its own Git root: never load the owner's ancestor settings.
  fs.mkdirSync(path.join(cwd, '.git/objects'), { recursive: true }); fs.mkdirSync(path.join(cwd, '.git/refs/heads'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.git/HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(cwd, '.git/config'), '[core]\nrepositoryformatversion = 0\nbare = false\n');
  const stats = { requests: 0, keys: [] };
  const server = http.createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (/count_tokens/.test(request.url)) {
        stats.countRequests = (stats.countRequests || 0) + 1;
        return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          input_tokens: typeof stats.countTokens === 'function' ? stats.countTokens(JSON.parse(body)) : stats.countTokens || 1,
        }));
      }
      if (!/\/messages/.test(request.url)) return response.writeHead(404).end();
      const data = JSON.parse(body);
      if (data.stream !== true) {
        stats.validationRequests = (stats.validationRequests || 0) + 1;
        return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', model: data.model,
          content: [{ type: 'text', text: 'OFFLINE_VALIDATION' }], stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }));
      }
      stats.requests++; stats.keys.push(request.headers['x-api-key']);
      const value = respond(data, response);
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
    t.after(() => abort.abort());
    const actual = { ...spec, ...changes };
    return { ...queryOptions(actual, { key: env.ANTHROPIC_API_KEY, executable: cli, abort, policy: createPolicy(actual),
      canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }) }),
      spawnClaudeCodeProcess(value) {
        const child = spawn(value.command, value.args, { cwd: value.cwd, env: value.env,
          signal: value.signal, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        const ended = new Promise(resolve => child.once('close', resolve));
        child.on('error', () => {});
        cleanup.push(async () => {
          abort.abort(); child.stdin.end();
          const timer = setTimeout(() => child.kill(), 4000);
          try { await ended; } finally { clearTimeout(timer); }
        });
        return child;
      }, ...overrides };
  }
  return { stats, cwd, env, sdk, options, cleanup: close => cleanup.push(close), run: async (overrides = {}, onMessage = () => {}, changes = {}, prompt = 'go') => {
    stats.requests = 0; const abort = new AbortController();
    const configured = options(overrides, abort, changes);
    try {
      const query = sdk.query({ prompt, options: configured });
      for await (const message of query) {
        if (message.type === 'system' && message.subtype === 'init') require('../../electron/prompt-queue.cjs').rememberClaudeSource(message.session_id, changes.owner || 'gui');
        onMessage(message, query);
        if (message.type === 'result') return message;
      }
    } finally { abort.abort(); configured.abortController.abort(); }
    throw new Error('no result');
  } };
}


module.exports = { harness, opening, textBlock, finish, stream, toolThenDone, thinkingThenText };
