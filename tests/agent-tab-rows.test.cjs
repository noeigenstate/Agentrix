const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// The project's Agent tab: every terminal's workers in one list (labelled 终端 N), the starting row and its notice, the 最近完成 list, the background group and its badge.
// Source files are transpiled the way the other UI tests do it; the open views are read straight from their store, and the hooks run without a render.
const root = path.join(__dirname, '..'), src = path.join(root, 'src');
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'), previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const stopped = [];
before(() => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset: {}, lang: '' } } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { agentrix: { stopAgent: (terminalId, callId) => { stopped.push([terminalId, callId]); return Promise.resolve({ ok: true }); } } } });
});
after(() => {
  if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else delete globalThis.document;
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete globalThis.window;
});

const hooks = { ...React, useSyncExternalStore: (subscribe, snapshot) => snapshot(), useState: initial => [initial, () => {}], useRef: current => ({ current }), useEffect() {} };
const cache = new Map();
const resolve = (from, name) => [name, `${name}.ts`, `${name}.tsx`].map(candidate => path.resolve(path.dirname(from), candidate)).find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
function load(filename) {
  if (cache.has(filename)) return cache.get(filename).exports;
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  cache.set(filename, mod);
  const original = mod.require.bind(mod);
  mod.require = name => {
    if (name === 'react') return hooks;
    if (name.endsWith('.css')) return {};
    if (name.endsWith('.json')) return original(name);
    if (name === '@phosphor-icons/react') return new Proxy({}, { get: (_, icon) => () => React.createElement('svg', { 'data-icon': icon }) });
    return name.startsWith('.') ? load(resolve(filename, name)) : original(name);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
  return mod.exports;
}
const files = relative => load(path.join(src, relative));
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
// A tree with its function components expanded (they hold no state here), to find the row buttons and call their handlers.
const deep = node => Array.isArray(node) ? node.flatMap(deep) : React.isValidElement(node)
  ? [node, ...(typeof node.type === 'function' ? deep(node.type(node.props)) : deep(node.props.children))] : [];

const call = (model, items, agent = 'Claude Code') => ({ agent, provider: agent === 'Codex' ? 'OpenAI' : 'Anthropic', model, effort: 'high', fast: null, preparing: 0, running: 0, reviewing: 0, tasks: [], rate: null, items });
const item = (id, patch = {}) => ({ id, state: 'running', role: '执行', title: `Task ${id}`, startedAt: 1, endedAt: null, viewable: true, hidden: false, ...patch });
const terminal = (id, calls, background) => ({ id, agentUsage: { provider: 'Anthropic', context: null, round: null, total: null, limits: [], calls, ...(background ? { background } : {}) } });
const setup = () => { files('shared/i18n.ts').applyLanguage('zh'); return files('features/agents/AgentCalls.tsx'); };
const cardTree = terminals => deep(React.createElement(setup().CallsCard, { calls: [], terminalId: terminals[0].id, terminals }));
const card = terminals => renderToStaticMarkup(React.createElement(setup().CallsCard, { calls: [], terminalId: terminals[0].id, terminals }));
const sidebar = terminals => { let handed; files('features/agents/AgentSidebar.tsx').AgentSidebar({ project: { id: 'p', terminals }, children: agent => { handed = agent; return null; } }); return handed; };

test('Claude workers from every project terminal remain visible across terminal selection', () => {
  setup();
  const splits = files('features/agents/subagent-splits.ts'), { setActiveTerminal } = files('features/terminal/active-terminal.ts');
  const terminals = [terminal('t1', [call('claude-sonnet-5-5', [item('dispatch:a', { title: '补写测试' })])]), terminal('t2', [call('claude-sonnet-5-5', [item('dispatch:b', { title: '评审事件重放' })]), call('claude-opus-5-5', [item('dispatch:c', { title: '核对边界' })])])];
  // Whichever terminal the grid has picked, the tab is the project's: the sidebar reads no terminal selection.
  for (const picked of ['t1', 't2']) {
    setActiveTerminal('p', picked);
    const handed = sidebar(terminals), html = renderToStaticMarkup(handed.panel);
    for (const title of ['补写测试', '评审事件重放', '核对边界']) assert.ok(html.includes(title), `${title} is listed with terminal ${picked} picked`);
    assert.ok(html.includes('终端 1') && html.includes('终端 2'), 'each row says which terminal it belongs to');
    assert.equal(handed.running, 3, 'the running count is the project\'s');
  }
  // One model, one head: the two Sonnet workers of different terminals share it.
  assert.equal(splits.projectCalls(splits.callSources(terminals), [], Date.now()).groups.map(group => group.rows.length).join(), '2,1');
  // A row opens its split with the terminal that owns it.
  const rows = cardTree(terminals).filter(node => node.type === 'button' && String(node.props.className).includes('activity-call-open'));
  assert.equal(rows.length, 3);
  rows.find(node => node.props['aria-label'].includes('评审事件重放')).props.onClick();
  assert.deepEqual(splits.getSplits().map(({ terminalId, callId }) => [terminalId, callId]), [['t2', 'dispatch:b']], 'the split is (terminal, call) of the row, not of the terminal in use');
  splits.closeSplit('t2', 'dispatch:b');
  // A missing rate or an unreadable feed leaves a plain row.
  assert.ok(card(terminals).includes('— token/s'), 'no rate: a dash, the row stays');
  const lone = [terminal('t9', [call('claude-sonnet-5-5', [item('x', { viewable: false })])])];
  assert.doesNotMatch(card(lone), /终端 \d/, 'one terminal needs no terminal label');
  assert.ok(card(lone).includes('Task x'), 'a row whose record cannot be read is plain, not a button');
});

test('a starting row shows 启动中 · 未确认, and a finished one is counted in 最近完成 N 个', () => {
  const splits = files('features/agents/subagent-splits.ts'), now = Date.now(), minutes = count => now - count * 60000;
  const starting = item('dispatch:s', { state: 'starting', notice: 'unconfirmed', title: '写属性测试', startedAt: now - 16000 });
  const terminals = [terminal('t1', [{ ...call('gpt-6.1-sol', [starting], 'Codex'), rate: { samples: 0, outputTokens: 0, activeMs: 0 } }])];
  const html = card(terminals);
  assert.ok(html.includes('启动中 · 未确认'), 'the state word');
  assert.ok(html.includes('已等 15 秒仍未确认，可能没有启动。') && html.includes('停止') && html.includes('再等等'), 'the 15 s notice with its two choices');
  assert.ok(html.includes('等待中'), 'a model with no reply yet reads 等待中, not a speed');
  const buttons = cardTree(terminals).filter(node => node.type === 'button');
  buttons.find(node => node.props.children === '停止').props.onClick();
  assert.deepEqual(stopped, [['t1', 'dispatch:s']], '停止 stops that worker');
  buttons.find(node => node.props.children === '再等等').props.onClick();
  assert.doesNotMatch(card(terminals), /已等 15 秒/, '再等等 hides the notice');
  assert.ok(splits.noticeShown('t1', starting, Date.now() + 16000), 'and it returns after another 15 s');
  const plain = card([terminal('t1', [call('gpt-6.1-sol', [item('dispatch:p', { state: 'starting', title: '刚准入' })], 'Codex')])]);
  assert.ok(plain.includes('启动中 · 未确认') && !plain.includes('已等 15 秒'), 'before the notice, only the word');

  // 继续 and 自启动 tags, and a row waiting for the owner.
  const tagged = card([terminal('t1', [call('claude-sonnet-5-5', [item('a', { resumed: true }), item('b', { source: 'intercepted' }), item('c', { awaiting: 'owner' })])])]);
  assert.ok(tagged.includes('继续') && tagged.includes('自启动') && tagged.includes('等待你确认'));
  assert.doesNotMatch(card([terminal('t1', [call('claude-sonnet-5-5', [item('a')])])]), /继续|自启动/);

  // 最近完成: finished rows leave the main list; the last 10, none older than 30 minutes.
  const done = (id, age) => item(id, { state: 'done', title: `done ${id}`, endedAt: minutes(age) });
  const finished = card([terminal('t1', [call('claude-sonnet-5-5', [item('live'), done('d1', 2)])]), terminal('t2', [call('claude-sonnet-5-5', [done('d2', 5), done('old', 31)])])]);
  assert.ok(finished.includes('最近完成 2 个'), 'two finished within 30 minutes; the 31-minute one is not counted');
  assert.ok(!finished.includes('done d1') && finished.includes('Task live'), 'folded by default, and not in the main list');
  const many = Array.from({ length: 12 }, (_, index) => done(`m${index}`, index + 1));
  const kept = splits.projectCalls(splits.callSources([terminal('t1', [call('claude-sonnet-5-5', many)])]), [], now).recent;
  assert.equal(kept.length, 10, 'at most 10');
  assert.equal(kept[0].call.item.id, 'm0', 'newest first');
  const onlyDone = card([terminal('t1', [call('claude-sonnet-5-5', [done('z', 1)])])]);
  assert.ok(onlyDone.includes('最近完成 1 个') && !onlyDone.includes('还没有调用其他模型'), 'only finished work: the folded list, and no "nothing yet" sentence above it');
  assert.ok(card([terminal('t1', [])]).includes('还没有调用其他模型'), 'nothing at all: the quiet sentence');
});

test('background tasks are listed with their terminal and age, and 后台 N 个运行中 shows outside the reading view', () => {
  const now = Date.now(), splits = files('features/agents/subagent-splits.ts');
  const running = { id: 'b1', command: 'node scripts/replay-t23.cjs --all', terminalId: 't1', startedAt: now - 40 * 60000, lastOutputAt: now - 6000, state: 'running', tail: ['replay 1183/1500  ok', 'replay 1184/1500  ok'] };
  const second = { id: 'b2', command: 'pnpm test', terminalId: 't2', startedAt: now - 60000, state: 'running' };
  const ended = { id: 'b3', command: 'pnpm build', terminalId: 't1', startedAt: now - 300000, lastOutputAt: now - 120000, state: 'done', exitCode: 0 };
  const terminals = [terminal('t1', [], [running, ended]), terminal('t2', [], [second])];
  const html = card(terminals);
  assert.ok(html.includes('后台任务') && html.includes('2 个运行中'), 'the group and its count');
  assert.ok(html.includes('node scripts/replay-t23.cjs --all') && html.includes('终端 1') && html.includes('终端 2'), 'command and terminal');
  assert.match(html, /(39:5\d|40:0\d)/, 'elapsed time, to the second');
  assert.match(html, /最后输出 [567] 秒前/); assert.ok(html.includes('还没有输出'), 'the last output age, or none yet');
  assert.ok(!html.includes('pnpm build') && html.includes('最近完成 1 个'), 'an ended command moves to 最近完成');

  // The split is read-only: the tail, no stop and no message box.
  const { BackgroundPane } = files('features/agents/BackgroundPane.tsx');
  const callId = splits.backgroundCallId('b1'), pane = renderToStaticMarkup(React.createElement(BackgroundPane, { terminal: terminals[0], callId, onClose() {} }));
  assert.ok(pane.includes('replay 1184/1500  ok') && pane.includes('只读'));
  assert.doesNotMatch(pane, /停止<|<textarea|<input/, 'nothing to stop and nowhere to type');
  assert.ok(renderToStaticMarkup(React.createElement(BackgroundPane, { terminal: terminals[0], callId: splits.backgroundCallId('gone'), onClose() {} })).includes('不在记录里'), 'a task that is gone says so');
  cardTree(terminals).find(node => node.type === 'button' && node.props['aria-label']?.includes('replay-t23')).props.onClick();
  assert.deepEqual(splits.getSplits().map(({ terminalId, callId: id }) => [terminalId, id]), [['t1', callId]], 'a row opens its split under the terminal that owns it');
  splits.closeSplit('t1', callId);

  // The badge, the tab count and the small card; the reading view is untouched.
  const { BackgroundBadge } = files('features/agents/BackgroundBadge.tsx');
  assert.ok(renderToStaticMarkup(React.createElement(BackgroundBadge, { terminals })).includes('后台 2 个运行中'), 'N counts the running ones only');
  assert.equal(renderToStaticMarkup(React.createElement(BackgroundBadge, { terminals: [terminal('t1', [], [ended])] })), '', 'none running, no badge');
  assert.equal(sidebar(terminals).background, 2, 'the Agent tab gets the count');
  assert.match(read('src/features/workspace/ProjectPanel.tsx'), /<BackgroundBadge terminals=\{project\.terminals\} \/>/, 'the project header, which is the small card\'s too');
  assert.match(read('src/features/files/ProjectExplorer.tsx'), /agentBackground > 0 && <span className="explorer-tab-count explorer-tab-background"/, 'the Agent tab');
  const walk = dir => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(dir + '/' + entry.name) : [dir + '/' + entry.name]);
  for (const file of walk('src/features/reading').filter(name => /\.(tsx?|css)$/.test(name))) assert.doesNotMatch(read(file), /BackgroundBadge|background-badge|后台 \{count\} 个运行中/, `${file}: nothing of it inside the reading view`);

  // Every new sentence has its English.
  const english = JSON.parse(read('electron/locales/en.json'));
  const used = ['已等 15 秒仍未确认，可能没有启动。', '启动中 · 未确认', '最近完成 {count} 个', '后台任务', '{count} 个运行中', '后台 {count} 个运行中', '最后输出 {count} 秒前', '终端 {number}', '继续', '自启动'];
  assert.deepEqual(used.filter(text => !english[text]), []);
});

test('a background task with output, as main publishes it, renders in its split', () => {
  setup();
  const splits = files('features/agents/subagent-splits.ts'), { BackgroundPane } = files('features/agents/BackgroundPane.tsx');
  const { BackgroundTasks, attach } = require('../electron/features/agents/background-tasks.cjs');
  const now = Date.now(), stamp = at => new Date(at).toISOString(), tasks = new BackgroundTasks('t1', { now: () => now });
  tasks.apply({ type: 'assistant', timestamp: stamp(now - 2000), message: { content: [{ type: 'tool_use', name: 'Bash', id: 'launch', input: { command: 'node replay.cjs', run_in_background: true } }] } });
  tasks.apply({ type: 'user', timestamp: stamp(now - 1000), toolUseResult: { backgroundTaskId: 'shell', stdout: 'replay 1/2 ok\r\nreplay 2/2 ok', stderr: '' },
    message: { content: [{ type: 'tool_result', tool_use_id: 'launch', is_error: false, content: '' }] } });
  const record = { id: 't1', agentUsage: attach({ provider: null, context: null, round: null, total: null, limits: [], calls: [] }, tasks.snapshot()) };
  const html = renderToStaticMarkup(React.createElement(BackgroundPane, { terminal: record, callId: splits.backgroundCallId('launch'), onClose() {} }));
  assert.equal(/<pre[^>]*>([^<]*)<\/pre>/.exec(html)?.[1], 'replay 1/2 ok\nreplay 2/2 ok');
});

test('a background split shows its output whether main sends lines or one string, and a bad tail never throws', () => {
  setup();
  const now = Date.now(), splits = files('features/agents/subagent-splits.ts'), { BackgroundPane } = files('features/agents/BackgroundPane.tsx');
  const task = (id, tail) => ({ id, command: `node ${id}.cjs`, terminalId: 't1', startedAt: now - 60000, lastOutputAt: now - 1000, state: 'running', tail });
  const tasks = [task('lines', ['step 1 ok', 'step 2 ok']), task('text', 'step 1 ok\nstep 2 ok'), task('number', 42), task('mixed', ['step 1 ok', null, 'step 2 ok'])];
  const terminals = [terminal('t1', [], tasks)];
  const pane = id => renderToStaticMarkup(React.createElement(BackgroundPane, { terminal: terminals[0], callId: splits.backgroundCallId(id), onClose() {} }));
  const log = html => /<pre[^>]*>([^<]*)<\/pre>/.exec(html)?.[1];
  assert.equal(log(pane('lines')), 'step 1 ok\nstep 2 ok', 'a task that has output shows it, one line each');
  assert.equal(log(pane('text')), 'step 1 ok\nstep 2 ok', 'a string tail renders the same lines');
  assert.equal(log(pane('number')), '还没有输出。', 'a tail that is neither reads as no output');
  assert.equal(log(pane('mixed')), 'step 1 ok\nstep 2 ok', 'a line that is not a string is left out');
  // The narrow window's chip lists the same rows (CallsCard) and opens this same split, so both paths read the tail through backgroundTail.
  assert.ok(card(terminals).includes('node text.cjs'), 'the list the chip and the Agent tab share renders these tasks');
  assert.deepEqual(splits.backgroundTail(task('empty', '')), []);
});

test('a finished call that main has already hidden is still counted in 最近完成 N 个', () => {
  const now = Date.now(), done = (id, patch = {}) => item(id, { state: 'done', hidden: true, endedAt: now - 1000, ...patch });
  const html = card([terminal('t1', [call('claude-sonnet-5-5', [done('a'), done('b', { endedAt: now - 31 * 60000 }), item('live', { hidden: true })])])]);
  assert.ok(html.includes('最近完成 1 个'), 'hidden and finished: listed; too old: not; a hidden live call stays out');
  assert.ok(!html.includes('Task live'));
});

test('停止 belongs to the starting state, waits while sent and says why a refusal came', async () => {
  const splits = files('features/agents/subagent-splits.ts'), now = Date.now();
  const confirmed = item('dispatch:c', { state: 'running', notice: 'unconfirmed' });
  assert.equal(splits.noticeShown('t1', confirmed, now + 99999), false, 'a confirmed worker never shows the notice');
  assert.doesNotMatch(card([terminal('t1', [call('claude-sonnet-5-5', [confirmed])])]), /已等 15 秒|>停止</);
  const starting = item('dispatch:r', { state: 'starting', notice: 'unconfirmed' }), terminals = [terminal('t1', [call('claude-sonnet-5-5', [starting])])];
  const previous = window.agentrix.stopAgent;
  let release;
  window.agentrix.stopAgent = () => new Promise(resolve => { release = resolve; });
  const stop = () => cardTree(terminals).find(node => node.type === 'button' && node.props.children === '停止');
  stop().props.onClick();
  assert.equal(stop().props.disabled, true, 'disabled while the request is out');
  release({ ok: false, error: '工作者已经结束' });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(stop().props.disabled, false);
  assert.ok(card(terminals).includes('没能停止它：工作者已经结束'), 'the refusal in words');
  window.agentrix.stopAgent = previous;
  splits.pruneSplits(new Set());
});

test('a row names its terminal by the terminal title, not its place in the list', () => {
  const reordered = [{ ...terminal('t2', [call('claude-sonnet-5-5', [item('a', { title: '甲' })])]), title: '终端 2' }, { ...terminal('t1', [call('claude-sonnet-5-5', [item('b', { title: '乙' })])]), title: '终端 1' }];
  const html = card(reordered);
  assert.match(html, /甲[^]*?终端 2/);
  assert.match(html, /乙[^]*?终端 1/);
});

test('a background task that has an end time counts from it', () => {
  const splits = files('features/agents/subagent-splits.ts');
  assert.equal(splits.backgroundEnd({ id: 'x', command: 'c', terminalId: 't', startedAt: 1, lastOutputAt: 5, endedAt: 9, state: 'done' }), 9);
  assert.equal(splits.backgroundEnd({ id: 'x', command: 'c', terminalId: 't', startedAt: 1, lastOutputAt: 5, state: 'done' }), 5);
});
