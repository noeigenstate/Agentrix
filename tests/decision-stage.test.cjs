const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readCss, assertRule } = require('./helpers/css-rules.cjs');
const { hookHarness } = require('./helpers/hook-harness.cjs');
const { elements, stubGlobals } = require('./helpers/renderer-fixtures.cjs');
const en = require('../electron/locales/en.json');

test('the decision page with nothing to decide is one stage: the guide, a 760px white box and a hint, the picked project always driving it', async t => {
  const Select = () => null, DecisionInbox = () => null;
  const projects = ['a', 'b'].map(id => ({ id, name: id, kind: 'local', terminals: [{ id, cliActive: true, sessionId: id }] }));
  const items = projects.map(project => ({ id: project.id, project, terminal: project.terminals[0], group: 'other' }));
  const sent = [];
  let acknowledge;
  const delivered = new Promise(resolve => { acknowledge = resolve; });
  stubGlobals(t, { window: { agentrix: { getState: async () => ({ ok: true, value: { projects } }) } } });
  const overrides = {
    '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './Select': { Select }, './DecisionInbox': { DecisionInbox }, './DecisionCard': {}, './SessionLine': { SessionLine: () => null },
    './inbox-items': { inboxItems: () => items, newWorkProjects: () => projects }, './review-history': { acceptedToday: () => 0 },
    './send-to-agent': { sendToAgent: async (...args) => { sent.push(args); acknowledge(); } }, './image-thumbnail': {}, './VoiceButton': { VoiceButton: () => null },
    './voice-input': { useDictatedBox() {} }, './file-popup': {}, './i18n': { t: text => text },
  };
  const view = hookHarness('src/features/home/DecisionHome.tsx', overrides);
  t.after(() => view.dispose());
  const props = { projects, decisions: [], snoozed: 0, onError: assert.fail };
  const render = () => elements(view.render('DecisionHome', props).result);
  let nodes = render(), stage = nodes.find(node => node.props.stage);
  assert.deepEqual([stage.props.selectedProjectId, stage.props.takeFocus], ['a', true]);
  nodes.find(node => node.type === DecisionInbox).props.onSelect('b');
  stage = render().find(node => node.props.stage);
  assert.deepEqual([stage.props.selectedProjectId, stage.props.takeFocus], ['b', false]);
  const composer = hookHarness('src/features/home/DecisionHome.tsx', overrides);
  t.after(() => composer.dispose());
  const work = () => elements(composer.render('NewWork', stage.props).result);
  const picker = work().find(node => node.type === Select && node.props.label === '项目');
  assert.equal(picker.props.value, 'b');
  picker.props.onChange('a');
  nodes = render();
  assert.equal(nodes.find(node => node.type === DecisionInbox).props.selectedId, 'a');
  stage = nodes.find(node => node.props.stage);
  assert.equal(work().find(node => node.type === Select && node.props.label === '项目').props.value, 'a');
  assert.ok(work().find(node => node.props.className === 'new-work-hint').props.children.includes('输入需求后按 Enter 开始'));
  work().find(node => node.type === 'textarea').props.onChange({ target: { value: 'Goal' } });
  const press = (shiftKey, isComposing, preventDefault) => work().find(node => node.type === 'textarea').props.onKeyDown({
    key: 'Enter', shiftKey, nativeEvent: { isComposing }, preventDefault,
  });
  press(true, false, assert.fail);
  press(false, true, assert.fail);
  assert.deepEqual(sent, []);
  let prevented = false;
  press(false, false, () => { prevented = true; });
  assert.equal(prevented, true);
  await delivered;
  assert.deepEqual(sent, [['a', 'a', 'claude', 'Goal']]);
  const css = readCss('src/features/home/home.css');
  assertRule(css, '.new-work.is-stage', { width: 'min(760px, 100%)' });
  assertRule(css, '.new-work-title', { 'font-size': '24px', 'font-weight': '600' });
  assertRule(css, '.new-work-sub', {
    margin: '8px 0 24px', 'font-size': '14px', 'font-weight': '400', color: 'var(--text-2)',
  }, '8px under the title, 24px above the box, the helper colour');
  assertRule(css, '.new-work.is-stage .new-work-input', {
    'min-height': '128px', 'border-radius': '16px', padding: '16px', 'border-color': 'var(--compose-border)', 'box-shadow': 'var(--compose-shadow)',
  });
  assertRule(css, '.home-right.is-stage', { 'padding-bottom': '92px' }, 'the title and the box sit 70px above where the old empty state sat');
  assertRule(css, '.new-work.is-stage .new-work-input:has(textarea:focus-visible)', { 'border-color': 'var(--compose-accent)' });
});

test('the send button is a quiet grey square until there is text, then the brand blue with a white icon', () => {
  const css = readCss('src/features/home/home.css'), themes = readCss('src/shared/styles/themes.css');
  assertRule(css, '.home-layer .new-work-start:not(.primary)', { background: 'var(--bg-hover)' });
  assertRule(css, '.home-layer .new-work-start.primary', { color: '#fff', background: 'var(--compose-accent)' });
  assertRule(themes, '.home-layer', { '--compose-border': 'var(--border)', '--compose-shadow': 'none', '--compose-accent': '#5686c4' });
  assertRule(themes, ':root[data-theme="light"] .home-layer', { '--compose-border': '#cbd5e1', '--compose-shadow': '0 4px 18px rgb(20 30 50 / .04)' });
  // white on #5686c4 is 3.75:1, the 3:1 an icon needs; the pressed shade is darker still
  const luminance = hex => { const [r, g, b] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const blue of ['#5686c4', '#4a77b4', '#3f6aa3']) assert.ok(ratio('#ffffff', blue) >= 3, `${blue} carries a white icon`);
  assert.ok(ratio('#5686c4', '#ffffff') >= 3, 'the focused border reads against the white box');
});

test('the project list recedes: idle sessions are plain names, only the picked one has its fill, its state line and a bold name', t => {
  const css = readCss('src/features/home/home.css');
  const view = hookHarness('src/features/home/DecisionInbox.tsx', {
    './DecisionCard': { kindLabel: () => 'Approval', waited: () => '1s' },
    './inbox-items': { isWorking: () => true, sessionTask: () => 'Working task' },
    './review-history': {}, './action-text': {}, './i18n': { t: text => text },
  });
  t.after(() => view.dispose());
  const terminal = { sessionId: 'session', cliActive: true };
  const items = ['picked', 'idle', 'working'].map(id => ({
    id, terminal, project: { name: id, terminals: [terminal] }, group: id === 'working' ? 'working' : 'other',
  }));
  items.push({ ...items[0], id: 'approval', group: 'decide', decision: { kind: 'approval', since: 0, context: ['Review this'] } });
  const rows = elements(view.render('DecisionInbox', { items, selectedId: 'picked', now: 1 }).result)
    .filter(node => node.props.role === 'option');
  assert.deepEqual(rows.map(row => row.props['aria-selected']), [false, false, true, false]);
  assert.deepEqual(rows.map(row => elements(row.props.children).find(node => node.type === 'small')?.props.children),
    ['1s · Review this', 'Working task', '等待指令', undefined]);
  assert.deepEqual(rows.map(row => elements(row.props.children).find(node => node.props.className?.startsWith('inbox-tag'))?.props.children),
    ['Approval', '等待指令', undefined, undefined]);
  assertRule(css, '.inbox-text b', { 'font-weight': '400', color: 'var(--text-2)' });
  assertRule(css, '.inbox-row:is([aria-selected="true"], .has-decision) .inbox-text b', { color: 'var(--text-1)', 'font-weight': '600' });
  assertRule(css, '.inbox-row.is-compact', { height: '36px' });
  assert.deepEqual(css.blocks.filter(({ selector }) => selector.includes('.inbox-row[aria-selected="true"]::before')), [], 'the new reference has no selection bar');
  assertRule(css, '.home-head h1', { 'font-size': '14px', 'font-weight': '600' });
});

test('the new texts have English translations', () => {
  for (const text of ['描述一个想法，让 Agentrix 帮你实现。', '描述你想构建的功能、修复的问题，或粘贴截图…', '输入需求后按 Enter 开始', '开始 (Enter)', '添加图片']) assert.ok(text in en, text);
});

test('review titles preserve plain angle-bracket text and both decision kinds use the same default agent', t => {
  const h = hookHarness('src/features/home/decisions.ts', {
    './terminal-screen': { subscribeScreen: () => () => {}, bindApproval: () => null },
    './agent-screen': require('../src/features/agents/agent-screen.ts'),
    './cli-panel': require('../src/features/reading/cli-panel.ts'),
    './review-history': { reviewHistory: () => ({ task: '' }) },
  });
  t.after(() => h.dispose());
  const terminal = { id: 't1', title: 'Terminal', sessionId: 's1', cliActive: true, agent: null, needsInput: 'Owner', task: '<Button> 样式修复' };
  const { decisions } = h.render('useDecisions', [{ id: 'p', name: 'Fixture', unread: true, terminals: [terminal] }]).result;
  assert.deepEqual(decisions.map(decision => [decision.kind, decision.agent, decision.title]),
    [['attention', 'codex', ''], ['review', 'codex', '<Button> 样式修复']]);
});

test('a rejected task history read tells the user the history could not be loaded', async t => {
  stubGlobals(t, { window: { agentrix: { terminalConversation: async () => { throw new Error('history disconnected'); } } } });
  const h = hookHarness('src/features/home/SessionLine.tsx', {
    '@phosphor-icons/react': { ArrowUpRight: () => null },
    './result-round': { lastRound: () => ({ reply: '' }) }, './time': { relativeTime: () => '' },
    './inbox-items': { sessionTask: () => 'Existing task' }, './i18n': { t: text => text },
  });
  t.after(() => h.dispose());
  const render = () => elements(h.render('SessionLine', {
    item: { project: { id: 'p', name: 'Fixture' }, terminal: { id: 't1' } }, now: 0, onOpenProject() {},
  }).result).find(node => node.props.className === 'session-summary').props.children;
  render(); await Promise.resolve();
  assert.equal(render(), '无法加载任务记录');
});

test('decision screens ignore unchanged draws and release the subscription of a removed terminal', t => {
  const listeners = new Map();
  const h = hookHarness('src/features/home/decisions.ts', {
    './agent-screen': require('../src/features/agents/agent-screen.ts'),
    './cli-panel': require('../src/features/reading/cli-panel.ts'),
    './terminal-screen': { subscribeScreen(id, fn) { listeners.set(id, fn); return () => listeners.delete(id); }, bindApproval: choice => choice },
    './review-history': { reviewHistory: () => ({ task: '' }) },
  });
  t.after(() => h.dispose());
  const projects = [{ id: 'p', name: 'Fixture', terminals: [{ id: 't', sessionId: 's', title: 'Terminal', cliActive: true, agent: 'claude', needsInput: null }] }];
  const render = () => h.render('useDecisions', projects).result.all;
  const empty = render();
  listeners.get('t')({ sessionId: 's', rows: ['ordinary output'], revision: 1 });
  assert.equal(render(), empty);
  listeners.get('t')({ sessionId: 's', rows: ['Login successful. Press Enter to continue…'], revision: 2 });
  const login = render();
  assert.equal(login[0]?.kind, 'signin');
  listeners.get('t')({ sessionId: 's', rows: ['Login successful. Press Enter to continue…'], revision: 3 });
  assert.equal(render(), login);
  assert.deepEqual(h.render('useDecisions', []).result.all, []);
  assert.equal(listeners.has('t'), false);
});
