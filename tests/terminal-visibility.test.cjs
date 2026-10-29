const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { visibleTerminals } = require('../src/features/terminal/terminal-visibility.ts');
const { fitTerminal } = require('../src/features/terminal/terminal-fit.ts');

const terminal = (id, overrides = {}) => ({ id, title: id, sessionId: `session-${id}`, status: 'shell', codexActive: false, agent: null, ...overrides });
const translate = (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, name) => values[name]);

function loadUI(name, overrides = {}) {
  const filename = path.join(__dirname, '../src/features', name);
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  mod.require = name => {
    const key = name.startsWith('.') ? path.basename(name) : name;
    if (Object.hasOwn(overrides, key)) return overrides[key];
    if (name.endsWith('.css')) return {};
    if (key === '@phosphor-icons/react') return new Proxy({}, { get: () => () => React.createElement('svg') });
    if (key === 'i18n') return { t: translate };
    if (key === 'time') return { relativeTime: () => '' };
    if (key === 'active-terminal') return { useActiveTerminal: () => null, setActiveTerminal() {} };
    if (key === 'reading-mode') return { useTerminalChoice: () => [], syncReading() {}, readingShown: item => !!item.sessionId && item.codexActive };
    if (key === 'ReadingView') return { ReadingView: () => null };
    if (key === 'VoiceButton') return { VoiceButton: () => null };
    if (key === 'useProjectReorder') return { useReorder: () => ({}) };
    if (key === 'TerminalPane') return { TerminalPane: ({ id }) => React.createElement('div', { 'data-pane': id }) };
    return original(name);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  return mod.exports;
}

test('launcher shows official agent marks, giving way to the busy spinner only while each agent installs or starts', () => {
  const { ClaudeLogo, CodexLogo } = require('../src/features/agents/AgentBrandIcon.ts');
  const CircleNotch = ({ size, className }) => React.createElement('svg', { 'data-icon': 'circle-notch', width: size, height: size, className });
  const Terminal = ({ size }) => React.createElement('svg', { 'data-icon': 'terminal', width: size, height: size });
  const expected = {
    claude: renderToStaticMarkup(React.createElement(ClaudeLogo, { size: 22 })),
    codex: renderToStaticMarkup(React.createElement(CodexLogo, { size: 22 })),
  };
  const spinner = renderToStaticMarkup(React.createElement(CircleNotch, { size: 16, className: 'loading-spinner' }));
  const terminal = renderToStaticMarkup(React.createElement(Terminal, { size: 13 }));
  for (const state of [{}, { missing: 'claude' }, { missing: 'codex' }, { installing: 'claude' }, { installing: 'codex' }, { starting: 'claude' }, { starting: 'codex' }]) {
    let index = 0;
    const slots = [null, 'new', state.starting ?? null, {
      npm: true, codex: { installed: state.missing !== 'codex' }, claude: { installed: state.missing !== 'claude' }, installing: state.installing ?? null,
    }];
    const { AgentLauncher } = loadUI('terminal/AgentLauncher.tsx', { react: {
      useState: () => [slots[index++], () => {}], useEffect() {},
    }, '@phosphor-icons/react': { CircleNotch, Terminal } });
    const html = renderToStaticMarkup(AgentLauncher({ terminalId: 't', projectId: 'p', onAction() {}, onOpenTerminal() {} }));
    for (const agent of ['claude', 'codex']) {
      const tile = html.match(new RegExp(`<button[^>]+class="agent-launcher-agent is-${agent}[^"]*"[\\s\\S]*?<\\/button>`))[0];
      const busy = state.installing === agent || state.starting === agent;
      assert.equal(tile.includes(expected[agent]), !busy, `${agent}: ${JSON.stringify(state)}`);
      assert.equal(tile.includes(spinner), busy, `${agent}: ${JSON.stringify(state)}`);
      assert.doesNotMatch(tile, /✻|(?:&gt;|>)_/);
    }
    assert.ok(html.includes(`${terminal}只打开终端`));
  }
});

test('cards use live agent detection, including typed commands and startup, rather than shell or saved agent metadata', () => {
  const shells = ['powershell', 'bash', 'zsh', 'cmd'].map(shell => terminal(shell, { shell, agent: 'codex', task: 'codex', agentCommand: 'codex', nativeMode: 'codex-native' }));
  assert.deepEqual(visibleTerminals(shells, false), []);
  const typed = terminal('typed', { shell: 'powershell' });
  assert.deepEqual(visibleTerminals([typed], false), [], 'typing a command alone has no effect');
  typed.codexActive = true; typed.agent = 'codex';
  assert.deepEqual(visibleTerminals([typed], false), [typed], 'the existing codex-started detection makes it visible');
  typed.codexActive = false;
  assert.deepEqual(visibleTerminals([typed], false), [], 'the shell-prompt/agent-exited state hides it again');
  const claude = terminal('claude', { codexActive: true, agent: 'claude' });
  const starting = terminal('starting', { agentStarting: true });
  assert.deepEqual(visibleTerminals([...shells, claude, starting, terminal('stale', { sessionId: null, codexActive: true })], false), [claude, starting]);
  assert.equal(visibleTerminals(shells, true), shells, 'expanded projects retain their complete list and order');
});

test('a single visible agent fills the card while hidden shell panes remain rendered, and expansion restores splits', () => {
  const { ProjectTerminals } = loadUI('terminal/ProjectTerminals.tsx', { AgentLauncher: { AgentLauncher: () => React.createElement('div', { className: 'agent-launcher' }) } });
  const props = { project: { id: 'p', name: 'Project', terminals: [terminal('shell'), terminal('codex', { codexActive: true })] }, activeId: 'shell', fontSize: 14, setActiveId() {}, onExpand() {} };
  const card = renderToStaticMarkup(React.createElement(ProjectTerminals, { ...props, focused: false }));
  assert.match(card, /data-terminal-slot="shell" style="display:none"/);
  assert.match(card, /data-pane="shell"/);
  assert.match(card, /is-active-terminal[^>]*data-terminal-id="codex"/);
  assert.doesNotMatch(card, /has-splits|agent-launcher|terminal-split-tools/);
  const expanded = renderToStaticMarkup(React.createElement(ProjectTerminals, { ...props, focused: true }));
  assert.match(expanded, /has-splits/); assert.doesNotMatch(expanded, /display:none/);
  assert.match(expanded, /is-active-terminal[^>]*data-terminal-id="shell"/);
  props.project.terminals.push(terminal('claude', { codexActive: true, agent: 'claude' }));
  assert.match(renderToStaticMarkup(React.createElement(ProjectTerminals, props)), /has-splits/);
});

test('a shell-only card offers the launcher and live count without unmounting its pane', () => {
  const { ProjectTerminals } = loadUI('terminal/ProjectTerminals.tsx', { AgentLauncher: { AgentLauncher: props => React.createElement('div', { className: 'agent-launcher', 'data-running': props.runningCount }) } });
  const card = renderToStaticMarkup(React.createElement(ProjectTerminals, { project: { id: 'p', terminals: [terminal('shell'), terminal('exited', { status: 'exited' })] }, focused: false, activeId: 'shell', setActiveId() {} }));
  assert.match(card, /data-pane="shell"/); assert.match(card, /data-running="1"/);
  assert.doesNotMatch(card, /is-active-terminal/);
});

test('empty grid cards render one launcher, and expansion renders one for each session-less terminal', () => {
  const { ProjectTerminals } = loadUI('terminal/ProjectTerminals.tsx', { AgentLauncher: { AgentLauncher: ({ terminalId }) => React.createElement('div', { className: 'agent-launcher', 'data-launcher-terminal': terminalId }, React.createElement('p', { className: 'agent-launcher-title' }, 'Pick an agent')) } });
  for (const count of [1, 2]) {
    const terminals = Array.from({ length: count }, (_, index) => terminal(`empty-${index}`, { sessionId: null, status: 'stopped' }));
    const props = { project: { id: 'p', terminals }, activeId: null, setActiveId() {} };
    const card = renderToStaticMarkup(React.createElement(ProjectTerminals, { ...props, focused: false }));
    assert.equal((card.match(/class="agent-launcher"/g) ?? []).length, 1);
    assert.equal((card.match(/class="agent-launcher-title"/g) ?? []).length, 1);
    assert.doesNotMatch(card, /data-terminal-slot/, 'session-less grid slots do not mount hidden launchers');
    const expanded = renderToStaticMarkup(React.createElement(ProjectTerminals, { ...props, focused: true }));
    assert.equal((expanded.match(/class="agent-launcher"/g) ?? []).length, count);
    for (const item of terminals) assert.ok(expanded.includes(`data-launcher-terminal="${item.id}"`));
  }
});

test('grid visibility preserves the expanded selection and plain-launch keeps its requested terminal through delayed expansion', async () => {
  const effects = [], terminals = [terminal('first'), terminal('chosen'), terminal('agent', { codexActive: true })];
  let activeId = 'chosen', expanded = false, expansion;
  const { ProjectTerminals } = loadUI('terminal/ProjectTerminals.tsx', {
    react: { useRef: current => ({ current }), useState: initial => [initial, () => {}], useEffect: effect => effects.push(effect) },
    AgentLauncher: { AgentLauncher: () => null },
  });
  const render = focused => {
    const tree = ProjectTerminals({ project: { id: 'p', terminals }, focused, activeId, setActiveId: id => { activeId = id; }, onExpand: () => { expansion = Promise.resolve().then(() => { expanded = true; }); } });
    effects.splice(0).forEach(effect => effect());
    return elements(tree);
  };
  const card = render(false);
  assert.equal(activeId, 'chosen', 'the filtered card selection must not overwrite the remembered expanded selection');
  assert.ok(card.find(node => node.props?.['data-terminal-id'] === 'agent').props.className.includes('is-active-terminal'));
  assert.ok(!card.find(node => node.props?.['data-terminal-id'] === 'chosen').props.className.includes('is-active-terminal'));
  assert.equal(render(true).find(node => node.props?.id === 'chosen').props.focused, true);
  terminals[1].sessionId = null; terminals[2].codexActive = false; activeId = 'first';
  const launcher = render(false).find(node => node.props?.terminalId === 'chosen');
  assert.ok(launcher);
  terminals[1].sessionId = 'session-chosen';
  launcher.props.onOpenTerminal('chosen');
  assert.equal(expanded, false);
  render(false);
  assert.equal(activeId, 'chosen', 'an intervening grid render must not clear the requested plain terminal');
  await expansion;
  assert.equal(render(expanded).find(node => node.props?.id === 'chosen').props.focused, true);
});

test('hidden and zero-sized terminals never resize; showing them again fits the same instance', t => {
  const original = globalThis.getComputedStyle;
  t.after(() => { if (original) globalThis.getComputedStyle = original; else delete globalThis.getComputedStyle; });
  globalThis.getComputedStyle = element => ({ getPropertyValue: name => element === parent ? ({ width: '400px', height: '200px' }[name] ?? '0px') : '0px' });
  let clears = 0;
  const sizes = [], parent = { clientWidth: 0, clientHeight: 0 };
  const instance = { element: { parentElement: parent }, options: { scrollback: 0 }, cols: 80, rows: 24,
    _core: { _renderService: { dimensions: { css: { cell: { width: 10, height: 20 } } }, clear: () => clears++ } },
    resize: (cols, rows) => sizes.push([cols, rows]) };
  fitTerminal(instance);
  parent.clientWidth = 400; fitTerminal(instance);
  parent.clientWidth = 0; parent.clientHeight = 200; fitTerminal(instance);
  assert.deepEqual(sizes, []); assert.equal(clears, 0);
  parent.clientWidth = 400; parent.clientHeight = 200; fitTerminal(instance);
  assert.deepEqual(sizes, [[40, 10]]); assert.equal(clears, 1);
});

function elements(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...React.Children.toArray(node.props?.children).flatMap(elements)];
}

test('launcher reserves a dedicated agent terminal without starting, writing to or restarting a shell', async t => {
  const previous = globalThis.window;
  t.after(() => { if (previous) globalThis.window = previous; else delete globalThis.window; });
  for (const agent of ['claude', 'codex']) await t.test(agent, async () => {
    const calls = [], terminals = [terminal('earlier-spare', { status: 'exited' }), terminal('busy-shell')];
    const before = structuredClone(terminals);
    let stateIndex = 0;
    globalThis.window = { agentrix: {
      getState: async () => ({ ok: true, value: { projects: [{ id: 'p', terminals }] } }),
      addTerminal: async (id, start) => { calls.push(['add', id, start]); terminals.push(terminal('new', { sessionId: null, status: 'stopped' })); return { ok: true, value: 'new' }; },
      startTerminal: id => calls.push(['start', id]),
      writeTerminal: (...args) => calls.push(['write', ...args]),
      restartTerminal: id => calls.push(['restart', id]),
      agentLaunch: async (...args) => { calls.push(['launch', ...args]); return { ok: true, value: true }; },
    } };
    const { AgentLauncher } = loadUI('terminal/AgentLauncher.tsx', { react: {
      useState: initial => [[null, 'native', null, { codex: { installed: true }, claude: { installed: true } }][stateIndex++] ?? initial, () => {}], useEffect() {},
    } });
    const tree = AgentLauncher({ terminalId: 'busy-shell', projectId: 'p', onAction: async promise => { const result = await promise; assert.equal(result.ok, true); return result.value; }, onOpenTerminal() {} });
    assert.ok(elements(tree).some(node => node.props?.role === 'radio' && node.props['aria-checked'] && node.props.children === '原生审批'));
    elements(tree).find(node => node.props?.className === `agent-launcher-agent is-${agent}`).props.onClick();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [['add', 'p', false], ['launch', 'new', agent, 'native']]);
    assert.deepEqual(terminals.slice(0, 2), before, 'the running shell and unrelated earlier spare remain untouched');
  });
});

test('an expanded later-terminal launcher targets its own terminal despite an earlier exited terminal', async t => {
  const previous = globalThis.window, calls = [];
  t.after(() => { if (previous) globalThis.window = previous; else delete globalThis.window; });
  globalThis.window = { agentrix: {
    getState: async () => ({ ok: true, value: { projects: [{ id: 'p', terminals }] } }),
    agentLaunch: async (...args) => { calls.push(['launch', ...args]); return { ok: true, value: true }; },
    startTerminal: async id => { calls.push(['start', id]); return { ok: true }; },
  } };
  const terminals = [terminal('first', { status: 'exited' }), terminal('chosen', { sessionId: null, status: 'stopped' })];
  let stateIndex = 0;
  const { AgentLauncher } = loadUI('terminal/AgentLauncher.tsx', { react: {
    useState: initial => [[null, 'new', null, { codex: { installed: true }, claude: { installed: true } }][stateIndex++] ?? initial, () => {}], useEffect() {},
  } });
  const { ProjectTerminals } = loadUI('terminal/ProjectTerminals.tsx', {
    react: { useRef: current => ({ current }), useState: initial => [initial, () => {}], useEffect() {} }, AgentLauncher: { AgentLauncher },
  });
  const expanded = ProjectTerminals({ project: { id: 'p', terminals }, focused: true, activeId: 'chosen', setActiveId: id => calls.push(['active', id]), onAction: async promise => (await promise).value, onExpand: () => assert.fail('the project is already expanded') });
  const launcher = elements(expanded).find(node => node.type === AgentLauncher);
  assert.equal(launcher.props.terminalId, 'chosen');
  const tree = AgentLauncher(launcher.props);
  elements(tree).find(node => node.props?.className === 'agent-launcher-agent is-codex').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  elements(tree).find(node => node.type === 'button' && React.Children.toArray(node.props.children).includes('只打开终端')).props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['launch', 'chosen', 'codex', 'new'], ['start', 'chosen'], ['active', 'chosen']]);
});

test('SSH empty cards keep the terminal prompt and never mount an agent launcher', () => {
  const { ProjectTerminals } = loadUI('terminal/ProjectTerminals.tsx', {
    AgentLauncher: { AgentLauncher: () => assert.fail('SSH projects must never mount AgentLauncher') },
  });
  for (const count of [1, 2]) for (const focused of [false, true]) {
    const terminals = Array.from({ length: count }, (_, index) => terminal(`empty-${index}`, { sessionId: null, status: 'stopped' }));
    const markup = renderToStaticMarkup(React.createElement(ProjectTerminals, { project: { id: 'p', kind: 'ssh', terminals }, focused, activeId: null, setActiveId() {} }));
    assert.equal((markup.match(/class="terminal-empty"/g) ?? []).length, focused ? count : 1);
    assert.match(markup, /项目已就位/); assert.match(markup, /启动终端，在这里开始开发/);
    assert.equal((markup.match(/>启动终端<\/button>/g) ?? []).length, focused ? count : 1);
    assert.doesNotMatch(markup, /agent-launcher|选择助手|原生审批|个终端运行中/);
  }
});

test('SSH shell-only cards retain hidden panes and expand through their running count', () => {
  const { ProjectTerminals } = loadUI('terminal/ProjectTerminals.tsx', {
    react: { useRef: current => ({ current }), useState: initial => [initial, () => {}], useEffect() {} },
    AgentLauncher: { AgentLauncher: () => assert.fail('SSH projects must never mount AgentLauncher') },
  });
  for (const count of [1, 2]) {
    const calls = [], shells = Array.from({ length: count }, (_, index) => terminal(`shell-${index}`));
    const terminals = [terminal('empty', { sessionId: null, status: 'stopped' }), ...shells, terminal('exited', { status: 'exited' })];
    const props = { project: { id: 'p', kind: 'ssh', terminals }, activeId: 'shell-0', setActiveId: id => calls.push(['active', id]), onExpand: () => calls.push('expand') };
    const tree = ProjectTerminals({ ...props, focused: false }), markup = renderToStaticMarkup(tree);
    assert.match(markup, /项目已就位/); assert.match(markup, /启动终端，在这里开始开发/);
    assert.doesNotMatch(markup, /class="agent-launcher"|>启动终端<\/button>|is-active-terminal/);
    for (const item of [...shells, terminals.at(-1)]) {
      assert.ok(markup.includes(`data-terminal-slot="${item.id}" style="display:none"`));
      assert.ok(markup.includes(`data-pane="${item.id}"`), 'plain PTY panes stay mounted while hidden');
    }
    elements(tree).find(node => node.type === 'button' && node.props.children === `${count} 个终端运行中 · 点击展开`).props.onClick();
    assert.deepEqual(calls, ['expand'], 'only the explicit count action expands, preserving selection');
    const expanded = renderToStaticMarkup(ProjectTerminals({ ...props, focused: true }));
    assert.doesNotMatch(expanded, /display:none|个终端运行中/);
    assert.match(expanded, />启动终端<\/button>/, 'expanded session-less SSH terminals retain the old start block');
    for (const item of shells) assert.ok(expanded.includes(`data-pane="${item.id}"`));
  }
});

test('SSH terminal start selects its record and expands only a small card', async t => {
  const previous = globalThis.window;
  t.after(() => { if (previous) globalThis.window = previous; else delete globalThis.window; });
  const { ProjectTerminals } = loadUI('terminal/ProjectTerminals.tsx', {
    react: { useRef: current => ({ current }), useState: initial => [initial, () => {}], useEffect() {} },
    AgentLauncher: { AgentLauncher: () => assert.fail('SSH projects must never mount AgentLauncher') },
  });
  for (const focused of [false, true]) {
    const calls = [];
    let finish;
    globalThis.window = { agentrix: { startTerminal: id => { calls.push(['start', id]); return new Promise(resolve => { finish = resolve; }); } } };
    const terminals = ['first', 'chosen'].map(id => terminal(id, { sessionId: null, status: 'stopped' }));
    const tree = ProjectTerminals({ project: { id: 'p', kind: 'ssh', terminals }, focused, activeId: null, setActiveId: id => calls.push(['active', id]), onExpand: () => calls.push('expand'), onAction: async promise => (await promise).value });
    renderToStaticMarkup(tree);
    const start = elements(tree).filter(node => node.type === 'button' && React.Children.toArray(node.props.children).includes('启动终端')).at(-1);
    start.props.onClick();
    const id = focused ? 'chosen' : 'first';
    assert.deepEqual(calls, [['start', id]], 'selection waits for terminal startup');
    finish({ ok: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [['start', id], ['active', id], ...(!focused ? ['expand'] : [])]);
  }
});

test('a user-typed SSH agent becomes visible while plain PTY panes stay mounted', () => {
  const { ProjectTerminals } = loadUI('terminal/ProjectTerminals.tsx', {
    AgentLauncher: { AgentLauncher: () => assert.fail('SSH projects must never mount AgentLauncher') },
  });
  for (const agent of ['claude', 'codex']) {
    const shell = terminal('shell'), typed = terminal('typed');
    const props = { project: { id: 'p', kind: 'ssh', terminals: [shell, typed] }, focused: false, activeId: 'shell', setActiveId() {} };
    const render = () => renderToStaticMarkup(React.createElement(ProjectTerminals, props));
    assert.match(render(), /data-terminal-slot="typed" style="display:none"/);
    Object.assign(typed, { codexActive: true, agent, status: 'codex' });
    const active = render();
    assert.match(active, /is-active-terminal[^>]*data-terminal-id="typed"/);
    assert.match(active, /data-terminal-slot="typed"><section/);
    assert.match(active, /data-terminal-slot="shell" style="display:none"/);
    assert.match(active, /data-pane="shell"/); assert.match(active, /data-pane="typed"/);
    assert.doesNotMatch(active, /terminal-empty|agent-launcher|has-splits/);
    Object.assign(typed, { codexActive: false, status: 'shell' });
    const exited = render();
    assert.match(exited, /data-terminal-slot="typed" style="display:none"/);
    assert.match(exited, /2 个终端运行中 · 点击展开/);
  }
});

test('card restart and voice actions target the visible agent even when the stored active terminal is a shell', t => {
  const previous = globalThis.window, calls = [];
  t.after(() => { if (previous) globalThis.window = previous; else delete globalThis.window; });
  globalThis.window = { agentrix: { restartTerminal: async id => { calls.push(['restart', id]); return { ok: true }; } } };
  let stateIndex = 0;
  const { ProjectPanel } = loadUI('workspace/ProjectPanel.tsx', {
    react: { useState: initial => [[true, false][stateIndex++] ?? initial, () => {}], useRef: current => ({ current }), useEffect() {} },
    'active-terminal': { useActiveTerminal: () => 'shell', setActiveTerminal() {} },
    ProjectTerminals: { ProjectTerminals: () => null }, ActivityPane: { ActivityPane: () => null }, ProjectImageDialog: { ProjectImageDialog: () => null },
    IconButton: { IconButton: () => null }, shortcuts: { shortcut: () => '' },
    'voice-input': { useVoice: () => ({ recording: null }), toggleDictation: (id, session) => calls.push(['voice', id, session]) },
  });
  const tree = ProjectPanel({ project: { id: 'p', name: 'Project', status: 'codex', codexActive: true, codexActivity: 'working', lastCompletedAt: null, terminals: [terminal('shell'), terminal('agent', { codexActive: true })] }, focused: false, onAction: async promise => (await promise).value });
  assert.ok(!elements(tree).some(node => node.props?.label === '切换到终端' || node.props?.label === '阅读视图：按文档排版显示对话'), 'the card header has no mode toggle');
  const menuItem = text => elements(tree).find(node => node.props?.role === 'menuitem' && React.Children.toArray(node.props.children).includes(text));
  menuItem('重启当前终端').props.onClick(); menuItem('语音输入').props.onClick();
  assert.deepEqual(calls, [['restart', 'agent'], ['voice', 'agent', 'session-agent']]);
});

test('the title bar switch shows both modes for the terminal in use, selects the current one and acts on that terminal', () => {
  const calls = [];
  let picked = null, raw = [];
  const { ModeSwitch } = loadUI('reading/ModeSwitch.tsx', {
    'active-terminal': { useActiveTerminal: () => picked },
    'reading-mode': { useTerminalChoice: () => raw, readingShown: (item, hidden) => !!item.sessionId && item.codexActive && !hidden.includes(item.id), setReading: (id, on) => calls.push([id, on]) },
  });
  const project = { id: 'p', terminals: [terminal('shell'), terminal('agent', { codexActive: true })] };
  const buttons = () => elements(ModeSwitch({ project })).filter(node => node.type === 'button');
  // The terminal in use of the expanded project is the one picked, else the first: a plain shell has no switch (only an agent session has two modes).
  assert.equal(ModeSwitch({ project }), null);
  picked = 'shell';
  assert.equal(ModeSwitch({ project }), null);
  picked = 'agent';
  assert.deepEqual(buttons().map(node => [node.props['aria-label'], node.props['aria-pressed']]), [['切换到终端', false], ['阅读视图：按文档排版显示对话', true]]);
  assert.deepEqual(buttons().map(node => node.props.title), ['切换到终端', '阅读视图：按文档排版显示对话']);
  buttons()[0].props.onClick(); buttons()[1].props.onClick();
  assert.deepEqual(calls, [['agent', false], ['agent', true]], 'each button sets its own mode, never toggles');
  raw = ['agent'];
  assert.deepEqual(buttons().map(node => node.props['aria-pressed']), [true, false]);
});

test('splits have no title or status bars: a corner cluster (grip, restart, close), a restart over a stopped body, and the grip is what reorders them', () => {
  const { ProjectTerminals } = loadUI('terminal/ProjectTerminals.tsx', { AgentLauncher: { AgentLauncher: () => React.createElement('div', { className: 'agent-launcher' }) } });
  const props = { project: { id: 'p', name: 'Project', kind: 'local', terminals: [terminal('shell', { title: '终端 1' }), terminal('codex', { title: '终端 2', codexActive: true, agent: 'codex' }), terminal('old', { title: '终端 3', status: 'exited' })] },
    activeId: 'shell', fontSize: 14, setActiveId() {}, onExpand() {}, focused: true };
  const html = renderToStaticMarkup(React.createElement(ProjectTerminals, props));
  assert.doesNotMatch(html, /terminal-split-header|terminal-split-footer|split-status|session-label|PowerShell|CODEX/, 'no bars, no status text, no shell or agent label');
  assert.equal((html.match(/class="terminal-split-tools"/g) || []).length, 3, 'one cluster in each split');
  for (const name of ['重启 Project 终端 1', '关闭 Project 终端 2']) assert.ok(html.includes(`aria-label="${name}"`), name);
  assert.equal((html.match(/class="button secondary small terminal-split-restart"/g) || []).length, 1, 'only the stopped split has the restart over its body');
  const single = renderToStaticMarkup(React.createElement(ProjectTerminals, { ...props, project: { ...props.project, terminals: [props.project.terminals[1]] } }));
  assert.doesNotMatch(single, /terminal-split-tools|terminal-split-restart/, 'a lone terminal has neither (its header already restarts it)');
  const css = fs.readFileSync(path.join(__dirname, '../src/features/workspace/workspace.css'), 'utf8');
  assert.doesNotMatch(css, /terminal-split-header|terminal-split-footer|split-status/);
  assert.match(css, /\.terminal-split-tools \{[^}]*position: absolute;[^}]*opacity: 0; pointer-events: none;/, 'hidden until hover, and then out of the way of the pointer');
  assert.match(css, /\.terminal-split:hover \.terminal-split-tools, \.terminal-split:focus-within \.terminal-split-tools \{ opacity: 1; pointer-events: auto; \}/, 'shown by the pointer or by keyboard focus');
  const { TERMINAL_SPLITS } = loadUI('workspace/useProjectReorder.ts', { motion: {} });
  const split = { dataset: { terminalId: 'codex' } }, grip = { closest: selector => selector === '[data-terminal-id]' ? split : null };
  assert.deepEqual(TERMINAL_SPLITS.item({ closest: selector => selector === '.terminal-split-grip' ? grip : null }), { element: split, id: 'codex' });
  assert.equal(TERMINAL_SPLITS.item({ closest: () => null }), null, 'only the grip picks a split up');
});
