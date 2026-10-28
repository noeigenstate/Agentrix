const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const en = require('../electron/locales/en.json');

function activityMarkup(calls, language = 'zh', terminal = {}) {
  const filename = path.join(__dirname, '../src/features/agents/ActivityPane.tsx');
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
    if (name === './reset-count') return require('../src/features/agents/reset-count.ts');
    if (name === '@phosphor-icons/react') return new Proxy({}, { get: () => () => React.createElement('svg') });
    return original(name);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  return renderToStaticMarkup(React.createElement(mod.exports.ActivityPane, { terminal: {
    id: 'placeholder', agent: 'claude', codexActive: true, prompts: [], agentSettings: { model: 'claude-opus-5-5', effort: 'xhigh', fast: false },
    agentUsage: { provider: 'Anthropic', limits: [], calls },
    ...terminal,
  } }));
}

test('the activity route hides empty calls and shows active counts, tasks and each state in both languages', () => {
  const empty = activityMarkup([]);
  assert.ok(empty.includes('Opus 5.5'));
  assert.ok(!empty.includes('调用的模型'));
  assert.ok(!activityMarkup(undefined).includes('activity-route-calls'));
  const calls = [
    { agent: 'Claude Code', provider: 'Anthropic', model: 'claude-sonnet-5-5', effort: null, fast: null, preparing: 0, running: 1, reviewing: 1, tasks: ['Polish <card>', 'Check spacing'], items: [] },
    { agent: 'Codex', provider: 'OpenAI', model: 'gpt-6.1-sol', effort: 'max', fast: true, preparing: 2, running: 3, reviewing: 1, tasks: ['parser.md'], items: [] },
  ];
  const html = activityMarkup(calls);
  const plain = html.replace(/<[^>]*>/g, '');
  for (const text of ['调用的模型', 'Sonnet 5.5', 'GPT-6.1-Sol', '子代理 ×2 · 1 个运行中 · 1 个审核中', 'Codex 子任务 ×6 · 2 个正在准备 · 3 个运行中 · 1 个审核中 · 思考 max · 快速']) assert.ok(plain.includes(text), text);
  assert.ok(html.includes('title="Polish &lt;card&gt;\nCheck spacing"'));
  for (const [state, count] of [['preparing', 1], ['running', 2], ['reviewing', 2]]) assert.equal((html.match(new RegExp(`class="activity-call-${state}"`, 'g')) || []).length, count);
  assert.doesNotMatch(plain, /0 个/);
  const english = activityMarkup(calls, 'en').replace(/<[^>]*>/g, '');
  for (const text of ['Models called', 'Subagents ×2 · 1 running · 1 reviewing', 'Codex subtasks ×6 · 2 preparing · 3 running · 1 reviewing · effort max · Fast']) assert.ok(english.includes(text), text);
});

test('a single preparing or reviewing group uses its own dot and reviewed routes disappear', () => {
  for (const state of ['preparing', 'reviewing']) {
    const html = activityMarkup([{ agent: 'Codex', model: 'gpt-6.1-sol', provider: null, effort: null, fast: null, preparing: 0, running: 0, reviewing: 0, [state]: 1, tasks: [], items: [] }], 'en');
    assert.match(html, new RegExp(`class="activity-call-${state}"`));
    assert.ok(html.replace(/<[^>]*>/g, '').includes(`Codex subtasks ×1 · 1 ${state}`));
    assert.doesNotMatch(html, /activity-call-running|0 preparing|0 reviewing|0 running/);
  }
  const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
  const calls = new AgentCalls();
  calls.apply({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id: 'a', input: { model: 'sonnet', description: 'Check layout' } }] } });
  calls.apply({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'Checked' }] } });
  assert.match(activityMarkup(calls.snapshot()), /activity-call-reviewing/);
  calls.apply({ type: 'system', subtype: 'stop_hook_summary', hookCount: 1 });
  assert.doesNotMatch(activityMarkup(calls.snapshot()), /activity-route-calls|Check layout|调用的模型/);
});

test('called models show four ordered role and title rows with state dots, full hovers and localized overflow', () => {
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
    const rows = /<ol class="activity-call-items">([\s\S]*?)<\/ol>/.exec(html)[1];
    const plain = rows.replace(/<[^>]*>/g, '');
    assert.equal((rows.match(/<li title=/g) || []).length, 4);
    assert.ok(rows.includes(`title="${long.replace('<parser>', '&lt;parser&gt;')}"`));
    assert.ok(plain.indexOf('Inspect') < plain.indexOf('Implement parser'));
    assert.ok(plain.indexOf('Implement parser') < plain.indexOf('Plan the checks'));
    assert.ok(plain.indexOf('Plan the checks') < plain.indexOf('Custom task'));
    for (const role of language === 'en' ? ['Investigate', 'Execute', 'Plan', 'custom-worker'] : ['调查', '执行', '规划', 'custom-worker']) assert.ok(plain.includes(`${role} ·`));
    for (const state of ['preparing', 'running', 'reviewing']) assert.ok(rows.includes(`class="activity-call-${state}"`));
    assert.ok(plain.includes(language === 'en' ? '+2 more' : '+2 个'));
    assert.doesNotMatch(plain, /Older task|Oldest task/);
    assert.doesNotMatch(activityMarkup([{ ...call, items: items.slice(0, 4) }], language), /activity-call-more/);
    for (const [role, translated] of [['搜索', 'Search'], ['通用', 'General'], ['分身', 'Fork']]) assert.ok(activityMarkup([{ ...call, items: [{ ...items[0], role }] }], 'en').includes(`${translated} ·`));
  }
});

test("Claude's usage keeps plan limits, tokens and their source without reset controls or text", () => {
  const now = Date.now();
  for (const language of ['zh', 'en']) {
    for (const [source, percent] of [['Claude Code', 6], ['CodePulse', 100]]) {
      const html = activityMarkup([], language, { agentUsage: {
        limits: [{ minutes: 300, percent, resetsAt: now + 3600000 }, { minutes: 10080, percent: 84, resetsAt: now + 86400000 }],
        limitsAt: now, limitsFrom: source,
        round: { input: 1200, cached: 600, output: 30 }, total: { input: 2400, cached: 1200, output: 60 },
      } });
      const labels = language === 'en' ? ['5-hour limit', 'Weekly limit', 'This round', 'This conversation', `Limits from ${source}, updated`]
        : ['5 小时额度', '每周额度', '本轮', '本次对话', `额度来自 ${source}，`];
      for (const label of labels) assert.ok(html.includes(label), label);
      assert.ok(html.includes(`aria-valuenow="${percent}"`)); assert.match(html, /aria-valuenow="84"/);
      assert.equal((html.match(/class="activity-token-row"/g) || []).length, 2);
      // The window's own reset time stays; only the reset control goes.
      assert.equal((html.match(/<small>[^<]*(?:重置|Resets)/gi) || []).length, 2);
      assert.doesNotMatch(html, /activity-reset|activity-estop|重置额度|limit-reset/i);
    }
    const empty = activityMarkup([], language);
    assert.ok(empty.includes(language === 'en' ? 'type /usage in the terminal to see them.' : '在终端输入 /usage 查看。'));
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
      const limits = [...html.matchAll(/<div class="activity-limit">([\s\S]*?)<\/div>/g)];
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
      assert.equal((html.match(/class="activity-token-row"/g) || []).length, Number(!!round) + Number(!!total));
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
      assert.ok(html.includes('class="activity-figure" title="1,230,010 / 2,000,000 tokens"'));
      const titles = language === 'en'
        ? ['1,328,775 tokens · Input 1,230,010 · Cache read 456,789 · Output 98,765', '125,456,789 tokens · Input 123,456,789 · Cache read 90,123,456 · Output 2,000,000']
        : ['1,328,775 tokens · 输入 1,230,010 · 缓存命中 456,789 · 输出 98,765', '125,456,789 tokens · 输入 123,456,789 · 缓存命中 90,123,456 · 输出 2,000,000'];
      for (const title of titles) assert.ok(html.includes(`class="activity-token-row" title="${title}"`), title);
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
  assert.match(zero, /<small>剩余 0 次<\/small>/); assert.match(zero, /<button[^>]*disabled/);
  const loading = render('loading');
  assert.match(loading, /正在查询剩余次数…/);
  assert.doesNotMatch(loading, /<button[^>]*disabled/);
  assert.match(loading, /点击后有 10 秒可以取消/);
  assert.doesNotMatch(loading, /剩余次数在 \/usage 里显示/);
  assert.match(render('error', null, 'timeout'), /查询失败，将自动重试/);
  assert.match(render('unavailable', null, 'remote'), /远程账号暂不支持后台查询/);
  assert.match(render('unavailable', null, 'provider'), /当前接口不提供重置次数/);
  assert.match(render('unavailable', null, 'unsupported'), /当前账号或 Codex 版本未提供次数，将自动重试/);
});

test('working task keeps its real status, spinner and text, with no fake progress or dead theme overrides', () => {
  const html = activityMarkup([], 'zh', { agent: 'codex',
    prompts: [{ id: 'work', text: 'Continue responding while usage hangs', summary: 'Continue responding while usage hangs', state: 'working' }],
    agentUsage: { provider: 'OpenAI', context: { used: 25000, window: 100000 },
      limits: [{ minutes: 300, percent: 60 }], resets: { left: 2 }, resetQuery: { state: 'ready' } },
  });
  const positions = ['activity-route"', 'activity-tasks"', 'activity-context"', 'activity-usage"'].map(name => html.indexOf(name));
  assert.ok(positions.every((position, i) => position >= 0 && (!i || position > positions[i - 1])), 'route, tasks, context, then usage/reset controls');
  const usage = html.slice(positions[3]);
  assert.match(usage, /activity-estop/); assert.match(usage, /剩余 2 次/);
  assert.match(html, /aria-valuenow="25"/); assert.match(usage, /aria-valuenow="60"/);
  assert.match(html, /正在处理/); assert.match(html, /Continue responding while usage hangs/);
  assert.match(fs.readFileSync(path.join(__dirname, '../src/features/agents/ActivityPane.tsx'), 'utf8'), /className="loading-spinner"/);
  assert.doesNotMatch(html, /activity-progress/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../src/features/agents/activity-pane.css'), 'utf8'), /activity-progress/);
});

test('inactive terminal keeps its empty card above tasks, whose height is bounded with internal scrolling', () => {
  const html = activityMarkup([], 'en', { codexActive: false });
  assert.ok(html.indexOf('activity-empty') < html.indexOf('activity-tasks'));
  assert.ok(html.includes('No task yet'));
  assert.doesNotMatch(html, /activity-route|activity-context|activity-usage/);
  const css = fs.readFileSync(path.join(__dirname, '../src/features/agents/activity-pane.css'), 'utf8');
  const tasks = /\.activity-tasks\s*\{([^}]+)\}/.exec(css)[1];
  assert.match(tasks, /max-height:\s*\d+px/);
  assert.doesNotMatch(tasks, /flex:\s*1|min-height:\s*(?:96|120)px/);
  assert.match(css, /\.activity-prompts\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.activity-call-title\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap/);
});

test('task cards display source summaries and retain the complete original only in their hovers', () => {
  const original = 'Please fix the button.\n<pasted_content id="1">Synthetic hidden details.</pasted_content>';
  const html = activityMarkup([], 'zh', { prompts: [
    { id: 'working', text: original, summary: 'Please fix the button.', state: 'working' },
    { id: 'queued', text: '```js\nconst synthetic = 1;\n```', summary: '（代码）', state: 'queued' },
  ] });
  assert.match(html, /<p>Please fix the button\.<\/p>/); assert.match(html, /<p>（代码）<\/p>/);
  assert.ok(html.includes('title="Please fix the button.\n&lt;pasted_content id=&quot;1&quot;&gt;Synthetic hidden details.&lt;/pasted_content&gt;'+String.fromCharCode(10)+'正在处理"'));
  assert.doesNotMatch(html.replace(/title="[^"]*"/g, ''), /pasted_content|Synthetic hidden details|const synthetic/);
  const completed = activityMarkup([], 'zh', { codexActivity: 'complete', task: '按钮现在可以正常点击。', taskTitle: original });
  assert.match(completed, /已完成：按钮现在可以正常点击。/); assert.ok(completed.includes('title="Please fix the button.'));
  const command = activityMarkup([], 'zh', { codexActivity: 'unknown', task: '/model', taskTitle: '<command-name>/model</command-name>' });
  assert.match(command, />\/model<\/p>/); assert.doesNotMatch(command.replace(/title="[^"]*"/g, ''), /command-name/);
});

test('each task is a 32px row: its state icon, the task on one line, a clock at the right and the state in the hover', () => {
  const now = Date.now();
  const html = activityMarkup([], 'zh', { prompts: [
    { id: 'a', text: 'first task', summary: 'first task', state: 'working', at: now - 134000 },
    { id: 'b', text: 'second task', summary: 'second task', state: 'queued', at: now - 12000 },
    { id: 'c', text: 'no start', summary: 'no start', state: 'queued' },
  ] });
  assert.equal((html.match(/<time>/g) || []).length, 3, 'one row per task');
  assert.match(html, /class="is-working" title="first task\n正在处理 · 2:1\d"/);
  assert.match(html, /title="second task\n排队中 · 0:\d\d"/);
  assert.ok(html.includes('title="no start\n排队中"') && html.includes('<time></time>'), 'a task with no start time shows no clock');
  assert.match(html, /<span class="activity-prompt-state">.*?<span class="sr-only">正在处理<\/span><\/span><p>first task<\/p><time>2:1\d<\/time>/);
  const done = activityMarkup([], 'zh', { codexActivity: 'complete', task: '按钮可以点了。', taskTitle: '原始提示', lastCompletedAt: Date.now() });
  assert.match(done, /<li class="is-done" title="原始提示\n已完成 · \d\d:\d\d">/);
  assert.match(done, /<p>已完成：按钮可以点了。<\/p>/);
  const css = fs.readFileSync(path.join(__dirname, '../src/features/agents/activity-pane.css'), 'utf8');
  const row = css.split(/\r?\n/).find(line => line.startsWith('.activity-prompts li {'));
  for (const part of ['grid-template-columns: 16px minmax(0, 1fr) auto', 'column-gap: 8px', 'height: 32px']) assert.ok(row.includes(part), part);
  assert.ok(css.includes('.activity-prompts li::before { content: \'\'; position: absolute; inset: 0 -8px; border-radius: 8px; }'), 'the hover reaches 8px past the text');
  assert.match(css, /\.activity-prompts li p \{[^}]*text-overflow: ellipsis; white-space: nowrap/);
  assert.match(css, /\.activity-prompts li time \{[^}]*font-size: 12px[^}]*var\(--flow-faint\)[^}]*tabular-nums/);
});

test('the clock reads m:ss and h:mm:ss', () => {
  const { elapsedClock } = (() => { const filename = path.join(__dirname, '../src/features/agents/ActivityPane.tsx'); const source = fs.readFileSync(filename, 'utf8').split(/\r?\n/).join(String.fromCharCode(10)); const body = /export function elapsedClock[\s\S]*?\n}\n/.exec(source)[0].replace('export ', ''); return new Function(`${ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.None } }).outputText}\nreturn { elapsedClock };`)(); })();
  assert.deepEqual([0, 999, 9000, 134000, 3600000, 3909000, -5].map(elapsedClock), ['0:00', '0:00', '0:09', '2:14', '1:00:00', '1:05:09', '0:00']);
});
