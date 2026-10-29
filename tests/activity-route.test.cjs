const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const en = require('../electron/locales/en.json');

// A component of the agents folder compiled with its imports stubbed (the language, the icons, the portal), for static rendering.
const loadedAgentsFiles = new Map();
function loadAgentsFile(basename, language = 'zh') {
  const key = `${basename}:${language}`;
  if (!loadedAgentsFiles.has(key)) loadedAgentsFiles.set(key, compileAgentsFile(basename, language));
  return loadedAgentsFiles.get(key);
}
function compileAgentsFile(basename, language) {
  const filename = path.join(__dirname, '../src/features/agents', basename);
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  mod.require = name => {
    if (name.endsWith('.css')) return {};
    if (name === '../../shared/i18n') return { t: (key, values = {}) => (language === 'en' ? en[key] ?? key : key).replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '') };
    if (name === '../reading/model-name') return require('../src/features/reading/model-name.ts');
    if (name === '../reading/useNow') return require('../src/features/reading/useNow.ts');
    if (name === '../terminal/terminal-screen') return { readScreen: () => null, subscribeScreen: () => () => {} };
    if (name === '../home/send-to-agent') return { sendToAgent: () => { throw new Error('render must not send input'); } };
    if (name === './AgentBrandIcon') return require('../src/features/agents/AgentBrandIcon.ts');
    if (name === './reset-count') return require('../src/features/agents/reset-count.ts');
    if (name === './ResetCountdown') return loadAgentsFile('ResetCountdown.tsx', language);
    if (name === './action-text') return loadAgentsFile('action-text.ts', language);
    if (name === 'react-dom') return { createPortal: children => children };
    if (name === '@phosphor-icons/react') return new Proxy({}, { get: (_, icon) => ({ className }) => React.createElement('svg', { className, 'data-icon': icon }) });
    return original(name);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  return mod.exports;
}
function activityMarkup(calls, language = 'zh', terminal = {}) {
  const { ActivityPane } = loadAgentsFile('ActivityPane.tsx', language);
  return renderToStaticMarkup(React.createElement(ActivityPane, { terminal: {
    id: 'placeholder', agent: 'claude', codexActive: true, prompts: [], agentSettings: { model: 'claude-opus-5-5', effort: 'xhigh', fast: false },
    agentUsage: { provider: 'Anthropic', limits: [], calls },
    ...terminal,
  } }));
}

test('the models group hides empty calls and lists each model with its calls, their states and the how-it-runs in both languages', () => {
  const empty = activityMarkup([]);
  assert.ok(empty.includes('Opus 5.5'));
  assert.ok(!empty.includes('调用的模型'));
  assert.ok(!activityMarkup(undefined).includes('activity-calls'));
  const calls = [
    { agent: 'Claude Code', provider: 'Anthropic', model: 'claude-sonnet-5-5', effort: null, fast: null, preparing: 0, running: 1, reviewing: 1, tasks: [], items: [{ state: 'running', role: '执行', title: 'Polish <card>' }, { state: 'reviewing', role: '审核', title: 'Check spacing' }] },
    { agent: 'Codex', provider: 'OpenAI', model: 'gpt-6.1-sol', effort: 'max', fast: true, preparing: 1, running: 2, reviewing: 0, tasks: [], items: [{ state: 'preparing', role: '准备', title: 'parser.md' }, { state: 'running', role: '执行', title: 'one' }, { state: 'running', role: '执行', title: 'two' }] },
  ];
  const html = activityMarkup(calls);
  const section = /<section class="activity-card activity-calls"[\s\S]*?<\/section>/.exec(html)[0], plain = section.replace(/<[^>]*>/g, '|');
  for (const text of ['调用的模型', 'Sonnet 5.5', 'GPT-6.1-Sol', 'max · 快速', '运行中', '审核中', '准备中']) assert.ok(plain.includes(text), text);
  assert.doesNotMatch(plain, /Anthropic|OpenAI|子代理/);
  assert.match(section, /title="Claude Code \/ Anthropic \/ Sonnet 5\.5"/);
  assert.match(section, /title="Codex \/ OpenAI \/ GPT-6\.1-Sol\nmax · 快速"/);
  assert.ok(section.includes('<span class="activity-count">5</span>'), 'the heading counts every call');
  assert.ok(html.indexOf('activity-main"') < html.indexOf('activity-calls"') && html.indexOf('activity-calls"') < html.indexOf('activity-context"'), 'the main model (with its task), the sub-agents, then context and usage');
  assert.ok(section.includes('title="Polish &lt;card&gt;"'));
  assert.match(section, /agent-brand-claude/); assert.match(section, /agent-brand-codex/);
  for (const [state, count] of [['preparing', 1], ['running', 3], ['reviewing', 1]]) assert.equal((section.match(new RegExp(`<li class="is-${state}"`, 'g')) || []).length, count);
  const english = activityMarkup(calls, 'en').replace(/<[^>]*>/g, '|');
  for (const text of ['Models called', 'Running', 'Reviewing', 'Preparing', 'max · Fast']) assert.ok(english.includes(text), text);
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
    const html = activityMarkup([call], language, { agent, agentSettings: { model }, agentUsage: { provider, model, rate, limits: [], calls: [call] } });
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
    const html = activityMarkup([call], language, { agent, agentSettings: { model, effort, fast }, agentUsage: { model, provider: null, calls: [call], limits: [] } });
    const how = [effort === 'default' ? language === 'en' ? 'default' : '默认' : effort,
      fast == null ? null : fast ? language === 'en' ? 'Fast' : '快速' : language === 'en' ? 'standard mode' : '普通模式'].filter(Boolean).join(' · ');
    const heads = [...html.matchAll(/<li class="activity-call-head" title="([^"]*)">([\s\S]*?)<\/li>/g)];
    assert.equal(heads.length, 2);
    for (const [, title, content] of heads) {
      assert.equal(title, `${label} / ${name}${how ? '\n' + how : ''}`);
      assert.ok(content.includes(`<p><b>${name}</b>${how ? `<span class="activity-call-settings"> · ${how}</span>` : ''}</p>`));
    }
    assert.doesNotMatch(html, /activity-call-note|Runs with its default settings|按默认设置运行/, 'known model heads have no duplicate note or invented default mode');
  }
});

test('340px heads reserve the rate column and truncate secondary settings before they can overflow', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/features/agents/activity-pane.css'), 'utf8');
  assert.match(css, /\.activity-call-rows li\.activity-call-head \{ grid-template-columns: 16px minmax\(0, 1fr\) 80px; \}/);
  assert.match(css, /\.activity-call-rows li\.activity-call-head p \{[^}]*display: flex;[^}]*min-width: 0;/);
  assert.match(css, /\.activity-call-head p > \* \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
  assert.match(css, /\.activity-call-head p > b \{ flex: 0 1 auto; \}/);
  assert.match(css, /\.activity-call-head p > \.activity-call-settings \{ flex: 0 2 auto; \}/);
  assert.match(css, /\.activity-call-settings \{ font-size: 12px; font-weight: 400; color: var\(--flow-muted\); \}/);
  assert.match(css, /\.activity-call-head p b \{ font-weight: 600; \}/);
});

test('a single preparing or reviewing call shows its own state and reviewed routes disappear', () => {
  for (const [state, word] of [['preparing', 'Preparing'], ['reviewing', 'Reviewing']]) {
    const html = activityMarkup([{ agent: 'Codex', model: 'gpt-6.1-sol', provider: null, effort: null, fast: null, preparing: 0, running: 0, reviewing: 0, [state]: 1, tasks: [], items: [{ state, role: '执行', title: 'one task' }] }], 'en');
    assert.match(html, new RegExp(`<li class="is-${state}"`));
    assert.ok(html.replace(/<[^>]*>/g, '|').includes(word));
    assert.doesNotMatch(html, /class="is-running"/);
  }
  const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
  const calls = new AgentCalls();
  calls.apply({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id: 'a', input: { model: 'sonnet', effort: 'high', description: 'Check layout' } }] } });
  const called = /<section class="activity-card activity-calls"[\s\S]*?<\/section>/.exec(activityMarkup(calls.snapshot()))[0];
  assert.match(called, /<span class="activity-call-settings"> · high<\/span>/, 'the Agent tool’s effort reaches the rendered model head');
  assert.doesNotMatch(called, /普通模式|快速|activity-call-note/, 'neither speed nor a duplicate note is inferred');
  calls.apply({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'Checked' }] } });
  assert.match(activityMarkup(calls.snapshot()), /class="is-reviewing"/);
  calls.apply({ type: 'system', subtype: 'stop_hook_summary', hookCount: 1 });
  assert.doesNotMatch(activityMarkup(calls.snapshot()), /activity-calls|Check layout|调用的模型/);
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
    const html = activityMarkup([call], language);
    const rows = /<section class="activity-card activity-calls"[\s\S]*?<ul class="activity-call-rows">([\s\S]*?)<\/ul>/.exec(html)[1];
    const plain = rows.replace(/<[^>]*>/g, ' ');
    assert.equal((rows.match(/<li class="is-/g) || []).length, 4);
    assert.ok(rows.includes(`title="${long.replace('<parser>', '&lt;parser&gt;')}"`));
    assert.ok(plain.indexOf('Inspect') < plain.indexOf('Implement parser'));
    assert.ok(plain.indexOf('Implement parser') < plain.indexOf('Plan the checks'));
    assert.ok(plain.indexOf('Plan the checks') < plain.indexOf('Custom task'));
    for (const role of language === 'en' ? ['Investigate', 'Execute', 'Plan', 'custom-worker'] : ['调查', '执行', '规划', 'custom-worker']) assert.ok(plain.includes(role));
    for (const state of ['preparing', 'running', 'reviewing']) assert.ok(rows.includes(`<li class="is-${state}"`));
    assert.ok(plain.includes(language === 'en' ? '+2 more' : '+2 个'));
    assert.doesNotMatch(plain, /Older task|Oldest task/);
    assert.doesNotMatch(activityMarkup([{ ...call, items: items.slice(0, 4) }], language), /activity-call-more/);
    assert.ok(html.includes('<span class="activity-count">6</span>'), 'the heading counts the calls, shown or folded');
    for (const [role, translated] of [['搜索', 'Search'], ['通用', 'General'], ['分身', 'Fork']]) assert.ok(activityMarkup([{ ...call, items: [{ ...items[0], role }] }], 'en').includes(`>${translated}<`));
  }
});

test("Claude's usage keeps plan limits, tokens and their source without reset controls or text", () => {
  const now = Date.now();
  for (const language of ['zh', 'en']) {
    for (const [source, percent] of [['Claude Code', 6], ['CodePulse', 100], ['Claude', 12]]) {
      const html = activityMarkup([], language, { agentUsage: {
        limits: [{ minutes: 300, percent, resetsAt: now + 3600000 }, { minutes: 10080, percent: 84, resetsAt: now + 86400000 }],
        limitsAt: now, limitsFrom: source,
        round: { input: 1200, cached: 600, output: 30 }, total: { input: 2400, cached: 1200, output: 60 },
      } });
      const note = source === 'CodePulse' ? language === 'en' ? 'Limits from a CodePulse status record, written' : '额度来自 CodePulse 状态记录，'
        : language === 'en' ? `Limits from ${source}, updated` : `额度来自 ${source}，`;
      const labels = language === 'en' ? ['5-hour limit', 'Weekly limit', 'This round', 'This conversation', note]
        : ['5 小时额度', '每周额度', '本轮', '本次对话', note];
      for (const label of labels) assert.ok(html.includes(label), label);
      assert.ok(html.includes(`aria-valuenow="${percent}"`)); assert.match(html, /aria-valuenow="84"/);
      assert.equal((html.match(/class="activity-metric activity-tokens" title=/g) || []).length, 2);
      assert.equal((html.match(/is-warn/g) || []).length, percent >= 90 ? 1 : 0, 'only a window from 90% takes the warning colour');
      // The window's own reset time stays; only the reset control goes.
      assert.equal((html.match(/<small>[^<]*(?:重置|Resets)/gi) || []).length, 2);
      assert.doesNotMatch(html, /activity-reset|activity-estop|重置额度|limit-reset/i);
    }
    const empty = activityMarkup([], language);
    assert.ok(empty.includes(language === 'en' ? 'Plan limits are currently unavailable.' : '账号额度暂不可用。'));
    assert.doesNotMatch(empty, /\/usage/);
    assert.doesNotMatch(empty, /activity-reset|activity-estop|重置|reset/i);
  }
});

test('expired limits show an empty muted bar and waiting text without a stale percent or reset time', t => {
  const now = new Date(2030, 4, 5, 12).getTime(), past = now - 86400000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const pastTime = new Date(past).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  for (const agent of ['claude', 'codex']) {
    for (const language of ['zh', 'en']) {
      const html = activityMarkup([], language, { agent, agentUsage: {
        limits: [{ minutes: 300, percent: 81.34, resetsAt: past }, { minutes: 10080, percent: 92.1, resetsAt: past }], limitsAt: now - 60000,
      } });
      const limits = [...html.matchAll(/<div class="activity-metric activity-limit">([\s\S]*?)<\/div>/g)];
      assert.equal(limits.length, 2);
      for (const [, limit] of limits) {
        assert.ok(limit.includes(language === 'en' ? 'Reset, waiting for an update' : '已重置，等待更新'));
        assert.match(limit, /class="activity-meter is-expired"/);
        assert.doesNotMatch(limit, /<b|<i|%|aria-valuenow| 重置|Resets /);
        assert.ok(!limit.includes(pastTime));
      }
    }
  }
});

test('future limits stay current and expire when the app clock rerenders the same snapshot', t => {
  const now = new Date(2030, 4, 5, 12).getTime(), resetsAt = now + 5000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const terminal = { agentUsage: { limits: [{ minutes: 300, percent: 81.34, resetsAt }], limitsAt: now } };
  const time = new Date(resetsAt).toLocaleString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const before = activityMarkup([], 'en', terminal);
  assert.match(before, />81%</); assert.match(before, /aria-valuenow="81"/);
  assert.ok(before.includes(`<small>Resets ${time}</small>`));
  assert.doesNotMatch(before, /is-expired|waiting for an update/);
  t.mock.timers.tick(5000);
  const after = activityMarkup([], 'en', terminal);
  assert.match(after, /Reset, waiting for an update/);
  assert.doesNotMatch(after, /81%|81\.3%|aria-valuenow|Resets /);
  assert.equal(terminal.agentUsage.limits[0].percent, 81.34);
});

test('unknown round and conversation totals explain earlier history when context is known', () => {
  const tokens = { input: 1200, cached: 600, output: 30 };
  for (const language of ['zh', 'en']) {
    const first = language === 'en' ? 'Shows after the first reply.' : '第一次回复后显示。';
    const roundNote = language === 'en' ? 'This round started in earlier records; its usage is unknown.' : '本轮从更早的记录开始，暂无法统计。';
    const totalNote = language === 'en' ? 'The conversation total is in earlier records.' : '本次对话的总量在更早的记录里。';
    for (const [round, total] of [[null, null], [null, tokens], [tokens, null]]) {
      const html = activityMarkup([], language, { agentUsage: { limits: [], context: { used: 120, window: 200000 }, round, total } });
      assert.equal(html.includes(roundNote), round === null);
      assert.equal(html.includes(totalNote), total === null);
      assert.ok(!html.includes(first));
      assert.equal((html.match(/class="activity-metric activity-tokens" title=/g) || []).length, Number(!!round) + Number(!!total));
    }
    const empty = activityMarkup([], language, { agentUsage: { limits: [], context: null, round: null, total: null } });
    assert.ok(empty.includes(first));
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
      const html = activityMarkup([], language, terminal);
      assert.ok(html.includes('class="activity-metric activity-figure" title="1,230,010 / 2,000,000 tokens"'));
      const titles = language === 'en'
        ? ['1,328,775 tokens · Input 1,230,010 · Cache read 456,789 · Output 98,765', '125,456,789 tokens · Input 123,456,789 · Cache read 90,123,456 · Output 2,000,000']
        : ['1,328,775 tokens · 输入 1,230,010 · 缓存命中 456,789 · 输出 98,765', '125,456,789 tokens · 输入 123,456,789 · 缓存命中 90,123,456 · 输出 2,000,000'];
      for (const title of titles) assert.ok(html.includes(`class="activity-metric activity-tokens" title="${title}"`), title);
      assert.ok(html.includes(`title="83.3% · ${language === 'en' ? `Updated ${time}` : `${time} 更新`}"`));
      assert.match(html, />83%</); assert.match(html, /aria-valuenow="83"/);
      terminal.agentUsage.limitsAt = null;
      assert.ok(activityMarkup([], language, terminal).includes('title="83.3%"'));
    }
  }
});

test('Codex reset count arrives automatically, shows zero and bounded query states, preserving explicit reset controls', () => {
  const render = (state, left = null, reason) => activityMarkup([], 'zh', { agent: 'codex', agentUsage: {
    limits: [], resets: left === null ? null : { left, total: null }, resetQuery: { state, reason },
  } });
  assert.match(render('ready', 2), /<small>剩余 2 次<\/small>/);
  const zero = render('ready', 0);
  assert.match(zero, /<small>已用完<\/small>/); assert.match(zero, /<button[^>]*disabled/); assert.doesNotMatch(zero, /剩余 0 次/, 'none left is told apart from not knowing');
  // Not knowing: a short status in the row's right-hand slot, the whole sentence (then the click's explanation) in the row's hover.
  const status = html => /<small>([^<]*)<\/small><\/button>/.exec(html)[1], hover = html => /class="activity-reset-row activity-estop" title="([^"]*)"/.exec(html)[1];
  const loading = render('loading');
  assert.equal(status(loading), '查询中…'); assert.match(hover(loading), /^正在查询剩余次数…\n点击后有 10 秒可以取消/);
  assert.doesNotMatch(loading, /<button[^>]*disabled/);
  const cases = [[render('error', null, 'timeout'), '查询失败', '查询失败，将自动重试'], [render('unavailable', null, 'remote'), '暂不支持', '远程账号暂不支持后台查询'],
    [render('unavailable', null, 'provider'), '暂不支持', '当前接口不提供重置次数'], [render('unavailable', null, 'scope'), '无法确认', '无法确认账号环境，暂不能查询'],
    [render('unavailable', null, 'unsupported'), '次数未知', '当前账号或 Codex 版本未提供次数，将自动重试']];
  for (const [html, short, full] of cases) { assert.equal(status(html), short); assert.ok(hover(html).startsWith(full + '\n'), full); assert.doesNotMatch(/<div class="activity-reset">[\s\S]*?<\/div>/.exec(html)[0], /activity-note/, 'no separate status line'); }
});

test('the pane: the main card (with its tasks) above the models, context and usage; no separate tasks card, no fake progress', () => {
  const html = activityMarkup([], 'zh', { agent: 'codex',
    prompts: [{ id: 'work', text: 'Continue responding while usage hangs', summary: 'Continue responding while usage hangs', state: 'working' }],
    agentUsage: { provider: 'OpenAI', context: { used: 25000, window: 100000 }, limits: [{ minutes: 300, percent: 60 }], resets: { left: 2 }, resetQuery: { state: 'ready' } },
  });
  const positions = ['activity-main"', 'activity-context"', 'activity-usage"'].map(name => html.indexOf(name));
  assert.ok(positions.every((position, i) => position >= 0 && (!i || position > positions[i - 1])), 'main model, context, then usage/reset controls');
  const usage = html.slice(positions[2]);
  assert.match(usage, /activity-estop/); assert.match(usage, /剩余 2 次/);
  assert.match(html, /aria-valuenow="25"/); assert.match(usage, /aria-valuenow="60"/);
  assert.match(/<section class="activity-card activity-main"[\s\S]*?<\/section>/.exec(html)[0], /Continue responding while usage hangs/);
  assert.doesNotMatch(html, /activity-tasks|正在处理的任务|activity-progress/);
  assert.match(fs.readFileSync(path.join(__dirname, '../src/features/agents/ActivityPane.tsx'), 'utf8'), /className="loading-spinner"/);
  const css = fs.readFileSync(path.join(__dirname, '../src/features/agents/activity-pane.css'), 'utf8');
  assert.doesNotMatch(css, /activity-progress|activity-tasks|activity-prompts|activity-prompt-state|activity-task-quiet/);
});

test('without an agent the pane shows only its hint, no main model and no tasks; it is bounded: no scrollbar, the lists scroll inside their own windows', () => {
  const html = activityMarkup([], 'en', { codexActive: false });
  assert.ok(html.includes('class="activity-empty"') && html.includes('main model, task, context length and usage'));
  assert.doesNotMatch(html, /activity-main|activity-context|activity-usage|activity-tasks|No task yet/);
  const css = fs.readFileSync(path.join(__dirname, '../src/features/agents/activity-pane.css'), 'utf8');
  // The pane shows no scrollbar; the fixed groups keep their height, the main card's prompts and the called models scroll under their own titles.
  assert.match(/\.activity-pane \{[^}]*\}/.exec(css)[0], /scrollbar-width: none/);
  assert.match(css, /\.activity-calls \{ flex: 0 1 auto; min-height: 60px; \}/);
  assert.match(css, /\.activity-main \{ flex: 0 1 auto; min-height: 100px; \}/);
  assert.doesNotMatch(css, /max-height/);
  assert.match(css, /\.activity-card \{ flex: none;/, 'context and usage never shrink');
  const list = /\.activity-main-tasks, \.activity-call-groups \{([^}]+)\}/.exec(css)[1];
  for (const part of ['flex: 0 1 auto', 'min-height: 0', 'overflow-y: auto', 'scrollbar-gutter: stable', 'mask-image', 'animation-timeline: scroll(self)']) assert.ok(list.includes(part), part);
  assert.match(css, /@keyframes activity-fade/);
  assert.match(css, /\.activity-call-rows li p \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis; white-space: nowrap/);
});

test('the main card lists the prompts: the working one with its spinner and clock, the step under it, those waiting after, each row the summary with the whole text in its hover', () => {
  const now = Date.now(), original = 'Please fix the button.\n<pasted_content id="1">Synthetic hidden details.</pasted_content>';
  const prompts = [{ id: 'a', text: original, summary: 'Please fix the button.', state: 'working', at: now - 134000 },
    { id: 'b', text: 'A real queued request.', summary: 'Queued request.', state: 'queued', at: now - 12000 }, { id: 'c', text: 'no start', summary: '（代码）', state: 'queued' }];
  const edit = { kind: 'edit', tool: 'Edit', target: 'src/App.tsx', detail: '', done: false };
  const main = html => /<section class="activity-card activity-main"[\s\S]*?<\/section>/.exec(html)[0], rows = html => [...main(html).matchAll(/<li class="(is-[a-z]+(?: [^"]*)?|activity-call-[a-z]+)"[^>]*>/g)].map(match => match[1]);
  const html = main(activityMarkup([], 'zh', { codexActivity: 'working', prompts, action: edit }));
  assert.deepEqual(rows(html), ['activity-call-head', 'is-working', 'is-step', 'is-queued', 'is-queued'], 'head, the working prompt, its step, then the waiting ones');
  assert.ok(html.includes('<li class="is-working" title="Please fix the button.\n&lt;pasted_content id=&quot;1&quot;&gt;Synthetic hidden details.&lt;/pasted_content&gt;\n处理中 · 2:1'), 'the whole text in the hover, with the state and clock');
  assert.match(html, /<span class="activity-call-role">处理中<\/span>Please fix the button\.<\/p><time>2:1\d<\/time>/);
  assert.match(html, /<li class="is-queued" title="A real queued request\.\n排队中 · 0:1\d">[\s\S]*?<span class="activity-call-role">排队中<\/span>Queued request\.<\/p><time>0:1\d<\/time>/);
  assert.ok(html.includes('title="no start\n排队中"') && html.includes('<p><span class="activity-call-role">排队中</span>（代码）</p><time></time>'), 'a prompt with no start shows no clock');
  assert.doesNotMatch(html.replace(/title="[^"]*"/g, ''), /pasted_content|Synthetic hidden details/);
  assert.match(html, /<li class="is-step" title="src\/App\.tsx">[\s\S]*?<span class="activity-call-role">正在<\/span>修改 App\.tsx<\/p>/);
  assert.ok(html.indexOf('is-working') < html.indexOf('is-step') && html.indexOf('is-step') < html.indexOf('is-queued'), 'the step is under the working prompt');
  const command = main(activityMarkup([], 'zh', { codexActivity: 'working', prompts: [{ id: 'command', text: '<command-name>/model</command-name>', summary: '/model', state: 'working' }] }));
  assert.match(command, /<\/span>\/model<\/p>/); assert.doesNotMatch(command.replace(/title="[^"]*"/g, ''), /command-name/);
  assert.ok(main(activityMarkup([], 'en', { codexActivity: 'working', prompts })).includes(`>${en['处理中']}<`) && main(activityMarkup([], 'en', { codexActivity: 'working', prompts })).includes(`>${en['排队中']}<`));
});

test('with no prompt the main card says the agent state in words and invents no task; the finished prompt shows only for the round it belongs to', () => {
  const now = Date.now(), prompt = { id: 'p', text: 'Fix <the> bug in the parser.', summary: 'Fix the parser bug.', state: 'working', at: now - 5000 };
  const main = html => /<section class="activity-card activity-main"[\s\S]*?<\/section>/.exec(html)[0], tasks = html => main(html).slice(main(html).indexOf('activity-main-tasks'));
  const render = (terminal, language = 'zh') => main(activityMarkup([], language, { id: 'finished-case', sessionId: 's1', task: 'RESULT SUMMARY', taskTitle: 'RESULT TITLE', ...terminal }));
  // Nothing tracked: the state in words, and not the result summary the card header's status may carry.
  for (const [codexActivity, word] of [['working', '正在处理'], ['complete', '本轮已完成'], ['interrupted', '已中断'], ['unknown', '等待下一步']]) {
    const html = tasks(render({ id: 'none', codexActivity }));
    assert.match(html, new RegExp('<li class="is-' + (codexActivity === 'working' ? 'working' : 'idle') + '"[^>]*>[\\s\\S]*?<p>' + word + '</p>'));
    assert.doesNotMatch(html, /RESULT|<time>[^<]+/);
    assert.match(html, new RegExp('data-icon="' + (codexActivity === 'working' ? 'CircleNotch' : 'Circle') + '"'));
  }
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
  const css = fs.readFileSync(path.join(__dirname, '../src/features/agents/activity-pane.css'), 'utf8');
  const row = css.split(/\r?\n/).find(line => line.startsWith('.activity-call-rows li {'));
  for (const part of ['grid-template-columns: 16px minmax(0, 1fr) auto', 'column-gap: 8px', 'height: 32px']) assert.ok(row.includes(part), part);
  assert.ok(css.includes('.activity-call-rows li::before { content: \'\'; position: absolute; inset: 0 -8px; border-radius: 8px; }'), 'the hover reaches 8px past the text');
  assert.match(css, /\.activity-call-rows li p \{[^}]*text-overflow: ellipsis; white-space: nowrap/);
  assert.match(css, /li :is\(time, \.activity-row-end\) \{[^}]*font-size: 12px[^}]*var\(--flow-faint\)[^}]*tabular-nums/);
  assert.match(css, /\.activity-call-rows li:is\(\.is-running, \.is-working\) \.activity-row-icon \{ color: var\(--running\); \}/, 'the spinner is the one colour');
  assert.match(css, /\.activity-call-rows li\.is-done \.activity-row-icon \{ color: var\(--success\); \}/);
  assert.match(css, /\.activity-call-rows li\.is-step p \{ color: var\(--flow-faint\); \}/, 'the step is quieter');
});

test('the main card shows the parent review source, clock and step before queued prompts, and ends with the parent', () => {
  const at = Date.now() - 65000;
  const background = { text: 'Parser worker completed verification.', summary: 'Parser verification completed', count: 2, at };
  const action = { kind: 'read', tool: 'Read', target: 'report.txt', detail: '', done: false };
  const prompts = [{ id: 'q', text: 'Next human request', summary: 'Next human request', state: 'queued', at: at + 60000 }];
  const main = (state, extra = {}, language = 'zh') => /<section class="activity-card activity-main"[\s\S]*?<\/section>/.exec(activityMarkup([], language,
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
  const main = extra => /<section class="activity-card activity-main"[\s\S]*?<\/section>/.exec(activityMarkup([], 'zh',
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
  const { elapsedClock } = (() => { const filename = path.join(__dirname, '../src/features/agents/ActivityPane.tsx'); const source = fs.readFileSync(filename, 'utf8').split(/\r?\n/).join(String.fromCharCode(10)); const body = /export function elapsedClock[\s\S]*?\n}\n/.exec(source)[0].replace('export ', ''); return new Function(`${ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.None } }).outputText}\nreturn { elapsedClock };`)(); })();
  assert.deepEqual([0, 999, 9000, 134000, 3600000, 3909000, -5].map(elapsedClock), ['0:00', '0:00', '0:09', '2:14', '1:00:00', '1:05:09', '0:00']);
});

test('metrics are label | meter | figure blocks: one number format, a warning colour only from 90% and a dash for an unknown window', () => {
  const metric = html => /<div class="activity-metric[^"]*"[^>]*>[\s\S]*?<\/div>/.exec(html)[0];
  const at = used => activityMarkup([], 'zh', { agentUsage: { limits: [], context: { used, window: 1000000 }, round: { input: 186000, cached: 0, output: 2000 }, total: { input: 2300000, cached: 0, output: 80000 } } });
  assert.doesNotMatch(metric(at(894999)), /is-warn/);
  assert.match(metric(at(900000)), /activity-metric is-warn activity-figure/);
  const full = at(930000);
  assert.ok(full.includes('>93%<') && full.includes('共 1M tokens · 还可容纳 70k') && !full.includes('<b>930k</b>'), 'the note stands alone: no figure beside the meter');
  assert.ok(/<section class="activity-card activity-context"[^>]*><div class="activity-metric is-warn activity-figure"[^>]*><span class="activity-metric-label">上下文长度<\/span><span class="activity-meter"/.test(full), 'the title is the label of the meter line, on the limit rows grid, with no separate heading');
  const tokenRows = [...full.matchAll(/<div class="activity-metric activity-tokens"[^>]*>[\s\S]*?<\/div>/g)].map(match => match[0]);
  assert.equal(tokenRows.length, 2);
  for (const row of tokenRows) assert.doesNotMatch(row, /<b|role="meter"/, 'a token row is its label and its breakdown on one line: no total, no meter');
  assert.ok(tokenRows[0].endsWith('<span class="activity-metric-label">本轮</span><small>输入 186k · 输出 2k</small></div>'));
  assert.ok(tokenRows[1].endsWith('<span class="activity-metric-label">本次对话</span><small>输入 2.3M · 输出 80k</small></div>'));
  const unknown = activityMarkup([], 'zh', { agentUsage: { limits: [], context: { used: 4200, window: 0 }, round: null, total: null } });
  assert.ok(unknown.includes('>—</b>') && unknown.includes('已用 4.2k tokens，窗口大小未知'));
  assert.doesNotMatch(unknown, /0%|还可容纳 0|role="meter"/);
  const css = fs.readFileSync(path.join(__dirname, '../src/features/agents/activity-pane.css'), 'utf8');
  assert.match(css, /\.activity-metric \{[^}]*grid-template-columns: 88px minmax\(0, 1fr\) 48px; grid-template-rows: 32px/);
  assert.ok(css.includes('.activity-metric.activity-tokens > small { grid-area: 1 / 2 / auto / -1;'), 'the breakdown starts in the meters column, on the label line');
  assert.match(css, /\.activity-metric\.is-warn > b \{ color: var\(--warning\); \}/);
  assert.match(css, /\.activity-metric\.is-warn \.activity-meter i \{ background: var\(--warning\); \}/);
  // The context and the usage have no headings and share one 8px list, so the gap before the first limit equals the gap between blocks.
  assert.doesNotMatch(full, /<h4[^>]*>用量<\/h4>/);
  assert.match(full, /<div class="activity-gauges"><section class="activity-card activity-context"[^>]*><div class="activity-metric[^>]*>[\s\S]*?<\/section><section class="activity-card activity-usage" aria-label="用量">/);
  assert.match(css, /\.activity-gauges \{[^}]*gap: 8px/);
});

test('the reset action is a 32px row on the task grid and keeps unknown, failed and zero counts apart', () => {
  const render = (resets, resetQuery) => activityMarkup([], 'zh', { agent: 'codex', agentUsage: { limits: [], resets, resetQuery } });
  const row = /<button[^>]*class="activity-reset-row activity-estop"[\s\S]*?<\/button>/.exec(render({ left: 2, total: null }, { state: 'ready' }))[0];
  assert.ok(row.indexOf('activity-row-icon') < row.indexOf('activity-reset-label') && row.indexOf('activity-reset-label') < row.indexOf('<small>剩余 2 次</small>'));
  assert.match(render({ left: 0, total: null }, { state: 'ready' }), /<small>已用完<\/small>/);
  assert.doesNotMatch(/<button[^>]*activity-estop[\s\S]*?<\/button>/.exec(render(null, { state: 'error', reason: 'timeout' }))[0], /剩余/, 'an unknown count is not shown as a number');
  assert.match(/<button[^>]*activity-estop[\s\S]*?<\/button>/.exec(render(null, { state: 'error', reason: 'timeout' }))[0], /<span class="activity-reset-label">重置额度<\/span><small>查询失败<\/small>/, 'the status is on the row itself');
  const css = fs.readFileSync(path.join(__dirname, '../src/features/agents/activity-pane.css'), 'utf8');
  assert.match(css, /\.activity-reset-row \{[^}]*grid-template-columns: 16px max-content minmax\(0, 1fr\); column-gap: 8px;[^}]*height: 32px/);
  assert.match(css, /\.activity-reset-label \{[^}]*white-space: nowrap; \}/, 'the label is never cut');
  assert.doesNotMatch(/\.activity-reset-label \{[^}]*\}/.exec(css)[0], /text-overflow/);
  assert.match(css, /\.activity-reset-row small \{[^}]*text-align: right; text-overflow: ellipsis;[^}]*font-size: 12px;[^}]*white-space: nowrap/, 'the slot is right-aligned like the other figures and gives way first');
  assert.match(css, /\.activity-reset > \.activity-note \{ padding-left: 24px; \}/, 'a note after a run starts under the label');
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
  const css = fs.readFileSync(path.join(__dirname, '../src/features/agents/reset-countdown.css'), 'utf8');
  assert.match(css, /\.reset-countdown \{ position: fixed; inset: 0; z-index: 400;[^}]*72%[^}]*-webkit-app-region: no-drag/, 'over the whole window, title bar included, at 72% of the canvas colour');
  assert.match(css, /\.reset-countdown-ring \{[^}]*width: 240px; height: 240px/);
  assert.match(css, /\.reset-countdown-number \{ font: 600 104px/);
  assert.match(css, /\.reset-countdown-cancel \{[^}]*height: 32px/);
  assert.match(css, /\.reset-countdown\.is-warning \.reset-countdown-ring \{ --ring-ink: var\(--warning\); \}/);
  assert.match(css, /transition: stroke-dashoffset 1s linear/);
  assert.match(css, /:root\[data-motion="off"\] \.reset-countdown\.is-draining[^}]*var\(--ring-now\)/, 'without motion the ring steps with the number');
  assert.match(css, /prefers-reduced-motion: reduce\)[^]*data-motion="system"[^]*var\(--ring-now\)/);
  assert.doesNotMatch(css, /animation|bounce|scale\(/);
});

test('the reset row stays the trigger: it never turns into a countdown row, and the old row countdown is gone', () => {
  const html = activityMarkup([], 'zh', { agent: 'codex', agentUsage: { limits: [], resets: { left: 2, total: null }, resetQuery: { state: 'ready' } } });
  assert.match(html, /<button type="button" class="activity-reset-row activity-estop" title="点击后有 10 秒可以取消，然后由 Codex 自己完成重置"><span class="activity-row-icon">[\s\S]*?<\/span><span class="activity-reset-label">重置额度<\/span><small>剩余 2 次<\/small><\/button>/);
  assert.doesNotMatch(html, /reset-countdown|role="timer"|倒计时中/, 'nothing counts before the click');
  const source = fs.readFileSync(path.join(__dirname, '../src/features/agents/ActivityPane.tsx'), 'utf8');
  assert.ok(source.includes("status = counting ? t('倒计时中…')"), 'while it counts the row says so quietly, in the same slot');
  assert.ok(source.includes('disabled={counting ||'), 'and cannot start a second countdown');
  assert.ok(source.includes('{!!count && <ResetCountdown count={count} total={COUNTDOWN} onCancel={() => setCount(null)} />}'));
  assert.doesNotMatch(source, /activity-reset-cancel|is-counting|'\{seconds\} 秒后重置'/);
  const css = fs.readFileSync(path.join(__dirname, '../src/features/agents/activity-pane.css'), 'utf8');
  assert.doesNotMatch(css, /activity-reset-cancel|is-counting/);
  assert.ok(!('{seconds} 秒后重置' in en), 'the old row label is gone from the translations');
});

test('the main model section: the model its latest reply records (the setting only until there is one), its rate, and the step it is on, never borrowed from a prompt or a sub-agent', () => {
  const main = html => /<section class="activity-card activity-main"[\s\S]*?<\/section>/.exec(html)[0], head = html => /<li class="activity-call-head" title="([^"]*)"><span class="activity-row-icon">[\s\S]*?<\/span><p><b>([^<]*)<\/b>/.exec(main(html)).slice(1);
  const usage = extra => ({ provider: 'Anthropic', limits: [], calls: [], ...extra });
  const html = activityMarkup([], 'zh', { agentUsage: usage({ model: 'claude-sonnet-5-5' }) });
  assert.match(html, /<section class="activity-card activity-main" aria-label="主模型"><h4 class="activity-card-title">主模型<\/h4>/);
  assert.deepEqual(head(html), ['Claude Code / Anthropic / Sonnet 5.5\n设置为 Opus 5.5，实际回复来自 Sonnet 5.5\nxhigh · 普通模式', 'Sonnet 5.5'], 'the reply wins over the setting, and the tooltip says so');
  assert.deepEqual(head(activityMarkup([], 'zh', { agentUsage: usage({ model: 'claude-opus-5-5' }) })), ['Claude Code / Anthropic / Opus 5.5\nxhigh · 普通模式', 'Opus 5.5'], 'no mismatch remark when they agree');
  assert.deepEqual(head(activityMarkup([], 'zh', { agentUsage: usage({}) })), ['Claude Code / Anthropic / Opus 5.5\nxhigh · 普通模式', 'Opus 5.5'], 'the setting stands in until a reply records the model');
  const waiting = activityMarkup([], 'zh', { agentSettings: null, agentUsage: usage({}) });
  assert.deepEqual(head(waiting), ['Claude Code / Anthropic', 'Claude Code']); assert.ok(main(waiting).includes('第一次回复后显示模型。'));
  assert.ok(main(html).includes('<span class="activity-call-settings"> · xhigh · 普通模式</span>'), 'how it runs, in the head');
  assert.doesNotMatch(main(html), /activity-call-note/, 'the same settings are not repeated below it');
  assert.doesNotMatch(main(html), /activity-call-tag|子代理/, 'the main agent is not a sub-agent');
  // The rate: average output speed; waiting before a finished reply; a dash when the records cannot be read (the tooltip says so).
  const rate = value => /<span class="activity-row-end activity-rate( is-live)?" title="([^"]*)">([^<]*)<\/span>/.exec(main(activityMarkup([], 'zh', { agentUsage: usage({ rate: value }) }))).slice(1);
  assert.deepEqual(rate({ outputTokens: 900, activeMs: 10000, samples: 3, updatedAt: 1, partial: false }), [' is-live', '平均输出速率：最近 3 条回复，共 900 token，用时 10.0 秒', '90 token/s']);
  assert.deepEqual(rate({ outputTokens: 1234, activeMs: 9800, samples: 2, updatedAt: 1, partial: true })[1], '平均输出速率：最近 2 条回复，共 1,234 token，用时 9.8 秒\n（部分记录）');
  assert.deepEqual(rate({ outputTokens: 0, activeMs: 0, samples: 0, updatedAt: 1, partial: false }), [undefined, '还没有完成一条回复，暂时没有速率。', '等待中']);
  assert.deepEqual(rate(null), [undefined, '这个模型的记录在这里读不到，所以没有速率。', '— token/s']);
  assert.deepEqual(rate(undefined), [undefined, '这个模型的记录在这里读不到，所以没有速率。', '— token/s']);
  assert.equal(rate({ outputTokens: 7, activeMs: 3000, samples: 1, updatedAt: 1, partial: false })[2], '2 token/s');
  const english = activityMarkup([], 'en', { agentUsage: usage({ rate: { outputTokens: 900, activeMs: 10000, samples: 3, updatedAt: 1, partial: true } }) });
  assert.ok(english.includes('title="Average output rate over the last 3 replies: 900 tokens in 10.0 s (partial records)"'.replace(' (partial', '\n (partial')));
  assert.ok(main(activityMarkup([], 'en', { agentUsage: usage({}) })).includes('>Main model<'));
});

test('the main row shows the step under way and spins only while the agent works; a finished or missing step shows the agent state, never a prompt or a sub-agent title', () => {
  const step = (action, codexActivity) => /<section class="activity-card activity-main"[\s\S]*?<\/section>/.exec(activityMarkup([{ agent: 'Codex', model: 'gpt-6.1-sol', provider: 'OpenAI', effort: null, fast: null, preparing: 0, running: 1, reviewing: 0, tasks: [], items: [{ state: 'running', role: '执行', title: 'SUB TITLE' }] }], 'zh',
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
  const css = fs.readFileSync(path.join(__dirname, '../src/features/agents/activity-pane.css'), 'utf8');
  assert.match(css, /\.activity-call-rows li \.activity-rate \{ min-width: 80px; text-align: right; \}/, 'a fixed column for the rate');
  assert.doesNotMatch(css, /activity-route/, 'the route chips are gone');
});

test('every group of called models has its own rate and inline effort, its calls exactly as given and is never merged', () => {
  const call = (model, extra = {}) => ({ agent: 'Claude Code', provider: 'Anthropic', model, effort: null, fast: null, preparing: 0, running: 1, reviewing: 0, tasks: [], items: [{ state: 'running', role: '执行', title: `${model} work` }], ...extra });
  const html = activityMarkup([call('claude-opus-5-5', { rate: { outputTokens: 480, activeMs: 10000, samples: 2, updatedAt: 1, partial: false }, effort: 'high' }),
    call('claude-sonnet-5-5'), call('claude-sonnet-5-5', { effort: 'max', fast: true, rate: null })], 'zh', { agentUsage: { provider: 'Anthropic', limits: [], model: 'claude-opus-5-5', calls: [] } });
  const calls = /<section class="activity-card activity-calls"[\s\S]*?<\/section>/.exec(activityMarkup([call('claude-opus-5-5', { rate: { outputTokens: 480, activeMs: 10000, samples: 2, updatedAt: 1, partial: false }, effort: 'high' }),
    call('claude-sonnet-5-5'), call('claude-sonnet-5-5', { effort: 'max', fast: true, rate: null })]))[0];
  assert.ok(html.includes('主模型'));
  assert.doesNotMatch(calls, /activity-call-tag|子代理/, 'the section heading identifies the called models');
  assert.equal((calls.match(/class="activity-call-head"/g) || []).length, 3, 'three groups, none merged');
  assert.deepEqual([...calls.matchAll(/<span class="activity-row-end activity-rate[^"]*" title="[^"]*">([^<]*)<\/span>/g)].map(match => match[1]), ['48 token/s', '— token/s', '— token/s'], 'each group has its own rate');
  assert.ok(calls.includes('<span class="activity-call-settings"> · high</span>') && calls.includes('<span class="activity-call-settings"> · max · 快速</span>'), 'effort and speed follow the bold model name');
  assert.doesNotMatch(calls, /activity-call-note/, 'settings are never repeated on a separate row');
  assert.deepEqual([...calls.matchAll(/<\/span>(claude-[a-z0-9-]+ work)<\/p>/g)].map(match => match[1]), ['claude-opus-5-5 work', 'claude-sonnet-5-5 work', 'claude-sonnet-5-5 work'], 'calls as given');
  const css = fs.readFileSync(path.join(__dirname, '../src/features/agents/activity-pane.css'), 'utf8');
  assert.match(css, /\.activity-call-head p > \.activity-call-provider \{ flex: 0 100 auto; \}/, 'the service gives way first');
  assert.doesNotMatch(css, /activity-call-tag/);
});
