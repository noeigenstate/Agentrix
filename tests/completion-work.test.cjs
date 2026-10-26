const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CompletionWork, LOST_WORK_TIMEOUT, isServiceCommand } = require('../electron/completion-work.cjs');

const stamp = at => new Date(at).toISOString();
const complete = { state: 'complete', updatedAt: 2000, turnId: 'turn' };
function fixture(t) {
  let now = 2000;
  const work = new CompletionWork({ now: () => now });
  t.after(() => work.reset());
  return { work, now: at => { now = at; },
    claude: (record, at = now) => work.record({ timestamp: stamp(at), ...record }, 'claude'),
    codex: (payload, at = now) => work.record({ type: 'response_item', timestamp: stamp(at), payload }, 'codex'),
  };
}
const tool = (name, id, input = {}) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, id, input }] } });
const result = (id, toolUseResult = {}, is_error = false) => ({ type: 'user', toolUseResult, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error }] } });
const notice = (id, operation = 'enqueue', status = 'completed') => ({ type: 'queue-operation', operation, content: `<task-notification><task-id>${id}</task-id><status>${status}</status></task-notification>` });
const call = (name, call_id, args) => ({ type: 'function_call', name, call_id, arguments: JSON.stringify(args) });
const output = (call_id, value) => ({ type: 'function_call_output', call_id, output: JSON.stringify(value) });

test('service command table excludes persistent servers and watchers but retains finite jobs', () => {
  const services = [
    ...['npm', 'pnpm', 'yarn', 'bun'].flatMap(manager => ['dev', 'start', 'serve', 'preview', 'watch']
      .flatMap(script => [`${manager} ${script}`, `${manager} run ${script} -- --port 5173`])),
    'vite', 'vite --host 0.0.0.0', 'vite preview', 'next dev', 'next start -p 3000', 'nuxt dev', 'astro dev',
    'webpack serve', 'webpack-dev-server --port 8080', 'electron-vite dev', 'nodemon server.js',
    'tsc -w', 'tsc -p tsconfig.json -w', 'tsc --watch', 'node watcher.js --watch', 'vitest --watch',
    'python -m http.server 8000', 'python3 -m http.server', 'uvicorn app:app --reload', 'flask run',
    'rails s', 'rails server', 'docker compose up', 'docker compose -f dev.yml up --build',
    'tail -f app.log', 'tail -n 20 -f app.log', 'jupyter notebook', 'jupyter lab', 'hugo server', 'jekyll serve',
    'S="/scratch" && node "$S/gray-preview.mjs"', 'node tools/preview.mjs', 'node scripts/dev-server.cjs',
    'npx vite --host', 'npx --yes next dev', 'pnpm exec tsc -w', 'bunx astro dev',
    'cd "/work/my app" && env NODE_ENV=development PORT=5173 npm run dev',
    "env -i FLAG='two words' cd '/work/app' && env --unset OLD tsc -w",
    'cd /d "C:\\work\\app" && NODE_ENV=development pnpm run preview',
  ];
  const jobs = [
    'npm run build', 'npm test', 'npm run test:desktop', 'pnpm run build', 'yarn test', 'bun test',
    'vite build', 'codex exec "check npm run dev"', 'node scripts/completion-smoke.mjs', 'pytest', 'cargo test',
    'tsc', 'docker compose up -d', 'docker compose -f dev.yml up --detach', 'tail -n 20 app.log',
    'cd /work/app && env CI=true npm run build', 'env CI=true vite build',
    'S=/scratch && npm run build', 'node scripts/completion-smoke.mjs --output /tmp/preview.mjs',
    'npx vite build', 'pnpm exec vite build',
    'npm run development', 'node -e "console.log(\'--watch\')"', '', undefined,
    'cd /work/app\nnode -e ' + '"quoted text" '.repeat(40),
  ];
  for (const [commands, expected] of [[services, true], [jobs, false]]) for (const command of commands) {
    assert.equal(isServiceCommand(command), expected, String(command));
  }
});

test('Claude services never become pending work, including automatic backgrounding and SDK task receipts', t => {
  for (const run_in_background of [true, false]) {
    const h = fixture(t), { work } = h;
    h.claude(tool('Bash', 'dev', { command: 'cd /work/app && env PORT=5173 npm run dev', run_in_background }));
    work.native({ type: 'system', subtype: 'task_started', tool_use_id: 'dev', task_id: 'server' }, 'claude', 2050);
    h.claude(result('dev', { backgroundTaskId: 'server' }));
    assert.equal(work.tasks.size, 0);
    assert.equal(work.state(complete), 'complete', 'a still-running server cannot hold an ended parent');
    h.now(2000 + 2 * LOST_WORK_TIMEOUT); assert.equal(work.state(complete), 'complete');
    h.claude(notice('server')); h.claude(notice('server', 'remove'));
    work.native({ type: 'system', subtype: 'task_notification', task_id: 'server', status: 'completed' }, 'claude', 2200);
    assert.equal(work.state(complete), 'complete', 'service receipts cannot create a phantom parent review');
  }
});

test('a service command also retires SDK launches received before their Bash input', t => {
  for (const tool_use_id of ['dev', undefined]) {
    const h = fixture(t), { work } = h;
    work.native({ type: 'system', subtype: 'task_started', tool_use_id, task_id: 'server' }, 'claude', 1900);
    assert.equal(work.tasks.size, 1, 'the command is not known yet');
    h.claude(tool('Bash', 'dev', { command: 'npm run dev', run_in_background: true }));
    h.claude(result('dev', { backgroundTaskId: 'server' }));
    assert.equal(work.tasks.size, 0); assert.equal(work.state(complete), 'complete');
    h.claude(notice('server')); assert.equal(work.state(complete), 'complete');
  }
});

test('Claude matches async agent ids, auto-backgrounded shells and failed/killed notifications without treating tool acknowledgments as completion', t => {
  const h = fixture(t), { work } = h;
  h.claude(tool('Agent', 'agent', { run_in_background: 'true' }));
  h.claude(result('agent', { isAsync: true, status: 'async_launched', agentId: 'a123' }));
  h.claude(tool('Bash', 'shell'));
  h.claude(result('shell', { backgroundTaskId: 'b123' }));
  assert.equal(work.tasks.size, 2); assert.equal(work.state(complete), 'working');
  h.claude(notice('a123', 'enqueue', 'failed'));
  assert.equal(work.tasks.size, 1); assert.equal(work.state(complete), 'working');
  h.claude(notice('b123', 'enqueue', 'killed'));
  assert.equal(work.tasks.size, 0); assert.equal(work.state(complete), 'working');
  h.claude({ type: 'queue-operation', operation: 'dequeue' });
  assert.equal(work.state(complete), 'working', 'anonymous dequeue cannot identify which message was delivered');
  h.claude(notice('a123', 'remove')); h.claude(notice('b123', 'remove'));
  assert.equal(work.state(complete), 'working', 'parent review must end');
  h.claude({ type: 'system', subtype: 'stop_hook_summary' }, 2100);
  assert.equal(work.state({ ...complete, updatedAt: 2100 }), 'complete');
});

test('TaskOutput running preserves the launch time, only terminal status or successful stops retire the matching task', t => {
  const h = fixture(t), { work } = h;
  h.claude(tool('Bash', 'launch', { run_in_background: true }));
  h.claude(result('launch', { backgroundTaskId: 'b123' }));
  h.claude(tool('TaskOutput', 'poll', { task_id: 'b123' }));
  h.claude(result('poll', { task: { task_id: 'b123', status: 'running' } }));
  assert.equal(work.state(complete), 'working');
  h.claude(tool('TaskStop', 'failed-stop', { task_id: 'b123' })); h.claude(result('failed-stop', {}, true));
  assert.equal(work.state(complete), 'working');
  h.claude(tool('TaskOutput', 'done', { task_id: 'b123' }));
  h.claude(result('done', { task: { task_id: 'b123', status: 'completed' } }));
  assert.equal(work.state(complete), 'complete');
});

test('human queue handoff blocks the idle gap, while cancelled task notifications need no review', t => {
  const h = fixture(t), { work } = h;
  h.claude({ type: 'queue-operation', operation: 'remove', content: 'Next task', reason: 'submitted' }, 2050);
  assert.equal(work.state(complete), 'working');
  h.claude({ type: 'assistant', uuid: 'done', message: { content: [], stop_reason: 'end_turn' } }, 2200);
  assert.equal(work.state({ ...complete, updatedAt: 2200 }), 'complete');
  h.claude(notice('finished'), 2300);
  h.claude({ ...notice('finished', 'remove'), reason: 'cleared_on_cancel' }, 2400);
  assert.equal(work.state({ ...complete, updatedAt: 2400 }), 'complete');
});

test('Codex CLI-style agent ids, wait statuses and resumed workers count each outstanding task', t => {
  const h = fixture(t), { work } = h;
  h.codex(call('spawn_agent', 'spawn', {})); h.codex(output('spawn', { agent_id: 'worker' }));
  assert.equal(work.state(complete), 'working');
  h.codex(call('wait', 'pending', { ids: ['worker'] })); h.codex(output('pending', { status: {}, timed_out: true }));
  assert.equal(work.state(complete), 'working');
  h.codex(call('wait', 'finished', { ids: ['worker'] })); h.codex(output('finished', { status: { worker: { completed: 'reply' } } }));
  assert.equal(work.state(complete), 'complete');
  h.codex(call('send_input', 'resume', { id: 'worker', message: 'Continue' })); h.codex(output('resume', {}));
  assert.equal(work.state(complete), 'working');
  h.codex(call('close_agent', 'close', { id: 'worker' })); h.codex(output('close', { previous_status: 'running' }));
  assert.equal(work.state(complete), 'complete');
});

test('todo/plan items do not hold an ended turn when the owner needs to answer', t => {
  const h = fixture(t);
  h.claude(tool('TodoWrite', 'todos', { todos: [{ status: 'pending' }, { status: 'in_progress' }] }));
  assert.equal(h.work.state(complete), 'complete');
  h.codex(call('update_plan', 'plan', { plan: [{ step: 'Wait for owner', status: 'in_progress' }] }));
  assert.equal(h.work.state(complete), 'complete');
});

test('missing receipts and discarded history fail closed while partial history holds completion', t => {
  const h = fixture(t), { work } = h;
  h.claude(tool('Agent', 'lost', { run_in_background: true }));
  assert.equal(work.state(complete), 'working');
  h.now(2000 + LOST_WORK_TIMEOUT - 1); assert.equal(work.state(complete), 'working');
  h.now(2000 + LOST_WORK_TIMEOUT); assert.equal(work.state(complete), 'interrupted');
  work.reset(); work.reading = true; assert.equal(work.state(complete), 'working');
  h.now(2000 + 2 * LOST_WORK_TIMEOUT); assert.equal(work.state(complete), 'working', 'history and parent review are not missing task receipts');
  work.reset(); work.uncertain = true; assert.equal(work.state(complete), 'interrupted');
});

test('quiet jobs wait 12 hours from launch, independent of the parent stop, polling and late launch receipts', t => {
  const h = fixture(t), { work } = h, launched = 2000;
  assert.equal(LOST_WORK_TIMEOUT, 12 * 60 * 60 * 1000);
  h.claude(tool('Bash', 'quiet', { command: 'npm run build', run_in_background: true }), launched);
  h.claude(result('quiet', { backgroundTaskId: 'shell' }), launched + 10000);
  h.now(launched + 60 * 60 * 1000);
  assert.equal(work.state(complete), 'working', 'a quiet hour-long command is still running');
  h.claude(tool('TaskOutput', 'poll', { task_id: 'shell' }));
  h.claude(result('poll', { task: { task_id: 'shell', status: 'running' } }));
  h.now(launched + 6 * 60 * 60 * 1000);
  assert.equal(work.state(complete), 'working', 'a quiet job can run for several hours');
  h.now(launched + LOST_WORK_TIMEOUT - 1); assert.equal(work.state(complete), 'working');
  h.claude(tool('TaskOutput', 'late-poll', { task_id: 'shell' }));
  h.claude(result('late-poll', { task: { task_id: 'shell', status: 'running' } }));
  h.now(launched + LOST_WORK_TIMEOUT);
  assert.equal(work.state(complete), 'interrupted');
  assert.equal(work.tasks.size, 0);
  work.begin(); assert.equal(work.state(complete), 'complete', 'a fresh real input can recover after expiry');
});

test('the lost-receipt timer wakes at the launch deadline without another transcript callback', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2000 });
  let state;
  const work = new CompletionWork({ changed: () => { state = work.state(complete); } });
  t.after(() => work.reset());
  work.record({ ...tool('Agent', 'lost', { run_in_background: true }), timestamp: stamp(2000) }, 'claude');
  t.mock.timers.tick(60 * 60 * 1000); state = work.state(complete);
  t.mock.timers.tick(LOST_WORK_TIMEOUT - 60 * 60 * 1000 - 1); assert.equal(state, 'working');
  t.mock.timers.tick(1); assert.equal(state, 'interrupted');
});

test('TaskStop and KillShell calls name the task even without a later notification, and failed stops restore it', t => {
  for (const name of ['TaskStop', 'KillShell']) {
    const h = fixture(t), { work } = h;
    h.claude(tool('Bash', 'launch', { run_in_background: true }));
    h.claude(result('launch', { backgroundTaskId: 'shell' }));
    const args = name === 'TaskStop' ? { task_id: 'shell' } : { shell_id: 'shell' };
    h.claude(tool(name, 'failed', args)); assert.equal(work.tasks.size, 0);
    h.claude(result('failed', {}, true)); assert.equal(work.tasks.size, 1);
    h.claude(tool(name, 'stop', args)); assert.equal(work.tasks.size, 0);
    h.claude(result('stop', { message: 'Successfully stopped task', task_id: 'shell', task_type: 'local_bash' }));
    assert.equal(work.state(complete), 'complete');
  }
});

test('every terminal notification status retires its task; archived API requests cannot replay task events', t => {
  for (const status of ['completed', 'failed', 'killed', 'stopped']) {
    const h = fixture(t), { work } = h;
    h.claude(tool('Agent', 'launch', { run_in_background: true }));
    h.claude(result('launch', { isAsync: true, agentId: 'worker' }));
    h.claude({ type: 'api-request-blob', message: { content: notice('worker', 'enqueue', status).content } });
    assert.equal(work.tasks.size, 1);
    h.claude(notice('worker', 'enqueue', status)); assert.equal(work.tasks.size, 0);
    assert.equal(work.state(complete), 'working', 'the notification still awaits parent review');
  }
});

test('Codex shell sessions and yielded cells do not hold completion or start a lost-work timer', t => {
  const h = fixture(t), { work } = h;
  h.codex({ type: 'custom_tool_call', name: 'exec', call_id: 'launch', input: 'two commands' });
  h.codex({ type: 'custom_tool_call_output', call_id: 'launch', output: [
    { type: 'text', text: '{"session_id":11}\n{"session_id":22}' },
  ] });
  h.codex({ type: 'custom_tool_call', name: 'exec', call_id: 'poll', input: 'tools.write_stdin({chars:"",session_id:11}); tools.write_stdin({session_id:22});' });
  h.codex({ type: 'custom_tool_call_output', call_id: 'poll', output: [{ type: 'text', text: '{"exit_code":130}\n{"session_id":22}' }] });
  assert.equal(work.tasks.size, 0);
  h.codex({ type: 'custom_tool_call', name: 'exec', call_id: 'yielded', input: 'text(await tools.write_stdin({session_id:22}));' });
  h.codex({ type: 'custom_tool_call_output', call_id: 'yielded', output: 'Script running with cell ID cell-1' });
  assert.equal(work.tasks.size, 0); assert.equal(work.state(complete), 'complete'); assert.equal(work.timer, null);
  h.now(2000 + 2 * LOST_WORK_TIMEOUT); assert.equal(work.state(complete), 'complete');
  h.codex(call('wait', 'cell-wait', { cell_id: 'cell-1' }));
  h.codex({ type: 'function_call_output', call_id: 'cell-wait', output: [{ type: 'text', text: '{"exit_code":0}' }] });
  assert.equal(work.tasks.size, 0); assert.equal(work.calls.size, 0); assert.equal(work.state(complete), 'complete');
});

test('Codex list-agent statuses discard completed children without retaining reply text', t => {
  const h = fixture(t);
  h.codex(call('spawn_agent', 'spawn', {})); h.codex(output('spawn', { task_name: '/root/child' }));
  h.codex(call('list_agents', 'list', {})); h.codex(output('list', { agents: [{ agent_name: '/root/child', agent_status: { completed: true } }] }));
  assert.equal(h.work.tasks.size, 0); assert.equal(h.work.state(complete), 'complete');
});

test('remote clock offsets keep launch deadlines and parent review in the local clock', t => {
  for (const offset of [-4 * LOST_WORK_TIMEOUT, 4 * LOST_WORK_TIMEOUT]) {
    const h = fixture(t), { work } = h;
    work.record({ ...tool('Bash', 'shell', { run_in_background: true }), timestamp: stamp(2000 - offset) }, 'claude', offset);
    assert.equal(work.state(complete), 'working');
    h.now(2000 + LOST_WORK_TIMEOUT - 1); assert.equal(work.state(complete), 'working');
    h.now(2000 + LOST_WORK_TIMEOUT); assert.equal(work.state(complete), 'interrupted');
  }
});
