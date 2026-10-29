const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { argumentsOf, commandOf, WorkerOutput } = require('../integration/dispatch.cjs');
const { createEventServer } = require('../electron/events.cjs');

const helper = path.resolve(__dirname, '../integration/dispatch.cjs');
const worker = path.resolve(__dirname, 'fixtures/dispatch-worker.cjs');
const session = '22222222-2222-4222-8222-222222222222';
const at = seconds => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
const codex = [
  { record: { type: 'thread.started', thread_id: session, model: 'gpt-6.1-sol', reasoning_effort: 'max', service_tier: 'fast' } },
  { record: { type: 'turn.started', timestamp: at(0) } },
  { record: { type: 'item.started', item: { type: 'reasoning', text: 'Inspect the parser' } } },
  { record: { type: 'turn.completed', timestamp: at(2), usage: { output_tokens: 100, reasoning_output_tokens: 20 } } },
];

async function fixture(t, lines = codex, { agent = 'codex', bootstrap = true, exitCode = 0, hold = 0, timeout = 30000 } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-dispatch-'));
  const events = [], server = await createEventServer(event => events.push(event));
  const brief = path.join(directory, 'brief.md'), out = path.join(directory, 'answer.md'), runner = path.join(directory, 'runner.cjs');
  const input = path.join(directory, 'fixture.json'), capture = path.join(directory, 'capture.json'), config = path.join(directory, 'bootstrap.json');
  await fs.writeFile(brief, '# A worker brief\nKeep Unicode: 执行.\n');
  await fs.writeFile(input, JSON.stringify({ lines, exitCode, hold }));
  await fs.writeFile(config, JSON.stringify({ pipeName: server.name.startsWith('agentrix-') ? server.name : server.address, projectId: 'project', sessionKey: 'secret-for-test' }));
  await fs.writeFile(runner, `const {spawn}=require('node:child_process');
const {run}=require(${JSON.stringify(helper)});
process.on('message', signal => process.emit(signal));
run(process.argv.slice(2), {startTimeout:${timeout}, launch:(file,args,options)=>spawn(process.execPath,[${JSON.stringify(worker)},...args],options)})
.then(code=>{process.exitCode=code;process.disconnect?.();});`);
  const args = [agent, '--role', '执行', '--title', 'Exact dispatch task', '--model', agent === 'codex' ? 'gpt-6.1-sol' : 'claude-sonnet-5-5', '--effort', agent === 'codex' ? 'max' : 'high',
    '--cwd', directory, '--brief', brief, '--out', out, ...(agent === 'codex' ? ['--fast', '--image', 'first image.png', '--read-only'] : ['--permission', 'plan'])];
  const env = { ...process.env, DISPATCH_FIXTURE: input, DISPATCH_CAPTURE: capture };
  delete env.AGENTRIX_BOOTSTRAP;
  if (bootstrap) env.AGENTRIX_BOOTSTRAP = config;
  const child = spawn(process.execPath, [runner, ...args], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); }); child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const finished = once(child, 'close').then(([code]) => ({ code, stdout, stderr }));
  t.after(async () => {
    if (child.exitCode === null) { child.send('SIGTERM'); await finished; }
    server.close(); await fs.rm(directory, { recursive: true, force: true });
  });
  return { child, finished, events, directory, out, capture, args, stdout: () => stdout };
}

async function until(predicate) {
  const end = Date.now() + 5000;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error('Timed out waiting for dispatch');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('helper constructs exact Codex/Claude argv and rejects incomplete or ambiguous options', () => {
  const base = ['--role', '审查', '--title', 'Inspect the parser', '--model', 'test-model', '--effort', 'high', '--cwd', os.tmpdir(), '--brief', 'brief.md', '--out', 'out.md'];
  const options = argumentsOf(['codex', ...base, '--fast', '--image', 'a.png', '--image', 'b.png', '--read-only']);
  assert.deepEqual(commandOf(options), ['exec', '-m', 'test-model', '-c', 'model_reasoning_effort=high', '-c', 'service_tier="fast"', '--json', '-C', options.cwd,
    '-o', options.out, '-i', path.join(options.cwd, 'a.png'), '-i', path.join(options.cwd, 'b.png'), '-s', 'read-only', '-']);
  assert.deepEqual(commandOf(argumentsOf(['claude', ...base, '--permission', 'acceptEdits'])),
    ['-p', '--model', 'test-model', '--effort', 'high', '--permission-mode', 'acceptEdits', '--output-format', 'json']);
  for (const args of [['codex'], ['other', ...base], ['codex', ...base, '--unknown'], ['codex', ...base, '--model', 'again'], ['codex', ...base, '--image'],
    ['claude', ...base], ['claude', ...base, '--permission', 'plan', '--fast'], ['codex', ...base, '--title', 'a\nb']]) assert.throws(() => argumentsOf(args));
});

test('Codex worker receives stdin/argv/cwd; stdout contains only two signals and pipe gets start/rate/end', async t => {
  const f = await fixture(t), result = await f.finished;
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
  const signals = result.stdout.trim().split('\n');
  assert.equal(signals.length, 2);
  assert.match(signals[0], /\[dispatch\] started [\w-]+ codex model gpt-6\.1-sol effort max fast on · routing ok · pid \d+ session /);
  assert.match(signals[1], /50 token\/s \(100 output tokens in 2 s\) · exit 0 reason exit · out /);
  assert.deepEqual(f.events.map(event => event.type), ['dispatch-start', 'dispatch-rate', 'dispatch-end']);
  assert.ok(f.events.every(event => event.sessionKey === 'secret-for-test' && event.projectId === 'project'));
  const [start, rate, end] = f.events;
  assert.equal(start.sessionId, session); assert.equal(start.title, 'Exact dispatch task'); assert.equal(start.declared, undefined);
  assert.equal(end.id, start.id); assert.equal(rate.outputTokens, 100); assert.equal(end.outputTokens, 100); assert.equal(end.activeMs, 2000);
  const capture = JSON.parse(await fs.readFile(f.capture, 'utf8'));
  assert.equal(capture.cwd, f.directory); assert.match(capture.brief, /Unicode: 执行/);
  assert.deepEqual(capture.args, commandOf(argumentsOf(f.args)));
  const log = await fs.readFile(f.out + '.log', 'utf8');
  assert.equal(log, codex.map(entry => JSON.stringify(entry.record) + '\n').join(''));
  assert.ok(!log.includes('[dispatch]'));
});

test('running totals are live, throttled to two seconds and final totals replace them', async t => {
  const f = await fixture(t, [...codex,
    { record: { type: 'turn.started', timestamp: at(3) } },
    { record: { type: 'turn.completed', timestamp: at(4), usage: { output_tokens: 25 } } },
    { delay: 2100, record: { type: 'turn.started', timestamp: at(7) } },
    { record: { type: 'turn.completed', timestamp: at(10), usage: { output_tokens: 75 } } },
  ], { hold: 300 });
  await until(() => f.events.some(event => event.type === 'dispatch-rate'));
  assert.equal(f.child.exitCode, null, 'the first rate arrives before worker exit');
  await f.finished;
  const rates = f.events.filter(event => event.type === 'dispatch-rate');
  assert.deepEqual(rates.map(({ outputTokens, activeMs }) => [outputTokens, activeMs]), [[100, 2000], [200, 6000]]);
  assert.equal(f.events.at(-1).outputTokens, 200);
});

test('reported mismatches and missing settings never borrow the declaration', async t => {
  const lines = [{ record: { ...codex[0].record, model: 'gpt-6.1-terra', reasoning_effort: 'high', service_tier: 'standard' } }];
  const f = await fixture(t, lines), result = await f.finished;
  assert.match(result.stdout, /model gpt-6\.1-terra effort high fast off · routing MISMATCH \(declared gpt-6\.1-sol max fast on\)/);
  assert.deepEqual(f.events[0].declared, { model: 'gpt-6.1-sol', effort: 'max', fast: true });
  const missing = await fixture(t, [{ record: { type: 'thread.started', thread_id: session } }]);
  const unreported = await missing.finished;
  assert.match(unreported.stdout, /model unreported effort unreported fast unreported · routing MISMATCH/);
  assert.equal(missing.events[0].model, 'unreported'); assert.equal(missing.events[0].fast, null);
  assert.match(unreported.stdout, /token\/s unreported/);
});

test('Claude JSON and recorded stream-json init/result report settings and write only final text', async t => {
  for (const format of ['lines', 'array', 'pretty']) {
    const records = [
      { type: 'system', subtype: 'init', session_id: session, model: 'claude-sonnet-5-5', effort: 'high', speed: 'standard' },
      { type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', name: 'Read' }], usage: { output_tokens: 10 } }, duration_api_ms: 200 },
      { type: 'result', result: 'Final Claude answer.\n', session_id: session, usage: { output_tokens: 60 }, duration_api_ms: 1500 },
    ];
    const lines = format === 'lines' ? records.map(record => ({ record })) : format === 'pretty' ? [{ raw: JSON.stringify(records, null, 2) + '\n' }] : [{ record: records }];
    const f = await fixture(t, lines, { agent: 'claude' });
    const result = await f.finished;
    assert.equal(result.code, 0); assert.match(result.stdout, /routing ok/);
    assert.equal(await fs.readFile(f.out, 'utf8'), 'Final Claude answer.\n');
    assert.deepEqual([f.events.at(-1).outputTokens, f.events.at(-1).activeMs], [60, 1500]);
  }
});

test('capacity and structured errors keep the worker exit status and reason', async t => {
  for (const [message, exitCode, reason] of [['model at capacity', 7, 'capacity'], ['provider failed', 9, 'error']]) {
    const f = await fixture(t, [...codex.slice(0, 1), { record: { type: 'turn.failed', error: { message } } }], { exitCode });
    const result = await f.finished;
    assert.equal(result.code, exitCode); assert.equal(f.events.at(-1).reason, reason);
    assert.match(result.stdout, new RegExp(`exit ${exitCode} reason ${reason}`));
  }
});

test('no session, timeout and spawn failure print failed-start once and end unconfirmed', async t => {
  for (const hold of [0, 2000]) {
    const f = await fixture(t, [], { hold, timeout: 50 }), result = await f.finished;
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout.split('[dispatch] failed to start').length, 2);
    assert.ok(!result.stdout.includes('[dispatch] started'));
    assert.deepEqual(f.events.map(event => event.type), ['dispatch-end']);
    assert.equal(f.events[0].reason, 'unconfirmed');
  }
  const { run } = require('../integration/dispatch.cjs');
  const f = await fixture(t); await f.finished;
  let stdout = '';
  const code = await run(f.args, { env: {}, stdout: { write: value => { stdout += value; } }, launch: (_, args, options) => spawn(path.join(f.directory, 'missing-executable'), args, options) });
  assert.notEqual(code, 0); assert.match(stdout, /failed to start .*ENOENT/);
});

for (const signal of ['SIGINT', 'SIGTERM']) test(`${signal} forwards to the worker and dispatch-end reports killed`, async t => {
  const f = await fixture(t, codex.slice(0, 1), { hold: 20000 });
  await until(() => f.events.some(event => event.type === 'dispatch-start'));
  const { pid } = JSON.parse(await fs.readFile(f.capture, 'utf8'));
  f.child.send(signal);
  const result = await f.finished;
  assert.notEqual(result.code, 0); assert.equal(f.events.at(-1).reason, 'killed');
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('without bootstrap or with a stalled pipe the worker still runs and finishes promptly', async t => {
  const f = await fixture(t, codex, { bootstrap: false }), result = await f.finished;
  assert.equal(result.code, 0); assert.deepEqual(f.events, []);
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\dispatch-stall-${randomUUID()}` : path.join(os.tmpdir(), `ds-${randomUUID().slice(0, 8)}.sock`);
  const connections = new Set(), server = net.createServer(socket => { connections.add(socket); socket.resume(); });
  await new Promise(resolve => server.listen(address, resolve));
  t.after(() => { for (const socket of connections) socket.destroy(); server.close(); });
  const { run } = require('../integration/dispatch.cjs');
  const bootstrap = path.join(f.directory, 'stalled.json');
  await fs.writeFile(bootstrap, JSON.stringify({ pipeName: address, sessionKey: 'test', projectId: 'project' }));
  const began = Date.now();
  assert.equal(await run(f.args, { env: { ...process.env, AGENTRIX_BOOTSTRAP: bootstrap, DISPATCH_FIXTURE: path.join(f.directory, 'fixture.json'), DISPATCH_CAPTURE: f.capture },
    stdout: { write() {} }, launch: (_, args, options) => spawn(process.execPath, [worker, ...args], options) }), 0);
  assert.ok(Date.now() - began < 2000, 'the worker never awaits pipe acknowledgments');
});

test('headers are read as reports and missing or backwards timing never invents a rate', () => {
  const output = new WorkerOutput('codex');
  for (const line of ['model: actual', 'reasoning effort: high', 'service tier: standard', `session id: ${session}`]) output.line(line);
  assert.deepEqual(output.routing(), { model: 'actual', effort: 'high', fast: false });
  output.line(JSON.stringify({ type: 'turn.completed', usage: { output_tokens: 50 } }));
  assert.equal(output.outputTokens, 50);
  output.line(JSON.stringify({ type: 'turn.started', timestamp: at(2) }));
  output.line(JSON.stringify({ type: 'turn.completed', timestamp: at(1), usage: { output_tokens: 50 } }));
  assert.equal(output.activeMs, null);
});

test('Codex excludes tool waits and deduplicates response usage against final turn totals', () => {
  const output = new WorkerOutput('codex');
  for (const [type, seconds, extra] of [
    ['turn.started', 0, {}],
    ['item.started', 2, { item: { id: 'tool', type: 'command_execution' } }],
    ['item.completed', 12, { item: { id: 'tool', type: 'command_execution' } }],
    ['token_usage_record', 14, { payload: { response_id: 'r1', usage: { output_tokens: 120, reasoning_output_tokens: 50 } } }],
    ['token_usage_record', 14, { payload: { response_id: 'r1', usage: { output_tokens: 120 } } }],
    ['turn.completed', 14, { usage: { output_tokens: 120 } }],
  ]) output.record({ type, timestamp: at(seconds), ...extra });
  assert.equal(output.outputTokens, 120); assert.equal(output.activeMs, 4000);
});

test('a real helper entrypoint resolves a fake executable without evaluating path or brief text', async t => {
  const f = await fixture(t); await f.finished;
  const bin = path.join(f.directory, 'fake bin (with spaces)');
  await fs.mkdir(bin);
  if (process.platform === 'win32') {
    const entry = path.join(bin, 'node_modules/@openai/codex/bin/codex.js');
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.writeFile(entry, `require(${JSON.stringify(worker)});`);
  } else {
    await fs.writeFile(path.join(bin, 'codex'), `#!${process.execPath}\nrequire(${JSON.stringify(worker)});\n`, { mode: 0o700 });
  }
  const env = { ...process.env, DISPATCH_FIXTURE: path.join(f.directory, 'fixture.json'), DISPATCH_CAPTURE: f.capture };
  delete env.AGENTRIX_BOOTSTRAP;
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH'; env[pathKey] = bin;
  const child = spawn(process.execPath, [helper, ...f.args], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.resume();
  const [code] = await once(child, 'close');
  assert.equal(code, 0); assert.match(stdout, /routing ok/);
  assert.deepEqual(JSON.parse(await fs.readFile(f.capture, 'utf8')).args, commandOf(argumentsOf(f.args)));
});
