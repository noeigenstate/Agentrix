const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { argumentsOf, commandOf, WorkerOutput, CodexRollout, runtimeFiles, RATE_INTERVAL } = require('../integration/dispatch.cjs');
const { TokenRates } = require('../electron/features/agents/token-rate.cjs');
const { createEventServer } = require('../electron/events.cjs');

const helper = path.resolve(__dirname, '../integration/dispatch.cjs');
const worker = path.resolve(__dirname, 'fixtures/dispatch-worker.cjs');
const session = '22222222-2222-4222-8222-222222222222';
const at = seconds => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
const records = name => require('node:fs').readFileSync(path.join(__dirname, 'fixtures', name), 'utf8').trim().split('\n').map(JSON.parse);
const rollout = records('codex-dispatch-rollout.jsonl');
const claude = records('claude-dispatch-stream.jsonl');
const codex = [
  { record: { type: 'thread.started', thread_id: session } },
  ...rollout.map(record => ({ rollout: record })),
  { record: { type: 'turn.started', timestamp: at(0) } },
  { record: { type: 'item.started', item: { type: 'reasoning', text: 'Inspect the parser' } } },
  { record: { type: 'turn.completed', usage: { output_tokens: 150, reasoning_output_tokens: 30 } } },
];

async function fixture(t, lines = codex, { agent = 'codex', role = '执行', bootstrap = true, exitCode = 0, hold = 150, timeout = 30000 } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-dispatch-'));
  const events = [], server = await createEventServer(event => events.push({ ...event, receivedAt: Date.now() }));
  const brief = path.join(directory, 'brief.md'), out = path.join(directory, 'answer.md'), runner = path.join(directory, 'runner.cjs');
  const input = path.join(directory, 'fixture.json'), capture = path.join(directory, 'capture.json'), config = path.join(directory, 'bootstrap.json');
  await fs.writeFile(brief, '# A worker brief\nKeep Unicode: 执行.\n');
  await fs.writeFile(input, JSON.stringify({ lines, exitCode, hold, sessionId: session }));
  await fs.mkdir(path.join(directory, 'codex'));
  await fs.writeFile(path.join(directory, 'codex/config.toml'), 'service_tier = "flex"\n');
  await fs.writeFile(config, JSON.stringify({ pipeName: server.name.startsWith('agentrix-') ? server.name : server.address, projectId: 'project', sessionKey: 'secret-for-test' }));
  await fs.writeFile(runner, `const {spawn}=require('node:child_process');
const {run}=require(${JSON.stringify(helper)});
process.on('message', signal => process.emit(signal));
run(process.argv.slice(2), {startTimeout:${timeout}, launch:(file,args,options)=>spawn(process.execPath,[${JSON.stringify(worker)},...args],options)})
.then(code=>{process.exitCode=code;process.disconnect?.();});`);
  const args = [agent, '--role', role, '--title', 'Exact dispatch task', '--model', agent === 'codex' ? 'gpt-6.1-sol' : 'claude-sonnet-5-5', '--effort', agent === 'codex' ? 'max' : 'high',
    '--cwd', directory, '--brief', brief, '--out', out, ...(agent === 'codex' ? ['--fast', '--image', 'first image.png', '--read-only'] : ['--permission', 'plan'])];
  const env = { ...process.env, CODEX_HOME: path.join(directory, 'codex'), DISPATCH_FIXTURE: input, DISPATCH_CAPTURE: capture };
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

async function until(predicate, timeout = 5000) {
  const end = Date.now() + timeout;
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
    ['-p', '--model', 'test-model', '--effort', 'high', '--permission-mode', 'acceptEdits', '--output-format', 'stream-json', '--verbose']);
  for (const [alias, expected] of [['exec', '执行'], ['investigate', '调查'], ['review', '审查'], ['执行', '执行'], ['调查', '调查'], ['审查', '审查']]) {
    assert.equal(argumentsOf(['codex', ...base.map(value => value === '审查' ? alias : value)]).role, expected);
  }
  for (const args of [['codex'], ['other', ...base], ['codex', ...base, '--unknown'], ['codex', ...base, '--model', 'again'], ['codex', ...base, '--image'],
    ['claude', ...base], ['claude', ...base, '--permission', 'plan', '--fast'], ['codex', ...base, '--title', 'a\nb'],
    ['codex', ...base.map(value => value === '审查' ? 'unknown-role' : value)]]) assert.throws(() => argumentsOf(args));
});

test('help prints all role aliases without launching a worker', async () => {
  const { run } = require('../integration/dispatch.cjs');
  for (const args of [['--help'], ['codex', '--help'], ['claude', '--help']]) {
    let stdout = '';
    assert.equal(await run(args, { stdout: { write: value => { stdout += value; } }, launch: () => assert.fail('help launched a worker') }), 0);
    assert.match(stdout, /--role <执行\|调查\|审查\|exec\|investigate\|review>/);
  }
});

test('Codex receives stdin/argv/cwd and reads its rollout for routing and final rate', async t => {
  const f = await fixture(t), result = await f.finished;
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
  const signals = result.stdout.trim().split('\n');
  assert.equal(signals.length, 2);
  assert.match(signals[0], /\[dispatch\] started [\w-]+ codex model gpt-6\.1-sol effort max fast on · routing ok · pid \d+ session /);
  assert.match(signals[1], /38 token\/s \(150 output tokens in 4 s\) · exit 0 reason exit · out /);
  assert.deepEqual(f.events.map(event => event.type), ['dispatch-start', 'dispatch-end']);
  assert.ok(f.events.every(event => event.sessionKey === 'secret-for-test' && event.projectId === 'project'));
  const [start, end] = f.events;
  assert.equal(start.sessionId, session); assert.equal(start.title, 'Exact dispatch task'); assert.equal(start.declared, undefined);
  assert.equal(end.id, start.id); assert.equal(end.outputTokens, 150); assert.equal(end.activeMs, 4000);
  const capture = JSON.parse(await fs.readFile(f.capture, 'utf8'));
  assert.equal(capture.cwd, f.directory); assert.match(capture.brief, /Unicode: 执行/);
  assert.deepEqual(capture.args, commandOf(argumentsOf(f.args)));
  const log = await fs.readFile(f.out + '.log', 'utf8');
  assert.equal(log, codex.filter(entry => entry.record).map(entry => JSON.stringify(entry.record) + '\n').join(''));
  assert.ok(!log.includes('[dispatch]'));
  assert.equal(await fs.readFile(path.join(f.directory, 'codex/config.toml'), 'utf8'), 'service_tier = "flex"\n');
  assert.equal(await fs.readFile(path.join(f.directory, `codex/sessions/2026/01/01/rollout-fixture-${session}.jsonl`), 'utf8'),
    rollout.map(record => JSON.stringify(record) + '\n').join(''));
});

test('live rates tick every five seconds, flush changed totals without another response and skip unchanged ticks', { timeout: 30000 }, async t => {
  assert.equal(RATE_INTERVAL, 5000);
  const f = await fixture(t, [codex[0], ...rollout.map((record, index) => ({ rollout: record, ...(index === 7 ? { delay: 7000 } : {}) }))], { hold: 8700 });
  await until(() => f.events.some(event => event.type === 'dispatch-rate'), 10000);
  assert.equal(f.child.exitCode, null, 'the first rate arrives before worker exit');
  await f.finished;
  const rates = f.events.filter(event => event.type === 'dispatch-rate');
  assert.deepEqual(rates.map(({ outputTokens, activeMs }) => [outputTokens, activeMs]), [[100, 2000], [150, 4000]]);
  assert.ok(rates[0].receivedAt - f.events[0].receivedAt >= 4800);
  assert.ok(rates[1].receivedAt - rates[0].receivedAt >= 4800);
  assert.ok(f.events.at(-1).receivedAt - rates[1].receivedAt >= 5000, 'one unchanged tick elapsed without a report');
  assert.equal(f.events.at(-1).outputTokens, 150);
});

test('reported mismatches and missing settings never borrow the declaration', async t => {
  const changed = structuredClone(rollout);
  for (const record of changed) {
    const settings = record.type === 'turn_context' ? record.payload : record.payload.thread_settings;
    if (settings) Object.assign(settings, { model: 'gpt-6.1-terra', effort: 'high', reasoning_effort: 'high', service_tier: 'standard' });
  }
  const lines = [codex[0], ...changed.map(record => ({ rollout: record }))];
  const f = await fixture(t, lines), result = await f.finished;
  assert.match(result.stdout, /model gpt-6\.1-terra effort high fast off · routing MISMATCH \(declared gpt-6\.1-sol max fast on\)/);
  assert.deepEqual(f.events[0].declared, { model: 'gpt-6.1-sol', effort: 'max', fast: true });
  const missing = await fixture(t, [codex[0], { rollout: rollout[0] }, { rollout: { type: 'turn_context', payload: {} } }]);
  const unreported = await missing.finished;
  assert.match(unreported.stdout, /model unreported effort unreported fast unreported · routing MISMATCH/);
  assert.equal(missing.events[0].model, 'unreported'); assert.equal(missing.events[0].fast, null);
  assert.match(unreported.stdout, /token\/s unreported/);
  const withoutTier = structuredClone(rollout);
  delete withoutTier[1].payload.thread_settings.service_tier;
  const tier = await fixture(t, [codex[0], ...withoutTier.map(record => ({ rollout: record }))]);
  assert.match((await tier.finished).stdout, /model gpt-6\.1-sol effort max fast unreported · routing MISMATCH/);
  assert.equal(tier.events[0].fast, null, 'global config and --fast are not session proof');
});

test('Claude JSON and recorded stream-json init/result report settings and write only final text', async t => {
  for (const format of ['lines', 'array', 'pretty']) {
    const records = claude;
    const lines = format === 'lines' ? records.map(record => ({ record })) : format === 'pretty' ? [{ raw: JSON.stringify(records, null, 2) + '\n' }] : [{ record: records }];
    const f = await fixture(t, lines, { agent: 'claude' });
    const result = await f.finished;
    assert.equal(result.code, 0); assert.match(result.stdout, /routing ok/);
    assert.equal(await fs.readFile(f.out, 'utf8'), 'Final Claude answer.\n');
    assert.deepEqual([f.events.at(-1).outputTokens, f.events.at(-1).activeMs], [150, 4000]);
  }
});

test('Claude per-message timestamps and usage give a live rate before the final API totals', { timeout: 15000 }, async t => {
  const output = new WorkerOutput('claude');
  for (const record of claude.slice(0, -1)) output.record(record);
  assert.deepEqual([output.outputTokens, output.activeMs], [150, 4000]);
  assert.deepEqual(output.routing(), { model: 'claude-sonnet-5-5', effort: 'high', fast: false });
  const f = await fixture(t, claude.map((record, index) => ({ record, ...(index === claude.length - 1 ? { delay: 5700 } : {}) })), { agent: 'claude', role: 'review' });
  await until(() => f.events.some(event => event.type === 'dispatch-rate'), 10000);
  assert.equal(f.child.exitCode, null);
  assert.equal(f.events[0].role, '审查');
  await f.finished;
  const rate = f.events.find(event => event.type === 'dispatch-rate');
  assert.deepEqual([rate.outputTokens, rate.activeMs], [150, 4000]);
});

test('Claude final-only JSON sends available totals and leaves absent routing fields unreported', async t => {
  const final = { ...claude.at(-1), modelUsage: { 'claude-sonnet-5-5': { outputTokens: 150 } } };
  const f = await fixture(t, [{ record: final }], { agent: 'claude' });
  const result = await f.finished;
  assert.equal(result.code, 0);
  assert.match(result.stdout, /model claude-sonnet-5-5 effort unreported fast unreported · routing MISMATCH/);
  assert.deepEqual([f.events.at(-1).outputTokens, f.events.at(-1).activeMs], [150, 4000]);
  const output = new WorkerOutput('claude');
  output.record({ ...claude[0], effort: undefined, fast_mode_state: undefined });
  output.record({ ...claude[2], timestamp: undefined });
  assert.equal(output.effort, null); assert.equal(output.fast, null); assert.equal(output.activeMs, null);
  output.record(final);
  assert.equal(output.activeMs, 4000, 'only the final API duration is usable without message timestamps');
});

test('rollout discovery binds the exact exec session and follows delayed and incomplete records read-only', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-rollout-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = new WorkerOutput('codex'), reader = new CodexRollout(directory, output);
  output.record(codex[0].record);
  await reader.read(); assert.equal(output.confirmed, false);
  const folder = path.join(directory, 'sessions/2026/01/01');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, `rollout-decoy-${session}.jsonl`), JSON.stringify({ ...rollout[0], payload: { ...rollout[0].payload, id: randomUUID() } }) + '\n');
  await reader.read(); assert.equal(output.confirmed, false);
  const filename = path.join(folder, `rollout-fixture-${session}.jsonl`);
  const prefix = rollout.slice(0, 10).map(record => JSON.stringify(record) + '\n').join('');
  const partial = JSON.stringify(rollout[10]);
  await fs.writeFile(filename, prefix + partial.slice(0, 20));
  await until(async () => { await reader.read(); return output.confirmed; });
  assert.deepEqual(output.routing(), { model: 'gpt-6.1-sol', effort: 'max', fast: true });
  assert.deepEqual([output.outputTokens, output.activeMs], [100, 2000]);
  await fs.appendFile(filename, partial.slice(20) + '\n');
  await reader.read();
  assert.deepEqual([output.outputTokens, output.activeMs], [150, 4000]);
  assert.equal(await fs.readFile(filename, 'utf8'), prefix + partial + '\n');
});

test('capacity and structured errors keep the worker exit status and reason', async t => {
  for (const [message, exitCode, reason] of [['model at capacity', 7, 'capacity'], ['provider failed', 9, 'error']]) {
    const f = await fixture(t, [...codex.slice(0, 5), { record: { type: 'turn.failed', error: { message } } }], { exitCode });
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
    assert.deepEqual(f.events.map(event => event.type), ['dispatch-start', 'dispatch-end']);
    assert.equal(f.events[0].unconfirmed, true); assert.equal(f.events[0].sessionId, null);
    assert.deepEqual([f.events[0].model, f.events[0].effort, f.events[0].fast], ['gpt-6.1-sol', 'max', true]);
    assert.equal(f.events[1].reason, 'unconfirmed'); assert.equal(f.events[1].id, f.events[0].id);
  }
  const { run } = require('../integration/dispatch.cjs');
  const f = await fixture(t); await f.finished;
  let stdout = '';
  const code = await run(f.args, { env: {}, stdout: { write: value => { stdout += value; } }, launch: (_, args, options) => spawn(path.join(f.directory, 'missing-executable'), args, options) });
  assert.notEqual(code, 0); assert.match(stdout, /failed to start .*ENOENT/);
});

test('a thread id alone cannot confirm a start and an exiting worker still leaves a declared failure row', async t => {
  const f = await fixture(t, [codex[0]], { hold: 0 });
  const result = await f.finished;
  assert.notEqual(result.code, 0); assert.match(result.stdout, /failed to start/);
  assert.deepEqual(f.events.map(event => event.type), ['dispatch-start', 'dispatch-end']);
  assert.equal(f.events[0].unconfirmed, true); assert.equal(f.events[0].sessionId, session);
  assert.equal(f.events[1].reason, 'unconfirmed');
});

test('exit or timeout emits the unconfirmed pair before still-open stdout closes', async t => {
  const { run } = require('../integration/dispatch.cjs');
  const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
  const f = await fixture(t); await f.finished;
  for (const cause of ['exit', 'timeout']) {
    f.events.length = 0;
    const child = new EventEmitter();
    Object.assign(child, { pid: 0, exitCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    child.stdin.resume();
    let completed = false;
    const running = run(f.args, { env: { CODEX_HOME: path.join(f.directory, 'codex'), AGENTRIX_BOOTSTRAP: path.join(f.directory, 'bootstrap.json') },
      stdout: { write() {} }, startTimeout: cause === 'timeout' ? 20 : 30000,
      launch: () => {
        if (cause === 'exit') queueMicrotask(() => { child.exitCode = 0; child.emit('exit', 0); });
        return child;
      } }).then(code => { completed = true; return code; });
    try {
      await until(() => f.events.length === 2);
      assert.equal(completed, false, 'failure reports do not wait for stdout to close');
      assert.deepEqual(f.events.map(event => event.type), ['dispatch-start', 'dispatch-end']);
      assert.equal(f.events[0].unconfirmed, true); assert.equal(f.events[1].reason, 'unconfirmed');
    } finally { child.emit('close', 0, null); }
    assert.equal(await running, 1);
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) test(`${signal} forwards to the worker and dispatch-end reports killed`, async t => {
  const f = await fixture(t, codex.slice(0, 5), { hold: 20000 });
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
  assert.equal(await run(f.args, { env: { ...process.env, CODEX_HOME: path.join(f.directory, 'codex'), AGENTRIX_BOOTSTRAP: bootstrap, DISPATCH_FIXTURE: path.join(f.directory, 'fixture.json'), DISPATCH_CAPTURE: f.capture },
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

test('Codex rollout metering is exactly TokenRates, excluding tools and deduplicating counters and responses', () => {
  const output = new WorkerOutput('codex');
  const meter = new TokenRates('codex');
  for (const record of rollout) { output.rollout(record); meter.apply(record); }
  output.record({ type: 'turn.completed', usage: { output_tokens: 150 } });
  assert.equal(output.outputTokens, 150); assert.equal(output.activeMs, 4000);
  assert.equal(output.outputTokens, meter.snapshot().outputTokens); assert.equal(output.activeMs, meter.snapshot().activeMs);
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
  const env = { ...process.env, CODEX_HOME: path.join(f.directory, 'codex'), DISPATCH_FIXTURE: path.join(f.directory, 'fixture.json'), DISPATCH_CAPTURE: f.capture };
  delete env.AGENTRIX_BOOTSTRAP;
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH'; env[pathKey] = bin;
  const installed = path.join(f.directory, 'installed/integration/dispatch.cjs');
  await fs.mkdir(path.dirname(installed), { recursive: true });
  await fs.copyFile(helper, installed);
  const modules = runtimeFiles();
  const resources = require('../package.json').build.extraResources.find(item => item.to === 'integration/electron');
  assert.deepEqual([...resources.filter].sort(), Object.keys(modules).sort(), 'packaging includes the shared runtime');
  for (const [name, source] of Object.entries(modules)) {
    const target = path.join(path.dirname(installed), 'electron', name);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, source);
  }
  const child = spawn(process.execPath, [installed, ...f.args], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.resume();
  const [code] = await once(child, 'close');
  assert.equal(code, 0); assert.match(stdout, /routing ok/);
  assert.deepEqual(JSON.parse(await fs.readFile(f.capture, 'utf8')).args, commandOf(argumentsOf(f.args)));
});
