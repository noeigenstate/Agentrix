const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');

const root = path.join(__dirname, '../src');
const fill = (text, values = {}) => text.replace(/\{(\w+)\}/g, (_match, key) => values[key]);
const empty = () => null;

// Loads a TSX/TS file from src with the renderer's hooks, icons, styles, i18n and Select replaced by stand-ins.
function loader(hooks, language = 'zh', extra = {}) {
  const cache = new Map();
  const translations = language === 'en' ? require('../electron/locales/en.json') : {};
  const stubs = {
    react: hooks, '@phosphor-icons/react': new Proxy({}, { get: () => empty }),
    i18n: { t: (text, values) => fill(translations[text] ?? text, values), currentLanguage: () => language }, Select: { Select: props => React.createElement('select-stub', props) }, ...extra,
  };
  const load = file => {
    if (cache.has(file)) return cache.get(file);
    const mod = new Module(file, module);
    mod.filename = file; mod.paths = Module._nodeModulePaths(path.dirname(file));
    const original = mod.require.bind(mod);
    mod.require = name => {
      if (name.endsWith('.css')) return {};
      if (name in stubs) return stubs[name];
      if (!name.startsWith('.')) return original(name);
      const target = path.resolve(path.dirname(file), name);
      if (stubs[path.basename(target)]) return stubs[path.basename(target)];
      return load(['', '.tsx', '.ts'].map(ext => target + ext).find(file => fs.existsSync(file) && fs.statSync(file).isFile()));
    };
    cache.set(file, mod.exports);
    mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, file);
    return mod.exports;
  };
  return load;
}

// One mounted component: useState and useEffect with dependencies, re-rendered until the async work has settled.
function mount(t, skills, { details = {}, failure = null, language = 'zh' } = {}) {
  const before = global.window, calls = [], listeners = [];
  const state = { skills, failure };
  const reply = value => Promise.resolve(state.failure ? { ok: false, error: state.failure } : { ok: true, value });
  const find = id => state.skills.find(skill => skill.id === id);
  const record = (name, ...args) => { calls.push([name, ...args]); };
  global.window = { agentrix: {
    listSkills: () => { record('list'); return reply(state.skills); },
    readSkill: id => { record('read', id); return reply(details[id] ?? { text: `text of ${id}`, versions: [], pending: null }); },
    saveSkill: (id, draft) => { record('save', id, draft); return reply(id ? find(id) : skill({ id: 'user:created', name: draft.name, source: 'user', scope: 'global' })); },
    deleteSkill: id => { record('delete', id); return reply(true); },
    setSkillOptions: (id, options) => { record('options', id, options); return reply(find(id)); },
    revertSkill: (id, version) => { record('revert', id, version); return reply(find(id)); },
    resolveSkillChange: (id, accept) => { record('resolve', id, accept); return reply(find(id)); },
    importSkill: (scope, projectId) => { record('import', scope, projectId); return reply(null); },
    onSkills: callback => { listeners.push(callback); return () => { listeners.splice(listeners.indexOf(callback), 1); }; },
  } };
  t.after(() => { global.window = before; });

  const slots = [];
  let cursor = 0, effects = [], dirty = false;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], next => { if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; } }];
    },
    useMemo: make => make(),
    useEffect(callback, deps) {
      const index = cursor++, previous = slots[index];
      if (previous && deps && deps.every((dep, at) => Object.is(dep, previous.deps[at]))) return;
      effects.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: callback() }; });
    },
  };
  // The reading view's Markdown, with its real parser: the DOM that sanitizes and decorates the HTML is not available here.
  const { readingMarked } = loader({})(path.join(root, 'features/reading/markdown-escape.ts'));
  const ReadingView = { Markdown: ({ text, softBreaks }) => React.createElement('div', { className: 'reading-markdown', dangerouslySetInnerHTML: { __html: readingMarked.parse(text, { breaks: !softBreaks }) } }) };
  const { SkillsSettings } = loader(hooks, language, { ReadingView })(path.join(root, 'features/settings/SkillsSettings.tsx'));
  const projects = [{ id: 'p1', name: 'agentrix', kind: 'local' }, { id: 'p2', name: 'demo-site', kind: 'local' }, { id: 'p3', name: 'prod-box', kind: 'ssh' }];
  const render = () => {
    cursor = 0; dirty = false; effects = [];
    const tree = SkillsSettings({ projects }), run = effects;
    run.forEach(effect => effect());
    return tree;
  };
  const view = { calls, state, listeners, render };
  view.settle = async () => {
    for (let round = 0; round < 20; round++) {
      view.tree = render();
      await new Promise(resolve => setImmediate(resolve));
      if (!dirty) return view.tree = render();
    }
    assert.fail('skills settings kept re-rendering');
  };
  const walk = node => Array.isArray(node) ? node.flatMap(walk) : !React.isValidElement(node) ? []
    : typeof node.type === 'function' ? walk(node.type(node.props)) : [node, ...walk(node.props.children)];
  const textOf = node => Array.isArray(node) ? node.map(textOf).join('') : React.isValidElement(node)
    ? textOf(typeof node.type === 'function' ? node.type(node.props) : node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
  Object.assign(view, {
    nodes: () => walk(view.tree), text: node => textOf(node),
    all: pick => view.nodes().filter(pick),
    one: pick => { const found = view.nodes().filter(pick); assert.equal(found.length, 1, `expected one match, found ${found.length}`); return found[0]; },
    byLabel: label => view.one(node => node.props['aria-label'] === label || node.type === 'select-stub' && node.props.label === label),
    button: label => view.one(node => node.type === 'button' && textOf(node) === label),
    hasButton: label => view.nodes().some(node => node.type === 'button' && textOf(node) === label),
    page: () => textOf(view.tree),
    items: () => view.all(node => node.props['data-skill-id']).map(node => textOf(node)),
    clear: () => { calls.length = 0; },
  });
  return view;
}

const now = Date.now();
const routingSummary = '谁来做什么：Opus 规划与审查架构，GPT-6.1-Sol 写核心代码并调试，Sonnet 做日常与前端，GPT-6.1-Terra 验收界面并处理小任务。GPT 默认 max + fast，Claude 默认 high；只装了一个 Agent 时也有对应分工。';
const builtinRouting = over => skill({ id: 'builtin:model-routing', name: 'model-routing', description: 'Who does what on a task, in English, seven lines long.', title: '模型路由', summary: routingSummary, source: 'builtin', scope: 'builtin', trigger: 'auto', autoOptimize: false, requires: { codex: true, claude: true }, ...over });
function skill(over = {}) {
  const named = { name: '发布流程', description: '发布新版本', ...over };
  return { id: 'user:release', title: named.name, summary: named.description, when: '描述与任务匹配时读取', yieldsTo: [], source: 'user', scope: 'global', projectId: null, projectName: null, path: '', enabled: true, trigger: 'auto',
    autoOptimize: true, confirmChanges: false, version: 1, updatedAt: null, updatedBy: null, updatedIn: null, createdByAgent: false, pending: false, requires: null, lastUsed: null, ...named };
}
const releaseV4 = { text: '## 步骤\n1. 升版本号\n2. 写更新说明，并确认 CHANGELOG\n3. 跑完整本地测试', pending: null, versions: [
  { version: 3, at: now - 1e7, by: 'user', project: null, text: '## 步骤\n1. 升版本号\n2. 写更新说明\n3. 跑完整本地测试' },
  { version: 4, at: now - 1e7, by: 'agent', project: 'agentrix', text: '## 步骤\n1. 升版本号\n2. 写更新说明，并确认 CHANGELOG\n3. 跑完整本地测试' }] };
const release = skill({ version: 4, updatedAt: now - 3 * 3600e3, updatedBy: 'agent', updatedIn: 'agentrix', lastUsed: { at: now, project: 'agentrix', agent: 'claude' } });
const fresh = skill({ id: 'user:ssh', name: 'SSH 排错', description: '连不上时的步骤', createdByAgent: true, updatedBy: 'agent', updatedAt: now });
const copy = skill({ id: 'user:copy', name: '页面文案', scope: 'project', projectId: 'p2', projectName: 'demo-site' });

test('the list has the two groups with counts, the 新 mark and no search below eight skills', async t => {
  const h = mount(t, [builtinRouting(), release, copy, fresh], { details: { 'user:release': releaseV4 } });
  await h.settle();
  assert.deepEqual(h.items(), ['模型路由', '发布流程', '页面文案', 'SSH 排错新']);
  assert.deepEqual(h.all(node => node.props['data-group']).map(node => h.text(node)), ['系统自带1', '我的技能3']);
  assert.equal(h.all(node => node.type === 'input' && node.props['aria-label'] === '搜索技能').length, 0);
  assert.equal(h.one(node => node.props['data-skill-id'] && node.props['aria-current'] === 'true').props['data-skill-id'], 'builtin:model-routing');
  h.byLabel('导入文件夹'); h.byLabel('新建技能');
});

test('eight or more skills show a search that filters both groups', async t => {
  const many = Array.from({ length: 6 }, (_, at) => skill({ id: `user:n${at}`, name: `技能 ${at}`, description: `第 ${at} 个` }));
  const h = mount(t, [builtinRouting(), release, ...many]);
  await h.settle();
  const search = h.byLabel('搜索技能');
  search.props.onChange({ target: { value: '发布' } });
  await h.settle();
  assert.deepEqual(h.items(), ['发布流程']);
  search.props.onChange({ target: { value: '路由' } });
  await h.settle();
  assert.deepEqual(h.items(), ['模型路由']);
  search.props.onChange({ target: { value: '没有这个' } });
  await h.settle();
  assert.deepEqual(h.items(), []); assert.ok(h.page().includes('无匹配'));
});

test('a built-in skill is read-only: no edit or delete, a trigger, its dependency and an unused note', async t => {
  const h = mount(t, [builtinRouting({ requires: { codex: false, claude: true } }), release]);
  await h.settle();
  assert.equal(h.hasButton('编辑'), false); assert.equal(h.hasButton('删除'), false);
  assert.equal(h.all(node => node.props.label === '范围').length, 0);
  assert.equal(h.all(node => node.props['aria-label'] === '允许 Agent 自动优化').length, 0);
  assert.ok(h.page().includes('系统自带 · 只读'));
  assert.ok(h.page().includes('至少安装 Codex 或 Claude Code 其中一个'));
  assert.ok(h.page().includes('已安装 Claude Code，按只装 Claude Code 的方案分工'));
  assert.equal(h.text(h.one(node => node.props['data-skill-used'])), '还没有 Agent 用过');
  assert.equal(h.one(node => node.props['data-skill-used']).props.className, 'is-quiet');
  assert.equal(h.items()[0], '模型路由');
  assert.equal(h.nodes().some(node => node.props.className?.includes('skills-dot is-hollow')), false);
});

test('a built-in skill needing no agents shows no dependency', async t => {
  const h = mount(t, [builtinRouting(), release]);
  await h.settle();
  h.state.skills = [builtinRouting({ requires: null }), release];
  h.listeners[0](h.state.skills);
  await h.settle();
  assert.equal(h.page().includes('依赖'), false);
  h.state.skills = [builtinRouting({ requires: { codex: null, claude: null } }), release];
  h.listeners[0](h.state.skills);
  await h.settle();
  assert.equal(h.page().includes('依赖'), false);
});

for (const language of ['zh', 'en']) test(`model routing shows the requirement and each installation state in ${language}`, async t => {
  const cases = [
    { requires: { codex: true, claude: true }, hollow: false, zh: '两个都已安装，按完整分工运行', en: 'Both are installed; the full role distribution applies' },
    { requires: { codex: false, claude: true }, hollow: false, zh: '已安装 Claude Code，按只装 Claude Code 的方案分工', en: 'Claude Code is installed; roles follow the Claude Code-only plan' },
    { requires: { codex: true, claude: false }, hollow: false, zh: '已安装 Codex，按只装 Codex 的方案分工', en: 'Codex is installed; roles follow the Codex-only plan' },
    { requires: { codex: false, claude: false }, hollow: true, zh: '都未安装，技能暂不生效', en: 'Neither is installed; this skill is inactive' },
    { requires: { codex: true, claude: true }, enabled: false, hollow: true, zh: '已关闭', en: 'Off' },
  ];
  const h = mount(t, [builtinRouting(), release], { language });
  await h.settle();
  for (const item of cases) {
    h.state.skills = [builtinRouting({ requires: item.requires, enabled: item.enabled ?? true }), release];
    h.listeners[0](h.state.skills);
    await h.settle();
    const row = h.one(node => node.props.className === 'skills-dependency');
    const [dot, text] = row.props.children;
    assert.equal(dot.props.className, item.hollow ? 'skills-dot is-hollow' : 'skills-dot');
    assert.equal(h.text(text.props.children[0]), language === 'zh' ? '至少安装 Codex 或 Claude Code 其中一个' : 'Install at least one of Codex or Claude Code');
    assert.equal(text.props.children[1].type, 'small');
    assert.equal(h.text(text.props.children[1]), item[language]);
    assert.equal(h.all(node => node.props.className === 'skills-dot is-hollow').length, item.hollow ? 2 : 0);
  }
});

test('a dependency on a single agent keeps its original fallback', async t => {
  const h = mount(t, [builtinRouting({ requires: { codex: true, claude: null } }), release]);
  await h.settle();
  assert.equal(h.text(h.one(node => node.props.className === 'skills-dependency')), 'Codex 已安装');
  h.state.skills = [builtinRouting({ requires: { codex: false, claude: null } }), release];
  h.listeners[0](h.state.skills);
  await h.settle();
  assert.equal(h.text(h.one(node => node.props.className === 'skills-dependency')), 'Codex 未安装 · 将由主模型自己完成');
});

test('the last use shows as today\'s clock time with project and agent', async t => {
  const h = mount(t, [builtinRouting(), release, copy], { details: { 'user:release': releaseV4 } });
  await h.settle();
  h.items(); h.all(node => node.props['data-skill-id'] === 'user:release')[0].props.onClick();
  await h.settle();
  assert.match(h.text(h.one(node => node.props['data-skill-used'])), /^最近一次生效：\d{2}:\d{2} · 项目 agentrix · Claude Code$/);
  h.all(node => node.props['data-skill-id'] === 'user:copy')[0].props.onClick();
  await h.settle();
  assert.equal(h.text(h.one(node => node.props['data-skill-used'])), '还没有 Agent 用过');
});

test('a user skill shows its version line and a 变更 tab with the line diff of the latest two versions', async t => {
  const h = mount(t, [builtinRouting(), release], { details: { 'user:release': releaseV4 } });
  await h.settle();
  h.all(node => node.props['data-skill-id'] === 'user:release')[0].props.onClick();
  await h.settle();
  assert.equal(h.text(h.one(node => node.props.className === 'skills-version')), 'v4 · 最近由 Agent 优化 · 3 小时前 · 项目 agentrix');
  assert.ok(h.page().includes('回退到 v3'));
  h.one(node => node.props['data-skill-view-mode'] === 'source').props.onClick(); await h.settle();
  assert.equal(h.text(h.one(node => node.type === 'pre')), releaseV4.text);
  h.button('变更').props.onClick();
  await h.settle();
  assert.ok(h.text(h.one(node => node.props.className === 'skills-diff-meta')).startsWith('v3 → v4 · '));
  const lines = h.all(node => node.props['data-diff']).map(node => [node.props['data-diff'], h.text(node)]);
  assert.deepEqual(lines, [['ctx', ' ## 步骤'], ['ctx', ' 1. 升版本号'], ['del', '−2. 写更新说明'], ['add', '+2. 写更新说明，并确认 CHANGELOG'], ['ctx', ' 3. 跑完整本地测试']]);
  h.button('SKILL.md').props.onClick();
  await h.settle();
  assert.equal(h.all(node => node.props['data-diff']).length, 0);
});

test('a built-in skill has no 变更 tab, even with several versions or after a user skill left the diff open', async t => {
  const h = mount(t, [builtinRouting({ version: 3 }), release], { details: { 'user:release': releaseV4, 'builtin:model-routing': releaseV4 } });
  await h.settle();
  h.all(node => node.props['data-skill-id'] === 'user:release')[0].props.onClick(); await h.settle();
  h.button('变更').props.onClick(); await h.settle();
  assert.ok(h.all(node => node.props['data-diff']).length > 0);
  h.all(node => node.props['data-skill-id'] === 'builtin:model-routing')[0].props.onClick(); await h.settle();
  assert.equal(h.hasButton('变更'), false);
  assert.equal(h.all(node => node.props['data-skill-changes']).length, 0);
  assert.equal(h.all(node => node.props['data-diff']).length, 0);
  assert.ok(h.page().includes('v3 · 随应用更新'));
});

test('each control makes its one call', async t => {
  const h = mount(t, [builtinRouting(), release], { details: { 'user:release': releaseV4 } });
  await h.settle();
  h.all(node => node.props['data-skill-id'] === 'user:release')[0].props.onClick();
  await h.settle(); h.clear();
  h.byLabel('启用 发布流程').props.onChange({ target: { checked: false } }); await h.settle();
  h.byLabel('触发').props.onChange('always'); await h.settle();
  h.byLabel('允许 Agent 自动优化').props.onChange({ target: { checked: false } }); await h.settle();
  h.byLabel('需要我确认后再生效').props.onChange({ target: { checked: true } }); await h.settle();
  h.one(node => node.props['data-skill-revert']).props.onClick(); await h.settle();
  h.byLabel('范围').props.onChange('p2'); await h.settle();
  assert.deepEqual(h.calls.filter(call => call[0] !== 'list' && call[0] !== 'read'), [
    ['options', 'user:release', { enabled: false }], ['options', 'user:release', { trigger: 'always' }],
    ['options', 'user:release', { autoOptimize: false }], ['options', 'user:release', { confirmChanges: true }],
    ['revert', 'user:release', 3],
    ['save', 'user:release', { name: '发布流程', description: '发布新版本', scope: 'project', projectId: 'p2', text: releaseV4.text }],
  ]);
  assert.equal(h.byLabel('需要我确认后再生效').props.disabled, false);
  h.state.skills = [builtinRouting(), { ...release, autoOptimize: false }]; h.listeners[0](h.state.skills); await h.settle();
  assert.equal(h.byLabel('需要我确认后再生效').props.disabled, true);
});

test('the trigger and the on switch of a built-in skill call setSkillOptions', async t => {
  const h = mount(t, [builtinRouting(), release]);
  await h.settle(); h.clear();
  h.byLabel('触发').props.onChange('auto'); await h.settle();
  h.byLabel('启用 模型路由').props.onChange({ target: { checked: false } }); await h.settle();
  assert.deepEqual(h.calls.filter(call => call[0] === 'options'), [['options', 'builtin:model-routing', { trigger: 'auto' }], ['options', 'builtin:model-routing', { enabled: false }]]);
});

test('a skill an agent made carries 新 and is kept with 确认保留', async t => {
  const h = mount(t, [builtinRouting(), fresh]);
  await h.settle();
  h.all(node => node.props['data-skill-id'] === 'user:ssh')[0].props.onClick(); await h.settle(); h.clear();
  assert.ok(h.page().includes('新 · 由 Agent 创建'));
  h.one(node => node.props['data-skill-keep']).props.onClick(); await h.settle();
  assert.deepEqual(h.calls.filter(call => call[0] === 'resolve'), [['resolve', 'user:ssh', true]]);
});

test('a proposed change shows its row and 查看 / 采用 / 放弃 work', async t => {
  const proposed = { ...releaseV4, pending: `${releaseV4.text}\n4. 打标签` };
  const h = mount(t, [builtinRouting(), { ...release, pending: true }], { details: { 'user:release': proposed } });
  await h.settle();
  h.all(node => node.props['data-skill-id'] === 'user:release')[0].props.onClick(); await h.settle(); h.clear();
  assert.ok(h.page().includes('Agent 提议了修改'));
  h.one(node => node.props['data-skill-view']).props.onClick(); await h.settle();
  assert.equal(h.text(h.one(node => node.props.className === 'skills-diff-meta')), '当前 → Agent 的提议');
  assert.deepEqual(h.all(node => node.props['data-diff'] === 'add').map(node => h.text(node)), ['+4. 打标签']);
  h.one(node => node.props['data-skill-accept']).props.onClick(); await h.settle();
  h.one(node => node.props['data-skill-discard']).props.onClick(); await h.settle();
  assert.deepEqual(h.calls.filter(call => call[0] === 'resolve'), [['resolve', 'user:release', true], ['resolve', 'user:release', false]]);
});

test('editing saves the form, cancelling drops it, and delete needs a second click', async t => {
  const h = mount(t, [builtinRouting(), release], { details: { 'user:release': releaseV4 } });
  await h.settle();
  h.all(node => node.props['data-skill-id'] === 'user:release')[0].props.onClick(); await h.settle();
  h.one(node => node.props['data-skill-edit']).props.onClick(); await h.settle();
  assert.equal(h.byLabel('名称').props.value, '发布流程'); assert.equal(h.byLabel('SKILL.md').props.value, releaseV4.text);
  h.button('取消').props.onClick(); await h.settle();
  assert.equal(h.nodes().some(node => node.props['data-skill-detail']), true);
  h.one(node => node.props['data-skill-edit']).props.onClick(); await h.settle(); h.clear();
  h.byLabel('名称').props.onChange({ target: { value: '发布' } }); await h.settle();
  h.byLabel('SKILL.md').props.onChange({ target: { value: '新的内容' } }); await h.settle();
  h.byLabel('范围').props.onChange('p1'); await h.settle();
  h.button('保存').props.onClick(); await h.settle();
  assert.deepEqual(h.calls.find(call => call[0] === 'save'), ['save', 'user:release', { name: '发布', description: '发布新版本', scope: 'project', projectId: 'p1', text: '新的内容' }]);
  assert.equal(h.nodes().some(node => node.props['data-skill-detail']), true);
  h.one(node => node.props['data-skill-edit']).props.onClick(); await h.settle(); h.clear();
  h.button('删除').props.onClick(); await h.settle();
  assert.equal(h.calls.some(call => call[0] === 'delete'), false);
  h.button('再点一次确认删除').props.onClick(); await h.settle();
  assert.deepEqual(h.calls.filter(call => call[0] === 'delete'), [['delete', 'user:release']]);
});

test('a new skill is created from the form, and an empty form cannot be saved', async t => {
  const h = mount(t, [builtinRouting()]);
  await h.settle(); h.clear();
  h.byLabel('新建技能').props.onClick(); await h.settle();
  assert.equal(h.button('创建').props.disabled, true);
  assert.equal(h.hasButton('删除'), false);
  h.byLabel('名称').props.onChange({ target: { value: '日志排查' } }); await h.settle();
  h.byLabel('描述').props.onChange({ target: { value: '先找第一个错误' } }); await h.settle();
  h.button('创建').props.onClick(); await h.settle();
  assert.deepEqual(h.calls.find(call => call[0] === 'save'), ['save', null, { name: '日志排查', description: '先找第一个错误', scope: 'global', projectId: null, text: '' }]);
});

test('with no skills of your own the right side explains how to make one, and both buttons work', async t => {
  const h = mount(t, [builtinRouting()]);
  await h.settle();
  assert.ok(h.page().includes('还没有自己的技能')); assert.ok(h.page().includes('SKILL.md 的文件夹'));
  assert.equal(h.nodes().some(node => node.props['data-skill-detail']), false);
  h.clear();
  h.button('导入文件夹').props.onClick(); await h.settle();
  assert.deepEqual(h.calls.find(call => call[0] === 'import'), ['import', 'global', null]);
  h.button('新建技能').props.onClick(); await h.settle();
  assert.equal(h.byLabel('名称').props.value, '');
  h.nodes().find(node => node.props['data-skill-id']).props.onClick(); await h.settle();
  assert.equal(h.nodes().some(node => node.props['data-skill-detail']), true);
});

test('before the first list arrives nothing is claimed, and an empty list shows the empty state', async t => {
  const h = mount(t, []);
  h.tree = h.render();
  assert.equal(h.page().includes('还没有自己的技能'), true); // the list column's note
  assert.equal(h.page().includes('SKILL.md 的文件夹'), false);
  await h.settle();
  assert.ok(h.page().includes('SKILL.md 的文件夹'));
});

test('a failed call shows its error once and a thrown call shows the exception', async t => {
  const h = mount(t, [builtinRouting(), release], { details: { 'user:release': releaseV4 } });
  await h.settle();
  h.all(node => node.props['data-skill-id'] === 'user:release')[0].props.onClick(); await h.settle();
  h.state.failure = 'Skill folder is read-only';
  h.byLabel('触发').props.onChange('always'); await h.settle();
  assert.equal(h.text(h.one(node => node.props.role === 'alert')), 'Skill folder is read-only');
  global.window.agentrix.listSkills = () => Promise.reject(new Error('gone'));
  h.state.failure = null;
  h.byLabel('启用 发布流程').props.onChange({ target: { checked: false } }); await h.settle();
  assert.match(h.text(h.one(node => node.props.role === 'alert')), /gone/);
});

test('the list follows what onSkills pushes', async t => {
  const h = mount(t, [builtinRouting()]);
  await h.settle();
  assert.equal(h.listeners.length, 1);
  h.listeners[0]([builtinRouting(), release, fresh]);
  await h.settle();
  assert.deepEqual(h.items(), ['模型路由', '发布流程', 'SSH 排错新']);
});

test('the diff keeps two lines of context, marks the rest with a gap, and says when nothing changed', () => {
  const { diffLines } = loader({})(path.join(root, 'features/settings/skill-diff.ts'));
  const before = Array.from({ length: 12 }, (_, at) => `line ${at}`).join('\n');
  const after = before.replace('line 6', 'line six');
  assert.deepEqual(diffLines(before, after).map(line => `${line.kind}:${line.text}`),
    ['gap:', 'ctx:line 4', 'ctx:line 5', 'del:line 6', 'add:line six', 'ctx:line 7', 'ctx:line 8', 'gap:']);
  assert.deepEqual(diffLines('a\nb', 'a\nb').every(line => line.kind !== 'add' && line.kind !== 'del'), true);
  assert.deepEqual(diffLines('', 'x').map(line => line.kind), ['del', 'add']);
});

test('Settings lists 技能 after 编码助手 and English strings exist for every new phrase', () => {
  const dialog = fs.readFileSync(path.join(root, 'features/settings/SettingsDialog.tsx'), 'utf8');
  assert.ok(dialog.indexOf("id: 'agents'") < dialog.indexOf("id: 'skills'") && dialog.indexOf("id: 'skills'") < dialog.indexOf("id: 'shortcuts'"));
  const en = require('../electron/locales/en.json');
  const phrases = ['Agent 提议了修改', '查看变更', '回退到 v{n}', '生效证据', '还没有 Agent 用过', '最近一次生效：{time} · 项目 {project} · {agent}', '再点一次确认删除', '系统自带 · 只读'];
  for (const phrase of phrases) assert.ok(en[phrase], phrase);
  for (const file of ['SkillsSettings.tsx', 'SkillsList.tsx', 'SkillEditForm.tsx', 'SkillDetailPane.tsx', 'skill-text.ts']) {
    for (const [, phrase] of fs.readFileSync(path.join(root, 'features/settings', file), 'utf8').matchAll(/\bt\('([^']+)'/g)) assert.ok(phrase in en, `${file}: ${phrase}`);
  }
});

test('the page shows a built-in skill by its title and clamped summary, never its English name or description', async t => {
  const h = mount(t, [builtinRouting(), release]);
  await h.settle();
  assert.equal(h.items()[0], '模型路由');
  const summary = h.one(node => node.props.className === 'skills-desc skills-summary');
  assert.equal(h.text(summary), routingSummary); assert.equal(summary.props.title, routingSummary);
  assert.equal(h.items().join().includes('model-routing'), false); assert.equal(h.page().includes('seven lines'), false);
  assert.equal(h.text(h.one(node => node.props.className === 'skills-title')).startsWith('模型路由'), true);
  h.byLabel('启用 模型路由');
  const css = fs.readFileSync(path.join(root, 'features/settings/skills-settings.css'), 'utf8');
  assert.match(css, /\.skills-summary \{[^}]*-webkit-line-clamp: 2;[^}]*overflow: hidden;/);
});

test('the search matches the shown title and summary as well as the name', async t => {
  const many = Array.from({ length: 6 }, (_, at) => skill({ id: `user:n${at}`, name: `技能 ${at}`, description: `第 ${at} 个` }));
  const h = mount(t, [builtinRouting(), release, ...many]);
  await h.settle();
  h.byLabel('搜索技能').props.onChange({ target: { value: '审查架构' } }); await h.settle();
  assert.deepEqual(h.items(), ['模型路由']);
});

test('the scope picker offers local projects only, in the detail and in the form', async t => {
  const h = mount(t, [builtinRouting(), release]);
  await h.settle();
  h.all(node => node.props['data-skill-id'] === 'user:release')[0].props.onClick(); await h.settle();
  const labels = select => select.props.options.map(option => option.label);
  assert.deepEqual(labels(h.byLabel('范围')), ['所有项目', 'agentrix', 'demo-site']);
  h.one(node => node.props['data-skill-edit']).props.onClick(); await h.settle();
  assert.deepEqual(labels(h.byLabel('范围')), ['所有项目', 'agentrix', 'demo-site']);
});

test('saving sends the folder name unless the name field was edited', async t => {
  const folder = skill({ id: 'user:release-flow', name: '发布流程', path: 'C:\\data\\skills\\release-flow\\SKILL.md' });
  const h = mount(t, [builtinRouting(), folder]);
  await h.settle();
  h.all(node => node.props['data-skill-id'] === 'user:release-flow')[0].props.onClick(); await h.settle(); h.clear();
  h.byLabel('范围').props.onChange('p1'); await h.settle();
  h.one(node => node.props['data-skill-edit']).props.onClick(); await h.settle();
  assert.equal(h.byLabel('名称').props.value, '发布流程');
  h.button('保存').props.onClick(); await h.settle();
  h.one(node => node.props['data-skill-edit']).props.onClick(); await h.settle();
  h.byLabel('名称').props.onChange({ target: { value: '发布' } }); await h.settle();
  h.button('保存').props.onClick(); await h.settle();
  assert.deepEqual(h.calls.filter(call => call[0] === 'save').map(call => call[2].name), ['release-flow', 'release-flow', '发布']);
});

test('saving over a pending agent proposal asks first, and 取消 keeps editing', async t => {
  const pending = { ...release, pending: true };
  const h = mount(t, [builtinRouting(), pending], { details: { 'user:release': { ...releaseV4, pending: 'proposal' } } });
  await h.settle();
  h.all(node => node.props['data-skill-id'] === 'user:release')[0].props.onClick(); await h.settle();
  h.one(node => node.props['data-skill-edit']).props.onClick(); await h.settle(); h.clear();
  h.button('保存').props.onClick(); await h.settle();
  assert.equal(h.calls.some(call => call[0] === 'save'), false);
  assert.equal(h.text(h.one(node => node.props.role === 'alert')), 'Agent 提议的修改尚未处理，保存会丢弃它。继续？');
  h.button('取消').props.onClick(); await h.settle();
  assert.equal(h.nodes().some(node => node.props.role === 'alert'), false); assert.equal(h.byLabel('名称').props.value, '发布流程');
  h.button('保存').props.onClick(); await h.settle();
  h.button('继续').props.onClick(); await h.settle();
  assert.equal(h.calls.filter(call => call[0] === 'save').length, 1);
  assert.equal(h.nodes().some(node => node.props['data-skill-detail']), true);
});

test('every settings switch has a hit area of at least 32 px around its 22 px look', () => {
  const css = fs.readFileSync(path.join(root, 'features/settings/settings.css'), 'utf8');
  const rule = /input\[type="checkbox"\]::after[^{]*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'a ::after hit area');
  const inset = /position: absolute; inset: (-?\d+)px (-?\d+)px/.exec(rule[1]);
  assert.ok(inset && 22 - 2 * Number(inset[1]) >= 32 && 38 - 2 * Number(inset[2]) >= 32);
  assert.match(css, /\.setting-row input\[type="checkbox"\]::after, \.skills-settings input\[type="checkbox"\]::after/);
});

test('English exists for each built-in skill title and summary', () => {
  const en = require('../electron/locales/en.json');
  assert.equal(en['模型路由'], 'Model routing'); assert.ok(en[routingSummary]);
  const folder = path.join(__dirname, '../resources/skills');
  for (const name of fs.readdirSync(folder)) {
    const front = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(path.join(folder, name, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n'))?.[1] ?? '';
    for (const [, key, text] of front.matchAll(/^(title|summary): (.+)$/gm)) assert.ok(en[text.trim()], `${name} ${key}`);
  }
});

test('the trigger offers 首次打开项目, which sets first-open, in Chinese and English', async t => {
  for (const [language, labels] of [['zh', ['始终', '按需', '首次打开项目']], ['en', ['Always', 'On demand', 'First project open']]]) {
    const h = mount(t, [builtinRouting({ trigger: 'first-open' }), release], { language });
    await h.settle(); h.clear();
    const trigger = h.byLabel(language === 'zh' ? '触发' : 'Trigger');
    assert.equal(trigger.props.value, 'first-open');
    assert.deepEqual(trigger.props.options.map(option => option.value), ['always', 'auto', 'first-open']);
    assert.deepEqual(trigger.props.options.map(option => option.label), labels);
    trigger.props.onChange('first-open'); await h.settle();
    assert.deepEqual(h.calls.filter(call => call[0] === 'options'), [['options', 'builtin:model-routing', { trigger: 'first-open' }]]);
  }
});

test('the trigger row shows when the skill takes effect: a built-in through translation, a user skill as given', async t => {
  const h = mount(t, [builtinRouting({ when: '每个任务开始前读取并遵循' }), release], { details: { 'user:release': releaseV4 } });
  await h.settle();
  assert.equal(h.text(h.one(node => node.props['data-skill-when'])), '每个任务开始前读取并遵循');
  assert.equal(h.one(node => node.props['data-skill-when']).props.className, 'skills-when');
  h.all(node => node.props['data-skill-id'] === 'user:release')[0].props.onClick(); await h.settle();
  assert.equal(h.text(h.one(node => node.props['data-skill-when'])), '描述与任务匹配时读取');
  const english = mount(t, [builtinRouting({ when: '始终 · 每个任务开始前' }), release], { language: 'en' });
  await english.settle();
  assert.equal(english.text(english.one(node => node.props['data-skill-when'])), 'Always · before every task');
});

test('a built-in that yields to project copies says so, naming three projects and the full list in the tooltip', async t => {
  const h = mount(t, [builtinRouting(), release]);
  await h.settle();
  assert.equal(h.all(node => node.props['data-skill-yield']).length, 0);
  const show = async yieldsTo => { h.state.skills = [builtinRouting({ yieldsTo }), release]; h.listeners[0](h.state.skills); await h.settle(); return h.one(node => node.props['data-skill-yield']); };
  const one = await show(['agentrix']);
  assert.equal(h.text(one), '以项目自己的版本为准：agentrix'); assert.equal(one.props.title, '以项目自己的版本为准：agentrix');
  assert.equal(h.text(await show(['a', 'b', 'c'])), '以项目自己的版本为准：a · b · c');
  const many = await show(['a', 'b', 'c', 'd', 'e']);
  assert.equal(h.text(many), '以项目自己的版本为准：a · b · c 等 5 个项目');
  assert.equal(many.props.title, '以项目自己的版本为准：a · b · c · d · e');
  const english = mount(t, [builtinRouting({ yieldsTo: ['a', 'b', 'c', 'd'] }), release], { language: 'en' });
  await english.settle();
  assert.equal(english.text(english.one(node => node.props['data-skill-yield'])), 'Defers to the project’s own copy: a · b · c and others (4 in all)');
});

test('SKILL.md shows rendered headings and lists without its front matter, and 源码 shows the file as written', async t => {
  const file = '---\nname: release\ndescription: 发布新版本\n---\n\n# 发布\n\nA hard-wrapped sentence\ncontinues here.\n\nAnother paragraph.\n\n## 步骤\n\n1. 升版本号\n2. 写更新说明\n\n- 先看 [说明](https://example.com)\n- 再发布\n\n```text\nfirst line\nsecond line\n```\n\nIntentional break  \ncontinues here.\n\n---\n\n结束';
  const h = mount(t, [builtinRouting(), release], { details: { 'user:release': { ...releaseV4, text: file } } });
  await h.settle();
  h.all(node => node.props['data-skill-id'] === 'user:release')[0].props.onClick(); await h.settle();
  const html = h.one(node => node.props.className === 'reading-markdown').props.dangerouslySetInnerHTML.__html;
  assert.match(html, /<h1>发布<\/h1>/); assert.match(html, /<h2>步骤<\/h2>/);
  assert.match(html, /<p>A hard-wrapped sentence\ncontinues here\.<\/p>\s*<p>Another paragraph\.<\/p>/);
  assert.match(html, /<ol>\s*<li>升版本号<\/li>\s*<li>写更新说明<\/li>\s*<\/ol>/); assert.match(html, /<ul>\s*<li>先看 <a href="https:\/\/example.com">说明<\/a><\/li>/);
  assert.match(html, /<pre><code class="language-text">first line\nsecond line\n<\/code><\/pre>/);
  assert.match(html, /<p>Intentional break<br>continues here\.<\/p>/);
  assert.match(html, /<hr/); assert.equal(html.includes('name: release') || html.includes('description:'), false);
  assert.equal(h.all(node => node.type === 'pre').length, 0);
  const view = mode => h.one(node => node.props['data-skill-view-mode'] === mode);
  assert.deepEqual([view('text').props['aria-pressed'], view('source').props['aria-pressed']], [true, false]);
  assert.deepEqual(['渲染', '源码'].map(label => h.text(view(label === '渲染' ? 'text' : 'source'))), ['渲染', '源码']);
  view('source').props.onClick(); await h.settle();
  assert.equal(h.text(h.one(node => node.type === 'pre')), file); assert.equal(h.all(node => node.props.className === 'reading-markdown').length, 0);
  assert.deepEqual([view('text').props['aria-pressed'], view('source').props['aria-pressed']], [false, true]);
  view('text').props.onClick(); await h.settle();
  assert.equal(h.all(node => node.type === 'pre').length, 0);
});

test('a link in the rendered SKILL.md is inert, and the 变更 tab stays plain text without the toggle', async t => {
  const h = mount(t, [builtinRouting(), release], { details: { 'user:release': releaseV4 } });
  await h.settle();
  h.all(node => node.props['data-skill-id'] === 'user:release')[0].props.onClick(); await h.settle();
  let prevented = 0;
  const target = { closest: selector => selector === 'a' ? {} : null };
  h.one(node => node.props.className === 'skills-rendered').props.onClick({ target, preventDefault: () => { prevented++; } });
  h.one(node => node.props.className === 'skills-rendered').props.onClick({ target: { closest: () => null }, preventDefault: () => { prevented++; } });
  assert.equal(prevented, 1);
  h.button('变更').props.onClick(); await h.settle();
  assert.equal(h.all(node => node.props['data-skill-view-mode']).length, 0);
  assert.equal(h.all(node => node.props.className === 'skills-rendered').length, 0);
  assert.ok(h.all(node => node.props['data-diff']).length > 0);
});

test('skillBody strips only the leading front matter', () => {
  const { skillBody } = loader({})(path.join(root, 'features/settings/skill-text.ts'));
  assert.equal(skillBody('---\r\nname: a\r\n---\r\n# 标题\r\n\r\n---\r\n结尾'), '# 标题\r\n\r\n---\r\n结尾');
  assert.equal(skillBody('---\n---\n正文'), '正文');
  assert.equal(skillBody('没有前置信息\n---\n不是前置信息\n---'), '没有前置信息\n---\n不是前置信息\n---');
});
