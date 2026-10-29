const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AgentCalls, codexCall, claudeCall } = require('../electron/features/agents/agent-calls.cjs');
const { UsageMeter } = require('../electron/features/agents/agent-usage.cjs');

const use = (id, name = 'Agent', input = {}) => ({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, toolUseResult = {}, is_error = false) => ({ type: 'user', toolUseResult, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'placeholder', is_error }] } });
const notice = (id, status = 'completed', array = false) => {
  const body = `<task-notification><task-id>task</task-id><tool-use-id>${id}</tool-use-id><status>${status}</status><summary>Placeholder</summary></task-notification>`;
  return { type: 'user', message: { content: array ? [{ type: 'text', text: body }] : body } };
};
const command = `codex exec -m gpt-6.1-sol -c model_reasoning_effort=high -c service_tier='"fast"' - < '<home>/scratch/prompt.md'`;
const stop = (timestamp = '2026-10-23T02:32:55.157Z') => ({ type: 'system', subtype: 'stop_hook_summary', hookCount: 1, hookInfos: [{ command: 'claude-hook.ps1 -Kind stop', durationMs: 399 }], hookErrors: [], preventedContinuation: false, timestamp });
const states = calls => calls.snapshot().map(({ preparing, running, reviewing }) => [preparing, running, reviewing]);

async function fixture(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-calls-'));
  const calls = new AgentCalls(); calls.setFolder(folder);
  t.after(async () => { calls.reset(); await fs.rm(folder, { recursive: true, force: true }); });
  return { folder, calls };
}

async function heredocFixture(home) {
  // Minimal real launches/receipts; completion events in tests are synthetic.
  const body = await fs.readFile(path.join(__dirname, 'fixtures/agent-calls-heredoc.jsonl'), 'utf8');
  return body.trim().split('\n').map(line => JSON.parse(line.replaceAll('<home>', home.replace(/\\/g, '/'))));
}

test('Codex shell flags preserve the route, prompt filename and resolved stdin path', () => {
  assert.deepEqual(codexCall(command), { model: 'gpt-6.1-sol', effort: 'high', fast: true, provider: 'openai', task: 'prompt.md', log: null, prompt: path.resolve('<home>/scratch/prompt.md') });
  assert.deepEqual(codexCall(`cd '<home>/repo' && "C:\\tools\\codex.cmd" exec --model=gpt-6.1-sol --config 'model_reasoning_effort="medium"' -c 'model_provider="azure"' --config=service_tier=standard`),
    { model: 'gpt-6.1-sol', effort: 'medium', fast: false, provider: 'azure', task: '', log: null, prompt: null });
  assert.deepEqual(codexCall('codex exec -c model=gpt-6.1-sol'), { model: 'gpt-6.1-sol', effort: null, fast: null, provider: 'openai', task: '', log: null, prompt: null });
  assert.equal(codexCall('codex --version'), null);
  assert.equal(codexCall('git status'), null);
  assert.equal(codexCall('echo codex exec -m gpt-6.1-sol'), null);
  assert.equal(codexCall(`printf '%s' 'codex exec -m gpt-6.1-sol'`), null);
  assert.equal(codexCall('cd <home>/repo&&codex exec -m gpt-6.1-sol\necho done').model, 'gpt-6.1-sol');
});

test('Claude Agent calls keep their own effort and leave unrecorded effort and speed unknown', () => {
  const calls = new AgentCalls({ local: false });
  for (const [id, effort] of [['high', 'high'], ['max', 'max'], ['missing', undefined]]) calls.apply(use(id, 'Agent', { model: 'opus', effort }));
  assert.deepEqual(calls.snapshot().map(({ agent, model, effort, fast }) => ({ agent, model, effort, fast })), [
    { agent: 'Claude Code', model: 'opus', effort: 'high', fast: null },
    { agent: 'Claude Code', model: 'opus', effort: 'max', fast: null },
    { agent: 'Claude Code', model: 'opus', effort: null, fast: null },
  ]);
});

test('Claude print launches parse model, effort and inline fast settings without inheriting defaults', () => {
  assert.deepEqual(claudeCall('claude -p "Inspect the parser" --effort high --model claude-opus-5-5'), { model: 'claude-opus-5-5', effort: 'high', fast: null });
  assert.deepEqual(claudeCall('cd /repo && env MODE=test nohup "/tools/claude.cmd" --model=sonnet --effort=max --print < brief.md > out.txt'), { model: 'sonnet', effort: 'max', fast: null });
  assert.deepEqual(claudeCall(`claude -p --effort xhigh --settings '{"fastMode":true}'`), { model: 'default', effort: 'xhigh', fast: true });
  assert.deepEqual(claudeCall(`claude --settings='{"fastMode":false}' --print --model opus`), { model: 'opus', effort: null, fast: false });
  assert.deepEqual(claudeCall(String.raw`claude -p --settings "{\"fastMode\":true}"`), { model: 'default', effort: null, fast: true });
  assert.deepEqual(claudeCall('claude -p < --effort=max > --model=decoy'), { model: 'default', effort: null, fast: null });
  assert.deepEqual(claudeCall('claude -p --effort ultracode --settings settings.json'), { model: 'default', effort: 'ultracode', fast: null });
  assert.deepEqual(claudeCall('claude -p "--effort max --model fake"; echo --effort low'), { model: 'default', effort: null, fast: null });
  for (const command of ['claude --help', 'claude --help -p', 'claude --version', 'claude --effort high --model opus', 'claude doctor -p',
    'echo claude -p --effort high', `printf '%s' 'claude -p --effort high'`, 'claude --model "--print"', 'claude -- "--print"',
    'cat <<EOF\nclaude -p --effort high\nEOF', '# claude -p --effort high', 'codex exec -m gpt-6.1-sol']) assert.equal(claudeCall(command), null, command);
});

test('Claude Bash print launches share call lifecycle while Codex detection keeps precedence', () => {
  const calls = new AgentCalls({ local: false });
  calls.apply(use('claude-shell', 'Bash', { command: 'claude -p --model opus --effort high', run_in_background: true }));
  calls.apply(result('claude-shell', { backgroundTaskId: 'shell-task' }));
  const claude = calls.snapshot()[0];
  assert.deepEqual([claude.agent, claude.model, claude.effort, claude.fast, claude.running], ['Claude Code', 'opus', 'high', null, 1]);
  calls.apply(use('codex-shell', 'Bash', { command: `${command} "claude -p --effort low"` }));
  const codex = calls.snapshot()[1];
  assert.deepEqual([codex.agent, codex.model, codex.effort, codex.fast], ['Codex', 'gpt-6.1-sol', 'high', true]);
  const completion = notice('unused'); completion.message.content = completion.message.content.replace('<task-id>task</task-id>', '<task-id>shell-task</task-id>');
  calls.apply(completion);
  assert.equal(calls.snapshot()[0].reviewing, 1);
  calls.apply(stop());
  assert.equal(calls.snapshot().length, 1);
  assert.equal(calls.snapshot()[0].agent, 'Codex');
});

test('Claude worker replies refine only their own effort and speed, and transcript resets restore launch records', async t => {
  const { folder, calls } = await fixture(t);
  const filename = path.join(folder, 'agent-own-settings.jsonl');
  await fs.writeFile(path.join(folder, 'agent-own-settings.meta.json'), JSON.stringify({ toolUseId: 'own-settings', model: 'opus' }));
  const reply = { type: 'assistant', isSidechain: true, effort: 'high', perTurnEffort: 'xhigh', message: { model: 'claude-opus-5-5', usage: { speed: 'fast' }, content: [] } };
  await fs.writeFile(filename, JSON.stringify(reply) + '\n');
  calls.apply(use('own-settings', 'Agent', { model: 'opus', effort: 'medium' })); await calls.work;
  await fs.writeFile(path.join(folder, 'agent-unrelated.meta.json'), JSON.stringify({ toolUseId: 'unrelated', model: 'sonnet', effort: 'low' }));
  await fs.writeFile(path.join(folder, 'agent-unrelated.jsonl'), '{}\n');
  calls.apply(use('unrelated', 'Agent', { model: 'sonnet' })); await calls.work;
  assert.deepEqual(calls.snapshot().map(({ model, effort, fast }) => [model, effort, fast]), [['claude-opus-5-5', 'xhigh', true], ['sonnet', 'low', null]]);
  let changes = 0; calls.changed = () => changes++;
  await fs.appendFile(filename, JSON.stringify({ ...reply, perTurnEffort: 'max', message: { ...reply.message, usage: { speed: 'standard' } } }) + '\n');
  calls.refresh('own-settings'); await calls.work;
  assert.deepEqual([calls.snapshot()[0].effort, calls.snapshot()[0].fast], ['max', false]);
  assert.equal(changes, 1, 'setting-only changes publish even when the model and rate stay the same');
  await fs.writeFile(filename, '\n');
  calls.refresh('own-settings'); await calls.work;
  assert.deepEqual([calls.snapshot()[0].effort, calls.snapshot()[0].fast], ['medium', null], 'a replaced transcript cannot retain another run’s settings');
});

test('sanitised real heredoc launches keep Codex flags and redirected files after cd &&', async () => {
  const records = await heredocFixture('/home/test');
  for (const record of records.filter(record => record.type === 'assistant')) {
    const { command } = record.message.content[0].input;
    const name = record.message.content[0].id === 'tool-codex-1' ? 'claude-usage-query' : 'calls-heredoc';
    assert.deepEqual(codexCall(command, record.cwd), {
      model: 'gpt-6.1-sol', effort: 'max', fast: true, provider: 'openai',
      task: `brief-${name}.md`, prompt: `/home/test/scratch/codex/brief-${name}.md`,
      log: `/home/test/scratch/codex/log-${name}.log`,
    });
  }
});

test('heredoc bodies are opaque for every delimiter form, including unbalanced quotes and shell syntax', () => {
  for (const [opener, terminator] of [['<<WORD', 'WORD'], ["<<'WORD'", 'WORD'], ['<<"WORD"', 'WORD'], ['<<-WORD', '\tWORD'], ["<<-'WORD'", '\tWORD']]) {
    for (const body of ["Claude's", 'An unmatched " quote', "Claude's, don't; < > | $S && codex exec -m fake", 'codex exec -m fake']) {
      const command = `S=/scratch; cat > brief.md ${opener}\n${body}\n${terminator}\ncd /repo && codex exec -m actual - < $S/brief.md > $S/run.log 2>&1`;
      assert.equal(codexCall(command, '/repo')?.model, 'actual');
      assert.equal(codexCall(command, '/repo')?.prompt, '/scratch/brief.md');
      assert.equal(codexCall(command.slice(0, command.indexOf('\ncd /repo')), '/repo'), null, 'body commands never create calls');
    }
  }
});

test('multiple heredocs consume bodies in order, with exact terminators, tab stripping and CRLF', () => {
  const command = `cat <<ONE <<"TWO"; echo ready
ONE\u0020
codex exec -m fake
ONE
Claude's " <<IGNORED
TWO
cat <<-THREE
\tmore unmatched '
\tTHREE
codex exec -m actual > run.log`;
  for (const body of [command, command.replace(/\n/g, '\r\n')]) assert.equal(codexCall(body)?.model, 'actual');
  assert.equal(codexCall('cat <<EOF\ncodex exec -m fake'), null, 'unterminated bodies consume the rest of the command');
  assert.equal(codexCall('cat <<-EOF\n EOF\ncodex exec -m fake'), null, '<<- strips tabs only');
  assert.equal(codexCall('codex exec -m actual <<EOF\nunmatched "\nEOF')?.model, 'actual');
});

test('quoted heredoc examples, comments and here strings cannot consume later shell commands', () => {
  for (const prefix of [`printf '%s' '<<EOF'`, `printf "%s" "<<EOF"`, '# cat <<EOF', 'cat <<<"example"']) {
    assert.equal(codexCall(`${prefix}\ncodex exec -m actual`)?.model, 'actual');
  }
});

test('foreground Agent and Codex runs finish on tool_result and replay never double counts or reopens them', () => {
  const meter = new UsageMeter('claude', { provider: 'Anthropic' });
  const agent = use('a', 'Agent', { model: 'sonnet', description: 'Polish the card' });
  assert.equal(meter.apply(agent), true);
  assert.equal(meter.apply(agent), false);
  meter.apply(use('b', 'Bash', { command, description: 'Implement parser' }));
  assert.deepEqual(meter.snapshot().calls, [
    { agent: 'Claude Code', provider: 'Anthropic', model: 'sonnet', effort: null, fast: null, preparing: 0, running: 1, reviewing: 0, tasks: ['Polish the card'], items: [{ state: 'running', role: '通用', title: 'Polish the card' }], rate: null },
    { agent: 'Codex', provider: 'OpenAI', model: 'gpt-6.1-sol', effort: 'high', fast: true, preparing: 0, running: 1, reviewing: 0, tasks: ['Implement parser'], items: [{ state: 'running', role: '执行', title: 'prompt.md' }], rate: null },
  ]);
  meter.apply(result('a', { resolvedModel: 'claude-sonnet-5-5' }));
  meter.apply(result('b'));
  meter.apply(agent);
  assert.deepEqual(meter.snapshot().calls.map(call => [call.model, call.reviewing, call.running]), [['claude-sonnet-5-5', 1, 0], ['gpt-6.1-sol', 1, 0]]);
  assert.equal(meter.apply(stop()), true);
  assert.deepEqual(meter.snapshot().calls, []);
  assert.equal(meter.apply(agent), false, 'replaying a reviewed launch cannot reopen it');
  meter.reset();
  assert.deepEqual(meter.snapshot().calls, []);
});

test('background launch receipts stay running until completed, failed or killed notifications', () => {
  for (const status of ['completed', 'failed', 'killed']) {
    const calls = new AgentCalls();
    calls.apply(use('a', 'Agent', { model: 'sonnet', run_in_background: 'true' }));
    calls.apply(use('b', 'Bash', { command, run_in_background: true }));
    calls.apply(result('a', { isAsync: true, status: 'async_launched', resolvedModel: 'claude-sonnet-5-5', agentId: 'placeholder' }));
    calls.apply(result('b', { backgroundTaskId: 'placeholder' }));
    assert.deepEqual(calls.snapshot('Anthropic').map(call => call.running), [1, 1]);
    calls.apply(notice('a', 'running'));
    assert.equal(calls.snapshot('Anthropic')[0].running, 1);
    assert.equal(calls.apply(notice('a', status)), true);
    assert.equal(calls.apply(notice('b', status, true)), true);
    assert.equal(calls.apply(notice('b', status)), false);
    // A late or duplicate launch receipt must not resurrect a finished call.
    calls.apply(result('a', { isAsync: true }));
    assert.deepEqual(calls.snapshot('Anthropic').map(call => call.running), [0, 0]);
  }
});

test('background Codex runs finish once on queue enqueue, matching either notification id', () => {
  for (const omit of ['', 'tool-use-id', 'task-id']) {
    const calls = new AgentCalls();
    const id = 'toolu_011S79Xo9hAEtCJPRLkByEb9';
    calls.apply(use(id, 'Bash', { command, run_in_background: true }));
    calls.apply(result(id, { backgroundTaskId: 'b1m86oomf' }));
    const queued = {
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: '2026-10-17T00:47:36.711Z',
      sessionId: '<session>',
      content: '<task-notification>\n<task-id>b1m86oomf</task-id>\n<tool-use-id>toolu_011S79Xo9hAEtCJPRLkByEb9</tool-use-id>\n<output-file><home>\\tasks\\b1m86oomf.output</output-file>\n<status>completed</status>\n<summary>Background command "…" completed (exit code 0)</summary>\n</task-notification>',
    };
    if (omit) queued.content = queued.content.replace(new RegExp(`<${omit}>[^<]*</${omit}>\\n`), '');
    for (const operation of ['dequeue', 'remove']) assert.equal(calls.apply({ ...queued, operation }), false);
    assert.equal(calls.snapshot()[0].running, 1);
    assert.equal(calls.apply(queued), true);
    assert.deepEqual(states(calls), [[0, 0, 1]]);
    assert.equal(calls.apply(queued), false);
    for (const operation of ['dequeue', 'remove']) assert.equal(calls.apply({ ...queued, operation }), false);
    for (const content of [queued.content, [{ type: 'text', text: queued.content }]]) {
      assert.equal(calls.apply({ type: 'user', message: { content } }), false);
    }
    calls.apply(result(id, { backgroundTaskId: 'b1m86oomf' }));
    assert.deepEqual(states(calls), [[0, 0, 1]]);
  }
});

test('background Agent runs finish once on queue enqueue for each terminal status', () => {
  for (const status of ['completed', 'failed', 'killed']) {
    const calls = new AgentCalls();
    calls.apply(use('a', 'Agent', { model: 'sonnet', run_in_background: true }));
    calls.apply(result('a', { isAsync: true, status: 'async_launched', agentId: 'child' }));
    const queued = {
      type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-17T00:47:36.711Z', sessionId: '<session>',
      content: notice('a', status).message.content,
    };
    assert.equal(calls.snapshot()[0].running, 1);
    assert.equal(calls.apply(queued), true);
    assert.deepEqual(states(calls), [[0, 0, 1]]);
    assert.equal(calls.apply(queued), false);
    assert.equal(calls.apply(notice('a', status, true)), false);
    for (const operation of ['dequeue', 'remove']) assert.equal(calls.apply({ ...queued, operation }), false);
    assert.deepEqual(states(calls), [[0, 0, 1]]);
  }
});

test('auto-backgrounded calls and failed launches follow the actual result', () => {
  const calls = new AgentCalls();
  calls.apply(use('a', 'Agent'));
  calls.apply(result('a', { isAsync: true }));
  calls.apply(use('b', 'Bash', { command }));
  calls.apply(result('b', { backgroundTaskId: 'placeholder' }));
  assert.deepEqual(calls.snapshot().map(call => call.running), [1, 1]);
  calls.apply(use('c', 'Agent', { run_in_background: true }));
  calls.apply(result('c', {}, true));
  assert.equal(calls.snapshot()[0].running, 1, 'the failed launch is no longer running in the inherited-model group');
  calls.apply(notice('a')); calls.apply(notice('b'));
  assert.ok(calls.snapshot().every(call => call.running === 0));
});

test('BashOutput and TaskOutput only finish their matching background call on a successful terminal receipt', () => {
  for (const name of ['BashOutput', 'TaskOutput']) {
    for (const status of ['completed', 'failed', 'killed']) {
      const calls = new AgentCalls();
      for (const id of ['worker', 'other']) {
        calls.apply(use(id, 'Bash', { command, run_in_background: true }));
        calls.apply(result(id, { backgroundTaskId: `task-${id}` }));
      }
      const poll = (id, task, status, error = false) => {
        calls.apply(use(id, name, name === 'BashOutput' ? { bash_id: task } : { task_id: task }));
        return calls.apply(result(id, name === 'BashOutput' ? { status } : { task: { task_id: task, status } }, error));
      };
      assert.equal(poll('running', 'task-worker', 'running'), false);
      assert.equal(poll('error', 'task-worker', status, true), false);
      assert.equal(poll('unknown', 'unrelated', status), false);
      assert.deepEqual(states(calls), [[0, 2, 0]]);
      assert.equal(poll('done', 'task-worker', status), true);
      assert.deepEqual(states(calls), [[0, 1, 1]]);
      assert.equal(poll('duplicate', 'task-worker', status), false);
      calls.apply(stop());
      assert.deepEqual(states(calls), [[0, 1, 0]], 'only the completed worker leaves after review');
      assert.equal(poll('late', 'task-worker', status), false);
    }
  }
});

test('TaskStop and KillShell finish only their matching worker after a successful receipt', () => {
  for (const name of ['TaskStop', 'KillShell']) {
    for (const agent of ['Codex', 'Claude Code']) {
      const calls = new AgentCalls({ local: false });
      for (const id of ['worker', 'other']) {
        calls.apply(use(id, agent === 'Codex' ? 'Bash' : 'Agent', { command, run_in_background: true }));
        calls.apply(result(id, agent === 'Codex' ? { backgroundTaskId: `task-${id}` } : { isAsync: true, agentId: `task-${id}` }));
      }
      const cancel = (id, task, error = false) => {
        calls.apply(use(id, name, name === 'TaskStop' ? { task_id: task } : { shell_id: task }));
        assert.deepEqual(states(calls), [[0, 2, 0]], 'a stop request alone does not end the worker');
        return calls.apply(result(id, { task_id: task, task_type: 'local_bash', message: 'Task stopped.' }, error));
      };
      assert.equal(cancel('failed', 'task-worker', true), false);
      assert.equal(cancel('unknown', 'unrelated'), false);
      assert.equal(cancel('success', 'task-worker'), true);
      assert.deepEqual(states(calls), [[0, 1, 1]]);
      assert.equal(calls.apply(result('success', { task_id: 'task-worker' })), false);
      calls.apply(stop());
      assert.deepEqual(states(calls), [[0, 1, 0]], 'only the stopped worker leaves after review');
      calls.apply(notice('worker'));
      assert.deepEqual(states(calls), [[0, 1, 0]], 'a late notification cannot reopen the stopped worker');
    }
  }
});

test('routes group by every route field, keep the latest five tasks and inherit the current Claude provider', () => {
  const meter = new UsageMeter('claude', { provider: 'relay.example' });
  for (let i = 0; i < 7; i++) {
    meter.apply(use(`a${i}`, 'Agent', { model: 'claude-sonnet-5-5', description: `Task ${i}` }));
    if (i < 6) meter.apply(result(`a${i}`));
  }
  assert.deepEqual(meter.snapshot().calls[0], { agent: 'Claude Code', provider: 'relay.example', model: 'claude-sonnet-5-5', effort: null, fast: null, preparing: 0, running: 1, reviewing: 6, tasks: ['Task 2', 'Task 3', 'Task 4', 'Task 5', 'Task 6'], items: Array.from({ length: 7 }, (_, i) => ({ state: i ? 'reviewing' : 'running', role: '通用', title: `Task ${6 - i}` })), rate: null });
  for (const [id, suffix] of [['b', ''], ['c', ''], ['d', ' -c model_reasoning_effort=low'], ['e', ' -c service_tier=standard'], ['f', ' -c model_provider=azure'], ['g', ' -m gpt-6-astra']]) {
    meter.apply(use(id, 'Bash', { command: command.replace(/ - < .*$/, '') + suffix }));
  }
  meter.apply(result('b'));
  const groups = meter.snapshot().calls;
  assert.equal(groups.length, 6);
  assert.equal(groups[1].reviewing, 1); assert.equal(groups[1].running, 1);
  assert.equal(groups[4].provider, 'Azure OpenAI');
  meter.provider = 'Anthropic';
  assert.equal(meter.snapshot().calls[0].provider, 'Anthropic');
  meter.apply(stop());
  assert.deepEqual(meter.snapshot().calls[0].tasks, ['Task 6'], 'reviewed tasks leave the hover text too');
  assert.equal(meter.snapshot().calls[1].reviewing, 0);
});

test('sidechains, request blobs, unrelated tools and orphan results do not create calls', () => {
  const calls = new AgentCalls();
  for (const record of [{ ...use('a'), isSidechain: true }, { ...use('b'), type: 'api-request-blob' }, use('c', 'Read'), result('unknown'), notice('unknown')]) assert.equal(calls.apply(record), false);
  assert.deepEqual(calls.snapshot(), []);
  calls.apply(use('a', 'Bash', { command }));
  assert.deepEqual(calls.snapshot()[0].tasks, ['prompt.md']);
});

test('small meta matches toolUseId and incremental subagent reads resolve the model while continuing checks', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-calls-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  let changes = 0;
  const meter = new UsageMeter('claude', { provider: 'Anthropic', changed: () => changes++ });
  t.after(() => meter.reset());
  meter.calls.setFolder(folder);
  await fs.writeFile(path.join(folder, 'agent-child.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Placeholder', toolUseId: 'a', model: 'sonnet' }));
  const reply = model => JSON.stringify({ type: 'assistant', isSidechain: true, message: { model } }) + '\n';
  const file = path.join(folder, 'agent-child.jsonl');
  // A huge first line straddles the tail boundary; only complete tail records can be considered.
  await fs.writeFile(file, JSON.stringify({ type: 'user', message: { content: 'x'.repeat(300 * 1024) } }) + '\n' + reply('claude-sonnet-5-5') + reply('<synthetic>'));
  meter.apply(use('a', 'Agent', { model: 'sonnet', run_in_background: true }));
  await meter.calls.work;
  assert.equal(meter.snapshot().calls[0].model, 'claude-sonnet-5-5');
  assert.equal(changes, 1);
  assert.ok(meter.calls.timer);
  await fs.appendFile(file, reply('claude-haiku-5-5'));
  assert.equal(meter.snapshot().calls[0].model, 'claude-sonnet-5-5', 'no read until another related record arrives');
  meter.apply(notice('a'));
  await meter.calls.work;
  assert.equal(meter.snapshot().calls[0].model, 'claude-haiku-5-5');
  assert.equal(meter.snapshot().calls[0].running, 0);
  assert.equal(changes, 2);
});

test('late metadata, missing tails, result agentId fallback, and reset during a read are safe', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-calls-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const calls = new AgentCalls(); calls.setFolder(folder);
  calls.apply(use('a', 'Agent', { model: 'sonnet', run_in_background: true }));
  await calls.work;
  await fs.writeFile(path.join(folder, 'agent-late.meta.json'), JSON.stringify({ toolUseId: 'a', model: 'claude-sonnet-5-5' }));
  calls.apply(result('a', { isAsync: true })); await calls.work;
  assert.equal(calls.snapshot()[0].model, 'claude-sonnet-5-5');
  await fs.writeFile(path.join(folder, 'agent-fallback.jsonl'), JSON.stringify({ type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-5-5' } }) + '\n');
  calls.apply(use('b', 'Agent', { model: 'haiku' }));
  calls.apply(result('b', { agentId: 'fallback' })); await calls.work;
  assert.equal(calls.snapshot()[1].model, 'claude-haiku-5-5');
  await fs.writeFile(path.join(folder, 'agent-inherited.meta.json'), JSON.stringify({ toolUseId: 'inherited', model: 'sonnet' }));
  calls.apply(use('inherited')); await calls.work;
  assert.equal(calls.snapshot()[2].model, 'sonnet', 'an inherited parent model yields to the subagent metadata');
  calls.apply(result('inherited', { resolvedModel: 'claude-sonnet-5-5' })); await calls.work;
  assert.equal(calls.snapshot()[0].reviewing + calls.snapshot()[0].preparing, 2, 'the resolved model merges into its route instead of reverting to the alias');
  assert.equal(calls.snapshot().length, 2);
  calls.apply(use('c')); const pending = calls.work; calls.reset(); await pending;
  assert.deepEqual(calls.snapshot(), []);
});

test('Codex log redirections resolve against record cwd without evaluating shell expressions', () => {
  const cwd = path.resolve('worker scratch');
  for (const redirect of ['> log.txt 2>&1', '>log.txt 2>&1', '1>log.txt 2>&1', '>>log.txt 2>&1', '&>log.txt']) {
    assert.equal(codexCall(`codex exec -o result.md - < prompt.md ${redirect}`, cwd).log, path.join(cwd, 'log.txt'));
  }
  assert.equal(codexCall(`cd repo && S="${cwd}" && codex exec - < "$S/prompt.md" > "$S/worker.log.txt" 2>&1`, cwd).log, path.join(cwd, 'worker.log.txt'));
  assert.equal(codexCall(`cd repo && S="${cwd}" && codex exec - < "$S/prompt.md"`, cwd).prompt, path.join(cwd, 'prompt.md'));
  assert.equal(codexCall('codex exec - < prompts/task.md', '/srv/repo').prompt, '/srv/repo/prompts/task.md');
  for (const command of ['codex exec - < "$UNKNOWN/prompt.md"', 'codex exec - < "$(pwd)/prompt.md"', "codex exec - < '$PWD/prompt.md'", 'codex exec - < /dev/null']) assert.equal(codexCall(command, cwd).prompt, null);
  assert.equal(codexCall('codex exec > logs/run.txt 2>&1', '/srv/repo').log, '/srv/repo/logs/run.txt');
  for (const command of ['codex exec -o result.md', 'codex exec ">" log.txt', 'codex exec > "$UNKNOWN/log.txt"', 'codex exec > "$(pwd)/log.txt"', "codex exec > '$PWD/log.txt'", 'codex exec > /dev/null']) assert.equal(codexCall(command, cwd).log, null);
});

test('Git Bash drive aliases resolve local worker files without rewriting SSH paths', () => {
  const command = 'S=/c/Users/test/scratch; codex exec - < $S/prompt.md > $S/worker.log 2>&1';
  if (process.platform === 'win32') {
    const call = codexCall(command, 'C:\\repo');
    assert.equal(call.prompt, 'c:\\Users\\test\\scratch\\prompt.md');
    assert.equal(call.log, 'c:\\Users\\test\\scratch\\worker.log');
  }
  const remote = codexCall(command, '/srv/repo');
  assert.equal(remote.prompt, '/c/Users/test/scratch/prompt.md');
  assert.equal(remote.log, '/c/Users/test/scratch/worker.log');
});

test('subagent items keep every role and full description newest first, including repeated tasks', () => {
  const calls = new AgentCalls();
  const roles = [['Explore', '搜索'], ['Plan', '规划'], ['general-purpose', '通用'], ['claude', '通用'], [undefined, '通用'], ['none', '通用'], ['fork', '分身'], ['custom-worker', 'custom-worker'], ['constructor', 'constructor']];
  for (const [i, [subagent_type]] of roles.entries()) calls.apply(use(`role-${i}`, 'Agent', { subagent_type, description: 'Inspect ' + 'the parser '.repeat(30) }));
  calls.apply(result('role-0'));
  assert.deepEqual(calls.snapshot()[0].items, roles.map(([, role], i) => ({ state: i ? 'running' : 'reviewing', role, title: 'Inspect ' + 'the parser '.repeat(30).trim() })).reverse());
  assert.equal(calls.snapshot()[0].tasks.length, 1, 'hover tasks still deduplicate while rows keep each call');
  assert.equal(calls.snapshot()[0].tasks[0].length, 240, 'existing hover task length stays bounded');
  calls.apply(stop());
  assert.equal(calls.snapshot()[0].items.length, roles.length - 1);
});

test('Codex reads the first 4 KB once for its heading and read-only role, retaining all lifecycle states', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { folder, calls } = await fixture(t);
  const prompt = path.join(folder, 'prompt file.md'), log = path.join(folder, 'worker.log.txt');
  const title = 'Inspect ' + 'the call parser '.repeat(25).trim();
  await fs.writeFile(prompt, `\uFEFF# Task R12: ${title} ###\r\n\r\nThis task is READ-ONLY.\r\n## Later heading\r\n${'x'.repeat(8192)}`);
  await fs.writeFile(log, 'OpenAI Codex\nuser\nPlaceholder prompt.\n');
  const open = fs.open, reads = [];
  t.mock.method(fs, 'open', async (...args) => {
    const file = await open(...args), read = file.read.bind(file);
    file.read = (...readArgs) => { if (args[0] === prompt) reads.push([readArgs[2], readArgs[3]]); return read(...readArgs); };
    return file;
  });
  const launch = { ...use('title', 'Bash', { command: 'codex exec - < "prompt file.md" > worker.log.txt 2>&1', description: 'Launch worker', run_in_background: true }), cwd: folder };
  calls.apply(launch); await calls.work;
  assert.deepEqual(calls.snapshot()[0].items, [{ state: 'preparing', role: '调查', title }]);
  assert.deepEqual(calls.snapshot()[0].tasks, ['Launch worker'], 'items add titles without changing the existing task hover');
  assert.deepEqual(reads, [[4096, 0]]);
  await fs.writeFile(prompt, '# Task R99: Changed title\nWrite code.');
  calls.apply(launch);
  t.mock.timers.tick(2500); await calls.work;
  await fs.appendFile(log, 'thinking\nInspect the implementation.\n');
  t.mock.timers.tick(2500); await calls.work;
  assert.deepEqual(calls.snapshot()[0].items, [{ state: 'running', role: '调查', title }]);
  assert.equal(calls.timer, null);
  calls.apply(notice('title'));
  assert.deepEqual(calls.snapshot()[0].items, [{ state: 'reviewing', role: '调查', title }]);
  calls.apply(stop()); assert.deepEqual(calls.snapshot(), []);
  t.mock.timers.tick(10000);
  assert.deepEqual(reads, [[4096, 0]], 'replay, preparing checks and completion never reread the prompt');
});

test('Codex roles recognize a read-only heading or early lines and preserve heading text', async t => {
  const { folder, calls } = await fixture(t);
  const cases = [
    ['# Task R1: READ-ONLY audit', '调查', 'READ-ONLY audit'],
    ['\n## Task R2: Inspect records\nRead-only investigation.', '调查', 'Inspect records'],
    ['# Task R3: Fix C#\nWrite the change.', '执行', 'Fix C#'],
    ['# Task R4: Implement parser\n' + '\n'.repeat(25) + 'Other workers are read-only.', '执行', 'Implement parser'],
    ['\n'.repeat(25) + '# Task R5: read-only review', '调查', 'read-only review'],
    ['# Task R6: Implement parser\nOther files are read-only.\nKeep user data read-only.', '执行', 'Implement parser'],
    ['# Task R7: Inspect records\n- This task is READ-ONLY.', '调查', 'Inspect records'],
  ];
  for (const [i, [body, role, title]] of cases.entries()) {
    await fs.writeFile(path.join(folder, `${i}.md`), body);
    calls.apply({ ...use(`prompt-${i}`, 'Bash', { command: `codex exec - < ${i}.md` }), cwd: folder });
    await calls.work;
    assert.deepEqual(calls.snapshot()[0].items[0], { state: 'running', role, title });
  }
});

test('missing local prompts retry while headingless, out-of-bounds and SSH prompts keep the filename', async t => {
  const { folder, calls } = await fixture(t);
  for (const [name, body] of [['plain.md', 'No heading.'], ['late.md', 'x'.repeat(4096) + '\n# Task R9: Out of bounds\nREAD-ONLY'], ['remote.md', '# Task R1: Local file must not be read over SSH']]) await fs.writeFile(path.join(folder, name), body);
  const open = t.mock.method(fs, 'open');
  for (const name of ['plain.md', 'missing.md', 'late.md']) {
    calls.apply({ ...use(name, 'Bash', { command: `codex exec - < ${name}`, description: 'A launch description' }), cwd: folder });
    await calls.work;
    assert.deepEqual(calls.snapshot()[0].items[0], { state: 'running', role: '执行', title: name });
  }
  assert.ok(calls.timer);
  await fs.writeFile(path.join(folder, 'missing.md'), '# Task R3: Delayed prompt');
  calls.refresh('missing.md'); await calls.work;
  assert.equal(calls.snapshot()[0].items.find(item => item.title === 'Delayed prompt')?.role, '执行');
  assert.equal(open.mock.callCount(), 4);
  const remote = new AgentCalls();
  remote.apply({ ...use('ssh', 'Bash', { command: `codex exec - < "${path.join(folder, 'remote.md')}"` }), cwd: folder });
  await remote.work;
  assert.deepEqual(remote.snapshot()[0].items, [{ state: 'running', role: '执行', title: 'remote.md' }]);
  assert.equal(open.mock.callCount(), 4, 'SSH sessions have no local transcript folder and never open a prompt');
  assert.equal(calls.timer, null); assert.equal(remote.timer, null);
});

test('reset during a prompt read cannot publish a stale title or rearm checks', async t => {
  const { folder, calls } = await fixture(t);
  await fs.writeFile(path.join(folder, 'prompt.md'), '# Task R6: READ-ONLY inspection');
  let changes = 0; calls.changed = () => changes++;
  const open = fs.open;
  let began, release;
  const reading = new Promise(resolve => { began = resolve; });
  t.mock.method(fs, 'open', async (...args) => {
    const file = await open(...args), read = file.read.bind(file);
    file.read = async (...readArgs) => { began(); await new Promise(resolve => { release = resolve; }); return read(...readArgs); };
    return file;
  });
  calls.apply({ ...use('reset-prompt', 'Bash', { command: 'codex exec - < prompt.md' }), cwd: folder });
  const pending = calls.work;
  await reading;
  calls.reset(); release(); await pending;
  assert.deepEqual(calls.snapshot(), []); assert.equal(calls.timer, null); assert.equal(changes, 0);
});

test('a background Codex run prepares, starts quietly, awaits its delivered review round, then leaves', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { folder, calls } = await fixture(t);
  let changes = 0; calls.changed = () => changes++;
  const [,, launch, receipt] = await heredocFixture(folder);
  const id = launch.message.content[0].id;
  const log = path.join(folder, 'scratch/codex/log-calls-heredoc.log');
  await fs.mkdir(path.dirname(log), { recursive: true });
  const header = 'OpenAI Codex v0.163.0\n--------\nworkdir: <repo>\nmodel: gpt-6.1-sol\nprovider: openai\n--------\nuser\nRead the code and use codex exec if asked.\n';
  await fs.writeFile(log, header);
  await fs.writeFile(path.join(path.dirname(log), 'brief-calls-heredoc.md'), 'Placeholder prompt.');
  calls.apply(launch);
  calls.apply(receipt);
  await calls.work;
  assert.deepEqual(states(calls), [[1, 0, 0]], 'header and echoed prompt are not model output');
  assert.ok(calls.timer);
  await fs.appendFile(log, '\nhook: SessionStart Completed\nhook: UserPromptSubmit Completed\n');
  t.mock.timers.tick(2500); await calls.work;
  assert.deepEqual(states(calls), [[1, 0, 0]], 'startup hooks are not model output');
  await fs.appendFile(log, 'codex\nI will inspect the allowed files.\n');
  t.mock.timers.tick(2500); await calls.work;
  assert.deepEqual(states(calls), [[0, 1, 0]]);
  assert.equal(changes, 1); assert.equal(calls.timer, null);
  await fs.writeFile(path.join(folder, 'scratch/codex/out-calls-heredoc.md'), 'Checks passed.');
  calls.apply(stop('2026-10-28T12:28:00.000Z'));
  assert.deepEqual(states(calls), [[0, 1, 0]], 'the launch round ending does not finish the worker');
  const completion = notice(id); completion.timestamp = '2026-10-28T12:35:00.000Z';
  completion.message.content = completion.message.content.replace('<task-id>task</task-id>', '<task-id>task-codex-2</task-id>').replace(`<tool-use-id>${id}</tool-use-id>`, '');
  calls.apply({ type: 'queue-operation', operation: 'enqueue', timestamp: completion.timestamp, content: completion.message.content });
  assert.deepEqual(states(calls), [[0, 0, 1]]);
  calls.apply(stop('2026-10-28T12:35:01.000Z'));
  assert.deepEqual(states(calls), [[0, 0, 1]], 'a queued report has not had its review round yet');
  calls.apply(completion);
  calls.apply(use('read', 'Read', { file_path: log }));
  calls.apply({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Checks passed.' }] } });
  assert.deepEqual(states(calls), [[0, 0, 1]], 'assistant text does not replace the existing Stop signal');
  assert.equal(calls.apply(stop('2026-10-28T12:36:00.000Z')), true);
  assert.deepEqual(calls.snapshot(), []);
  for (const record of [launch, receipt, completion, stop()]) assert.equal(calls.apply(record), false, 'late records cannot reopen a reviewed call');
  t.mock.timers.tick(10000); assert.equal(changes, 1); assert.equal(calls.timer, null);
});

test('background and foreground subagents start at their first assistant record and leave after review', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { folder, calls } = await fixture(t);
  for (const [background, status] of [[true, 'completed'], [true, 'failed'], [true, 'killed'], [false, 'completed']]) {
    const id = `${background ? 'background' : 'foreground'}-${status}`, file = path.join(folder, `agent-${id}.jsonl`);
    await fs.writeFile(path.join(folder, `agent-${id}.meta.json`), JSON.stringify({ toolUseId: id, model: 'sonnet' }));
    await fs.writeFile(file, JSON.stringify({ type: 'user', isSidechain: true, message: { content: 'Check the work.' } }) + '\n');
    calls.apply(use(id, 'Agent', { model: 'sonnet', run_in_background: background }));
    if (background) calls.apply(result(id, { isAsync: true, status: 'async_launched', agentId: id }));
    await calls.work;
    assert.deepEqual(states(calls), [[1, 0, 0]]);
    // The worker can start with a tool call, without a text block.
    await fs.appendFile(file, JSON.stringify({ type: 'assistant', isSidechain: true, message: { model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', name: 'Read', id: 'inspect', input: { file_path: 'AGENTS.md' } }] } }) + '\n');
    t.mock.timers.tick(2500); await calls.work;
    assert.deepEqual(states(calls), [[0, 1, 0]]);
    assert.equal(calls.snapshot()[0].model, 'claude-sonnet-5-5'); assert.ok(calls.timer);
    calls.apply(background ? notice(id, status, true) : result(id, { agentId: id, resolvedModel: 'claude-sonnet-5-5' }));
    await calls.work;
    assert.deepEqual(states(calls), [[0, 0, 1]]); assert.equal(calls.timer, null);
    calls.apply(stop()); assert.deepEqual(calls.snapshot(), []);
  }
});

test('failed launches stop preparing immediately and a new user prompt removes only the reviewed calls', async t => {
  const { calls } = await fixture(t);
  calls.apply(use('failed', 'Agent', { model: 'sonnet', run_in_background: true, description: 'Failed launch' }));
  await calls.work;
  assert.deepEqual(states(calls), [[1, 0, 0]]); assert.equal(calls.timer.hasRef(), false);
  calls.apply(result('failed', {}, true)); await calls.work;
  assert.deepEqual(states(calls), [[0, 0, 1]]); assert.equal(calls.timer, null);
  calls.apply(use('working', 'Agent', { model: 'haiku', description: 'Keep working' })); await calls.work;
  calls.apply({ type: 'user', message: { content: 'Check another file.' } });
  assert.equal(calls.snapshot().length, 1);
  assert.deepEqual(calls.snapshot()[0].tasks, ['Keep working']); assert.deepEqual(states(calls), [[1, 0, 0]]);
});

test('failed and killed background workers enter review and leave on Stop, including absorbed reports', () => {
  for (const status of ['failed', 'killed']) {
    const calls = new AgentCalls();
    calls.apply(use(status, 'Bash', { command, run_in_background: true }));
    calls.apply(result(status, { backgroundTaskId: status }));
    const completion = notice(status, status);
    calls.apply({ type: 'queue-operation', operation: 'enqueue', content: completion.message.content });
    assert.deepEqual(states(calls), [[0, 0, 1]]);
    calls.apply({ type: 'queue-operation', operation: 'remove', content: completion.message.content });
    calls.apply(stop()); assert.deepEqual(calls.snapshot(), []);
  }
});

test('missing local Codex logs stay preparing until completion; commands without logs still run', async t => {
  const { folder, calls } = await fixture(t);
  calls.apply({ ...use('missing', 'Bash', { command: 'codex exec > missing.log 2>&1', run_in_background: true }), cwd: folder });
  await calls.work;
  assert.deepEqual(states(calls), [[1, 0, 0]]); assert.ok(calls.timer);
  calls.apply({ ...use('no-log', 'Bash', { command: 'codex exec -o out.md', run_in_background: true }), cwd: folder });
  await calls.work;
  assert.deepEqual(states(calls), [[1, 1, 0]]); assert.ok(calls.timer);
  calls.apply(notice('missing', 'failed')); calls.apply(notice('no-log', 'killed')); await calls.work;
  assert.deepEqual(states(calls), [[0, 0, 2]]); assert.equal(calls.timer, null);
  calls.apply(stop()); assert.deepEqual(calls.snapshot(), []);
});

test('Codex starts on a tool invocation even when it has not written commentary', async t => {
  const { folder, calls } = await fixture(t);
  await fs.writeFile(path.join(folder, 'tool.log.txt'), 'OpenAI Codex v0.163.0\n--------\nuser\nInspect this repo.\nhook: UserPromptSubmit Completed\nexec\n"powershell.exe" -Command "Get-Content AGENTS.md" in <repo>\n');
  calls.apply({ ...use('tool-first', 'Bash', { command: 'codex exec > tool.log.txt 2>&1', run_in_background: true }), cwd: folder });
  await calls.work;
  assert.deepEqual(states(calls), [[0, 1, 0]]); assert.equal(calls.timer, null);
});

test('preparing checks are bounded and cancelled by reset, folder changes, and in-flight reads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scheduled = t.mock.method(global, 'setTimeout');
  const { folder, calls } = await fixture(t);
  let changes = 0; calls.changed = () => changes++;
  const log = path.join(folder, 'large.log.txt');
  await fs.writeFile(log, 'x'.repeat(300 * 1024) + '\n');
  const open = fs.open;
  const reads = [];
  let pause = false, reading, release;
  t.mock.method(fs, 'open', async (...args) => {
    const file = await open(...args), read = file.read.bind(file);
    file.read = async (...args) => {
      reads.push(args[2]);
      if (pause) { pause = false; reading(); await new Promise(resolve => { release = resolve; }); }
      return read(...args);
    };
    return file;
  });
  const launch = id => ({ ...use(id, 'Bash', { command: 'codex exec > large.log.txt 2>&1', run_in_background: true }), cwd: folder });
  calls.apply(launch('reset')); await calls.work;
  assert.deepEqual(states(calls), [[1, 0, 0]]); assert.ok(calls.timer);
  assert.ok(reads.every(size => size <= 256 * 1024));
  const staleCallback = scheduled.mock.calls[0].arguments[0];
  calls.reset();
  const before = reads.length;
  staleCallback();
  t.mock.timers.tick(10000); await Promise.resolve();
  assert.equal(reads.length, before); assert.equal(calls.timer, null); assert.equal(changes, 0);
  calls.apply(launch('folder')); await calls.work;
  calls.setFolder(path.join(folder, 'another-session'));
  t.mock.timers.tick(10000); assert.equal(calls.timer, null); assert.deepEqual(calls.snapshot(), []);
  await fs.appendFile(log, 'thinking\nReview the implementation.\n');
  const began = new Promise(resolve => { reading = resolve; }); pause = true;
  calls.apply(launch('in-flight'));
  const pending = calls.work;
  await began;
  calls.reset(); release(); await pending;
  assert.equal(calls.timer, null); assert.equal(changes, 0); assert.deepEqual(calls.snapshot(), []);
  calls.apply(launch('tail')); await calls.work;
  assert.deepEqual(states(calls), [[0, 1, 0]]); assert.equal(calls.timer, null);
  const running = reads.length;
  t.mock.timers.tick(10000); assert.equal(reads.length, running, 'running workers have no file checks');
});
