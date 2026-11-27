const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readCss, assertRule } = require('./helpers/css-rules.cjs');
const { quotaView } = require('./helpers/quota-view.cjs');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const en = require('../electron/locales/en.json');
const { hookHarness } = require('./helpers/hook-harness.cjs');

// A component of a feature folder compiled with its imports stubbed (the language, the icons, the portal), for static rendering.
// The terminals' native sessions as the conversation knows them: by terminal, the turn status (the pane reads it to tell a failed round from an interrupted one).
const nativeTurns = new Map();
const loadedFiles = new Map();
function loadFeatureFile(relative, language = 'zh') {
  const key = `${relative}:${language}`;
  if (!loadedFiles.has(key)) loadedFiles.set(key, compileFile(path.join(__dirname, '../src/features', relative), language));
  return loadedFiles.get(key);
}
const loadAgentsFile = (basename, language = 'zh') => loadFeatureFile(`agents/${basename}`, language);
function compileFile(filename, language, hooks, overrides = {}) {
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  mod.require = name => {
    if (Object.hasOwn(overrides, name)) return overrides[name];
    if (name === 'react' && hooks) return { ...React, ...hooks };
    if (name.endsWith('.css')) return {};
    if (name === '../../shared/i18n') return { currentLanguage: () => language, t: (key, values = {}) => (language === 'en' ? en[key] ?? key : key).replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '') };
    if (name === '../../shared/routing-command.ts') return compileFile(path.join(__dirname, '../src/shared/routing-command.ts'), language);
    if (name === './routing-seats.ts' || name === './routing-seats') return require('../src/features/agents/routing-seats.ts');
    if (name === './RoutingKeyCard') return loadAgentsFile('RoutingKeyCard.tsx', language);
    if (name === './SeatsHost') return loadAgentsFile('SeatsHost.tsx', language);
    if (name === '../../shared/routing-role-icons.ts') return compileFile(path.join(__dirname, '../src/shared/routing-role-icons.ts'), language);
    if (name === '../../shared/call-model-name') return compileFile(path.join(__dirname, '../src/shared/call-model-name.ts'), language);
    if (name === './i18n') return { currentLanguage: () => language, t: (key, values = {}) => (language === 'en' ? en[key] ?? key : key).replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '') };
    if (name === './model-name') return require('../src/shared/model-name.ts');
    if (name === '../../shared/model-name') return require('../src/shared/model-name.ts');
    if (name === '../../shared/useNow') return require('../src/shared/useNow.ts');
    if (name === '../terminal/terminal-screen') return { readScreen: () => null, subscribeScreen: () => () => {} };
    if (name === '../terminal/active-terminal') return { useActiveTerminal: () => 'selected' };
    if (name === '../home/send-to-agent') return { sendToAgent: () => { throw new Error('render must not send input'); } };
    if (name === './AgentBrandIcon') return require('../src/features/agents/AgentBrandIcon.ts');
    if (name === './reset-count') return require('../src/features/agents/reset-count.ts');
    if (name === './ApiUsage') return { ApiUsage: () => null };
    if (name === './AgentCalls') return loadAgentsFile('AgentCalls.tsx', language);
    if (name === './MainModel') return loadAgentsFile('MainModel.tsx', language);
    if (name === './Metric') return loadAgentsFile('Metric.tsx', language);
    if (name === './ResetQuota') return loadAgentsFile('ResetQuota.tsx', language);
    if (name === './ResetCountdown') return loadAgentsFile('ResetCountdown.tsx', language);
    if (name === './action-text') return loadAgentsFile('action-text.ts', language);
    if (name === '../native-session/native-bridge.ts') return { nativeBridge: () => null };
    if (name === '../native-session/native-store.ts') return { useUsageRevision: () => 0, useNativeEntries: () => nativeTurns };
    if (name === '../native-session/native-billing-link.ts') return loadFeatureFile('native-session/native-billing-link.ts', language);
    if (name === './native-bridge.ts') return { openProjectLink: () => Promise.resolve({ ok: true }) };
    if (name === './native-words') return loadFeatureFile('native-session/native-words.ts', language);
    if (name === '../native-session/native-words') return loadFeatureFile('native-session/native-words.ts', language);
    if (name === 'react-dom') return { createPortal: children => children };
    if (name === '@phosphor-icons/react') return new Proxy({}, { get: (_, icon) => ({ className, role, 'aria-label': label, focusable, size }) =>
      React.createElement('svg', { className, 'data-icon': icon, role, 'aria-label': label, focusable, width: icon === 'Hammer' ? size : undefined }) });
    return original(name);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
  return mod.exports;
}
function mainMarkup(calls, language = 'zh', terminal = {}) {
  const { MainModel, useMainTurn } = loadAgentsFile('MainModel.tsx', language);
  const Main = ({ terminal }) => React.createElement(MainModel, { turn: useMainTurn(terminal) });
  return renderToStaticMarkup(React.createElement(Main, { terminal: {
    id: 'placeholder', agent: 'claude', cliActive: true, prompts: [], agentSettings: { model: 'claude-opus-5-5', effort: 'xhigh', fast: false },
    agentUsage: { provider: 'Anthropic', limits: [], calls },
    ...terminal,
  } }));
}

function rightMarkup(terminal = {}, language = 'zh') {
  const { ActivityPane } = loadAgentsFile('ActivityPane.tsx', language);
  return renderToStaticMarkup(React.createElement(ActivityPane, { terminal: { id: 'placeholder', cliActive: true, ...terminal } }));
}

function routingWorkMarkup(terminal, { terminals = [terminal], conductor = true, language = 'en' } = {}) {
  const { roles, defaults, catalog } = require('./fixtures/team-seats.json');
  const info = { roles, effective: defaults, conductor, lead: 'orchestrator', catalog };
  const component = file => path.join(__dirname, '../src/features/agents', file);
  const routing = compileFile(component('RoutingKeyCard.tsx'), language, { useState: initial => React.useState(initial ?? info) });
  const { ActivityPane } = compileFile(component('ActivityPane.tsx'), language, undefined, { './RoutingKeyCard': routing });
  return renderToStaticMarkup(React.createElement(ActivityPane, { terminal, terminals }));
}

const hammerSeats = markup => [...markup.matchAll(/data-seat="([^"]+)"[^>]*>(?:(?!data-seat=).)*?data-icon="Hammer"/g)].map(match => match[1]);

test('routing shows one hammer per seat with an unfinished role across the project and removes it after the last one ends', () => {
  const terminal = { id: 'selected', cliActive: true };
  const running = { seat: 'developer', state: 'running', endedAt: null };
  const starting = { ...running, state: 'starting' };
  const done = { ...running, state: 'done', endedAt: 42 };
  const reviewing = { seat: 'reviewer', state: 'reviewing', endedAt: 42 };
  const render = items => routingWorkMarkup(terminal, { terminals: [terminal, { id: 'other', agentUsage: { calls: [{ items }] } }] });
  const both = render([running, starting, reviewing]);
  assert.deepEqual(hammerSeats(both), ['developer']);
  assert.match(both, /GPT-6\.2-Sol<\/span><svg class="activity-routing-hammer" data-icon="Hammer" role="img" aria-label="Working" focusable="false" width="14"/);
  assert.deepEqual(hammerSeats(render([done, starting, reviewing])), ['developer']);
  assert.deepEqual(hammerSeats(render([done, done, reviewing])), []);
});

test('routing shows the lead hammer only while the selected main conversation works', () => {
  const terminal = { id: 'selected', sessionId: 'pty', cliActive: true, mainTurn: { state: 'working' } };
  const working = routingWorkMarkup(terminal, { language: 'zh' });
  assert.deepEqual(hammerSeats(working), ['orchestrator']);
  assert.match(working, /data-icon="Hammer" role="img" aria-label="正在工作" focusable="false"/);
  const waiting = { ...terminal, cliState: { sessionId: 'pty', revision: 1, updatedAt: 1, state: 'waiting' } };
  assert.deepEqual(hammerSeats(routingWorkMarkup(waiting)), []);
  const finished = { ...terminal, mainTurn: { state: 'complete' } };
  assert.deepEqual(hammerSeats(routingWorkMarkup(finished, { terminals: [finished, terminal] })), []);
});

test('native routing shows no hammer even when the lead and a role are working', () => {
  const terminal = { id: 'selected', cliActive: true, mainTurn: { state: 'working' },
    agentUsage: { calls: [{ items: [{ seat: 'developer', state: 'preparing', endedAt: null }] }] } };
  assert.deepEqual(hammerSeats(routingWorkMarkup(terminal)), ['orchestrator', 'developer']);
  assert.deepEqual(hammerSeats(routingWorkMarkup(terminal, { conductor: false })), []);
});

// The called models, as the left bar's Agent tab (and the narrow window's popover) lists them.
function callsMarkup(calls, language = 'zh', terminalId = 'placeholder') {
  const { CallsCard } = loadAgentsFile('AgentCalls.tsx', language);
  return renderToStaticMarkup(React.createElement(CallsCard, { calls, terminalId }));
}

function groupedCallsMarkup(items, language = 'en', otherCalls = []) {
  const team = require('./fixtures/team-seats.json');
  const info = { ...team, catalog: [{ model: 'opus', label: 'Opus (follows latest)' }] };
  const { CallsCard, AgentTabScope } = compileFile(path.join(__dirname, '../src/features/agents/AgentCalls.tsx'), language, {
    useState: initial => React.useState(initial && typeof initial === 'object' ? { t1: info } : initial),
  });
  const calls = [{ agent: 'Claude Code', model: 'opus', effort: 'high', fast: false, items }, ...otherCalls];
  const terminal = { id: 't1', agentUsage: { calls } };
  return renderToStaticMarkup(React.createElement(AgentTabScope.Provider, { value: 'p1' },
    React.createElement(CallsCard, { calls, terminalId: 't1', terminals: [terminal] })));
}

test('a role group has the Orchestrator’s model line for each model setting, and its rows keep their own specialties', () => {
  const item = { state: 'running', seat: 'developer', seatSource: 'declared' };
  const html = groupedCallsMarkup([
    { ...item, id: 'one', specialty: 'backend', title: 'Build parser' },
    { ...item, id: 'two', specialty: 'frontend', title: 'Build UI' },
  ], 'en', [{ agent: 'Codex', model: 'gpt-6.2-sol', effort: 'medium', fast: true, rate: { samples: 2, outputTokens: 900, activeMs: 10000 },
    items: [{ ...item, id: 'three', title: 'Build fixture' }] }]);
  assert.match(html, /<h4 class="agent-team-heading"><span class="activity-row-icon"><svg data-icon="Code"><\/svg><\/span><span>Developer<\/span><\/h4>/,
    'the role group leads with the role card’s own mark in the 16px icon column');
  const head = /<li class="activity-call-head"[^>]*><span class="activity-row-icon">.*?<\/span><p><b>([^<]+)<\/b>/.source
    + /<span class="activity-call-settings">([^<]+)<\/span><\/p>(.*?)<\/li>/.source;
  const heads = [...html.matchAll(new RegExp(head, 'g'))].map(([, name, settings, end]) => [name, settings, end]);
  assert.deepEqual(heads, [
    ['Opus', 'high · Standard', ''],
    ['GPT-6.2-Sol', 'medium · Fast', '<span class="activity-row-end activity-rate is-live" title="Average output rate over the last 2 replies: 900 tokens in 10.0 s">90 token/s</span>'],
  ], 'one line per model, the rate only where one is known');
  assert.equal((html.match(/>Developer</g) ?? []).length, 1);
  assert.match(html, /<li class="activity-call-note" title="Backend"><span><\/span><p>Backend<\/p><span><\/span><\/li>/);
  assert.match(html, /<li class="activity-call-note" title="Frontend"><span><\/span><p>Frontend<\/p><span><\/span><\/li>/);
});

test('a role group is built like the Orchestrator’s block: heading, model line, task lines with state words and the same fold', () => {
  const now = Date.now();
  const items = Array.from({ length: 6 }, (_, index) => ({ id: `t${index}`, title: `Task ${index} `.repeat(index ? 1 : 30).trim(),
    state: index === 1 ? 'preparing' : 'running', seat: 'developer', seatSource: 'declared', startedAt: now - 65000, viewable: index === 0 }));
  const group = /<li class="agent-team-group" data-role="developer">(.*?)<\/li><\/ul><\/section>/s.exec(groupedCallsMarkup(items, 'zh'))[1];
  const main = /<section class="activity-card activity-main agent-team-group"[^>]*>(.*)<\/section>/s.exec(mainMarkup([], 'zh', {
    prompts: Array.from({ length: 6 }, (_, index) => ({ id: `p${index}`, state: 'queued', summary: `Prompt ${index}`, text: `Prompt ${index}`, at: now - 1000 })),
  }))[1];
  // The Orchestrator's head keeps its dash where no rate is known; the Agent tab's role lines leave the column empty.
  const shape = html => html.replace(/ (?:title|aria-label|data-icon|data-role)="[^"]*"/g, '').replace(/>[^<]+</g, '><')
    .replace(/<span class="activity-row-end activity-rate"><\/span>/, '')
    .replace(/<h4( class="agent-team-heading")?>.*?<\/h4>/, '<h4>').replace(/(<li class="is-[\w-]+">.*?<\/li>)+/, '<task>');
  assert.equal(shape(group), shape(main), 'the same elements and classes: an h4, a model line, task lines and the fold');
  assert.match(group, /<span class="activity-row-icon"><svg class="loading-spinner" data-icon="CircleNotch"><\/svg><\/span><p><span class="activity-call-role">运行中<\/span>Task 0 Task 0/);
  assert.match(group, /<li class="is-preparing" title="Task 1\n准备中 · 1:0\d\nOpus · high · 普通\n没有可打开的工作会话"><span class="activity-row-icon">/);
  assert.match(group, /<button type="button" class="activity-call-open activity-task-open" aria-label="开发 Task 0[^"]*，运行中">/, 'a viewable task is one button');
  assert.equal((group.match(/<li class="is-/g) ?? []).length, 4, 'four tasks before the fold');
  assert.match(group, /<li class="activity-task-fold"><button type="button" aria-expanded="false"><svg data-icon="CaretDown"><\/svg>还有 2 条<\/button><\/li>/);
  const css = readCss('src/features/agents/agent-calls.css');
  assertRule(css, '.activity-call-rows li > .activity-task-open', { 'grid-column': '1 / -1', display: 'grid', 'grid-template-columns': 'subgrid' });
});

test('each role group leads with its role card’s mark, a custom role with the dialog’s default person', () => {
  const html = groupedCallsMarkup([
    { id: 'qa', title: 'Run checks', state: 'running', seat: 'qa', seatSource: 'declared' },
    { id: 'mine', title: 'Own task', state: 'running', seat: 'custom-lab', seatName: 'Lab role', offTeam: true, seatSource: 'declared' },
  ]);
  const marks = [...html.matchAll(/<h4 class="agent-team-heading"><span class="activity-row-icon"><svg data-icon="(\w+)"><\/svg><\/span><span>([^<]+)</g)]
    .map(([, icon, name]) => [name, icon]);
  assert.deepEqual(marks, [['QA / Tester', 'Flask'], ['Lab role · Off team', 'User']]);
  const { roleIconOf } = compileFile(path.join(__dirname, '../src/shared/routing-role-icons.ts'), 'en');
  assert.equal(roleIconOf('frontend'), roleIconOf('frontend'), 'one mark per role, the one the routing dialog draws');
  assert.notEqual(roleIconOf('frontend'), roleIconOf('backend'));
  const css = readCss('src/features/agents/agent-calls.css');
  assertRule(css, '.agent-team-heading > .activity-row-icon', { flex: 'none', 'align-self': 'center' });
});

test('spacing alone separates the role rows and the folded 最近完成 list: no line under a row or above the fold', () => {
  const sheets = ['src/features/agents/agent-calls.css', 'src/features/agents/activity-pane.css'].map(readCss);
  const borders = sheets.flatMap(sheet => sheet.declarations)
    .filter(({ selectors, property, value }) => /^border(?:-(?:top|bottom))?$/.test(property) && value !== '0'
      && selectors.some(selector => /(?:agent-team-group|activity-task-open|activity-call-note|activity-finished)\b/.test(selector)));
  assert.deepEqual(borders, []);
  assertRule(sheets[1], '.activity-finished', { 'margin-top': '8px' }, 'with the card’s 8px gap, 16px as between two role groups');
});

test('grouped call rows show the status icon and the state word on the task line, and only actionable routing notes', () => {
  const { toggleFinished } = require('../src/features/agents/subagent-splits.ts');
  const endedAt = Date.now(), worktree = '/workspace/worker-runs/a-long-worktree-name-that-needs-truncation';
  const cases = [
    ['running', 'CircleNotch', '运行中', { state: 'running', declared: { model: 'opus' }, worktree }],
    ['awaiting', 'DotsThreeCircle', '等待你确认', { state: 'running', awaiting: 'owner', viewable: true }],
    ['failed', 'Circle', '出错退出', { state: 'reviewing', endedAt, failure: { reason: 'error' }, declared: { model: 'not-opus' } }],
    ['stopped', 'Stop', '已停止', { state: 'reviewing', endedAt, failure: { reason: 'killed' } }],
    ['done', 'CheckCircle', '已完成', { state: 'done', endedAt, declared: { model: 'opus' } }],
    ['starting', 'Circle', '启动中 · 未确认', { state: 'starting' }],
    ['preparing', 'Circle', '准备中', { state: 'preparing' }],
    ['reviewing', 'Record', '审核中', { state: 'reviewing', endedAt, declared: { model: 'opus' } }],
  ];
  const items = cases.map(([id, , , state]) => ({ id, title: `Task ${id}`, seat: 'developer', seatSource: 'declared', startedAt: endedAt - 65000, ...state }));
  toggleFinished('t1');
  try {
    for (const language of ['zh', 'en']) {
      // Two renders, since a role shows four tasks before its fold. A task is its line and the note lines under it, up to the next task.
      const pages = [items.slice(0, 4), items.slice(4)].map(page => groupedCallsMarkup(page, language)), html = pages.join('');
      const rows = pages.flatMap(page => page.split(/(?=<li class="is-)/).slice(1).map(markup => markup.split(/<\/ul>/)[0]));
      assert.equal(rows.length, cases.length);
      assert.ok(pages.every(page => !page.includes('activity-task-fold')));
      for (const [state, icon, key] of cases) {
        const word = language === 'en' ? en[key] : key;
        const row = rows.find(markup => markup.startsWith(`<li class="is-${state}" title="Task ${state}\n${word} · `));
        assert.ok(row, state);
        assert.ok(row.includes(`data-icon="${icon}"></svg></span><p><span class="activity-call-role">${word}</span>Task ${state}</p><time>`));
      }
      const [running, awaiting, failed, stopped, done] = ['running', 'awaiting', 'failed', 'stopped', 'done'].map(state => rows.find(row => row.startsWith(`<li class="is-${state}"`)));
      assert.ok(running.includes(`\n${worktree}\n`));
      assert.equal(running.split(worktree).length, 2, 'the path appears only in the tooltip');
      assert.doesNotMatch(awaiting, /activity-call-note/, 'no empty note line or premature routing note');
      assert.match(awaiting, /<button type="button" class="activity-call-open activity-task-open"/);
      const seat = language === 'en' ? 'Developer' : '开发';
      const mode = language === 'en' ? en['普通'] : '普通';
      assert.ok(done.includes(`<p>${seat} · Opus · high · ${mode}</p>`), 'in 最近完成 the note says the role and model');
      assert.match(failed, /<li class="activity-call-note"[^>]*><span><\/span><p><span data-routing-verdict="mismatch">/);
      assert.match(stopped, /data-routing-verdict="unknown"/);
      assert.match(stopped, /<time>1:05<\/time>/);
      assert.equal((html.match(/data-routing-verdict=/g) ?? []).length, 2);
    }
  } finally {
    toggleFinished('t1');
  }
});
// The pane's run-mode and allowance block, rendered from a main-process usage answer.
// options[agent] is its connection kind; options.limits holds each agent's main-process limits; options.usage overrides parts of the answer.
function usageMarkup(language = 'zh', terminal = {}, options = {}) {
  const { AgentSections } = loadAgentsFile('ApiUsage.tsx', language);
  const connection = kind => ({ kind, source: null, observedAt: null });
  const state = agent => ({ path: null, reason: null, next: { path: agent === 'agy' ? 'native' : null, reason: null },
    limits: options.limits?.[agent] ?? null, connection: connection(options[agent] ?? 'subscription') });
  const agents = { claude: state('claude'), codex: state('codex'), ...(options.agy && { agy: state('agy') }) };
  const usage = { month: '2030-05', apiRecords: true, todayUsdMicros: 100000, monthUsdMicros: 6400000, estimated: true, budgetUsd: null, agents, ...options.usage };
  return renderToStaticMarkup(React.createElement(AgentSections, { usage, installations: options.installations, models: options.models, terminal: {
    id: 'placeholder', agent: 'claude', cliActive: true, prompts: [], agentSettings: { model: 'claude-opus-5-5', effort: 'xhigh', fast: false }, agentUsage: { provider: 'Anthropic', limits: [] }, ...terminal } }));
}
const agentSection = (html, name) => new RegExp('<section class="api-agent" aria-label="' + name + '">[\\s\\S]*?</section>').exec(html)[0];
// The main block and the called models together, for the heads they share.
const bothMarkup = (calls, language, terminal) => mainMarkup(calls, language, terminal) + callsMarkup(calls, language);

test('with routing off the lead panel is the main model and names no routing model; in conductor mode a saved model that differs says when it applies', () => {
  const { MainModel, useMainTurn } = loadAgentsFile('MainModel.tsx');
  const terminal = { id: 'lead', agent: 'claude', cliActive: true, prompts: [], agentUsage: { model: 'claude-fable-5-2', limits: [], calls: [] } };
  const markup = seats => renderToStaticMarkup(React.createElement(({ terminal }) => React.createElement(MainModel, { turn: useMainTurn(terminal), seats }), { terminal }));
  const leads = model => ({ claude: { model, effort: 'medium' }, codex: null });
  const off = markup({ conductor: false, leads: leads('opus') });
  assert.match(off, /<h4>主模型<\/h4>/);
  assert.doesNotMatch(off, /正在切换到/, 'in native mode /model and /effort decide; routing names no model');
  const on = markup({ conductor: true, leads: leads('opus') });
  assert.match(on, /<h4>总指挥<\/h4>/);
  assert.match(on, /Fable 5\.2[\s\S]*正在切换到 Opus/);
  assert.doesNotMatch(markup({ conductor: true, leads: leads('fable') }), /正在切换到/, 'an alias names whichever model of that family runs');
  assert.doesNotMatch(markup({ conductor: true, leads: { codex: { model: 'gpt-6.2-sol', effort: 'high' } } }), /正在切换到/);
  assert.match(markup(null), /<h4>总指挥<\/h4>/, 'the heading is unchanged until the routing is known');
});

test('the lead panel replaces pending with the failure of the current seat and conversation', t => {
  const { MainModel, useMainTurn } = loadAgentsFile('MainModel.tsx');
  const { leadRoutingScope, setLeadRoutingFailure } = require('../src/shared/lead-routing-notices.ts');
  const terminal = { id: 'lead-failure', sessionId: 'pty', agent: 'claude', cliActive: true, agentUsage: { model: 'claude-fable-5-2' } };
  const scope = leadRoutingScope(terminal);
  const render = (model, sessionId = terminal.sessionId) => renderToStaticMarkup(React.createElement(() => React.createElement(MainModel, {
    turn: useMainTurn({ ...terminal, sessionId }), seats: { conductor: true, leads: { claude: { model, effort: 'medium' } } },
  })));
  t.after(() => setLeadRoutingFailure(scope, null));
  setLeadRoutingFailure(scope, { targetModel: 'opus', notice: { incomplete: true } });
  assert.match(render('opus'), /未能切换到 Opus，可在终端里用 \/model 手动切换/);
  assert.doesNotMatch(render('opus'), /正在切换到/);
  assert.match(render('sonnet'), /正在切换到 Sonnet/);
  assert.match(render('opus', 'another-pty'), /正在切换到 Opus/);
  setLeadRoutingFailure(scope, null);
  assert.match(render('opus'), /正在切换到 Opus/);
});

test('the lead model keeps the current effort visible and shows a deferred switch only in its own conversation', t => {
  const { MainModel, useMainTurn } = loadAgentsFile('MainModel.tsx');
  const { leadRoutingScope, setLeadRoutingPending, setLeadRoutingFailure } = require('../src/shared/lead-routing-notices.ts');
  const terminal = { id: 'lead-wait-panel', sessionId: 'pty', agent: 'claude', cliActive: true, readingHistory: { threadId: 'current' },
    agentUsage: { model: 'claude-fable-5-2' }, agentSettings: { model: 'claude-fable-5-2', effort: 'medium' } };
  const scope = leadRoutingScope(terminal);
  const render = (conductor = true, threadId = 'current') => renderToStaticMarkup(React.createElement(() => React.createElement(MainModel, {
    turn: useMainTurn({ ...terminal, readingHistory: { threadId } }), seats: { conductor, leads: { claude: { model: 'fable', effort: 'high' } } },
  })));
  t.after(() => { setLeadRoutingPending(scope, null); setLeadRoutingFailure(scope, null); });
  setLeadRoutingPending(scope, { effort: 'high' });
  assert.match(render(), /activity-call-settings[^>]*>medium<.*role="status"><span><\/span><p>这一轮结束后切换到 high</);
  assert.doesNotMatch(render(false), /这一轮结束后/);
  assert.doesNotMatch(render(true, 'other'), /这一轮结束后/);
  setLeadRoutingFailure(scope, { targetModel: 'fable', notice: { incomplete: true } });
  assert.match(render(), /按模型路由切换未完成/);
  assert.doesNotMatch(render(), /这一轮结束后/);
});

test('the Agent tab leads with the selected terminal’s Orchestrator above calls from every terminal', () => {
  const { AgentSidebar } = loadAgentsFile('AgentSidebar.tsx');
  const call = { agent: 'Claude Code', model: 'claude-sonnet-5-5', items: [{ id: 'one', state: 'running', role: '执行', title: 'First terminal’s worker' }] };
  const terminals = [
    { id: 'first', cliActive: true, agent: 'claude', agentUsage: { model: 'claude-opus-5-5', calls: [call] } },
    { id: 'selected', cliActive: true, agent: 'codex', agentUsage: { model: 'gpt-6.1-sol', calls: [] } },
  ];
  const html = renderToStaticMarkup(React.createElement(AgentSidebar, { project: { id: 'p1', terminals } }, ({ panel }) => panel));
  assert.match(html, /aria-label="主模型"[^>]*><h4>总指挥<\/h4>[\s\S]*?GPT-6\.1-Sol[\s\S]*?First terminal’s worker/);
  assert.doesNotMatch(html, /Opus 5\.5/);
});

test('a terminal screen frame updates the mounted Orchestrator without rendering a sidebar sibling', t => {
  const directory = 'src/features/agents/';
  const terminal = { id: 'selected', agent: 'claude', cliActive: true, sessionId: 'pty', codexActivity: 'working' };
  const listeners = new Set();
  const screenFor = rerender => ({
    ...require('../src/features/terminal/terminal-screen.ts'),
    readScreen: () => null,
    subscribeScreen(id, receive) {
      assert.equal(id, terminal.id);
      const listener = frame => { receive(frame); rerender(); };
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  let panel, siblingRenders = 0, groupRender;
  const Sibling = () => { siblingRenders++; return null; };
  const sidebarProps = { project: { id: 'p1', terminals: [terminal] }, children: agent => {
    panel = agent.panel;
    return React.createElement(Sibling);
  } };
  const renderSidebar = () => {
    const { result } = sidebar.render('AgentSidebar', sidebarProps);
    renderToStaticMarkup(result);
  };
  const mainImports = {
    '@phosphor-icons/react': {},
    './i18n': { t: text => text }, './model-name': {},
    './routing-command.ts': {}, './useNow': {}, './native-store.ts': {},
    './action-text': {}, './AgentCalls': { CallsCard: () => null }, './Metric': {},
  };
  const main = hookHarness(directory + 'MainModel.tsx', { ...mainImports, './terminal-screen.ts': screenFor(() => {
    groupRender = main.render('MainModelGroup', panel.props.children[0].props).result;
  }) });
  const sidebar = hookHarness(directory + 'AgentSidebar.tsx', {
    ...mainImports,
    './active-terminal': { useActiveTerminal: () => terminal.id },
    './terminal-screen.ts': screenFor(renderSidebar),
    './MainModel': { ...main.load(directory + 'MainModel.tsx'), useMainTurn: terminal => sidebar.load(directory + 'MainModel.tsx').useMainTurn(terminal) },
  });
  t.after(() => { main.dispose(); sidebar.dispose(); });
  const sendFrame = () => { for (const receive of listeners) receive({ rows: ['────', '❯ ', '────'], sessionId: 'pty', revision: 1 }); };

  renderSidebar();
  const before = siblingRenders;
  sendFrame();
  assert.equal(siblingRenders, before, 'a closed Agent panel leaves the sidebar sibling idle');
  assert.equal(listeners.size, 0);

  const group = panel.props.children[0];
  assert.equal(group.type, main.load(directory + 'MainModel.tsx').MainModelGroup);
  groupRender = main.render('MainModelGroup', group.props).result;
  assert.equal(groupRender.props.turn.activity, 'working');
  assert.equal(listeners.size, 1);
  sendFrame();
  assert.equal(groupRender.props.turn.activity, 'complete');
  assert.equal(siblingRenders, before, 'the mounted Agent panel still leaves the sidebar sibling idle');
  main.dispose();
  assert.equal(listeners.size, 0);
});

test('the right Activity pane has no copy of the main model or its prompt list', () => {
  assert.doesNotMatch(rightMarkup(), /activity-main|Opus 5\.5/);
});

test('the models list says what will appear when empty, and lists each model with its calls, their states and the how-it-runs in both languages', () => {
  const empty = callsMarkup([]);
  assert.ok(empty.includes('还没有调用其他模型。规划员分派任务后，会显示在这里。') && !empty.includes('activity-call-groups'));
  assert.ok(mainMarkup([]).includes('Opus 5.5'));
  const calls = [
    { agent: 'Claude Code', provider: 'Anthropic', model: 'claude-sonnet-5-5', effort: null, fast: null, preparing: 0, running: 1, reviewing: 1, tasks: [], items: [{ state: 'running', role: '执行', title: 'Polish <card>' }, { state: 'reviewing', role: '审核', title: 'Check spacing' }] },
    { agent: 'Codex', provider: 'OpenAI', model: 'gpt-6.1-sol', effort: 'max', fast: true, preparing: 1, running: 2, reviewing: 0, tasks: [], items: [{ state: 'preparing', role: '准备', title: 'parser.md' }, { state: 'running', role: '执行', title: 'one' }, { state: 'running', role: '执行', title: 'two' }] },
  ];
  const html = callsMarkup(calls);
  const section = /<section class="activity-card activity-calls"[\s\S]*?<\/section>/.exec(html)[0], plain = section.replace(/<[^>]*>/g, '|');
  for (const text of ['Sonnet 5.5', 'GPT-6.1-Sol', 'max · 快速', '运行中', '审核中', '准备中']) assert.ok(plain.includes(text), text);
  assert.doesNotMatch(plain, /Anthropic|OpenAI|子代理/);
  assert.match(section, /title="Claude Code \/ Anthropic \/ Sonnet 5\.5"/);
  assert.match(section, /title="Codex \/ OpenAI \/ GPT-6\.1-Sol\nmax · 快速"/);
  assert.ok(section.includes('aria-label="调用的模型"') && !section.includes('activity-card-title') && !section.includes('activity-count'), 'a labelled list with no heading of its own: the tab is its title');
  assert.doesNotMatch(rightMarkup({ agentUsage: { calls } }), /activity-calls|调用的模型|activity-call-groups/, 'the right pane no longer lists the called models');
  assert.ok(section.includes('<span class="activity-call-text"><p>Polish &lt;card&gt;</p><small class="activity-call-sub">执行 · 运行中</small></span>'), 'two lines: what it does, then its role and state');
  assert.ok(section.includes('title="Polish &lt;card&gt;"'));
  assert.match(section, /agent-brand-claude/); assert.match(section, /agent-brand-codex/);
  for (const [state, count] of [['preparing', 1], ['running', 3], ['reviewing', 1]]) assert.equal((section.match(new RegExp(`<li class="activity-call-item is-${state}"`, 'g')) || []).length, count);
  const english = callsMarkup(calls, 'en').replace(/<[^>]*>/g, '|');
  for (const text of ['Running', 'Reviewing', 'Preparing', 'max · Fast']) assert.ok(english.includes(text), text);
  assert.doesNotMatch(english, /Anthropic|OpenAI|Sub-agent/);
});

test('main and called heads show non-default providers, retain full tooltips and keep their rate column', () => {
  const cases = [
    ['claude', 'Claude Code', 'claude-opus-5-5', 'Opus 5.5', 'Anthropic', null],
    ['codex', 'Codex', 'gpt-6.1-sol', 'GPT-6.1-Sol', 'OpenAI', null],
    ['claude', 'Claude Code', 'claude-opus-5-5', 'Opus 5.5', 'relay.example:8443', 'relay.example:8443'],
    ['claude', 'Claude Code', 'claude-opus-5-5', 'Opus 5.5', 'Amazon Bedrock', 'Amazon Bedrock'],
    ['claude', 'Claude Code', 'claude-opus-5-5', 'Opus 5.5', 'Google Vertex AI', 'Google Vertex AI'],
    ['claude', 'Claude Code', 'claude-opus-5-5', 'Opus 5.5', 'OpenAI', 'OpenAI'],
    ['codex', 'Codex', 'gpt-6.1-sol', 'GPT-6.1-Sol', 'proxy.example', 'proxy.example'],
    ['codex', 'Codex', 'gpt-6.1-sol', 'GPT-6.1-Sol', 'Azure OpenAI', 'Azure OpenAI'],
    ['codex', 'Codex', 'gpt-6.1-sol', 'GPT-6.1-Sol', 'Anthropic', 'Anthropic'],
    ['claude', 'Claude Code', 'claude-opus-5-5', 'Opus 5.5', null, null],
    ['codex', 'Codex', 'gpt-6.1-sol', 'GPT-6.1-Sol', null, null],
  ];
  const rate = { outputTokens: 480, activeMs: 10000, samples: 2, updatedAt: 1, partial: false };
  for (const language of ['zh', 'en']) for (const [agent, label, model, name, provider, visible] of cases) {
    const call = { agent: label, provider, model, effort: null, fast: null, rate, items: [{ state: 'running', role: '执行', title: 'work' }] };
    const html = bothMarkup([call], language, { agent, agentSettings: { model }, agentUsage: { provider, model, rate, limits: [], calls: [call] } });
    const heads = [...html.matchAll(/<li class="activity-call-head" title="([^"]*)">([\s\S]*?)<\/li>/g)];
    assert.equal(heads.length, 2, `${language} ${label} ${provider}`);
    for (const [, title, content] of heads) {
      assert.equal(title, [label, provider, name].filter(Boolean).join(' / '));
      assert.equal(/<span class="activity-call-provider">([^<]*)<\/span>/.exec(content)?.[1] ?? null, visible);
      assert.ok(content.includes(`<p><b>${name}</b>`));
      assert.match(content, /class="activity-row-end activity-rate is-live"[^>]*>48 token\/s<\/span>/);
      assert.doesNotMatch(content, /activity-call-tag|子代理|Sub-agent/);
    }
  }
});

test('main and called heads share inline recorded effort and speed, including explicit off and unknown values', () => {
  for (const language of ['zh', 'en']) for (const [agent, label, model, name] of [
    ['claude', 'Claude Code', 'claude-opus-5-5', 'Opus 5.5'], ['codex', 'Codex', 'gpt-6.1-terra', 'GPT-6.1-Terra'],
  ]) for (const [effort, fast] of [['high', false], ['max', true], ['xhigh', null], [null, false], [null, true], [null, null], ['default', null], ['ultracode', null]]) {
    const call = { agent: label, provider: null, model, effort, fast, items: [] };
    const html = bothMarkup([call], language, { agent, agentSettings: { model, effort, fast }, agentUsage: { model, provider: null, calls: [call], limits: [] } });
    const how = [effort === 'default' ? language === 'en' ? 'default' : '默认' : effort,
      fast == null ? null : fast ? language === 'en' ? 'Fast' : '快速' : language === 'en' ? 'Standard' : '普通'].filter(Boolean).join(' · ');
    const heads = [...html.matchAll(/<li class="activity-call-head" title="([^"]*)">([\s\S]*?)<\/li>/g)];
    assert.equal(heads.length, 2);
    for (const [, title, content] of heads) {
      assert.equal(title, `${label} / ${name}${how ? '\n' + how : ''}`);
      assert.ok(content.includes(`<p><b>${name}</b>${how ? `<span class="activity-call-settings">${how}</span>` : ''}</p>`));
    }
    assert.doesNotMatch(html, /activity-call-note|Runs with its default settings|按默认设置运行/, 'known model heads have no duplicate note or invented default mode');
  }
});

test('340px heads reserve the rate column and truncate secondary settings before they can overflow', () => {
  const css = readCss('src/features/agents/activity-pane.css');
  assertRule(css, '.activity-call-rows li.activity-call-head', { 'grid-template-columns': '16px minmax(0, 1fr) 80px' });
  assertRule(css, '.activity-call-rows li.activity-call-head p', { display: 'flex', 'min-width': '0' });
  assertRule(css, '.activity-call-head p > *', { 'min-width': '0', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' });
  assertRule(css, '.activity-call-head p > b', { flex: '0 1 auto' });
  assertRule(css, '.activity-call-head p > .activity-call-settings', { flex: '0 2 auto' });
  assertRule(css, '.activity-call-settings', { 'font-size': '12px', 'font-weight': '400', color: 'var(--flow-muted)' });
  assertRule(css, '.activity-call-head p b', { 'font-weight': '600' });
  // The called models' list sits in a narrower bar: the rate shrinks to its figure and the settings give way first.
  assertRule(css, '.activity-main .activity-call-rows li.activity-call-head', { 'grid-template-columns': '16px minmax(0, 1fr) auto' });
  assertRule(css, '.activity-calls .activity-call-rows li .activity-rate, .activity-main .activity-call-rows li .activity-rate', { 'min-width': '0' });
  assertRule(css, '.activity-calls .activity-call-head p > .activity-call-settings, .activity-main .activity-call-head p > .activity-call-settings', { flex: '0 8 auto' });
});

test('a single preparing or reviewing call shows its own state and reviewed routes disappear', () => {
  for (const [state, word] of [['preparing', 'Preparing'], ['reviewing', 'Reviewing']]) {
    const html = callsMarkup([{ agent: 'Codex', model: 'gpt-6.1-sol', provider: null, effort: null, fast: null, preparing: 0, running: 0, reviewing: 0, [state]: 1, tasks: [], items: [{ state, role: '执行', title: 'one task' }] }], 'en');
    assert.match(html, new RegExp(`<li class="activity-call-item is-${state}"`));
    assert.ok(html.replace(/<[^>]*>/g, '|').includes(word));
    assert.doesNotMatch(html, /activity-call-item is-running/);
  }
  const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
  const calls = new AgentCalls();
  calls.apply({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id: 'a', input: { model: 'sonnet', effort: 'high', description: 'Check layout' } }] } });
  const called = callsMarkup(calls.snapshot());
  assert.match(called, /<span class="activity-call-settings">high<\/span>/, 'the Agent tool’s effort reaches the rendered model head');
  assert.doesNotMatch(called, /普通|快速|activity-call-note/, 'neither speed nor a duplicate note is inferred');
  calls.apply({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'Checked' }] } });
  assert.match(callsMarkup(calls.snapshot()), /class="activity-call-item is-reviewing"/);
  calls.apply({ type: 'system', subtype: 'stop_hook_summary', hookCount: 1 });
  assert.doesNotMatch(callsMarkup(calls.snapshot()), /Check layout|activity-call-groups/);
});

test('called models show four ordered role and title rows with state icons and words, full hovers and localized overflow', () => {
  const long = 'Inspect <parser> ' + 'and preserve every detail '.repeat(20);
  const items = [
    { state: 'preparing', role: '调查', title: long },
    { state: 'running', role: '执行', title: 'Implement parser' },
    { state: 'reviewing', role: '规划', title: 'Plan the checks' },
    { state: 'running', role: 'custom-worker', title: 'Custom task' },
    { state: 'running', role: '通用', title: 'Older task' },
    { state: 'running', role: '分身', title: 'Oldest task' },
  ];
  const call = { agent: 'Codex', provider: 'OpenAI', model: 'gpt-6.1-sol', effort: null, fast: null, preparing: 1, running: 4, reviewing: 1, tasks: [], items };
  for (const language of ['zh', 'en']) {
    const html = callsMarkup([call], language);
    const rows = /<section class="activity-card activity-calls"[\s\S]*?<ul class="activity-call-rows">([\s\S]*?)<\/ul>/.exec(html)[1];
    const plain = rows.replace(/<[^>]*>/g, ' ');
    assert.equal((rows.match(/<li class="activity-call-item is-/g) || []).length, 4);
    assert.ok(rows.includes(`title="${long.replace('<parser>', '&lt;parser&gt;')}"`));
    assert.ok(plain.indexOf('Inspect') < plain.indexOf('Implement parser'));
    assert.ok(plain.indexOf('Implement parser') < plain.indexOf('Plan the checks'));
    assert.ok(plain.indexOf('Plan the checks') < plain.indexOf('Custom task'));
    for (const role of language === 'en' ? ['Investigate', 'Execute', 'Plan', 'custom-worker'] : ['调查', '执行', '规划', 'custom-worker']) assert.ok(plain.includes(role));
    for (const state of ['preparing', 'running', 'reviewing']) assert.ok(rows.includes(`<li class="activity-call-item is-${state}"`));
    assert.ok(plain.includes(language === 'en' ? '+2 more' : '+2 个'));
    assert.doesNotMatch(plain, /Older task|Oldest task/);
    assert.doesNotMatch(callsMarkup([{ ...call, items: items.slice(0, 4) }], language), /activity-call-more/);
    for (const [role, translated] of [['搜索', 'Search'], ['通用', 'General'], ['分身', 'Fork']]) assert.ok(callsMarkup([{ ...call, items: [{ ...items[0], role }] }], 'en').includes(`>${translated} · `));
  }
});

test("Claude's usage keeps plan limits and tokens without a source line, reset controls or text", () => {
  const now = Date.now();
  for (const language of ['zh', 'en']) {
    for (const [source, percent] of [['Claude Code', 6], ['CodePulse', 100], ['Claude', 12]]) {
      const html = agentSection(usageMarkup(language, { agentUsage: {
        limits: [{ minutes: 300, percent, resetsAt: now + 3600000 }, { minutes: 10080, percent: 84, resetsAt: now + 86400000 }],
        limitsAt: now, limitsFrom: source,
        round: { input: 1200, cached: 600, output: 30 }, total: { input: 2400, cached: 1200, output: 60 },
      } }), 'Claude');
      const labels = language === 'en' ? ['5-hour limit', 'Weekly limit', 'This round', 'This conversation']
        : ['5 小时额度', '每周额度', '本轮', '本次对话'];
      for (const label of labels) assert.ok(html.includes(label), label);
      assert.doesNotMatch(html, /额度来自|Limits from|data-usage-detail/, 'no line says where the limits came from');
      assert.ok(html.includes(`aria-valuenow="${percent}"`)); assert.match(html, /aria-valuenow="84"/);
      assert.equal((html.match(/class="activity-metric activity-tokens" title=/g) || []).length, 2);
      assert.equal((html.match(/is-warn/g) || []).length, percent >= 90 ? 1 : 0, 'only a window from 90% takes the warning colour');
      // The window's own reset time stays; only the reset control goes.
      assert.equal((html.match(/<small>[^<]*(?:重置|Resets)/gi) || []).length, 2);
      assert.doesNotMatch(html, /activity-reset|activity-estop|重置额度|limit-reset/i);
    }
    const empty = agentSection(usageMarkup(language), 'Claude');
    assert.ok(empty.includes(language === 'en' ? 'Plan limits are currently unavailable.' : '账号额度暂不可用。'));
    assert.doesNotMatch(empty, /\/usage/);
    assert.doesNotMatch(empty, /activity-reset|activity-estop|重置|reset/i);
  }
});

test('expired terminal limits display unknown while waiting for a fresh observation', t => {
  const now = new Date(2030, 4, 5, 12).getTime(), past = now - 86400000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const pastTime = new Date(past).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  for (const agent of ['claude', 'codex']) {
    for (const language of ['zh', 'en']) {
      const html = agentSection(usageMarkup(language, { agent, agentUsage: {
        limits: [{ minutes: 300, percent: 81.34, resetsAt: past }, { minutes: 10080, percent: 92.1, resetsAt: past }], limitsAt: now - 60000,
      } }), agent === 'claude' ? 'Claude' : 'Codex');
      const limits = [...html.matchAll(/<div class="activity-metric(?: is-warn)? activity-limit">([\s\S]*?)<\/div>/g)];
      assert.equal(limits.length, 2);
      for (const [, limit] of limits) {
        assert.ok(limit.includes(language === 'en' ? 'Reset time reached; waiting for an update' : '已到重置时间，等待更新'));
        assert.ok(limit.includes(language === 'en' ? 'Unknown' : '未知'));
        assert.doesNotMatch(limit, /aria-valuenow|(?:81|92)%/);
        assert.ok(!limit.includes(pastTime));
      }
    }
  }
});

test('the app clock hides a percentage at expiry and retains the underlying observation', t => {
  const now = new Date(2030, 4, 5, 12).getTime(), resetsAt = now + 5000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const terminal = { agentUsage: { limits: [{ minutes: 300, percent: 81.34, resetsAt }], limitsAt: now } };
  const time = new Date(resetsAt).toLocaleString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const before = agentSection(usageMarkup('en', terminal), 'Claude');
  assert.match(before, />81%</); assert.match(before, /aria-valuenow="81"/);
  assert.ok(before.includes(`<small>Resets ${time}</small>`));
  assert.doesNotMatch(before, /is-expired|waiting for an update/);
  t.mock.timers.tick(5000);
  const after = agentSection(usageMarkup('en', terminal), 'Claude');
  assert.match(after, /Reset time reached; waiting for an update/);
  assert.match(after, />Unknown</);
  assert.doesNotMatch(after, /81%|aria-valuenow/);
  assert.equal(terminal.agentUsage.limits[0].percent, 81.34);
});

test('an unknown round explains earlier history when context is known; an unknown conversation total says nothing', () => {
  const tokens = { input: 1200, cached: 600, output: 30 };
  for (const language of ['zh', 'en']) {
    const first = language === 'en' ? 'Shows after the first reply.' : '第一次回复后显示。';
    const roundNote = language === 'en' ? 'This round started in earlier records; its usage is unknown.' : '本轮从更早的记录开始，暂无法统计。';
    const totalNote = language === 'en' ? 'The conversation total is in earlier records.' : '本次对话的总量在更早的记录里。';
    for (const [round, total] of [[null, null], [null, tokens], [tokens, null]]) {
      const html = agentSection(usageMarkup(language, { agentUsage: { limits: [], context: { used: 120, window: 200000 }, round, total } }), 'Claude');
      assert.equal(html.includes(roundNote), round === null);
      assert.ok(!html.includes(totalNote));
      assert.ok(!html.includes(first));
      assert.equal((html.match(/class="activity-metric activity-tokens" title=/g) || []).length, Number(!!round) + Number(!!total));
    }
    const empty = agentSection(usageMarkup(language, { agentUsage: { limits: [], context: null, round: null, total: null } }), 'Claude');
    assert.ok(!empty.includes(first), 'no context length, so no hint that it comes with the first reply');
    assert.doesNotMatch(empty, /上下文|Context|activity-tokens" title=/, 'no context length and no round or conversation rows');
    assert.ok(!empty.includes(roundNote)); assert.ok(!empty.includes(totalNote));
  }
});

test('hover titles give exact token counts, one-decimal limit percentages and their observation time', t => {
  const now = new Date(2030, 4, 5, 12, 34).getTime(), limitsAt = now - 60000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const time = new Date(limitsAt).toLocaleString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  for (const agent of ['claude', 'codex']) {
    for (const language of ['zh', 'en']) {
      const terminal = { agent, agentUsage: {
        limits: [{ minutes: 300, percent: 83.25, resetsAt: now + 3600000 }], limitsAt,
        context: { used: 1230010, window: 2000000 },
        round: { input: 1230010, cached: 456789, output: 98765 }, total: { input: 123456789, cached: 90123456, output: 2000000 },
      } };
      const html = usageMarkup(language, terminal);
      assert.doesNotMatch(html, /activity-figure|2,000,000 tokens/, 'the context length is not shown');
      const titles = language === 'en'
        ? ['1,328,775 tokens · Input 1,230,010 · Cache read 456,789 · Output 98,765', '125,456,789 tokens · Input 123,456,789 · Cache read 90,123,456 · Output 2,000,000']
        : ['1,328,775 tokens · 输入 1,230,010 · 缓存命中 456,789 · 输出 98,765', '125,456,789 tokens · 输入 123,456,789 · 缓存命中 90,123,456 · 输出 2,000,000'];
      for (const title of titles) assert.ok(html.includes(`class="activity-metric activity-tokens" title="${title}"`), title);
      assert.ok(html.includes(`title="83.3% · ${language === 'en' ? `Updated ${time}` : `${time} 更新`}"`));
      assert.match(html, />83%</); assert.match(html, /aria-valuenow="83"/);
      terminal.agentUsage.limitsAt = null;
      assert.ok(usageMarkup(language, terminal).includes('title="83.3%"'));
    }
  }
});

test('Codex reset count arrives automatically, shows zero and bounded query states, preserving explicit reset controls', () => {
  const render = (language, state, left = null, reason) => usageMarkup(language, { agent: 'codex', agentUsage: {
    limits: [], resets: left === null ? null : { left, total: null }, resetQuery: state && { state, reason },
  } });
  // The row's right-hand slot (a short status) and its hover (the whole sentence); renderToStaticMarkup escapes the apostrophe in English.
  const status = html => /<small>([^<]*)<\/small><\/button>/.exec(html)[1];
  const hover = html => /class="activity-reset-row activity-estop"[^>]*? title="([^"]*)"/.exec(html)[1].replaceAll('&#x27;', "'");
  const click = {
    zh: '点击后开始 10 秒倒计时，期间可取消；结束后打开 Codex 的 /usage，由你选择并确认重置',
    en: "Click to start a 10-second countdown; you can cancel it. Afterward, Codex's /usage opens, where you choose and confirm a reset.",
  };
  const unsupportedFull = ['这个账号没有返回重置次数，5 小时和每周额度照常显示；将定时再查', 'This account did not return a reset count; the 5-hour and weekly limits still show. It will be checked again on a schedule'];
  const unknownFull = ['无法确定重置次数，将定时再查', 'Cannot tell how many resets are left; it will be checked again on a schedule'];
  // [state, count, reason, short and hover in Chinese, short and hover in English]
  const cases = [
    [undefined, null, undefined, ['暂无状态', '当前会话还没有重置次数的查询状态；符合条件的本地账号会自动查询'], ['No status yet', 'No reset-count query status is available for this session yet; eligible local accounts are checked automatically.']],
    ['loading', null, undefined, ['查询中…', '正在查询剩余重置次数，结果出来后会显示在这里'], ['Checking…', 'Checking the remaining reset count; the result will appear here.']],
    ['error', null, 'timeout', ['查询失败', '查询失败，将自动重试'], ['Query failed', 'Query failed; retrying automatically']],
    ['unavailable', null, 'remote', ['暂不支持', '远程账号暂不支持后台查询'], ['Not supported', 'Background queries are not yet supported for remote accounts']],
    ['unavailable', null, 'provider', ['暂不支持', '当前接口不提供重置次数'], ['Not supported', 'This provider does not provide reset counts']],
    ['unavailable', null, 'version', ['暂不支持', '当前 Codex 版本不支持查询重置次数'], ['Not supported', 'This Codex version cannot query the reset count.']],
    ['unavailable', null, 'missing', ['暂不支持', '找不到 Codex 程序，无法查询重置次数'], ['Not supported', 'Codex was not found, so the reset count cannot be queried.']],
    ['unavailable', null, 'scope', ['无法确认', '无法确认账号环境，暂不能查询'], ['Unconfirmed', 'Cannot verify the account environment; query unavailable']],
    ['unavailable', null, 'unsupported', ['未提供次数', unsupportedFull[0]], ['Not provided', unsupportedFull[1]]],
    ['ready', null, undefined, ['未提供次数', unsupportedFull[0]], ['Not provided', unsupportedFull[1]]],
    ['unavailable', null, 'something-new', ['次数未知', unknownFull[0]], ['Unknown', unknownFull[1]]],
    ['unavailable', null, undefined, ['次数未知', unknownFull[0]], ['Unknown', unknownFull[1]]],
  ];
  for (const language of ['zh', 'en']) {
    const shown = language === 'zh' ? 0 : 1, hovers = [];
    assert.match(render(language, 'ready', 2), language === 'zh' ? /<small>剩余 2 次<\/small>/ : /<small>2 left<\/small>/);
    assert.equal(hover(render(language, 'ready', 2)), click[language], 'a known count has only the click explanation');
    const zero = render(language, 'ready', 0);
    assert.match(zero, language === 'zh' ? /<small>已用完<\/small>/ : /<small>None left<\/small>/); assert.match(zero, /<button[^>]*disabled/);
    assert.equal(hover(zero), language === 'zh' ? '没有剩余重置次数，此行不可点击' : 'No resets remain; this row is disabled.', 'none left says the row is disabled');
    assert.doesNotMatch(zero, /剩余 0 次|0 left/, 'none left is told apart from not knowing');
    for (const [state, left, reason, ...texts] of cases) {
      const html = render(language, state, left, reason), [short, full] = texts[shown];
      assert.equal(status(html), short, `${state} ${reason}`); assert.equal(hover(html), `${full}\n${click[language]}`, `${state} ${reason}`);
      assert.doesNotMatch(/<div class="activity-reset">[\s\S]*?<\/div>/.exec(html)[0], /activity-note/, 'no separate status line');
      assert.doesNotMatch(html, /剩余 0 次|已用完|0 left|None left/, `${short} is not zero`);
      assert.equal(/<button[^>]*disabled/.test(html), false, 'an unknown count can still be used');
      hovers.push(full);
    }
    // Each reason has its own words; only two pairs share them: an answer without a count (unsupported or ready) and an unnamed or absent reason.
    assert.equal(new Set(hovers).size, cases.length - 2);
  }
  // Without a background answer, a count the screen once said still shows.
  assert.match(usageMarkup('zh', { agent: 'codex', agentUsage: { limits: [], resets: { left: 2, total: null } } }), /<small>剩余 2 次<\/small>/);
  // Only a subscription has limit resets: a Codex on the API, or not connected, has no reset row.
  for (const kind of ['api', 'none', 'unknown']) assert.doesNotMatch(usageMarkup('zh', { agent: 'codex', agentUsage: { limits: [], resets: { left: 2, total: null } } }, { codex: kind }), /activity-estop|重置额度/);
  // Nor does the other agent's section, which cannot type into the session in view.
  assert.doesNotMatch(usageMarkup('zh', { agent: 'claude', agentUsage: { limits: [] } }), /activity-estop|重置额度/);
  for (const [, , , zh, english] of cases) for (const [key, value] of [[zh[0], english[0]], [zh[1], english[1]]]) assert.equal(en[key], value, key);
  for (const [key, value] of Object.entries({ '没有剩余重置次数，此行不可点击': 'No resets remain; this row is disabled.', '点击后开始 10 秒倒计时，期间可取消；结束后打开 {agent} 的 /usage，由你选择并确认重置': click.en.replace('Codex', '{agent}') })) assert.equal(en[key], value, key);
  for (const gone of ['尚未查询', '还没有查询过这个账号的重置次数', '正在查询剩余次数…', '点击后有 10 秒可以取消，然后由 {agent} 自己完成重置']) assert.ok(!(gone in en), `${gone} is no longer used`);
});

test('the lead shows the current prompt while Codex usage lists its channel, limit bars and reset controls in order', () => {
  const terminal = { agent: 'codex', codexActivity: 'working',
    prompts: [{ id: 'work', text: 'Continue responding while usage hangs', summary: 'Continue responding while usage hangs', state: 'working' }],
    agentUsage: { provider: 'OpenAI', context: { used: 25000, window: 100000 }, limits: [{ minutes: 300, percent: 60 }], resets: { left: 2 }, resetQuery: { state: 'ready' }, calls: [{ agent: 'Codex', provider: 'OpenAI', model: 'gpt-6.1-sol', effort: null, fast: null, preparing: 0, running: 1, reviewing: 0, tasks: [], items: [{ state: 'running', role: '执行', title: 'one' }] }] },
  };
  const html = mainMarkup([], 'zh', terminal);
  assert.match(/<section class="activity-card activity-main agent-team-group"[\s\S]*?<\/section>/.exec(html)[0], /Continue responding while usage hangs/);
  assert.doesNotMatch(html, /activity-calls|activity-context|activity-usage|activity-gauges|activity-tasks|正在处理的任务|activity-progress/, 'the called models and the figures are not blocks of the pane');
  const codex = agentSection(usageMarkup('zh', terminal), 'Codex');
  const positions = ['<dt>通道</dt>', '5 小时额度', 'activity-estop'].map(name => codex.indexOf(name));
  assert.ok(positions.every((position, i) => position >= 0 && (!i || position > positions[i - 1])), 'the channel, then the limit bars, then the reset controls');
  assert.match(codex, /剩余 2 次/); assert.doesNotMatch(codex, /上下文长度|aria-valuenow="25"/); assert.match(codex, /aria-valuenow="60"/);
  assert.match(html, /class="loading-spinner"/);
  const css = readCss('src/features/agents/activity-pane.css');
  const removed = /activity-progress|activity-tasks|activity-prompts|activity-prompt-state|activity-task-quiet|activity-gauges|activity-count/;
  assert.deepEqual(css.blocks.filter(({ selector }) => removed.test(selector)), []);
});

test('the inactive pane shows its usage and routing hint; only the sidebar lists can scroll', () => {
  const html = rightMarkup({ cliActive: false }, 'en');
  assert.ok(html.includes('class="activity-empty"') && html.includes('model route and usage here'));
  assert.doesNotMatch(html, /activity-main|activity-calls|activity-tasks|No task yet/);
  const css = readCss('src/features/agents/activity-pane.css');
  // Expanded tasks and called model groups can scroll in the sidebar.
  const pane = css.rule('.activity-pane');
  assert.equal(pane.overflow, 'hidden');
  assert.notEqual(pane['overflow-y'], 'auto');
  assert.equal(pane['scrollbar-width'], undefined);
  assertRule(css, '.activity-main:has([data-expanded])', { flex: '0 1 auto', 'min-height': '0' });
  for (const selector of ['.api-agents', '.activity-routing-rows']) {
    const properties = Object.keys(css.rule(selector));
    assert.deepEqual(properties.filter(property => property.startsWith('overflow') || property === 'max-height'), [], selector);
  }
  assertRule(css, '.activity-calls', { flex: '0 1 auto', 'min-height': '0' }, 'the called models take what the left bar gives and their list scrolls');
  assert.deepEqual(css.declarations.filter(({ property }) => property === 'max-height'), []);
  assertRule(css, '.activity-main > .activity-call-rows, .activity-call-groups', {
    'scrollbar-gutter': 'stable', margin: '0 -8px', padding: '0 8px',
  });
  const selector = '.activity-main > .activity-main-tasks[data-expanded], .activity-call-groups';
  assertRule(css, selector, {
    flex: '0 1 auto', 'min-height': '0', 'overflow-y': 'auto', 'animation-timeline': 'scroll(self)',
  });
  assert.ok(Object.hasOwn(css.rule(selector), 'mask-image'));
  assert.ok(css.atRules.includes('@keyframes activity-fade'));
  assertRule(css, '.activity-call-rows li p', { overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' });
});

test('the main card lists the prompts: the working one with its spinner and clock, the step under it, those waiting after, each row the summary with the whole text in its hover', () => {
  const now = Date.now(), original = 'Please fix the button.\n<pasted_content id="1">Synthetic hidden details.</pasted_content>';
  const prompts = [{ id: 'a', text: original, summary: 'Please fix the button.', state: 'working', at: now - 134000 },
    { id: 'b', text: 'A real queued request.', summary: 'Queued request.', state: 'queued', at: now - 12000 }, { id: 'c', text: 'no start', summary: '（代码）', state: 'queued' }];
  const edit = { kind: 'edit', tool: 'Edit', target: 'src/App.tsx', detail: '', done: false };
  const main = html => /<section class="activity-card activity-main agent-team-group"[\s\S]*?<\/section>/.exec(html)[0];
  const rows = html => [...main(html).matchAll(/<li class="(is-[a-z]+(?: [^"]*)?|activity-call-[a-z]+)"[^>]*>/g)].map(match => match[1]);
  const html = main(mainMarkup([], 'zh', { codexActivity: 'working', prompts, action: edit }));
  assert.deepEqual(rows(html), ['activity-call-head', 'is-working', 'is-step', 'is-queued', 'is-queued'], 'head, the working prompt, its step, then the waiting ones');
  assert.ok(html.includes('<li class="is-working" title="Please fix the button.\n&lt;pasted_content id=&quot;1&quot;&gt;Synthetic hidden details.&lt;/pasted_content&gt;\n处理中 · 2:1'), 'the whole text in the hover, with the state and clock');
  assert.match(html, /<span class="activity-call-role">处理中<\/span>Please fix the button\.<\/p><time>2:1\d<\/time>/);
  assert.match(html, /<li class="is-queued" title="A real queued request\.\n排队中 · 0:1\d">[\s\S]*?<span class="activity-call-role">排队中<\/span>Queued request\.<\/p><time>0:1\d<\/time>/);
  assert.ok(html.includes('title="no start\n排队中"') && html.includes('<p><span class="activity-call-role">排队中</span>（代码）</p><time></time>'), 'a prompt with no start shows no clock');
  assert.doesNotMatch(html.replace(/title="[^"]*"/g, ''), /pasted_content|Synthetic hidden details/);
  assert.match(html, /<li class="is-step" title="src\/App\.tsx">[\s\S]*?<span class="activity-call-role">正在<\/span>修改 App\.tsx<\/p>/);
  assert.ok(html.indexOf('is-working') < html.indexOf('is-step') && html.indexOf('is-step') < html.indexOf('is-queued'), 'the step is under the working prompt');
  const command = main(mainMarkup([], 'zh', { codexActivity: 'working', prompts: [{ id: 'command', text: '<command-name>/model</command-name>', summary: '/model', state: 'working' }] }));
  assert.match(command, /<\/span>\/model<\/p>/); assert.doesNotMatch(command.replace(/title="[^"]*"/g, ''), /command-name/);
  const english = main(mainMarkup([], 'en', { codexActivity: 'working', prompts }));
  assert.ok(english.includes(`>${en['处理中']}<`) && english.includes(`>${en['排队中']}<`));
});

test('with no prompt the main card says the agent state in words and invents no task; the finished prompt shows only for the round it belongs to', () => {
  const now = Date.now(), prompt = { id: 'p', text: 'Fix <the> bug in the parser.', summary: 'Fix the parser bug.', state: 'working', at: now - 5000 };
  const main = html => /<section class="activity-card activity-main agent-team-group"[\s\S]*?<\/section>/.exec(html)[0], tasks = html => main(html).slice(main(html).indexOf('activity-main-tasks'));
  const render = (terminal, language = 'zh') => main(mainMarkup([], language, { id: 'finished-case', sessionId: 's1', task: 'RESULT SUMMARY', taskTitle: 'RESULT TITLE', ...terminal }));
  // Nothing tracked: the state in words, and not the result summary the card header's status may carry.
  for (const [codexActivity, word] of [['working', '正在处理'], ['complete', '本轮已完成'], ['interrupted', '已中断']]) {
    const html = tasks(render({ id: 'none', codexActivity }));
    assert.match(html, new RegExp('<li class="is-' + (codexActivity === 'working' ? 'working' : 'idle') + '"[^>]*>[\\s\\S]*?<p>' + word + '</p>'));
    assert.doesNotMatch(html, /RESULT|<time>[^<]+/);
    assert.match(html, new RegExp('data-icon="' + (codexActivity === 'working' ? 'CircleNotch' : 'Circle') + '"'));
  }
  // An agent with no round yet shows only its model: no idle row with nothing to say.
  assert.doesNotMatch(tasks(render({ id: 'none', codexActivity: 'unknown' })), /<li|等待下一步/);
  // A working round with its prompt is remembered; when the round ends the same prompt stays as the finished row.
  render({ codexActivity: 'working', prompts: [prompt] });
  const done = tasks(render({ codexActivity: 'complete', prompts: [], lastCompletedAt: now }));
  assert.match(done, /<li class="is-done" title="Fix &lt;the&gt; bug in the parser\.\n本轮已完成 · \d\d:\d\d">[\s\S]*?<span class="activity-call-role">本轮已完成<\/span>Fix the parser bug\.<\/p><time>\d\d:\d\d<\/time>/);
  assert.doesNotMatch(done, /RESULT/, 'the result summary is not the task');
  assert.match(tasks(render({ codexActivity: 'interrupted', prompts: [] })), /<li class="is-idle" title="Fix &lt;the&gt; bug in the parser\.\n已中断">[\s\S]*?<span class="activity-call-role">已中断<\/span>Fix the parser bug\.<\/p><time><\/time>/);
  // Another session of the same terminal never shows it, and a round without a prompt of its own (a background notification) forgets it.
  assert.doesNotMatch(tasks(render({ codexActivity: 'complete', prompts: [], sessionId: 's2' })), /parser bug/);
  render({ codexActivity: 'working', prompts: [] });
  assert.doesNotMatch(tasks(render({ codexActivity: 'complete', prompts: [], lastCompletedAt: now })), /parser bug|is-done/, 'no stale task after a round that had none');
});

test('each task row is on the 32px grid: its state icon, the role word and the task on one line, a clock at the right', () => {
  const css = readCss('src/features/agents/activity-pane.css');
  assertRule(css, '.activity-call-rows li', { 'grid-template-columns': '16px minmax(0, 1fr) auto', 'column-gap': '8px', height: '32px' });
  assertRule(css, '.activity-call-rows li::before', { content: "''", position: 'absolute', inset: '0 -8px', 'border-radius': '8px' }, 'the hover reaches 8px past the text');
  assertRule(css, '.activity-call-rows li p', { 'text-overflow': 'ellipsis', 'white-space': 'nowrap' });
  assertRule(css, '.activity-call-rows li :is(time, .activity-row-end)', {
    'font-size': '12px', color: 'var(--flow-faint)', 'font-variant-numeric': 'tabular-nums',
  });
  assertRule(css, '.activity-call-rows li:is(.is-running, .is-working) .activity-row-icon', { color: 'var(--running)' }, 'the spinner is the one colour');
  assertRule(css, '.activity-call-rows li.is-done .activity-row-icon', { color: 'var(--success)' });
  assertRule(css, '.activity-call-rows li.is-step p', { color: 'var(--flow-faint)' }, 'the step is quieter');
});

test('the main card shows the parent review source, clock and step before queued prompts, and ends with the parent', t => {
  const now = new Date(2030, 4, 5, 12).getTime(), at = now - 65000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const background = { text: 'Parser worker completed verification.', summary: 'Parser verification completed', count: 2, at };
  const action = { kind: 'read', tool: 'Read', target: 'report.txt', detail: '', done: false };
  const prompts = [{ id: 'q', text: 'Next human request', summary: 'Next human request', state: 'queued', at: at + 60000 }];
  const main = (state, extra = {}, language = 'zh') => /<section class="activity-card activity-main agent-team-group"[\s\S]*?<\/section>/.exec(mainMarkup([], language,
    { id: 'background-round', sessionId: 'session', codexActivity: 'working', mainTurn: { state, background }, action, prompts, ...extra }))[0];
  const running = main('working');
  assert.match(running, /<li class="is-working"[^>]*>[\s\S]*?class="loading-spinner" data-icon="CircleNotch"[\s\S]*?<p>处理后台结果：Parser verification completed 等 2 项<\/p><time>1:0\d<\/time>/);
  assert.ok(running.indexOf('is-working') < running.indexOf('is-step') && running.indexOf('is-step') < running.indexOf('is-queued'));
  assert.equal((running.match(/class="is-step"/g) || []).length, 1);
  const done = main('complete', { prompts: [], lastCompletedAt: at - 3600000, mainTurn: { state: 'complete', updatedAt: at, background } });
  assert.match(done, /class="is-done"[\s\S]*?data-icon="CheckCircle"[\s\S]*?本轮已完成/);
  assert.doesNotMatch(done, /loading-spinner|is-step|is-working/);
  const endedClock = new Date(at).toTimeString().slice(0, 5);
  assert.ok(done.includes(`<time>${endedClock}</time>`), 'the clock is this main round, not a previous project completion');
  const interrupted = main('interrupted', { prompts: [] });
  assert.match(interrupted, /已中断/); assert.doesNotMatch(interrupted, /loading-spinner|is-step|is-working/);
  const waiting = main('complete', { mainTurn: { state: 'complete', background: null }, prompts: [], id: 'main-waits-for-worker' });
  assert.match(waiting, /本轮已完成/); assert.doesNotMatch(waiting, /正在处理|loading-spinner|is-step/);
  const english = main('working', {}, 'en');
  assert.match(english, /Reviewing background result: Parser verification completed and others \(2 total\)/);
});

test('a working main round without a known task spins with its current step, including while a human request is queued', () => {
  const action = { kind: 'edit', tool: 'Edit', target: 'parser.ts', detail: 'Update parser', done: false };
  const main = extra => /<section class="activity-card activity-main agent-team-group"[\s\S]*?<\/section>/.exec(mainMarkup([], 'zh',
    { id: 'unknown-main-task', sessionId: 'session', codexActivity: 'working', action, ...extra }))[0];
  for (const prompts of [[], [{ id: 'q', text: 'Next request', summary: 'Next request', state: 'queued', at: Date.now() }]]) {
    const html = main({ prompts });
    assert.match(html, /class="is-working"[^>]*>[\s\S]*?class="loading-spinner" data-icon="CircleNotch"[\s\S]*?正在<\/span>修改 parser.ts/);
    assert.doesNotMatch(html, /class="is-idle"|class="is-step"/);
  }
  const noStep = main({ action: { ...action, done: true } });
  assert.match(noStep, /data-icon="CircleNotch"[\s\S]*?<p>正在处理<\/p>/);
  assert.doesNotMatch(noStep, /parser.ts|data-icon="Circle"/);
});

test('the clock reads m:ss and h:mm:ss', () => {
  const { elapsedClock } = require('../src/shared/elapsed-clock.ts');
  assert.deepEqual([0, 999, 9000, 134000, 3600000, 3909000, -5].map(elapsedClock), ['0:00', '0:00', '0:09', '2:14', '1:00:00', '1:05:09', '0:00']);
});

test('metrics are label | meter | figure blocks: one number format, a warning colour only from 90% and 未知 for an unknown allowance', () => {
  const metric = html => /<div class="activity-metric[^"]*"[^>]*>[\s\S]*?<\/div>/.exec(html)[0];
  const at = percent => agentSection(usageMarkup('zh', { agentUsage: { limits: [{ minutes: 300, percent, resetsAt: null }], limitsAt: 1,
    round: { input: 186000, cached: 0, output: 2000 }, total: { input: 2300000, cached: 0, output: 80000 } } }), 'Claude');
  assert.doesNotMatch(metric(at(89.4)), /is-warn/);
  assert.match(metric(at(90)), /activity-metric is-warn activity-limit/);
  const full = at(93);
  assert.ok(/<div class="activity-metric is-warn activity-limit"[^>]*><span class="activity-metric-label">5 小时额度<\/span><span class="activity-meter"/.test(full), 'the title is the label of the meter line, with no separate heading');
  assert.ok(full.includes('>93%<'));
  const tokenRows = [...full.matchAll(/<div class="activity-metric activity-tokens"[^>]*>[\s\S]*?<\/div>/g)].map(match => match[0]).filter(row => /本轮|本次对话/.test(row));
  assert.equal(tokenRows.length, 2);
  for (const row of tokenRows) assert.doesNotMatch(row, /<b|role="meter"/, 'a token row is its label and its breakdown on one line: no total, no meter');
  assert.ok(tokenRows[0].endsWith('<span class="activity-metric-label">本轮</span><small>输入 186k · 输出 2k</small></div>'));
  assert.ok(tokenRows[1].endsWith('<span class="activity-metric-label">本次对话</span><small>输入 2.3M · 输出 80k</small></div>'));
  const unknown = agentSection(usageMarkup('zh', { agentUsage: { limits: [{ minutes: 300, percent: null, resetsAt: null }], limitsAt: 1, round: null, total: null } }), 'Claude');
  assert.ok(unknown.includes('>未知</b>'));
  assert.doesNotMatch(unknown, /0%|role="meter"/);
  const css = readCss('src/features/agents/activity-pane.css');
  assertRule(css, '.activity-metric', { 'grid-template-columns': '88px minmax(0, 1fr) 48px', 'grid-template-rows': '32px' });
  assertRule(css, '.activity-metric.activity-tokens > small', { 'grid-area': '1 / 2 / auto / -1' }, 'the breakdown starts in the meters column, on the label line');
  assertRule(css, '.activity-metric.is-warn > b', { color: 'var(--warning)' });
  assertRule(css, '.activity-metric.is-warn .activity-meter i', { background: 'var(--warning)' });
  // Compact bar rows leave room for the routing key below both accounts.
  assertRule(css, '.api-agent .activity-metrics', { gap: '2px' });
  assertRule(css, '.api-agent .activity-metric', { 'grid-template-rows': '20px' });
  assert.doesNotMatch(full, /<h4[^>]*>用量<\/h4>|上下文长度/);
  assert.ok(full.indexOf('5 小时额度') < full.indexOf('>本轮<') && full.indexOf('>本轮<') < full.indexOf('>本次对话<'), 'the bars first, then this round, then this conversation');
});

test('the reset action is a 32px row on the task grid and keeps unknown, failed and zero counts apart', () => {
  const render = (resets, resetQuery) => usageMarkup('zh', { agent: 'codex', agentUsage: { limits: [], resets, resetQuery } });
  const row = /<button[^>]*class="activity-reset-row activity-estop"[\s\S]*?<\/button>/.exec(render({ left: 2, total: null }, { state: 'ready' }))[0];
  assert.ok(row.indexOf('activity-row-icon') < row.indexOf('activity-reset-label') && row.indexOf('activity-reset-label') < row.indexOf('<small>剩余 2 次</small>'));
  assert.match(render({ left: 0, total: null }, { state: 'ready' }), /<small>已用完<\/small>/);
  assert.doesNotMatch(/<button[^>]*activity-estop[\s\S]*?<\/button>/.exec(render(null, { state: 'error', reason: 'timeout' }))[0], /剩余/, 'an unknown count is not shown as a number');
  assert.match(/<button[^>]*activity-estop[\s\S]*?<\/button>/.exec(render(null, { state: 'error', reason: 'timeout' }))[0], /<span class="activity-reset-label">重置额度<\/span><small>查询失败<\/small>/, 'the status is on the row itself');
  const css = readCss('src/features/agents/activity-pane.css');
  assertRule(css, '.activity-reset-row', { 'grid-template-columns': '16px max-content minmax(0, 1fr)', 'column-gap': '8px', height: '32px' });
  const label = css.rule('.activity-reset-label');
  assert.equal(label['white-space'], 'nowrap', 'the label is never cut');
  assert.equal(label['text-overflow'], undefined);
  assertRule(css, '.activity-reset-row small', {
    'text-align': 'right', 'text-overflow': 'ellipsis', 'font-size': '12px', 'white-space': 'nowrap',
  }, 'the slot is right-aligned like the other figures and gives way first');
  assertRule(css, '.activity-reset > .activity-note', { 'padding-left': '24px' }, 'a note after a run starts under the label');
});

test('the reset countdown is one large overlay: a draining ring with the seconds, its text, cancel and the hint, warning only in the last seconds, with no per-second announcement', t => {
  const previous = globalThis.document; globalThis.document = { body: {} };
  t.after(() => { if (previous) globalThis.document = previous; else delete globalThis.document; });
  const { CountdownView, ResetCountdown } = loadAgentsFile('ResetCountdown.tsx');
  const view = count => renderToStaticMarkup(React.createElement(CountdownView, { count, total: 10, armed: false, announcement: '', onCancel() {} }));
  const html = view(7);
  assert.match(html, /role="timer" aria-label="7 秒后重置额度"/);
  assert.match(html, /<span class="reset-countdown-number">7<\/span><span class="reset-countdown-unit">秒<\/span>/);
  for (const text of ['秒后重置 Codex 额度', '取消', '<kbd>Esc</kbd>', '或点击空白处取消']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /is-warning|立即重置|<ol|<li/, 'only the ring, the text, cancel and the hint');
  assert.doesNotMatch(view(4), /is-warning/); assert.match(view(3), /is-warning/); assert.match(view(1), /is-warning/);
  // The ring is full at 10 and drains to the next second's share: --ring-now is where this second starts, --ring-next where it ends.
  const circumference = 2 * Math.PI * 100, [now, next] = /--ring-now:([\d.]+);--ring-next:([\d.]+)/.exec(html).slice(1).map(Number);
  assert.ok(Math.abs(now - circumference * 0.3) < 0.01 && Math.abs(next - circumference * 0.4) < 0.01);
  // Only the start and 5 seconds are announced.
  const announced = (count, language) => /<span class="reset-countdown-announce" role="status">([^<]*)<\/span>/.exec(renderToStaticMarkup(React.createElement(loadAgentsFile('ResetCountdown.tsx', language).ResetCountdown, { count, total: 10, onCancel() {} })))[1];
  assert.deepEqual([10, 9, 6, 5, 4, 1].map(count => announced(count, 'zh')), ['10 秒后重置额度', '', '', '还剩 5 秒', '', '']);
  assert.deepEqual([10, 5, 4].map(count => announced(count, 'en')), ['Resetting the limit in 10 s', '5 seconds left', '']);
  assert.ok(typeof ResetCountdown === 'function');
  for (const key of ['秒', '秒后重置 Codex 额度', '或点击空白处取消', '还剩 {seconds} 秒', '倒计时中…']) assert.ok(en[key], key);
  const css = readCss('src/features/agents/reset-countdown.css');
  assertRule(css, '.reset-countdown', {
    position: 'fixed', inset: '0', 'z-index': '400', background: 'color-mix(in srgb, var(--bg-app) 72%, transparent)', '-webkit-app-region': 'no-drag',
  }, 'over the whole window, title bar included, at 72% of the canvas colour');
  assertRule(css, '.reset-countdown-ring', { width: '240px', height: '240px' });
  assert.match(css.rule('.reset-countdown-number').font, /^600 104px\b/);
  assertRule(css, '.reset-countdown-cancel', { height: '32px' });
  assertRule(css, '.reset-countdown.is-warning .reset-countdown-ring', { '--ring-ink': 'var(--warning)' });
  assertRule(css, '.reset-countdown-arc', { transition: 'stroke-dashoffset 1s linear' });
  const draining = '.reset-countdown.is-draining .reset-countdown-arc';
  assertRule(css, `:root[data-motion="off"] ${draining}`, { 'stroke-dashoffset': 'var(--ring-now)' }, 'without motion the ring steps with the number');
  const reduced = css.rule(`:root[data-motion="system"] ${draining}`, '@media (prefers-reduced-motion: reduce)');
  assert.equal(reduced['stroke-dashoffset'], 'var(--ring-now)');
  assert.deepEqual(css.atRules.filter(rule => /keyframes|bounce/.test(rule)), []);
  assert.deepEqual(css.declarations.filter(({ property, value }) => property.includes('animation') || /bounce|scale\(/.test(value)), []);
});

test('the reset row stays the trigger: it never turns into a countdown row, and the old row countdown is gone', t => {
  const html = usageMarkup('zh', { agent: 'codex', agentUsage: { limits: [], resets: { left: 2, total: null }, resetQuery: { state: 'ready' } } });
  assert.match(html, /<button type="button" class="activity-reset-row activity-estop" title="点击后开始 10 秒倒计时，期间可取消；结束后打开 Codex 的 \/usage，由你选择并确认重置"><span class="activity-row-icon">[\s\S]*?<\/span><span class="activity-reset-label">重置额度<\/span><small>剩余 2 次<\/small><\/button>/);
  assert.doesNotMatch(html, /reset-countdown|role="timer"|倒计时中/, 'nothing counts before the click');
  const view = quotaView(t);
  view.row().props.onClick();
  const row = view.row().props;
  assert.equal(row.className, 'activity-reset-row activity-estop');
  assert.equal(row.children.at(-1).props.children, '倒计时中…');
  assert.equal(row.disabled, true);
  assert.equal(row.title, '倒计时进行中，可点击「取消」、按 Esc 或点击空白处取消');
  assert.deepEqual([view.countdown().props.count, view.countdown().props.total], [10, 10]);
  view.countdown().props.onCancel();
  assert.equal(view.countdown(), undefined);
  assert.equal(view.row().props.disabled, false);
  assert.equal(en['倒计时进行中，可点击「取消」、按 Esc 或点击空白处取消'], 'The countdown is in progress. Cancel it with the button, Esc, or a click outside.');
  const css = readCss('src/features/agents/activity-pane.css');
  assert.deepEqual(css.blocks.filter(({ selector }) => /activity-reset-cancel|is-counting/.test(selector)), []);
  assert.ok(!('{seconds} 秒后重置' in en), 'the old row label is gone from the translations');
});

test('the main model section: the model its latest reply records (the setting only until there is one), its rate, and the step it is on, never borrowed from a prompt or a sub-agent', () => {
  const main = html => /<section class="activity-card activity-main agent-team-group"[\s\S]*?<\/section>/.exec(html)[0];
  const head = html => /<li class="activity-call-head" title="([^"]*)"><span class="activity-row-icon">[\s\S]*?<\/span><p><b>([^<]*)<\/b>/.exec(main(html)).slice(1);
  const usage = extra => ({ provider: 'Anthropic', limits: [], calls: [], ...extra });
  const html = mainMarkup([], 'zh', { agentUsage: usage({ model: 'claude-sonnet-5-5' }) });
  assert.match(html, /<section class="activity-card activity-main agent-team-group" aria-label="主模型"><h4>总指挥<\/h4>/);
  assert.deepEqual(head(html), ['Claude Code / Anthropic / Sonnet 5.5\n设置为 Opus 5.5，实际回复来自 Sonnet 5.5\nxhigh · 普通', 'Sonnet 5.5'], 'the reply wins over the setting, and the tooltip says so');
  assert.deepEqual(head(mainMarkup([], 'zh', { agentUsage: usage({ model: 'claude-opus-5-5' }) })),
    ['Claude Code / Anthropic / Opus 5.5\nxhigh · 普通', 'Opus 5.5'], 'no mismatch remark when they agree');
  assert.deepEqual(head(mainMarkup([], 'zh', { agentUsage: usage({}) })), ['Claude Code / Anthropic / Opus 5.5\nxhigh · 普通', 'Opus 5.5'], 'the setting stands in until a reply records the model');
  const waiting = mainMarkup([], 'zh', { agentSettings: null, agentUsage: usage({}) });
  assert.deepEqual(head(waiting), ['Claude Code / Anthropic', 'Claude Code']); assert.ok(main(waiting).includes('第一次回复后显示模型。'));
  assert.ok(main(html).includes('<span class="activity-call-settings">xhigh · 普通</span>'), 'how it runs, in the head');
  assert.doesNotMatch(main(html), /activity-call-note/, 'the same settings are not repeated below it');
  assert.doesNotMatch(main(html), /activity-call-tag|子代理/, 'the main agent is not a sub-agent');
  // The rate: average output speed; waiting before a finished reply; a dash when the records cannot be read (the tooltip says so).
  const rate = value => /<span class="activity-row-end activity-rate( is-live)?" title="([^"]*)">([^<]*)<\/span>/.exec(main(mainMarkup([], 'zh', { agentUsage: usage({ rate: value }) }))).slice(1);
  assert.deepEqual(rate({ outputTokens: 900, activeMs: 10000, samples: 3, updatedAt: 1, partial: false }), [' is-live', '平均输出速率：最近 3 条回复，共 900 token，用时 10.0 秒', '90 token/s']);
  assert.deepEqual(rate({ outputTokens: 1234, activeMs: 9800, samples: 2, updatedAt: 1, partial: true })[1], '平均输出速率：最近 2 条回复，共 1,234 token，用时 9.8 秒\n（部分记录）');
  assert.deepEqual(rate({ outputTokens: 0, activeMs: 0, samples: 0, updatedAt: 1, partial: false }), [undefined, '还没有完成一条回复，暂时没有速率。', '等待中']);
  assert.deepEqual(rate(null), [undefined, '这个模型的记录在这里读不到，所以没有速率。', '— token/s']);
  assert.deepEqual(rate(undefined), [undefined, '这个模型的记录在这里读不到，所以没有速率。', '— token/s']);
  assert.equal(rate({ outputTokens: 7, activeMs: 3000, samples: 1, updatedAt: 1, partial: false })[2], '2 token/s');
  const english = mainMarkup([], 'en', { agentUsage: usage({ rate: { outputTokens: 900, activeMs: 10000, samples: 3, updatedAt: 1, partial: true } }) });
  assert.ok(english.includes('title="Average output rate over the last 3 replies: 900 tokens in 10.0 s (partial records)"'.replace(' (partial', '\n (partial')));
  assert.ok(main(mainMarkup([], 'en', { agentUsage: usage({}) })).includes('<h4>Orchestrator</h4>'));
});

test('an agy session shows its model and effort in the Orchestrator head; its usage card names the channel and shows no context length, as Codex does', () => {
  const agy = { id: 'placeholder', agent: 'agy', cliActive: true, prompts: [], agentSettings: { model: 'gemini-4-neon', effort: 'high', fast: null },
    agentUsage: { provider: 'Google Antigravity', limits: [], calls: [], model: 'gemini-4-neon', context: { used: 17400, window: 1000000 } } };
  const head = /<li class="activity-call-head" title="([^"]*)">[\s\S]*?<p><b>([^<]*)<\/b><span class="activity-call-settings">([^<]*)<\/span>/.exec(mainMarkup([], 'zh', agy));
  assert.ok(head, 'the Orchestrator head names the model and how it runs');
  assert.deepEqual(head.slice(1), ['Antigravity / Google Antigravity / gemini-4-neon\nhigh', 'gemini-4-neon', 'high']);
  const markup = usageMarkup('zh', agy, { agy: 'subscription' }), section = agentSection(markup, 'Antigravity');
  assert.match(section, /<dt>通道<\/dt><dd><span>原生模式<\/span><\/dd>/);
  assert.doesNotMatch(markup, /上下文长度|17,400|<dt>连接<\/dt>|Antigravity 登录/, 'neither the context length nor the connection row');
});

test('the main model shows Ultracode only when the session reports it is on', () => {
  const markup = ultracode => mainMarkup([], 'zh', { agentSettings: { model: 'opus', effort: 'high', fast: false, ultracode } });
  assert.match(markup(true), /activity-call-settings">high · 普通 · Ultracode<\/span>/);
  for (const inactive of [false, null, undefined]) assert.doesNotMatch(markup(inactive), /Ultracode/);
});

test('the main row shows the step under way and spins only while the agent works; a finished or missing step shows the agent state, never a prompt or a sub-agent title', () => {
  const calls = [{ agent: 'Codex', model: 'gpt-6.1-sol', provider: 'OpenAI', items: [{ state: 'running', role: '执行', title: 'SUB TITLE' }] }];
  const step = (action, codexActivity) => /<section class="activity-card activity-main agent-team-group"[\s\S]*?<\/section>/.exec(mainMarkup(calls, 'zh',
    { action, codexActivity, task: 'RESULT SUMMARY', prompts: [{ id: 'p', text: 'PROMPT TEXT', summary: 'PROMPT TEXT', state: 'working' }] }))[0];
  const edit = { kind: 'edit', tool: 'Edit', target: 'src/features/agents/ActivityPane.tsx', detail: '', done: false };
  const running = step(edit, 'working');
  assert.match(running, /<li class="is-step" title="src\/features\/agents\/ActivityPane\.tsx">[\s\S]*?<span class="activity-call-role">正在<\/span>修改 ActivityPane\.tsx<\/p>/);
  for (const html of [running, step({ ...edit, done: true }, 'working'), step(null, 'working')]) { assert.doesNotMatch(html, /SUB TITLE|RESULT SUMMARY/, 'neither a sub-agent title nor the result summary'); assert.match(html, /PROMPT TEXT/, 'the main task is the queue\'s working prompt'); }
  const finished = step({ ...edit, done: true }, 'working');
  assert.doesNotMatch(finished, /is-step|ActivityPane/, 'a done step is not shown as running');
  assert.doesNotMatch(step(edit, 'complete'), /is-step|ActivityPane/, 'a running step of an agent that is not working is stale');
  assert.match(step(edit, 'complete'), /<li class="is-queued"|<li class="is-working"/);
  assert.equal((step(edit, 'working').match(/<li class="is-step"/g) || []).length, 1); assert.equal((finished.match(/<li class="is-step"/g) || []).length, 0);
  const css = readCss('src/features/agents/activity-pane.css');
  assertRule(css, '.activity-call-rows li .activity-rate', { 'min-width': '80px', 'text-align': 'right' }, 'a fixed column for the rate');
  assert.deepEqual(css.blocks.filter(({ selector }) => selector.includes('activity-route')), [], 'the route chips are gone');
});

test('every group of called models has its own rate and inline effort, its calls exactly as given and is never merged', () => {
  const call = (model, extra = {}) => ({ agent: 'Claude Code', provider: 'Anthropic', model, effort: null, fast: null, preparing: 0, running: 1, reviewing: 0, tasks: [], items: [{ state: 'running', role: '执行', title: `${model} work` }], ...extra });
  const html = mainMarkup([call('claude-opus-5-5', { rate: { outputTokens: 480, activeMs: 10000, samples: 2, updatedAt: 1, partial: false }, effort: 'high' }),
    call('claude-sonnet-5-5'), call('claude-sonnet-5-5', { effort: 'max', fast: true, rate: null })], 'zh', { agentUsage: { provider: 'Anthropic', limits: [], model: 'claude-opus-5-5', calls: [] } });
  const calls = /<section class="activity-card activity-calls"[\s\S]*?<\/section>/.exec(callsMarkup([call('claude-opus-5-5', { rate: { outputTokens: 480, activeMs: 10000, samples: 2, updatedAt: 1, partial: false }, effort: 'high' }),
    call('claude-sonnet-5-5'), call('claude-sonnet-5-5', { effort: 'max', fast: true, rate: null })]))[0];
  assert.ok(html.includes('主模型'));
  assert.doesNotMatch(calls, /activity-call-tag|子代理/, 'the section heading identifies the called models');
  assert.equal((calls.match(/class="activity-call-head"/g) || []).length, 3, 'three groups, none merged');
  assert.deepEqual([...calls.matchAll(/<span class="activity-row-end activity-rate[^"]*" title="[^"]*">([^<]*)<\/span>/g)].map(match => match[1]), ['48 token/s'], 'each group has its own rate, and a group without one shows nothing');
  assert.ok(calls.includes('<span class="activity-call-settings">high</span>') && calls.includes('<span class="activity-call-settings">max · 快速</span>'), 'effort and speed follow the bold model name');
  assert.doesNotMatch(calls, /activity-call-note/, 'settings are never repeated on a separate row');
  assert.deepEqual([...calls.matchAll(/<p>(claude-[a-z0-9-]+ work)<\/p>/g)].map(match => match[1]), ['claude-opus-5-5 work', 'claude-sonnet-5-5 work', 'claude-sonnet-5-5 work'], 'calls as given');
  const css = readCss('src/features/agents/activity-pane.css');
  assertRule(css, '.activity-call-head p > .activity-call-provider', { flex: '0 100 auto' }, 'the service gives way first');
  assert.deepEqual(css.blocks.filter(({ selector }) => selector.includes('activity-call-tag')), []);
});

test('a dispatched worker that has not reported its model shows the requested one as unconfirmed, or 模型未确认, never the placeholder, until it reports', t => {
  const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
  const calls = new AgentCalls({ local: false }); t.after(() => calls.reset());
  const start = (id, extra = {}) => ({ type: 'dispatch-start', id, agent: 'codex', role: '执行', title: `Task ${id}`, model: 'unreported', effort: null, fast: null,
    sessionId: `thread-${id}`, startedAt: 1000, ...extra });
  calls.dispatch(start('asked', { requestedModel: 'gpt-6.1-sol' })); calls.dispatch(start('unasked'));
  const heads = html => [...html.matchAll(/<li class="activity-call-head" title="([^"]*)">[\s\S]*?<b>([^<]*)<\/b>/g)].map(match => [match[2], match[1]]);
  assert.deepEqual(heads(callsMarkup(calls.snapshot())), [['GPT-6.1-Sol', 'Codex / GPT-6.1-Sol'], ['模型未确认', 'Codex / 模型未确认']]);
  assert.deepEqual(heads(callsMarkup(calls.snapshot(), 'en')).map(([name]) => name), ['GPT-6.1-Sol', 'Model unconfirmed']);
  for (const language of ['zh', 'en']) assert.doesNotMatch(callsMarkup(calls.snapshot(), language), /unreported/);
  // The worker's report replaces the placeholder in its own group.
  assert.equal(calls.dispatch({ type: 'dispatch-routing', id: 'asked', model: 'gpt-6.1-sol', effort: 'max', fast: true }), true);
  assert.deepEqual(heads(callsMarkup(calls.snapshot())), [['GPT-6.1-Sol', 'Codex / GPT-6.1-Sol\nmax · 快速'], ['模型未确认', 'Codex / 模型未确认']]);
});

test('an agent’s sections follow the connection: a session that reports plan windows is on a plan even when the connection is unknown; otherwise unknown and not connected say 额度 未知 and measure nothing', () => {
  const future = Date.now() + 3600000, own = { limits: [{ minutes: 300, percent: 20, resetsAt: future }], limitsAt: Date.now(), limitsFrom: 'Codex' };
  // Unknown connection, but the session's own windows: the bars show without a source line, and no 额度 未知 row.
  const plan = agentSection(usageMarkup('zh', { agent: 'codex', agentUsage: own }, { codex: 'unknown' }), 'Codex');
  assert.match(plan, /5 小时额度/); assert.doesNotMatch(plan, /额度来自/); assert.doesNotMatch(plan, /<dt>额度<\/dt>/);
  // Without any window, from main or from the session: 额度 未知, and the round (the session's own) is all there is.
  for (const kind of ['unknown', 'none']) {
    const none = agentSection(usageMarkup('zh', { agent: 'codex', agentUsage: { limits: [], context: { used: 100, window: 1000 }, round: { input: 10, cached: 0, output: 1 } } }, { codex: kind }), 'Codex');
    assert.match(none, /<dt>额度<\/dt><dd><span>未知<\/span><\/dd>/); assert.doesNotMatch(none, /5 小时额度|每周额度|API 花费|月预算|activity-estop/);
    assert.match(none, />本轮</, 'the current session still has its round'); assert.doesNotMatch(none, /上下文长度/);
  }
  // The other agent never borrows the session's windows.
  assert.doesNotMatch(agentSection(usageMarkup('zh', { agent: 'codex', agentUsage: own }, { claude: 'unknown' }), 'Claude'), /5 小时额度/);
  // An API connection shows no subscription windows even when the session has some, and has no limit reset.
  const api = agentSection(usageMarkup('zh', { agent: 'codex', agentUsage: own }, { codex: 'api' }), 'Codex');
  assert.doesNotMatch(api, /5 小时额度|activity-estop|API 花费/);
});

test('the session’s own windows win when the screen read them after main did; main’s win otherwise, and neither an API connection nor another agent borrows them', () => {
  const future = Date.now() + 3600000, at = Date.now();
  const main = observedAtMs => ({ state: 'ready', observedAtMs, ordinaryUsageAllowed: true, limitsById: { codex: { primary: { usedPercent: 70, windowDurationMins: 300, resetsAtMs: future } } } });
  const screen = limitsAt => ({ limits: [{ minutes: 300, percent: 20, resetsAt: future }], limitsAt, limitsFrom: 'Codex' });
  const codex = (agentUsage, limits, kind = 'subscription') => agentSection(usageMarkup('zh', { agent: 'codex', agentUsage }, { codex: kind, limits: { codex: limits } }), 'Codex');
  assert.match(codex(screen(at), main(at - 60000)), /20%/, 'the screen read it later than main: the screen’s');
  assert.doesNotMatch(codex(screen(at), main(at - 60000)), /70%/);
  assert.match(codex(screen(at - 60000), main(at)), /70%/, 'main read it later: main’s');
  assert.doesNotMatch(codex(screen(at - 60000), main(at)), /20%/);
  assert.match(codex(screen(at), main(null)), /20%/, 'main says when it read nothing: the screen’s, which has a time');
  assert.match(codex({ ...screen(null), limitsAt: null }, main(at)), /70%/, 'a screen with no time never replaces main');
  assert.match(codex({ limits: [], limitsAt: at }, main(at - 60000)), /70%/, 'a screen with no windows replaces nothing');
  const api = codex(screen(at), main(at - 60000), 'api');
  assert.doesNotMatch(api, /5 小时额度|20%|70%/, 'an API connection shows no subscription windows, whichever is newer');
  assert.doesNotMatch(agentSection(usageMarkup('zh', { agent: 'codex', agentUsage: screen(at) }, { claude: 'subscription', limits: { claude: main(at - 60000) } }), 'Claude'), /20%/, 'the other agent never borrows the session’s windows');
});

test('the activity pane leaves room for routing when agy is absent or has no usage to show', () => {
  for (const options of [{ agy: 'none' }, { agy: 'unknown', installations: { agy: { installed: false } }, limits: { agy: { state: 'unavailable' } } }]) {
    const html = usageMarkup('en', {}, options);
    assert.deepEqual([...html.matchAll(/<section class="api-agent" aria-label="([^"]+)"/g)].map(([, name]) => name), ['Claude', 'Codex']);
  }
});

test('agy lists only the quota group of the models the project runs on it, inline like Claude and Codex, each group named only when several show', () => {
  const window = (windowDurationMins, usedPercent) => ({ windowDurationMins, usedPercent, resetsAtMs: null });
  const agy = { state: 'ready', limitsById: {
    '3p': { primary: window(300, 51), secondary: window(10080, 77) },
    gemini: { primary: window(300, 0), secondary: window(10080, 26) },
  } };
  const values = html => [...html.matchAll(/aria-valuenow="(\d+)"/g)].map(([, percent]) => Number(percent));
  const headings = html => [...html.matchAll(/<h5 class="api-quota-group-title">([^<]+)<\/h5>/g)].map(([, label]) => label);
  for (const [language, gemini, thirdParty] of [['zh', 'Gemini 模型', '第三方模型'], ['en', 'Gemini models', 'Third-party models']]) {
    const labels = language === 'zh' ? ['5 小时额度', '每周额度'] : ['5-hour limit', 'Weekly limit'];
    const section = models => agentSection(usageMarkup(language, {}, { agy: 'subscription', limits: { agy }, models: models && { agy: models } }), 'Antigravity');
    for (const html of [section(['gemini-3.8-flash']), section(['gemini-4-neon', 'agy:gemini-3.8-flash'])]) {
      assert.deepEqual(values(html), [0, 26], 'a Gemini model in use: the Gemini group only');
      assert.deepEqual(headings(html), [], 'one group: no group name, the rows sit in the block as Claude and Codex rows do');
      assert.deepEqual([...html.matchAll(/<span class="activity-metric-label">([^<]+)<\/span>/g)].map(([, label]) => label), labels);
      assert.doesNotMatch(html, /popover|api-quota-trigger|<button/, 'no quota button and no pop-up');
    }
    assert.deepEqual(values(section(['agy:claude-opus-5-5'])), [51, 77], 'a third-party model in use: its group only');
    const both = section(['gemini-3.8-flash', 'agy:claude-opus-5-5']);
    assert.deepEqual(headings(both), [gemini, thirdParty], 'both kinds in use: both groups, each named');
    assert.deepEqual(values(both), [0, 26, 51, 77]);
    assert.deepEqual(headings(section()), [gemini, thirdParty], 'no model of agy known: every reported group, each named');
    const onlyGemini = agentSection(usageMarkup(language, {}, { agy: 'subscription', limits: { agy: { state: 'ready', limitsById: { gemini: agy.limitsById.gemini } } },
      models: { agy: ['agy:claude-opus-5-5'] } }), 'Antigravity');
    assert.deepEqual(headings(onlyGemini), [gemini], 'the group in use was not reported: what was reported keeps its name, so it is not read as that model');
  }
});

test('the models a project runs on each agent: its main sessions by the agent that runs them, and the enabled roles seats with the team on', () => {
  const { modelsInUse } = loadAgentsFile('ApiUsage.tsx');
  const terminals = [
    { id: 'a', cliActive: true, agent: 'agy', agentUsage: { model: 'claude-opus-5-5' } },
    { id: 'b', cliActive: true, agent: 'claude', agentSettings: { model: 'claude-sonnet-5-5' } },
    { id: 'c', cliActive: false, agent: 'agy', agentUsage: { model: 'gemini-4-neon' } },
  ];
  const roles = [{ id: 'orchestrator', enabled: true }, { id: 'frontend', enabled: true }, { id: 'qa', enabled: false }];
  const effective = { orchestrator: { model: 'opus', effort: 'high' }, frontend: { model: 'agy:gemini-3.8-flash', effort: 'low' }, qa: { model: 'gpt-6.2-sol', effort: 'low' } };
  const seats = conductor => ({ conductor, lead: 'orchestrator', roles, effective, current: null });
  assert.deepEqual(modelsInUse(terminals, seats(true)), { agy: ['claude-opus-5-5', 'agy:gemini-3.8-flash'], claude: ['claude-sonnet-5-5', 'opus'] });
  assert.deepEqual(modelsInUse(terminals, seats(false)), { agy: ['claude-opus-5-5'], claude: ['claude-sonnet-5-5'] }, 'with the team off no role runs');
  assert.deepEqual(modelsInUse(terminals, null), { agy: ['claude-opus-5-5'], claude: ['claude-sonnet-5-5'] });
});

test('agy reports unreadable allowance without a zero or a window from any terminal', () => {
  const agy = { state: 'unavailable', limitsById: {} };
  const agentUsage = { limits: [{ minutes: 300, percent: 80 }] };
  for (const [language, message] of [['zh', '暂时读不到 agy 的额度（未登录或版本过低时会这样）。'],
    ['en', 'agy quota is unavailable right now (this happens when agy is signed out or outdated).']]) {
    for (const agent of ['claude', 'agy']) {
      const html = usageMarkup(language, { agent, agentUsage }, { agy: 'unknown', limits: { agy } });
      const section = agentSection(html, 'Antigravity');
      assert.ok(section.includes(message));
      assert.doesNotMatch(section, /role="meter"|\d+%|api-quota-group/);
      if (agent === 'claude') assert.match(agentSection(html, 'Claude'), /aria-valuenow="80"/);
    }
  }
});

test('agy explains unavailable SSH quota using the reason returned by main', () => {
  const reason = '暂时无法读取远端 agy 的额度。';
  for (const [language, message] of [['zh', reason], ['en', 'Unable to read agy quota from the remote host right now.']]) {
    const limits = { agy: { state: 'unavailable', reason, limitsById: {} } };
    const section = agentSection(usageMarkup(language, {}, { agy: 'unknown', limits }), 'Antigravity');
    assert.ok(section.includes(message));
    assert.doesNotMatch(section, /role="meter"|\d+%/);
  }
});

test('the main card tells a round that ended unknown quietly: no check, not complete, not interrupted; a complete one keeps its check', () => {
  const turn = state => ({ cliActive: true, mainTurn: { state, updatedAt: Date.now(), background: null } });
  const main = html => /<section class="activity-card activity-main agent-team-group"[\s\S]*?<\/section>/.exec(html)[0];
  const unknown = main(mainMarkup([], 'zh', turn('unknown'))), complete = main(mainMarkup([], 'zh', turn('complete')));
  assert.match(unknown, /本轮已结束，完成状态未知。/); assert.doesNotMatch(unknown, /本轮已完成|已中断|is-done|data-icon="CheckCircle"/);
  assert.match(complete, /本轮已完成/); assert.doesNotMatch(complete, /完成状态未知/);
  assert.doesNotMatch(main(mainMarkup([], 'zh', { cliActive: true })), /完成状态未知/, 'a session that has not ended a round says nothing of one');
});

test('a ready Claude terminal before its first turn is idle despite unknown completion history', () => {
  for (const codexActivity of ['unknown', 'working']) {
    const cliState = { sessionId: 'pty', state: 'idle', revision: 1, updatedAt: 100, phase: 'ready', turn: 0 };
    const terminal = { sessionId: 'pty', codexActivity, cliState, mainTurn: { state: 'unknown', updatedAt: 100, background: null } };
    const html = mainMarkup([], 'zh', terminal);
    assert.match(html, />已就绪</);
    assert.doesNotMatch(html, /完成状态未知|本轮已完成|正在处理/);
    assert.match(mainMarkup([], 'zh', { ...terminal, mainTurn: null }), />已就绪</);
    assert.match(mainMarkup([], 'zh', { ...terminal, cliState: { ...cliState, turn: 1 } }), /本轮已结束，完成状态未知。/);
  }
});

test('the main card says 失败 for a round that failed (a /compact that compacted nothing), as the conversation’s card does, and 已中断 for a real interruption or another session', () => {
  const main = html => /<section class="activity-card activity-main agent-team-group"[\s\S]*?<\/section>/.exec(html)[0];
  const ended = { cliActive: true, id: 't-ended', nativeRuntimeSessionId: 'rs1', mainTurn: { state: 'interrupted', updatedAt: Date.now(), background: null } };
  const turn = (status, runtimeSessionId = 'rs1') => { nativeTurns.clear(); nativeTurns.set('t-ended', { model: { identity: { runtimeSessionId }, turn: { status } } }); };
  try {
    turn('failed');
    const failed = main(mainMarkup([], 'zh', ended));
    assert.match(failed, /失败/); assert.doesNotMatch(failed, /已中断/);
    turn('interrupted'); assert.match(main(mainMarkup([], 'zh', ended)), /已中断/);
    nativeTurns.clear();
    const bare = main(mainMarkup([], 'zh', ended));
    assert.match(bare, /已中断/); assert.doesNotMatch(bare, /失败/);
    // The native turn failed, then the owner typed `claude` into the same terminal and pressed Esc: that terminal has no native session now (or another one).
    turn('failed');
    for (const typed of [{ ...ended, nativeRuntimeSessionId: null }, { ...ended, nativeRuntimeSessionId: undefined }, { ...ended, nativeRuntimeSessionId: 'rs2' }]) {
      const html = main(mainMarkup([], 'zh', typed));
      assert.match(html, /已中断/); assert.doesNotMatch(html, /失败/, JSON.stringify(typed.nativeRuntimeSessionId));
    }
  } finally { nativeTurns.clear(); }
});

test('activity shows the working prompt and three most recent queued prompts, with an accessible fold', () => {
  const prompts = [{ id: 'working', state: 'working', text: 'Work now', summary: 'Work now', at: 1 },
    ...Array.from({ length: 5 }, (_, n) => ({ id: 'queued-' + n, state: 'queued', text: 'Prompt ' + n, summary: 'Prompt ' + n, at: n + 2 }))];
  const html = mainMarkup([], 'zh', { codexActivity: 'working', prompts });
  const list = /class="activity-call-rows activity-main-tasks"[\s\S]*?<\/ul>/.exec(html)[0];
  assert.match(list, /Work now[\s\S]*Prompt 4[\s\S]*Prompt 3[\s\S]*Prompt 2/);
  assert.doesNotMatch(list, /Prompt [01]/);
  assert.match(list, /aria-expanded="false"[\s\S]*还有 2 条/);
});

// The owner saw a still hammer with Windows' animation effects off, while the app's motion setting (default "smooth")
// keeps animations on: the hammer must follow the app setting, not the OS alone.
test('the working hammer follows the app motion setting, not the Windows reduced-motion switch alone', () => {
  const css = readCss('src/features/agents/activity-pane.css');
  assert.match(css.rule('.activity-routing-hammer').animation, /^activity-routing-strike /);
  assert.equal(css.rule('.activity-routing-hammer', '@media (prefers-reduced-motion: reduce)'), undefined, 'no bare OS rule stops it');
  assert.deepEqual(css.rule(':root[data-motion="system"] .activity-routing-hammer', '@media (prefers-reduced-motion: reduce)'), { animation: 'none' });
});
