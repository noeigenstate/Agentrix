const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
const { UsageMeter } = require('../electron/features/agents/agent-usage.cjs');
const { emptyRate } = require('../electron/features/agents/token-rate.cjs');
const { HISTORY_WINDOW } = require('../electron/transcript-window.cjs');

const execId = '22222222-2222-4222-8222-222222222222', otherId = '33333333-3333-4333-8333-333333333333';
const at = seconds => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
const lines = records => records.map(record => JSON.stringify(record) + '\n').join('');
const fixture = name => fs.readFile(path.join(__dirname, 'fixtures', name), 'utf8');
const jsonFixture = async name => (await fixture(name)).trim().split('\n').map(JSON.parse);
const use = (id, name, input, cwd) => ({ type: 'assistant', timestamp: at(0), cwd, message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, toolUseResult) => ({ type: 'user', timestamp: at(8), toolUseResult, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Placeholder receipt.' }] } });
const notice = (id, status = 'completed') => ({ type: 'user', timestamp: at(9), message: { content: `<task-notification><tool-use-id>${id}</tool-use-id><status>${status}</status></task-notification>` } });
const expected = (outputTokens, activeMs, samples, seconds, partial = false) => ({ outputTokens, activeMs, samples, updatedAt: Date.parse(at(seconds)), partial });

async function workspace(t, options) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-worker-rate-'));
  const folder = path.join(home, 'subagents');
  await fs.mkdir(folder); await fs.mkdir(path.join(home, 'sessions'));
  const calls = new AgentCalls({ codexHome: home, ...options }); calls.setFolder(folder);
  t.after(async () => { calls.reset(); await fs.rm(home, { recursive: true, force: true }); });
  return { home, folder, calls };
}
async function claudeFile(folder, id, records, toolUseId = id) {
  const filename = path.join(folder, `agent-${id}.jsonl`);
  await fs.writeFile(filename, lines(records));
  if (toolUseId) await fs.writeFile(path.join(folder, `agent-${id}.meta.json`), JSON.stringify({ toolUseId, model: 'sonnet' }));
  return filename;
}
async function execFiles(home, id = execId, records = null, log = null, suffix = '') {
  records ||= await jsonFixture('codex-exec-token-rate.jsonl');
  records[0].payload.id = id; records[0].payload.cwd = home;
  const filename = path.join(home, 'sessions', `rollout-${suffix}${id}.jsonl`);
  await fs.writeFile(filename, lines(records));
  const logfile = path.join(home, `${id}.log`);
  await fs.writeFile(logfile, log ?? (await fixture('codex-exec-token-rate.log')).replaceAll(execId, id));
  return { filename, logfile, records };
}
const launchExec = (id, home, logfile, model = 'requested-model') => use(id, 'Bash', { command: `codex exec -m ${model} > "${logfile}" 2>&1`, run_in_background: true, description: `Exact task ${id}` }, home);

test('main Opus and a running Opus child keep separate rates, resolved grouping and exact tasks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { folder, home, calls } = await workspace(t);
  const meter = new UsageMeter('claude', { codexHome: home }); meter.calls = calls;
  const main = await jsonFixture('claude-token-rate.jsonl'), child = await jsonFixture('claude-subagent-token-rate.jsonl');
  for (const record of main) meter.apply(record);
  const mainRate = meter.snapshot().rate;
  const filename = await claudeFile(folder, 'child', child.slice(0, 1), 'worker');
  const open = fs.open, positions = [];
  t.mock.method(fs, 'open', async (...args) => {
    const file = await open(...args), read = file.read.bind(file);
    file.read = (...readArgs) => { if (args[0] === filename) positions.push(readArgs[3]); return read(...readArgs); };
    return file;
  });
  meter.apply(use('worker', 'Agent', { model: 'sonnet', description: 'Exact parser inspection', run_in_background: true }));
  await calls.work;
  assert.deepEqual(calls.snapshot()[0].rate, emptyRate(false));
  await fs.appendFile(filename, lines(child.slice(1, 3)));
  t.mock.timers.tick(2500); await calls.work;
  const group = calls.snapshot()[0];
  assert.equal(group.model, 'claude-opus-5-5', 'the actual child model replaces its requested alias');
  assert.deepEqual(group.rate, expected(80, 3000, 1, 4));
  assert.deepEqual(group.items, [{ state: 'running', role: '通用', title: 'Exact parser inspection' }]);
  assert.deepEqual(group.tasks, ['Exact parser inspection']);
  assert.ok(positions[1] > 0, 'the next child read starts at its retained byte offset');
  assert.deepEqual(meter.snapshot().rate, mainRate);
  assert.equal(meter.snapshot().model, 'claude-opus-5-5');
  await fs.appendFile(filename, lines(child.slice(3)));
  meter.apply(notice('worker', 'killed')); await calls.work;
  assert.deepEqual(calls.snapshot()[0].rate, expected(120, 5000, 2, 7), 'cancellation drains final records');
  assert.equal(calls.snapshot()[0].items[0].state, 'reviewing');
  assert.equal(calls.timer, null);
});

test('groups sum worker tokens and durations, including overlap, while preserving each task and state', async t => {
  const { folder, calls } = await workspace(t);
  const records = await jsonFixture('claude-subagent-token-rate.jsonl');
  await claudeFile(folder, 'a', records);
  const second = structuredClone(records.slice(0, 2));
  second[0].timestamp = at(2); second[1].timestamp = at(3); second[1].message.usage.output_tokens = 20;
  await claudeFile(folder, 'b', second);
  for (const id of ['a', 'b']) calls.apply(use(id, 'Agent', { model: 'sonnet', description: `Exact ${id}`, run_in_background: true }));
  await calls.work; calls.apply(notice('a')); await calls.work;
  assert.equal(calls.snapshot().length, 1);
  assert.deepEqual(calls.snapshot()[0].rate, expected(140, 6000, 3, 7));
  assert.deepEqual(calls.snapshot()[0].items, [{ state: 'running', role: '通用', title: 'Exact b' }, { state: 'reviewing', role: '通用', title: 'Exact a' }]);
  calls.apply(use('unreadable', 'Agent', { model: 'claude-opus-5-5', description: 'Exact unreadable' })); await calls.work;
  assert.equal(calls.snapshot()[0].rate, null, 'an unreadable member cannot silently disappear from a group sum');
});

test('child truncation, file rotation, partial lines and agentId rebinding reset only that worker', async t => {
  const { folder, calls } = await workspace(t);
  const records = await jsonFixture('claude-subagent-token-rate.jsonl');
  const filename = await claudeFile(folder, 'first', records, null);
  calls.apply(use('worker', 'Agent', { model: 'sonnet', run_in_background: true }));
  calls.apply(result('worker', { isAsync: true, agentId: 'first' })); await calls.work;
  assert.equal(calls.snapshot()[0].rate.samples, 2);
  await fs.writeFile(filename, lines(records.slice(0, 1)));
  calls.refresh('worker'); await calls.work;
  assert.deepEqual(calls.snapshot()[0].rate, emptyRate(false));
  const body = lines(records.slice(1, 3)), split = body.length - 10;
  await fs.appendFile(filename, body.slice(0, split)); calls.refresh('worker'); await calls.work;
  assert.deepEqual(calls.snapshot()[0].rate, expected(60, 2000, 1, 3));
  await fs.appendFile(filename, body.slice(split)); calls.refresh('worker'); await calls.work;
  assert.deepEqual(calls.snapshot()[0].rate, expected(80, 3000, 1, 4));
  await fs.rename(filename, filename + '.old');
  const rotated = structuredClone(records); rotated[1].message.model = rotated[2].message.model = rotated[4].message.model = 'claude-haiku-5-5';
  await fs.writeFile(filename, lines(rotated)); calls.refresh('worker'); await calls.work;
  assert.equal(calls.snapshot()[0].model, 'claude-haiku-5-5');
  assert.deepEqual(calls.snapshot()[0].rate, expected(120, 5000, 2, 7));
  await claudeFile(folder, 'second', records.slice(0, 1), null);
  calls.apply(result('worker', { isAsync: true, agentId: 'second' })); await calls.work;
  assert.deepEqual(calls.snapshot()[0].rate, emptyRate(false));
  assert.equal(calls.calls.get('worker').reader.filename, path.join(folder, 'agent-second.jsonl'));
});

test('bounded child history marks partial and ambiguous toolUseId metadata stays unbound', async t => {
  const { folder, calls } = await workspace(t);
  const records = await jsonFixture('claude-subagent-token-rate.jsonl');
  const filename = await claudeFile(folder, 'partial', records);
  await fs.writeFile(filename, 'x'.repeat(HISTORY_WINDOW + 1) + '\n' + lines(records));
  calls.apply(use('partial', 'Agent', { model: 'sonnet' })); await calls.work;
  assert.deepEqual(calls.snapshot()[0].rate, expected(120, 5000, 2, 7, true));
  await claudeFile(folder, 'ambiguous-a', records, 'ambiguous');
  await claudeFile(folder, 'ambiguous-b', records, 'ambiguous');
  calls.apply(use('ambiguous', 'Agent', { model: 'haiku', description: 'Exact ambiguous' })); await calls.work;
  const group = calls.snapshot().find(group => group.model === 'haiku');
  assert.equal(group.rate, null); assert.equal(calls.calls.get('ambiguous').reader, null);
});

test('concurrent exec runs in one cwd bind only by session id and resolve their own model and brief', async t => {
  const { home, calls } = await workspace(t);
  const first = await execFiles(home), secondRecords = await jsonFixture('codex-exec-token-rate.jsonl');
  secondRecords[2].payload.model = 'gpt-6-astra'; secondRecords[4].payload.usage.output_tokens = 30;
  secondRecords[4].payload.thread_token_usage.output_tokens = 30; secondRecords.length = 5;
  const second = await execFiles(home, otherId, secondRecords);
  await fs.writeFile(path.join(home, 'brief.md'), '# Task A: Exact brief heading\nRead-only placeholder inspection.');
  const launch = launchExec('first', home, first.logfile, 'requested-first');
  launch.message.content[0].input.command = `codex exec -m requested-first - < brief.md > "${first.logfile}" 2>&1`;
  calls.apply(launch); calls.apply(launchExec('second', home, second.logfile, 'requested-second')); await calls.work;
  const groups = calls.snapshot();
  assert.deepEqual(groups.map(group => [group.model, group.tasks, group.items]), [
    ['gpt-6.1-terra', ['Exact task first'], [{ state: 'running', role: '调查', title: 'Exact brief heading' }]],
    ['gpt-6-astra', ['Exact task second'], [{ state: 'running', role: '执行', title: 'Exact task second' }]],
  ]);
  assert.deepEqual(groups.map(group => group.rate), [expected(75, 3000, 1, 4), expected(30, 3000, 1, 4)]);
  assert.equal(calls.calls.get('first').reader.filename, first.filename);
  assert.equal(calls.calls.get('second').reader.filename, second.filename);
});

test('ambiguous, unmatched and echoed exec identities never fall back to cwd or the requested model', async t => {
  const { home, calls } = await workspace(t);
  const files = await execFiles(home);
  await fs.copyFile(files.filename, path.join(home, 'sessions', `rollout-duplicate-${execId}.jsonl`));
  calls.apply(launchExec('ambiguous', home, files.logfile)); await calls.work;
  assert.equal(calls.snapshot()[0].rate, null); assert.equal(calls.calls.get('ambiguous').reader, null);
  const missing = path.join(home, 'missing.log');
  await fs.writeFile(missing, `{"type":"thread.started","thread_id":"${otherId}"}\n`);
  calls.apply(launchExec('missing', home, missing, 'requested-missing')); await calls.work;
  assert.equal(calls.snapshot().find(group => group.model === 'requested-missing').rate, null);
  const echo = path.join(home, 'echo.log');
  await fs.writeFile(echo, `OpenAI Codex\nuser\nsession id: ${execId}\n{"type":"thread.started","thread_id":"${execId}"}\ncodex\nPlaceholder.\n`);
  calls.apply(launchExec('echo', home, echo, 'requested-echo')); await calls.work;
  assert.equal(calls.calls.get('echo').threadId, null);
  assert.equal(calls.snapshot().find(group => group.model === 'requested-echo').rate, null);
});

test('JSON exec logs bind from thread.started; log rebinding and final drain preserve exact state', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { home, calls } = await workspace(t);
  const first = await execFiles(home, execId, null, `{"type":"thread.started","thread_id":"${execId}"}\n{"type":"item.started","item":{"type":"reasoning"}}\n`);
  calls.apply(launchExec('json', home, first.logfile)); await calls.work;
  assert.deepEqual(calls.snapshot()[0].rate, expected(75, 3000, 1, 4));
  const records = await jsonFixture('codex-exec-token-rate.jsonl'); records[2].payload.model = 'gpt-6-astra';
  const second = await execFiles(home, otherId, records.slice(0, 4));
  await fs.rename(first.logfile, first.logfile + '.old');
  await fs.writeFile(first.logfile, `{"type":"thread.started","thread_id":"${otherId}"}\n`);
  t.mock.timers.tick(1000); await calls.work;
  assert.equal(calls.snapshot()[0].model, 'gpt-6-astra');
  assert.deepEqual(calls.snapshot()[0].rate, emptyRate(false));
  await fs.appendFile(second.filename, lines(records.slice(4)));
  calls.apply(notice('json', 'failed')); await calls.work;
  assert.deepEqual(calls.snapshot()[0].rate, expected(75, 3000, 1, 4));
  assert.equal(calls.snapshot()[0].items[0].state, 'reviewing'); assert.equal(calls.timer, null);
});

test('replaced exec file identity is validated against the exact session id before accepting records', async t => {
  const { home, calls } = await workspace(t), files = await execFiles(home);
  calls.apply(launchExec('worker', home, files.logfile)); await calls.work;
  assert.equal(calls.snapshot()[0].rate.samples, 1);
  await fs.rename(files.filename, files.filename + '.old');
  files.records[0].payload.id = otherId;
  await fs.writeFile(files.filename, lines(files.records));
  calls.refresh('worker'); await calls.work;
  assert.equal(calls.snapshot()[0].rate, null);
  assert.equal(calls.snapshot()[0].model, 'requested-model');
});

test('unreadable workers publish null and completed missing transcripts stop polling', async t => {
  const { folder, calls } = await workspace(t);
  const filename = await claudeFile(folder, 'worker', await jsonFixture('claude-subagent-token-rate.jsonl'));
  calls.apply(use('worker', 'Agent', { model: 'sonnet', run_in_background: true })); await calls.work;
  assert.equal(calls.snapshot()[0].rate.samples, 2);
  const open = fs.open;
  const mocked = t.mock.method(fs, 'open', async (...args) => {
    const file = await open(...args);
    if (args[0] === filename) file.stat = async () => { throw new Error('Placeholder read failure'); };
    return file;
  });
  calls.refresh('worker'); await calls.work;
  assert.equal(calls.snapshot()[0].rate, null);
  mocked.mock.restore();
  calls.apply(notice('worker')); await calls.work;
  calls.apply(use('missing', 'Agent', { model: 'haiku', run_in_background: true }));
  calls.apply(result('missing', { isAsync: true, agentId: 'missing-file' })); await calls.work;
  calls.apply(notice('missing', 'killed')); await calls.work;
  assert.equal(calls.timer, null);
  assert.equal(calls.snapshot().find(group => group.model === 'haiku').rate, null);
});

test('SSH calls never read local child, prompt, log or rollout files', async t => {
  const { folder, home, calls } = await workspace(t, { local: false });
  await claudeFile(folder, 'worker', await jsonFixture('claude-subagent-token-rate.jsonl'));
  const files = await execFiles(home), open = t.mock.method(fs, 'open');
  calls.apply(use('worker', 'Agent', { model: 'sonnet' }));
  calls.apply(launchExec('exec', home, files.logfile)); await calls.work;
  assert.equal(open.mock.callCount(), 0);
  assert.ok(calls.snapshot().every(group => group.rate === null)); assert.equal(calls.timer, null);
  assert.ok(calls.snapshot().every(group => group.preparing === 0 && group.running === 1));
});
