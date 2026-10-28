const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { choiceKeys, selectedChoiceIndex, choiceIdentity, writeChoiceKeys } = require('../src/features/reading/choice-keys.ts');
const { parseAgentScreen } = require('../src/features/agents/agent-screen.ts');
const en = require('../electron/locales/en.json');

// Components use test-only screen values until feat/screen-parser replaces the stub.
const fakeScreen = overrides => ({
  banner: { product: 'Claude Code', version: '2.1.293', model: 'Opus 5.5', effort: 'high', plan: 'Claude Max', directory: 'C:\\work\\demo-app' },
  status: { model: null, effort: null, context: 'ctx 4%', mode: 'manual mode on', notes: [] },
  choice: null, overlay: 'none', ...overrides,
});
const fakeChoice = () => ({
  kind: 'permission', title: 'Run this command?', context: ['$ echo hello', 'Reason: write hello.txt'],
  options: [
    { number: 1, label: 'Yes', detail: '', hotkey: 'y', selected: false },
    { number: 2, label: 'Always allow', detail: 'Commands starting with echo', hotkey: 'p', selected: true },
    { number: 3, label: 'No', detail: '', hotkey: 'esc', selected: false },
  ], hint: 'Enter to confirm · Esc to cancel',
});

// Transpile only these UI modules. No Electron, DOM, terminal or production parser is started.
function loadUI(name, overrides = {}) {
  const filename = path.join(__dirname, '..', 'src', name);
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = mod.require.bind(mod);
  mod.require = name => {
    const key = name.startsWith('.') ? './' + path.basename(name) : name;
    if (Object.hasOwn(overrides, key)) return overrides[key];
    if (name.endsWith('.css')) return {};
    // Every icon renders as a plain svg carrying its class name.
    if (name === '@phosphor-icons/react') return new Proxy({}, { get: () => props => React.createElement('svg', { className: props.className }) });
    if (key === './i18n') return { currentLanguage: () => 'en', t: (text, values = {}) => (en[text] ?? text).replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match) };
    if (key === './choice-keys') return require('../src/features/reading/choice-keys.ts');
    if (key === './approval-action') return require('../src/features/reading/approval-action.ts');
    if (key === './dictation-send') return require('../src/features/reading/dictation-send.ts');
    if (key === './reading-sessions') return require('../src/features/reading/reading-sessions.ts');
    if (key === './reply-files') return require('../src/features/reading/reply-files.ts');
    if (key === './reading-paths') return { pathTooltip: () => 'Ctrl+click to show in File Explorer', markReadingPaths() {} };
    if (key === './PathText') return { PathText: ({ text }) => text };
    if (key === './useReadingPaths') return { useReadingPaths: () => ({}) };
    if (key === './ReadingTerminalPopup') return { ReadingTerminalPopup: function ReadingTerminalPopup() { return null; } };
    if (key === './ReadingSignIn') return { ReadingSignIn: () => null };
    if (key === './AgentCommandRun') return { AgentCommandRun: () => null };
    if (key === './NativeApprovalCard') return { NativeApprovalCard: () => null };
    if (key === './ManagedSession') return { ManagedSession: () => null };
    if (key === './Timeline') return loadUI('features/reading/Timeline.tsx');
    if (key === './ResultCard') return loadUI('features/reading/ResultCard.tsx');
    if (key === './result-round') return require('../src/features/reading/result-round.ts');
    if (key === './typing') return require('../src/features/reading/typing.ts');
    if (key === './composer-prefill') return require('../src/features/reading/composer-prefill.ts');
    if (key === './image-thumbnail') return require('../src/features/reading/image-thumbnail.ts');
    if (key === './markdown-escape') return require('../src/features/reading/markdown-escape.ts');
    if (key === './pasted-pictures') return require('../src/features/reading/pasted-pictures.ts');
    if (key === './sign-in-screen') return require('../src/features/agents/sign-in-screen.ts');
    if (key === './UserAvatar') return { UserAvatar: () => React.createElement('svg') };
    if (key === './file-popup') return { showPopup: () => {}, closePopup: () => {}, usePopup: () => null };
    return originalRequire(name);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  return mod.exports;
}

function projectHeaderHarness(t) {
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const slots = [], effects = [], listeners = new Map(), focused = [], started = [];
  let cursor = 0;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = value; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useEffect(callback, deps) {
      const index = cursor++, previous = slots[index];
      if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      effects.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: callback() }; });
    },
  };
  globalThis.window = { innerWidth: 1600, agentrix: { startTerminal: id => { started.push(id); return Promise.resolve({ ok: true }); } } };
  globalThis.document = {
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name, listener) => { if (listeners.get(name) === listener) listeners.delete(name); },
  };
  t.after(() => {
    for (const slot of slots) slot?.cleanup?.();
    globalThis.window = previousWindow; globalThis.document = previousDocument;
  });
  const { ProjectPanel } = loadUI('features/workspace/ProjectPanel.tsx', {
    react: hooks,
    './ProjectTerminals': { ProjectTerminals: () => null },
    './ActivityPane': { ActivityPane: () => null },
    './ProjectImageDialog': { ProjectImageDialog: () => null },
    './IconButton': loadUI('shared/IconButton.tsx'),
    './active-terminal': { useActiveTerminal: () => null, setActiveTerminal() {} },
    './voice-input': { useVoice: () => ({ recording: null }) },
    './shortcuts': { shortcut: () => '' },
    './time': { relativeTime: () => '' },
    './i18n': { t: (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, name) => values[name]) },
  });
  const props = {
    project: { id: 'project', name: 'Example', path: '/example', branch: 'main', status: 'codex',
      unread: 0, codexActive: true, codexActivity: 'unknown', agent: 'codex', error: null, lastCompletedAt: null,
      terminals: [{ id: 'terminal', sessionId: 'session', status: 'codex', codexActive: true }] },
    index: 0, hidden: false, focused: false, activityOpen: true, fontSize: 12, now: 0,
    onFocus: id => focused.push(id), onAction: promise => promise, onError: assert.fail, onOpenLink() {}, onRevealProject() {},
  };
  const render = () => {
    cursor = 0;
    const root = ProjectPanel(props);
    while (effects.length) effects.shift()();
    return elements(root);
  };
  return { props, render, listeners, focused, started };
}

test('only a focused project with the activity toggle off omits the header actions, at every window width, and no card header has a mode toggle', t => {
  const h = projectHeaderHarness(t);
  for (const width of [1600, 1000, 800]) for (const focused of [false, true]) for (const activityOpen of [false, true]) {
    window.innerWidth = width;
    Object.assign(h.props, { focused, activityOpen });
    const nodes = h.render(), visible = !focused || activityOpen;
    const label = `${width}px, focused=${focused}, activityOpen=${activityOpen}`;
    assert.equal(nodes.some(node => node.props.className?.startsWith('status-badge')), visible, `status: ${label}`);
    // The terminal / reading switch is in the title bar of the expanded project (ModeSwitch), never in a card header.
    assert.equal(nodes.some(node => node.props.label === '切换到终端' || node.props.label === '阅读视图：按文档排版显示对话'), false, `no mode toggle: ${label}`);
    assert.equal(nodes.some(node => node.props.className === 'panel-menu-anchor'), visible, `more menu: ${label}`);
    assert.equal(nodes.find(node => node.props.className === 'panel-name').props.children[0].props.children, 'Example');
  }
});

test('the unread status button still opens a grid card with either activity toggle setting', t => {
  const h = projectHeaderHarness(t);
  h.props.project.unread = 1;
  for (const activityOpen of [false, true]) {
    h.props.activityOpen = activityOpen;
    const button = h.render().find(node => node.props.className?.includes('status-button'));
    assert.equal(button.type, 'button'); button.props.onClick();
  }
  assert.deepEqual(h.focused, ['project', 'project']);
});

test('the project badge follows the work gate for orphan receipts and genuinely open jobs', t => {
  const { CompletionWork } = require('../electron/completion-work.cjs');
  const work = new CompletionWork({ now: () => 2000 }), h = projectHeaderHarness(t);
  t.after(() => work.reset());
  h.props.project.agent = 'claude';
  const record = value => work.record({ timestamp: new Date(2000).toISOString(), ...value }, 'claude');
  const badge = () => {
    h.props.project.codexActivity = work.state({ state: 'complete' });
    return renderToStaticMarkup(h.render().find(node => node.props.className?.startsWith('status-badge')));
  };
  record({ type: 'queue-operation', operation: 'enqueue', content: '<task-notification><task-id>old-shell</task-id><tool-use-id>old-launch</tool-use-id><status>killed</status></task-notification>' });
  assert.match(badge(), /status-badge is-complete/); assert.match(badge(), /本轮已完成/);
  h.props.project.unread = 1;
  assert.match(badge(), /status-badge is-review/); assert.match(badge(), /等待你查看/);
  record({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'job', input: { command: 'npm test', run_in_background: true } }] } });
  assert.match(badge(), /status-badge is-working/); assert.match(badge(), /正在处理/);
});

test('a stopped single terminal can restart while the focused header actions are hidden', t => {
  const h = projectHeaderHarness(t);
  Object.assign(h.props, { focused: true, activityOpen: false });
  for (const status of ['stopped', 'exited']) {
    h.props.project.terminals[0].status = status;
    const restart = h.render().find(node => node.props['aria-label'] === '重新启动');
    assert.ok(restart); restart.props.onClick();
  }
  assert.deepEqual(h.started, ['terminal', 'terminal']);
});

test('hiding the header actions closes its open menu and removes the dismiss listener without reopening it later', t => {
  const h = projectHeaderHarness(t);
  h.props.activityOpen = false;
  const openMenu = () => {
    h.render().find(node => node.props.label === 'Example 的更多操作').props.onClick();
    assert.ok(h.render().some(node => node.props.role === 'menu'));
    assert.equal(h.listeners.size, 1);
  };
  const closedMenu = () => {
    assert.equal(h.render().some(node => node.props.role === 'menu'), false);
    assert.equal(h.listeners.size, 0);
  };
  openMenu(); h.props.focused = true; closedMenu();
  h.props.activityOpen = true; closedMenu();
  openMenu(); h.props.activityOpen = false; closedMenu();
  h.props.activityOpen = true; closedMenu();
});

test('named timeline heads show their time even in the same minute as the previous step', () => {
  const { TimelineStep, stepTime } = loadUI('features/reading/Timeline.tsx');
  const at = new Date(2026, 9, 17, 16, 16, 20).getTime();
  for (const who of ['你', 'Claude Code', 'Codex']) {
    const html = renderToStaticMarkup(React.createElement(TimelineStep, {
      at, kind: who === '你' ? 'user' : 'agent', who, showTime: false, mark: null,
    }, 'message'));
    assert.ok(html.includes(`<b class="reading-step-label">${who}</b><time dateTime="${new Date(at).toISOString()}">${stepTime(at)}</time>`), who);
  }
});

test('child replies and tools show minute changes without adding main rail nodes', () => {
  const { AgentTurnItem } = loadUI('features/reading/Timeline.tsx');
  const at = new Date(2026, 9, 17, 16, 16, 40).getTime();
  for (const kind of ['message', 'tools']) {
    const render = showTime => renderToStaticMarkup(React.createElement(AgentTurnItem, { at, kind, showTime, mark: null }, 'step'));
    assert.doesNotMatch(render(false), /<time|reading-step-head|reading-node|class="reading-step /);
    assert.match(render(true), /<time dateTime=/);
    if (kind === 'tools') assert.match(render(true), /step<time/);
  }
});

test('choice keys move up, down or confirm in place using option positions', () => {
  assert.deepEqual(choiceKeys(1, 3), ['\x1b[B', '\x1b[B', '\r']);
  assert.deepEqual(choiceKeys(3, 0), ['\x1b[A', '\x1b[A', '\x1b[A', '\r']);
  assert.deepEqual(choiceKeys(2, 2), ['\r']);
  assert.equal(selectedChoiceIndex(fakeChoice()), 1);
  assert.equal(selectedChoiceIndex({ ...fakeChoice(), options: [] }), 0);
});

test('choice identity survives cursor redraws and changes for the next menu', () => {
  const choice = fakeChoice();
  assert.equal(choiceIdentity(choice), choiceIdentity({ ...choice, options: choice.options.map(option => ({ ...option, selected: !option.selected })) }));
  assert.notEqual(choiceIdentity(choice), choiceIdentity({ ...choice, title: 'Select effort' }));
  assert.notEqual(choiceIdentity(choice), choiceIdentity({ ...choice, options: choice.options.slice(1) }));
});

test('choice writes are separate and spaced 25 ms apart, with Enter last', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const written = [];
  const pending = writeChoiceKeys(0, 2, key => written.push(key));
  assert.deepEqual(written, ['\x1b[B']);
  t.mock.timers.tick(24); await Promise.resolve(); assert.equal(written.length, 1);
  t.mock.timers.tick(1); await Promise.resolve(); assert.deepEqual(written, ['\x1b[B', '\x1b[B']);
  t.mock.timers.tick(25); await pending; assert.deepEqual(written, ['\x1b[B', '\x1b[B', '\r']);
});

test('dismissing a choice aborts its remaining keys', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let active = true; const written = [];
  const pending = writeChoiceKeys(2, 0, key => written.push(key), () => active);
  active = false; t.mock.timers.tick(25); await pending;
  assert.deepEqual(written, ['\x1b[A']);
});

test('screen parser stub preserves its replacement contract', () => {
  for (const agent of ['claude', 'codex']) assert.deepEqual(parseAgentScreen(agent, ['anything']), {
    banner: null, status: { model: null, effort: null, context: null, mode: null, notes: [] }, choice: null, overlay: 'none',
  });
});

test('welcome renders CLI metadata and the cached agent commands without a terminal toggle', () => {
  const { ReadingWelcome } = loadUI('features/reading/ReadingWelcome.tsx');
  for (const agent of ['claude', 'codex']) {
    const names = agent === 'claude' ? ['/init', '/help', '/model', '/status', '/review'] : ['/init', '/model', '/status', '/review', '/permissions'];
    const commands = names.map(name => ({ name, source: 'builtin', description: '审查代码', view: 'reading' }));
    const html = renderToStaticMarkup(React.createElement(ReadingWelcome, { agent, screen: fakeScreen(), commands, complete: () => {}, disabled: false }));
    assert.match(html, /Claude Code/); assert.match(html, /v2\.1\.293/); assert.match(html, /Opus 5\.5/); assert.match(html, /high/);
    assert.match(html, /Claude Max/); assert.match(html, /C:\\work\\demo-app/); assert.match(html, /Review code/);
    assert.equal((html.match(/<button/g) ?? []).length, 5);
    for (const name of names) assert.ok(html.includes(name));
    assert.doesNotMatch(html, /切换到终端|Switch to terminal/);
  }
});

test('welcome uses startup spinner and status model before a banner is available', () => {
  const { ReadingWelcome } = loadUI('features/reading/ReadingWelcome.tsx');
  const screen = fakeScreen({ banner: null, status: { model: 'GPT-6.1-Sol', effort: 'high', context: null, mode: null, notes: [] } });
  const html = renderToStaticMarkup(React.createElement(ReadingWelcome, { agent: 'codex', screen, commands: [], complete: () => {}, disabled: false }));
  assert.match(html, /Codex/); assert.match(html, /Starting…/); assert.match(html, /loading-spinner/); assert.match(html, /GPT-6\.1-Sol/);
});

test('welcome without a banner settles to the agent name and parsed status without a spinner', () => {
  const { ReadingWelcome } = loadUI('features/reading/ReadingWelcome.tsx');
  const html = renderToStaticMarkup(React.createElement(ReadingWelcome, {
    agent: 'claude', screen: fakeScreen({ banner: null }), commands: [], complete() {}, disabled: false, starting: false,
  }));
  assert.match(html, /Claude Code/); assert.doesNotMatch(html, /Starting…|loading-spinner/);
  const withModel = renderToStaticMarkup(React.createElement(ReadingWelcome, {
    agent: 'claude', screen: fakeScreen({ banner: null, status: { model: 'Opus 5.5', effort: 'high', notes: [] } }), commands: [], complete() {}, disabled: false, starting: false,
  }));
  assert.match(withModel, /Opus 5\.5/); assert.match(withModel, /high/); assert.doesNotMatch(withModel, /Starting…|loading-spinner/);
});

function sessionsHarness(t, initialSessions = []) {
  const slots = [initialSessions], written = [], followed = [], sent = [], errors = []; let cursor = 0, closed = 0;
  const hooks = {
    useState: initial => {
      const index = cursor++;
      if (!Object.hasOwn(slots, index)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef: initial => {
      const index = cursor++;
      if (!Object.hasOwn(slots, index)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect() {},
  };
  const previous = globalThis.window;
  globalThis.window = { agentrix: {
    writeTerminal: (id, text) => written.push({ id, text }),
    followAgentSession: async (id, sessionId) => { followed.push({ id, sessionId }); return { ok: true, value: true }; },
  } };
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  const { ReadingSessions } = loadUI('features/reading/ReadingSessions.tsx', { react: hooks });
  const render = () => {
    cursor = 0;
    const root = ReadingSessions({ terminalId: 'resume-terminal', onClose: () => { closed++; }, onSent: text => sent.push(text), onError: error => errors.push(error) });
    root.props.ref.current = { focus() {} }; return root;
  };
  const press = key => {
    let prevented = false;
    render().props.onKeyDown({ key, nativeEvent: {}, preventDefault: () => { prevented = true; }, stopPropagation() {} });
    assert.equal(prevented, true);
  };
  const options = () => elements(render()).filter(node => node.props.className === 'reading-choice-option');
  return { render, press, options, written, followed, sent, errors, closed: () => closed };
}

test('native session card arrows highlight, Enter types a targeted resume and follows after Enter', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sessions = ['first', 'second'].map(id => ({ id, title: id, updatedAt: Date.now() - 180000, messages: 3 }));
  const h = sessionsHarness(t, sessions);
  assert.equal(h.options()[0].props['data-highlighted'], true);
  h.press('ArrowDown'); assert.equal(h.options()[1].props['data-highlighted'], true);
  h.press('ArrowUp'); assert.equal(h.options()[0].props['data-highlighted'], true);
  h.press('ArrowDown'); h.press('Enter'); h.press('Enter'); h.press('Escape');
  // What waits in Claude's input is cleared first, then the command is typed.
  assert.deepEqual(h.written, [{ id: 'resume-terminal', text: '\x15' }]); assert.deepEqual(h.followed, []);
  assert.ok(h.options().every(option => option.props.disabled));
  t.mock.timers.tick(60); for (let index = 0; index < 6; index++) await Promise.resolve();
  assert.deepEqual(h.written, [{ id: 'resume-terminal', text: '\x15' }, { id: 'resume-terminal', text: '/resume second' }]);
  t.mock.timers.tick(150);
  for (let index = 0; index < 6; index++) await Promise.resolve();
  assert.deepEqual(h.written, [{ id: 'resume-terminal', text: '\x15' }, { id: 'resume-terminal', text: '/resume second' }, { id: 'resume-terminal', text: '\r' }]);
  assert.deepEqual(h.followed, [{ id: 'resume-terminal', sessionId: 'second' }]);
  assert.deepEqual(h.sent, ['/resume second']); assert.equal(h.closed(), 1); assert.deepEqual(h.errors, []);
});

test('native session card click chooses and Esc closes without sending terminal keys', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = sessionsHarness(t, [{ id: 'clicked', title: 'Restore this prompt', updatedAt: Date.now(), messages: 2 }]);
  const option = h.options()[0]; void option.props.onClick();
  t.mock.timers.tick(60); for (let index = 0; index < 6; index++) await Promise.resolve();
  assert.deepEqual(h.written, [{ id: 'resume-terminal', text: '\x15' }, { id: 'resume-terminal', text: '/resume clicked' }]);
  t.mock.timers.tick(150); for (let index = 0; index < 6; index++) await Promise.resolve();
  assert.equal(h.closed(), 1);
  const empty = sessionsHarness(t);
  empty.press('ArrowDown'); empty.press('Enter'); empty.press('Escape');
  assert.equal(empty.closed(), 1); assert.deepEqual(empty.written, []);
  const labels = elements(empty.render()).flatMap(node => typeof node.props.children === 'string' ? [node.props.children] : []);
  assert.ok(labels.includes('This project has no other Claude sessions yet'));
});

test('choice renders context, printed numbers, details, hotkeys and CLI selection', () => {
  const { ReadingChoice } = loadUI('features/reading/ReadingChoice.tsx');
  const html = renderToStaticMarkup(React.createElement(ReadingChoice, { choice: fakeChoice(), terminalId: 'test', onError: () => {} }));
  assert.match(html, /is-permission/); assert.match(html, /Run this command\?/); assert.match(html, /\$ echo hello/);
  assert.match(html, /Commands starting with echo/); assert.match(html, /<kbd>p<\/kbd>/);
  assert.match(html, /is-cli-selected/); assert.match(html, /data-highlighted="true"/);
  assert.match(html, /data-approval-mode="terminal-only"/); assert.match(html, /Open terminal/);
  assert.match(html, /Confirm or reject this request in the source terminal/); assert.doesNotMatch(html, /Enter to confirm|Cancel/);
});

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  return [node, ...elements(node.props.children)];
}

const composerRows = (agent, activity = 'idle', draft = '') => [
  ...(activity === 'working' ? [agent === 'claude' ? '✶ Swooping… (12s)' : '• Working (12s • esc to interrupt)'] : []),
  ...(activity === 'shell' ? ['! sleep 10', '  ⎿ Running…'] : []),
  ...(agent === 'claude' ? ['────', '❯ ' + draft, '────', '  ⏸ manual mode on']
    : ['› ' + draft, '', 'GPT-6.1-Sol high · C:\\work', '? for shortcuts']),
];

// Run ReadingView's composer handlers and effect cleanup without starting a browser or Electron.
function dictationHarness(t, overrides = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slots = [], effects = [], written = [], pasted = [], echoed = [];
  let cursor = 0, root, insert;
  const listeners = new Map();
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!Object.hasOwn(slots, index)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!Object.hasOwn(slots, index)) slots[index] = { current: initial };
      return slots[index];
    },
    useMemo(make) { cursor++; return make(); },
    useEffect(effect, deps) {
      const index = cursor++, previous = slots[index];
      if (previous && deps && deps.length === previous.deps?.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      const slot = slots[index] = { deps, cleanup: previous?.cleanup };
      effects.push(() => { slot.cleanup?.(); slot.cleanup = effect(); });
    },
  };
  hooks.useLayoutEffect = hooks.useEffect;
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const node = { value: '', selectionStart: 0, selectionEnd: 0, dataset: {},
    focus() { document.activeElement = node; },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
  };
  globalThis.document = { activeElement: node, body: {}, getElementById: () => null, createElement: () => ({ innerHTML: '', querySelectorAll: () => [] }) };
  globalThis.window = { addEventListener: (name, take) => listeners.set(name, take), removeEventListener: name => listeners.delete(name), agentrix: {
    terminalCommands: async () => ({ ok: true, value: [] }),
    writeTerminal: (id, text) => written.push({ id, text }),
    pasteTerminal: async (id, text) => { pasted.push({ id, text }); return { ok: true }; },
  } };
  const props = { projectId: 'project', terminal: { id: 'dictation', sessionId: 'session', agent: 'codex', codexActive: true, needsInput: null },
    autoFocus: false, onShowTerminal() {}, onError: message => assert.fail(message), onOpenLink() {},
  };
  const screen = fakeScreen();
  const { ReadingView } = loadUI('features/reading/ReadingView.tsx', {
    react: hooks, dompurify: { default: () => ({ sanitize: html => html }) },
    './action-text': {}, './cli-panel': require('../src/features/reading/cli-panel.ts'),
    './pending-prompts': require('../src/features/reading/pending-prompts.ts'),
    './voice-input': { dictateInto: (id, take) => { insert = take; return () => { insert = null; }; } },
    './terminal-screen': { useScreen: () => null, readScreen: () => ({ rows: ['› ', '', 'GPT-6.1-Sol high · C:\\work'] }) },
    './agent-screen': { parseAgentScreen: () => screen },
    './ReadingWelcome': {}, './ReadingChoice': {}, './ReadingQuestion': {}, './ReadingSessions': {},
    './reading-mode': { setChoiceVisible() {} }, './typing': { markTyping() {}, isTyping: () => false },
    './useStickToBottom': { useStickToBottom: () => ({ stuck: true, unseen: 0, ready: true, holdPosition() {}, toBottom() {} }) },
    './useReadingConversation': { conversationKey: () => 'session', useReadingConversation: () => [] },
    './useVisibleTail': { blocks: () => [], conversationTurns: () => [], useVisibleTail: () => ({ earlier: 0, visible: [] }) },
    './useMentions': { useMentions: () => ({ open: false, keys: () => false }) }, './MentionPalette': {},
    './usePendingPrompts': { usePendingPrompts: () => ({ pending: [], echo: (text, images) => { echoed.push({ text, images }); return null; }, cancelEcho() {} }) },
    './PendingPromptEntries': {}, './markdown-parse': {}, './FileCards': {},
    './reading-welcome': { useWelcomeStarting: () => false },
    './image-thumbnail': { thumbnail: async () => 'data:image/png;base64,picture' },
    ...overrides,
  });
  const render = () => {
    cursor = 0; root = ReadingView(props);
    // The public component routes managed SDK sessions before mounting the legacy TUI reader.
    if (typeof root.type === 'function') root = root.type(root.props);
    const box = elements(root).find(element => element.type === 'textarea');
    box.props.ref.current = node; node.value = box.props.value;
    while (effects.length) effects.shift()();
    elements(root).find(element => element.type?.name === 'ReadingTerminalPopup')?.props.onReady();
    return box;
  };
  const unmount = () => { for (const slot of slots) if (slot?.cleanup) { slot.cleanup(); slot.cleanup = undefined; } };
  t.after(() => { unmount(); globalThis.window = previousWindow; globalThis.document = previousDocument; });
  render(); render();
  return { props, screen, node, written, pasted, echoed, render, unmount, tree: () => root,
    popup: () => elements(root).find(element => element.type?.name === 'ReadingTerminalPopup'),
    command(text) { listeners.get('agentrix:command')({ detail: { terminalId: props.terminal.id, text }, preventDefault() {} }); render(); },
    dictate: (text, submit = true) => { insert(text, submit); render(); },
    edit: text => { render().props.onChange({ target: { value: text } }); render(); },
    pending: () => elements(root).some(element => /\bis-sending-soon\b/.test(element.props.className)),
    press(key) {
      const event = { key, currentTarget: node, nativeEvent: {}, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
      render().props.onKeyDown(event); render(); return event;
    },
    async tick(ms) { t.mock.timers.tick(ms); for (let i = 0; i < 12; i++) await Promise.resolve(); render(); },
  };
}

test('submitted dictation appears at the caret for half a second, then uses the composer send with pictures', async t => {
  const h = dictationHarness(t);
  h.edit('before replace after'); h.node.setSelectionRange(7, 14);
  h.render().props.onPaste({ preventDefault() {}, clipboardData: { getData: () => '', items: [{ kind: 'file', type: 'image/png', getAsFile: () => ({ size: 1 }) }] } });
  await h.tick(0);
  h.dictate('spoken');
  assert.equal(h.node.value, 'before spoken after');
  assert.equal(document.activeElement, h.node);
  assert.equal(h.node.selectionStart, 13); assert.equal(h.node.selectionEnd, 13);
  assert.equal(h.pending(), true);
  await h.tick(499); assert.deepEqual(h.pasted, []);
  await h.tick(1);
  assert.deepEqual(h.pasted, [{ id: 'dictation', text: 'before spoken after' }]);
  assert.deepEqual(h.echoed, [{ text: 'before spoken after', images: ['data:image/png;base64,picture'] }]);
  assert.equal(h.pending(), false); assert.equal(h.node.value, '');
  await h.tick(2000); assert.equal(h.pasted.length, 1);
});

test('Enter sends pending dictation at once and disarms its timer', async t => {
  const h = dictationHarness(t);
  h.dictate('send now'); h.press('Enter'); await h.tick(0);
  assert.deepEqual(h.pasted, [{ id: 'dictation', text: 'send now' }]);
  assert.equal(h.pending(), false);
  await h.tick(2000); assert.equal(h.pasted.length, 1);
});

test('Escape only cancels pending dictation, leaving text alone', async t => {
  const h = dictationHarness(t);
  h.props.terminal.codexActivity = 'working';
  h.dictate('keep for editing');
  const event = h.press('Escape');
  assert.equal(event.prevented, true); assert.equal(event.stopped, true);
  assert.deepEqual(h.written, []);
  assert.equal(h.node.value, 'keep for editing'); assert.equal(h.pending(), false);
  await h.tick(1000); assert.deepEqual(h.pasted, []);
});

test('editing, clearing and starting IME input cancel dictation without sending', async t => {
  for (const action of ['edit', 'clear', 'compose']) await t.test(action, async t => {
    const h = dictationHarness(t); h.dictate('keep');
    if (action === 'compose') h.render().props.onCompositionStart();
    else h.edit(action === 'clear' ? '' : 'keep editing');
    await h.tick(1000);
    assert.deepEqual(h.pasted, []); assert.equal(h.pending(), false);
    assert.equal(h.node.value, action === 'clear' ? '' : action === 'edit' ? 'keep editing' : 'keep');
  });
});

test('terminal changes, split selection and unmount cancel pending dictation', async t => {
  for (const action of ['terminal', 'session', 'selection', 'unmount']) await t.test(action, async t => {
    const h = dictationHarness(t); h.props.autoFocus = true; h.render(); h.dictate('cancel on leaving');
    if (action === 'terminal') h.props.terminal = { ...h.props.terminal, id: 'other' };
    if (action === 'session') h.props.terminal = { ...h.props.terminal, sessionId: 'other' };
    if (action === 'selection') h.props.autoFocus = false;
    if (action === 'unmount') h.unmount(); else h.render();
    await h.tick(1000); assert.deepEqual(h.pasted, []);
  });
});

test('the delayed send respects a newly blocked composer', async t => {
  const h = dictationHarness(t); h.dictate('wait');
  h.screen.choice = fakeChoice(); h.render();
  await h.tick(1000);
  assert.deepEqual(h.pasted, []); assert.equal(h.node.value, 'wait'); assert.equal(h.pending(), false);
});

test('dictation without submit inserts and focuses without scheduling a send', async t => {
  const h = dictationHarness(t); document.activeElement = null;
  h.dictate('insert only', false);
  assert.equal(h.node.value, 'insert only'); assert.equal(document.activeElement, h.node);
  assert.equal(h.node.selectionStart, 11); assert.equal(h.pending(), false);
  await h.tick(2000); assert.deepEqual(h.pasted, []);
});

// Exercise the component's handlers with persistent hook slots, without a DOM or native GUI.
function choiceHarness(t, choice = { ...fakeChoice(), kind: 'menu' }) {
  const slots = []; let cursor = 0;
  const hooks = {
    useState: initial => {
      const index = cursor++;
      if (!Object.hasOwn(slots, index)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef: initial => {
      const index = cursor++;
      if (!Object.hasOwn(slots, index)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect: () => {},
  };
  const written = [], previous = globalThis.window;
  globalThis.window = { agentrix: { writeTerminal: (id, key) => written.push({ id, key }) } };
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  const { ReadingChoice } = loadUI('features/reading/ReadingChoice.tsx', { react: hooks });
  const render = () => {
    cursor = 0;
    const root = ReadingChoice({ choice, terminalId: 'native-choice', onError: message => assert.fail(message) });
    root.props.ref.current = { focus: () => {} };
    return root;
  };
  const press = key => {
    let prevented = false;
    render().props.onKeyDown({ key, nativeEvent: { isComposing: false }, preventDefault: () => { prevented = true; }, stopPropagation: () => {} });
    assert.equal(prevented, true);
  };
  const options = () => elements(render()).filter(node => node.props.className?.split(' ').includes('reading-choice-option'));
  return { written, render, press, options };
}

test('welcome command rows call the existing completion callback with the cached command', () => {
  const { ReadingWelcome } = loadUI('features/reading/ReadingWelcome.tsx');
  const command = { name: '/model', source: 'builtin', description: '切换模型', view: 'terminal' };
  const picked = [];
  const root = ReadingWelcome({ agent: 'claude', screen: fakeScreen(), commands: [command], complete: value => picked.push(value), disabled: false });
  elements(root).find(node => node.type === 'button').props.onClick();
  assert.deepEqual(picked, [command]);
});

test('choice arrows move a local highlight; Enter submits once and keeps a pending card', t => {
  const harness = choiceHarness(t);
  assert.equal(harness.options()[1].props['data-highlighted'], true);
  harness.press('ArrowDown'); assert.equal(harness.options()[2].props['data-highlighted'], true);
  harness.press('ArrowUp'); assert.equal(harness.options()[1].props['data-highlighted'], true);
  assert.deepEqual(harness.written, []);
  harness.press('Enter'); harness.press('Enter'); harness.press('Escape');
  assert.deepEqual(harness.written, [{ id: 'native-choice', key: '\r' }]);
  assert.equal(harness.render().props['aria-busy'], true);
  assert.ok(harness.options().every(option => option.props.disabled));
  assert.ok(elements(harness.options()[1]).some(node => node.props.className === 'loading-spinner'));
});

test('choice number keys target printed numbers and write relative to the CLI cursor', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const choice = { ...fakeChoice(), kind: 'menu' }; choice.options.forEach((option, index) => { option.number = [4, 7, 9][index]; });
  const harness = choiceHarness(t, choice);
  harness.press('4'); harness.options()[2].props.onClick();
  assert.deepEqual(harness.written, [{ id: 'native-choice', key: '\x1b[A' }]);
  t.mock.timers.tick(25); await Promise.resolve();
  assert.deepEqual(harness.written, [{ id: 'native-choice', key: '\x1b[A' }, { id: 'native-choice', key: '\r' }]);
});

test('Enter on a focused button presses that button, never the highlighted option (Cancel never approves)', t => {
  const harness = choiceHarness(t);
  let prevented = false;
  const button = { closest: selector => selector === 'button' ? button : null };
  harness.render().props.onKeyDown({ key: 'Enter', target: button, nativeEvent: { isComposing: false }, preventDefault: () => { prevented = true; }, stopPropagation: () => {} });
  assert.equal(prevented, false, 'the button keeps its own Enter');
  assert.deepEqual(harness.written, [], 'nothing chosen for it');
});

test('choice Esc and cancel button each send a single Escape and wait for CLI dismissal', t => {
  for (const action of ['Escape', 'button']) {
    const harness = choiceHarness(t);
    if (action === 'Escape') harness.press('Escape');
    else elements(harness.render()).find(node => node.props.className === 'text-button').props.onClick();
    harness.press('Escape'); harness.press('Enter');
    assert.deepEqual(harness.written, [{ id: 'native-choice', key: '\x1b' }]);
    assert.equal(harness.render().props['aria-busy'], true);
  }
});

function readingMode() {
  return loadUI('features/reading/reading-mode.ts', { react: { useSyncExternalStore: (_subscribe, snapshot) => snapshot() } });
}
const terminal = (id, needsInput = 'Allow command?') => ({ id, sessionId: 'session', codexActive: true, needsInput });
const isReading = (mode, value) => mode.readingShown(value, mode.useTerminalChoice());

test('needsInput falls back at 1.5 seconds and automatically returns after acknowledgment', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mode = readingMode(), value = terminal('fallback');
  mode.syncReading(value); assert.equal(isReading(mode, value), true);
  t.mock.timers.tick(1499); assert.equal(isReading(mode, value), true);
  t.mock.timers.tick(1); assert.equal(isReading(mode, value), false);
  mode.syncReading(terminal(value.id, null)); assert.equal(isReading(mode, value), true);
});

test('a parsed choice cancels a pending handoff and its disappearance does not rearm that notice', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mode = readingMode(), value = terminal('native');
  mode.syncReading(value); t.mock.timers.tick(1000); mode.setChoiceVisible(value.id, true);
  t.mock.timers.tick(1000); assert.equal(isReading(mode, value), true);
  mode.setChoiceVisible(value.id, false); mode.syncReading(value); t.mock.timers.tick(2000);
  assert.equal(isReading(mode, value), true);
  mode.syncReading(terminal(value.id, null)); mode.syncReading(value); t.mock.timers.tick(1500);
  assert.equal(isReading(mode, value), false, 'a new notice gets its own timeout');
});

test('a choice already visible keeps reading open for a permission hook', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mode = readingMode(), value = terminal('already-visible');
  mode.setChoiceVisible(value.id, true); mode.syncReading(value); t.mock.timers.tick(5000);
  assert.equal(isReading(mode, value), true);
});

test('permission notice clearing or agent exit cancels its timeout', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mode = readingMode(), value = terminal('cancel');
  mode.syncReading(value); mode.syncReading(terminal(value.id, null)); t.mock.timers.tick(1500);
  assert.equal(isReading(mode, value), true);
  mode.syncReading(value); mode.syncReading({ ...value, codexActive: false }); t.mock.timers.tick(1500);
  assert.equal(isReading(mode, value), true);
});

test('one automatic handoff per notice and manual toggles cancel automatic return', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mode = readingMode(), value = terminal('manual');
  mode.syncReading(value); t.mock.timers.tick(1500); assert.equal(isReading(mode, value), false);
  mode.setReading(value.id, true); mode.syncReading(value); t.mock.timers.tick(1500);
  assert.equal(isReading(mode, value), true);
  mode.syncReading(terminal(value.id, null)); mode.syncReading(value); t.mock.timers.tick(1500);
  mode.setReading(value.id, false); mode.syncReading(terminal(value.id, null));
  assert.equal(isReading(mode, value), false);
  mode.agentExited({ ...value, codexActive: false }); assert.equal(isReading(mode, value), true);
});

test('manual choice during the delay cancels the pending handoff', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mode = readingMode(), value = terminal('manual-delay');
  mode.syncReading(value); mode.setReading(value.id, false); mode.setReading(value.id, true); t.mock.timers.tick(1500);
  assert.equal(isReading(mode, value), true);
});

test('choice visibility and handoff timers are isolated per terminal', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mode = readingMode(), first = terminal('first'), second = terminal('second');
  mode.syncReading(first); mode.syncReading(second); mode.setChoiceVisible(first.id, true); t.mock.timers.tick(1500);
  assert.equal(isReading(mode, first), true); assert.equal(isReading(mode, second), false);
});

test('reading view requires an active agent and a live terminal session', () => {
  const mode = readingMode(), value = terminal('shell', null);
  assert.equal(mode.readingShown({ ...value, codexActive: false }, []), false);
  assert.equal(mode.readingShown({ ...value, sessionId: null }, []), false);
});

test('the terminal surface follows reading intent even before the reading subtree exists, and respects raw choice', () => {
  const mode = readingMode(), value = { ...terminal('surface', null), title: 'Terminal', status: 'shell' };
  const { ProjectTerminals } = loadUI('features/terminal/ProjectTerminals.tsx', {
    './reading-mode': mode,
    './ReadingView': { ReadingView: () => null },
    './TerminalPane': { TerminalPane: props => React.createElement('div', { className: 'terminal-host', 'data-focused': props.focused }) },
    './AgentLauncher': { AgentLauncher: () => null }, './VoiceButton': { VoiceButton: () => null },
    './useProjectReorder': { useReorder: () => ({}) },
  });
  const render = terminal => renderToStaticMarkup(React.createElement(ProjectTerminals, {
    project: { id: 'project', name: 'Project', terminals: [terminal] }, focused: true, activeId: value.id, setActiveId() {}, fontSize: 14,
  }));
  const starting = render({ ...value, codexActive: false, agentStarting: true });
  assert.match(starting, /data-reading="true"/); assert.match(starting, /data-focused="false"/);
  const reading = render(value);
  assert.match(reading, /data-reading="true"/); assert.doesNotMatch(reading, /class="reading-view"/);
  mode.setReading(value.id, false);
  const raw = render(value);
  assert.match(raw, /data-reading="false"/); assert.match(raw, /data-focused="true"/);
  assert.match(render({ ...value, codexActive: false }), /data-reading="false"/, 'ordinary shells remain visible');
});

function readingHarness(t, entries = [], overrides = {}) {
  const tail = require('../src/features/reading/useVisibleTail.ts');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ innerHTML: '', querySelectorAll: () => [] }) } });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete globalThis.window;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else delete globalThis.document;
  });
  const state = { entries, pending: [], terminal: { id: 'terminal', sessionId: 'session', agent: 'codex', codexActive: true, needsInput: null } };
  const parsed = [], icon = () => React.createElement('svg');
  const { ReadingView } = loadUI('features/reading/ReadingView.tsx', {
    './markdown-escape': { readingMarked: { parse: text => { parsed.push(text); return text; } } },
    dompurify: { default: () => ({ sanitize: html => html }) },
    '@phosphor-icons/react': new Proxy({}, { get: () => icon }),
    './action-text': { stepVerb: tool => tool.kind, actionText: tool => tool.target }, './voice-input': {}, './terminal-screen': { useScreen: () => null },
    './agent-screen': { parseAgentScreen: () => fakeScreen() },
    './ReadingWelcome': { ReadingWelcome: () => React.createElement('p', null, 'welcome preserved') },
    './ReadingChoice': {}, './ReadingQuestion': {}, './reading-mode': {},
    './useStickToBottom': { useStickToBottom: () => ({ stuck: true, unseen: 0, ready: true, holdPosition() {}, toBottom() {} }) },
    './useReadingConversation': { conversationKey: () => 'session', useReadingConversation: () => state.entries },
    './useVisibleTail': tail, './reading.css': {},
    './useMentions': { useMentions: () => ({ open: false }) }, './MentionPalette': { MentionPalette: () => null },
    './pending-prompts': require('../src/features/reading/pending-prompts.ts'),
    './usePendingPrompts': { usePendingPrompts: () => ({ pending: state.pending, echo() {}, cancelEcho() {} }) },
    './PendingPromptEntries': loadUI('features/reading/PendingPromptEntries.tsx'),
    './markdown-parse': { parseMarkdown: async () => null, parsedMarkdown: () => undefined },
    './FileCards': { FileCards: ({ files }) => React.createElement('div', { className: 'file-cards' }, files.join(',')), previewable: () => true },
    './ReadingSessions': { ReadingSessions: () => null }, './reading-sessions': require('../src/features/reading/reading-sessions.ts'),
    './reading-welcome': { useWelcomeStarting: () => false },
    './cli-panel': require('../src/features/reading/cli-panel.ts'),
    './i18n': { currentLanguage: () => 'en', t: (text, values) => (en[text] ?? text).replace(/\{(\w+)\}/g, (_, name) => String(values?.[name] ?? name)) },
    ...overrides,
  });
  const render = () => renderToStaticMarkup(React.createElement(ReadingView, {
    projectId: 'project', terminal: state.terminal,
    autoFocus: false, onShowTerminal() {}, onError() {}, onOpenLink() {},
  }));
  return { state, render, parsed, ReadingView };
}

test('reading entry rendering parses only the last 40 blocks inside a turn and leaves the welcome branch intact', t => {
  const { state, render, parsed } = readingHarness(t, Array.from({ length: 400 }, (_, index) => ({ id: String(index), at: 0, role: 'assistant', text: `answer-${index}` })));
  const html = render();
  assert.equal(parsed.length, 40);
  assert.equal(parsed[0], 'answer-360'); assert.equal(parsed.at(-1), 'answer-399');
  assert.match(html, /Show earlier conversation \(360\)/);
  assert.doesNotMatch(html, /answer-359/);
  assert.equal((html.match(/class="reading-step is-agent/g) || []).length, 1);
  state.entries = []; parsed.length = 0;
  assert.match(render(), /welcome preserved/); assert.equal(parsed.length, 0);
});

const timelineSections = html => html.split(/(?=<div class="reading-step is-)/).filter(part => part.startsWith('<div class="reading-step is-'));
const readingEntry = (id, role, minute, extra = {}) => ({ id, role, at: new Date(2026, 9, 17, 16, minute).getTime(), ...extra });
const readingTool = (id, minute, extra = {}) => readingEntry(id, 'tool', minute, { tool: { kind: 'command', tool: 'shell', target: id, done: true, failed: false, ...extra } });

test('Claude and Codex render user and agent parents with ordered child replies, leading tools and tools-only turns', t => {
  const { state, render } = readingHarness(t, [
    readingEntry('u1', 'user', 10, { text: 'first prompt' }), readingTool('skill', 11, { kind: 'skill' }),
    readingEntry('a1', 'assistant', 12, { text: 'first reply' }), readingEntry('a2', 'assistant', 13, { text: 'second reply' }),
    readingTool('cmd', 14), readingEntry('a3', 'assistant', 15, { text: 'third reply' }),
    readingEntry('u2', 'user', 16, { text: 'next prompt' }),
    readingTool('edit', 17, { kind: 'edit', written: ['report.md'] }), readingTool('failed command', 17, { failed: true }),
    readingTool('running command', 18, { done: false, detail: 'still processing' }),
  ]);
  for (const agent of ['claude', 'codex']) {
    state.terminal.agent = agent;
    const html = render(), sections = timelineSections(html);
    assert.deepEqual(sections.map(section => section.match(/reading-step is-(\w+)/)[1]), ['user', 'agent', 'user', 'agent']);
    assert.equal((html.match(/class="reading-node"/g) || []).length, 4);
    assert.equal((html.match(/class="reading-turn-tools/g) || []).length, 3);
    assert.equal((html.match(/class="reading-assistant /g) || []).length, 3);
    assert.equal((html.match(new RegExp(`<b class="reading-step-label">${agent === 'claude' ? 'Claude Code' : 'Codex'}</b>`, 'g')) || []).length, 2);
    assert.deepEqual([...sections[1].matchAll(/class="reading-turn-(tools|message)/g)].map(match => match[1]), ['tools', 'message', 'message', 'tools', 'message']);
    assert.match(sections[1], /first reply[\s\S]*second reply[\s\S]*third reply/);
    for (const minute of [10, 11, 12, 13, 14, 15, 16, 17]) {
      assert.ok(html.includes(`dateTime="${new Date(2026, 9, 17, 16, minute).toISOString()}"`));
    }
    assert.match(sections[3], /is-running/); assert.match(sections[3], /has-failed/);
    assert.match(sections[3], /aria-expanded="true"/); assert.match(sections[3], /reading-tools-tree/);
    assert.match(sections[3], /failed command/); assert.match(sections[3], /still processing/);
    assert.match(sections[3], /class="file-cards">report.md/);
  }
});

test('live thinking and confirmation stay inside the latest agent, including a tools-only history', t => {
  const { state, render } = readingHarness(t, [readingTool('leading', 11)]);
  state.terminal.codexActivity = 'working';
  let sections = timelineSections(render());
  assert.equal(sections.length, 1); assert.match(sections[0], /reading-turn-tools[\s\S]*role="status"/);
  assert.match(sections[0], /Codex is thinking/);
  state.terminal.needsInput = 'confirm this command';
  sections = timelineSections(render());
  assert.equal(sections.length, 1); assert.match(sections[0], /confirm this command/);
  state.entries = [readingEntry('user', 'user', 12, { text: 'new prompt' })];
  sections = timelineSections(render());
  assert.deepEqual(sections.map(section => section.match(/reading-step is-(\w+)/)[1]), ['user', 'agent']);
  state.entries = [readingTool('failed only', 13, { failed: true })];
  state.terminal.codexActivity = 'idle'; state.terminal.needsInput = null;
  sections = timelineSections(render());
  assert.equal(sections.length, 1); assert.match(sections[0], /class="reading-step is-agent is-codex is-failed is-latest"/);
  assert.match(sections[0], /reading-turn-tools is-failed/); assert.match(sections[0], /aria-expanded="false"/);
  assert.doesNotMatch(sections[0], /reading-tools-tree|role="status"/);
});

test('pending users retain their cards and a new sending prompt separates live agent turns; queued users wait after the active agent', t => {
  const { state, render } = readingHarness(t, [readingEntry('reply', 'assistant', 11, { text: 'answer' })]);
  state.terminal.codexActivity = 'working';
  state.pending = [{ id: 'pending', at: readingEntry('', 'user', 12).at, text: 'next prompt', sending: true }];
  let sections = timelineSections(render());
  assert.deepEqual(sections.map(section => section.match(/reading-step is-(\w+)/)[1]), ['agent', 'user', 'agent']);
  assert.match(sections[1], /reading-pending is-sending/); assert.match(sections[2], /role="status"/);
  state.entries.push(readingEntry('queued', 'user', 12, { text: 'next prompt', queued: true }));
  sections = timelineSections(render());
  assert.deepEqual(sections.map(section => section.match(/reading-step is-(\w+)/)[1]), ['agent', 'user']);
  assert.match(sections[0], /role="status"/); assert.match(sections[1], /reading-pending is-queued/);
});

test('real Claude queue records render without an echo and promote once in producer order', t => {
  const { ConversationLog, claudeConversation } = require('../electron/conversation.cjs');
  const log = new ConversationLog(), timestamp = '2026-10-17T01:00:00Z';
  log.put(readingEntry('active', 'assistant', 0, { text: 'active reply' }));
  claudeConversation(log, { type: 'queue-operation', operation: 'enqueue', timestamp, content: 'QUEUED_FROM_TERMINAL' });
  const { state, render } = readingHarness(t, log.list);
  state.terminal.agent = 'claude'; state.terminal.codexActivity = 'working';
  let html = render(), sections = timelineSections(html);
  assert.deepEqual(sections.map(section => section.match(/reading-step is-(\w+)/)[1]), ['agent', 'user']);
  assert.match(sections[0], /role="status"/); assert.match(sections[1], /reading-pending is-queued/);
  assert.equal((html.match(/QUEUED_FROM_TERMINAL/g) || []).length, 1);
  assert.match(sections[1], new RegExp(`dateTime="${timestamp.replace('Z', '.000Z')}"`));
  state.pending = [{ id: 'echo', role: 'user', text: 'QUEUED_FROM_TERMINAL', at: Date.parse(timestamp) - 100, sending: true }];
  assert.equal((render().match(/QUEUED_FROM_TERMINAL/g) || []).length, 1, 'an echo adds no duplicate');
  claudeConversation(log, { type: 'queue-operation', operation: 'dequeue', timestamp, content: 'QUEUED_FROM_TERMINAL' });
  claudeConversation(log, { type: 'attachment', uuid: 'accepted', timestamp, attachment: { type: 'queued_command', prompt: 'QUEUED_FROM_TERMINAL' } });
  state.entries = log.list;
  const prompts = require('../src/features/reading/pending-prompts.ts');
  state.pending = prompts.reconcilePendingPrompts({ sessionId: 'session', seen: [], prompts: state.pending }, 'session', state.entries, Date.parse(timestamp)).prompts;
  html = render(); sections = timelineSections(html);
  assert.equal((html.match(/QUEUED_FROM_TERMINAL/g) || []).length, 1);
  assert.match(sections[0], /active reply/); assert.match(sections[1], /QUEUED_FROM_TERMINAL/);
  assert.doesNotMatch(html, /is-queued/);
  state.entries = log.list.filter(entry => entry.role === 'user').map(entry => ({ ...entry, queued: true }));
  html = render(); assert.match(html, /QUEUED_FROM_TERMINAL/); assert.doesNotMatch(html, /welcome preserved/);
});

test('a queue receipt removes the stale card and keeps message order, while a withdrawn card is invisible', t => {
  const { ConversationLog, claudeConversation } = require('../electron/conversation.cjs');
  const log = new ConversationLog(), timestamp = '2026-10-17T01:00:00Z';
  const feed = record => claudeConversation(log, { timestamp, ...record });
  log.put(readingEntry('active', 'assistant', 0, { text: 'active reply' }));
  feed({ type: 'queue-operation', operation: 'enqueue', content: 'TAKEN_UP_WITHOUT_REMOVE' });
  feed({ type: 'user', uuid: 'accepted', message: { content: 'TAKEN_UP_WITHOUT_REMOVE' } });
  feed({ type: 'assistant', uuid: 'next', message: { content: [{ type: 'text', text: 'worked on it' }] } });
  feed({ type: 'queue-operation', operation: 'enqueue', content: 'WITHDRAWN_SEND' });
  feed({ type: 'queue-operation', operation: 'popAll', content: 'WITHDRAWN_SEND' });
  const { state, render } = readingHarness(t, log.list);
  state.terminal.agent = 'claude'; state.terminal.codexActivity = 'idle'; state.terminal.taskTitle = 'A task';
  const html = render();
  assert.doesNotMatch(html, /is-queued|WITHDRAWN_SEND/);
  assert.equal((html.match(/TAKEN_UP_WITHOUT_REMOVE/g) || []).length, 1);
  assert.ok(html.indexOf('active reply') < html.indexOf('TAKEN_UP_WITHOUT_REMOVE'));
  assert.ok(html.indexOf('TAKEN_UP_WITHOUT_REMOVE') < html.indexOf('worked on it'));
});

test('an expanded visible tool group keeps its component state through rolling eviction and snapshot refreshes', t => {
  const { applyConversationPacket } = require('../src/features/reading/conversation-buffer.ts');
  // Retain hook state at React's keyed ancestry, so a changed parent or child key resets ToolGroup's open state.
  const instances = new Map(); let slots, cursor;
  const hooks = {
    useState(initial) { const index = cursor++; if (!Object.hasOwn(slots, index)) slots[index] = typeof initial === 'function' ? initial() : initial; const own = slots; return [own[index], value => { own[index] = typeof value === 'function' ? value(own[index]) : value; }]; },
    useRef(initial) { return hooks.useState(() => ({ current: initial }))[0]; },
    useMemo(make) { return make(); }, useEffect() {}, useLayoutEffect() {},
  };
  const run = (key, component, props) => { if (!instances.has(key)) instances.set(key, []); slots = instances.get(key); cursor = 0; return component(props); };
  const initial = Array.from({ length: 400 }, (_, index) => index === 398 ? readingTool('visible-tool', 10) : readingEntry('a' + index, 'assistant', 9, { text: 'reply' }));
  const tail = require('../src/features/reading/useVisibleTail.ts');
  let count = 40;
  const { state, ReadingView } = readingHarness(t, applyConversationPacket([], { list: initial }), { react: hooks, './useVisibleTail': { ...tail, useVisibleTail: grouped => tail.visibleTail(grouped, count) } });
  const props = { projectId: 'project', terminal: state.terminal, autoFocus: false, onShowTerminal() {}, onError() {}, onOpenLink() {} };
  const group = () => {
    const root = run('root', ReadingView, props); let found;
    const visit = (node, path = '') => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(child => visit(child, path)); return; }
      const key = path + '/' + String(node.key ?? (typeof node.type === 'function' ? node.type.name : node.type));
      if (node.type?.name === 'ToolGroup') found = { key, node: run(key, node.type, node.props) };
      else if (node.type?.name === 'LegacyReadingView') visit(run(key, node.type, node.props), key);
      else visit(node.props?.children, key);
    };
    visit(root); return found;
  };
  const before = group();
  elements(before.node).find(element => element.type === 'button').props.onClick();
  assert.equal(elements(group().node).find(element => element.type === 'button').props['aria-expanded'], true);
  count = 80;
  assert.equal(group().key, before.key);
  assert.equal(elements(group().node).find(element => element.type === 'button').props['aria-expanded'], true);
  count = 40;
  for (let index = 400; index < 425; index++) {
    const entry = readingEntry('a' + index, 'assistant', 11, { text: 'next' });
    state.entries = applyConversationPacket(state.entries, index % 2 ? { list: [...state.entries, entry].slice(-400).map(entry => ({ ...entry })) } : { changes: [entry] });
    const after = group();
    assert.equal(state.entries.length, 400); assert.equal(after.key, before.key);
    assert.equal(elements(after.node).find(element => element.type === 'button').props['aria-expanded'], true);
    assert.ok(elements(after.node).some(element => element.type === 'ul'));
  }
});

test('unrelated user records cannot discard a stalled prompt; retries stay bounded and queued prompts never resend', async t => {
  const prompts = require('../src/features/reading/pending-prompts.ts');
  let clock = 30000, sequence = 0;
  t.mock.method(Date, 'now', () => clock);
  const records = [{ id: 'unrelated', role: 'user', text: 'DIFFERENT_MESSAGE', at: 2000 }], cancellations = [];
  let state = prompts.addPendingPrompt(prompts.createPendingPrompts('session'), 'lost', 'NEVER_DELIVERED', 1000);
  state = prompts.reconcilePendingPrompts(state, 'session', records, clock);
  const h = dictationHarness(t, {
    './useReadingConversation': { conversationKey: (id, session) => session, useReadingConversation: () => records },
    './usePendingPrompts': { usePendingPrompts: () => {
      state = prompts.reconcilePendingPrompts(state, 'session', records, clock);
      return { pending: state.prompts,
        echo(text, images) { const id = 'retry-' + ++sequence; state = prompts.addPendingPrompt(state, id, text, clock, images); return id; },
        cancelEcho(id) { cancellations.push(id); state = prompts.removePendingPrompt(state, id); },
      };
    } },
  });
  h.props.terminal.codexActivity = 'idle';
  clock += 6000; await h.tick(6000);
  assert.deepEqual(h.pasted.map(item => item.text), ['NEVER_DELIVERED']);
  assert.deepEqual(cancellations, ['lost'], 'a replacement echo follows a real resend, never a timestamp-only acknowledgment');
  await h.tick(400); await h.tick(2000); await h.tick(1000);
  clock += 21000; h.render(); await h.tick(0);
  assert.equal(h.pasted.length, 2);
  await h.tick(400); await h.tick(2000); await h.tick(1000);
  clock += 21000; h.render(); await h.tick(0);
  assert.equal(h.pasted.length, 2, 'at most two automatic resends');
  assert.equal(state.prompts.length, 1, 'an undelivered prompt remains visible');
  const card = elements(h.tree()).find(element => element.props?.undelivered);
  assert.equal(card.props.undelivered(state.prompts[0]), true);
  records.push({ id: 'q', role: 'user', text: 'NEVER_DELIVERED', at: clock, queued: true });
  clock += 30000; h.render(); await h.tick(0);
  assert.equal(h.pasted.length, 2);
  assert.equal(elements(h.tree()).find(element => element.props?.queued).props.queued(state.prompts[0]), true);
  records.pop();
  h.props.terminal.sessionId = 'next-session';
  // The actual pending hook clears old-session echoes; give this new session its own stalled send.
  state = prompts.addPendingPrompt(prompts.createPendingPrompts('session'), 'new-send', 'NEVER_DELIVERED', clock - 21000);
  h.render(); await h.tick(0);
  assert.equal(h.pasted.length, 3, 'the previous session cannot exhaust the new session retry budget');
});

test('a question renders as its own card: progress, the question, options, an own answer or notes, Submit and Chat', () => {
  const icon = props => React.createElement('svg', { className: props.className });
  const icons = { CircleNotch: icon, CaretLeft: icon, CaretRight: icon, Check: icon, PaperPlaneRight: icon };
  const { ReadingQuestion } = loadUI('features/reading/ReadingQuestion.tsx', { '@phosphor-icons/react': icons, './question-keys': require('../src/features/reading/question-keys.ts') });
  const { parseAgentScreen } = require('../src/features/agents/agent-screen.ts');
  const screen = name => parseAgentScreen(name.startsWith('claude') ? 'claude' : 'codex', fs.readFileSync(path.join(__dirname, 'fixtures/questions', name + '.txt'), 'utf8').split('\n')).choice;
  const render = name => renderToStaticMarkup(React.createElement(ReadingQuestion, { choice: screen(name), terminalId: 'terminal', onError: () => {} }));
  const multi = render('claude-question-multi-checked');
  assert.match(multi, /要清理哪些目录？/); assert.match(multi, /aria-pressed="true"/); assert.match(multi, /Submit this question/);
  assert.match(multi, /Talk it over instead/); assert.match(multi, /placeholder="Type your own answer…"/); assert.match(multi, /清理目录/);
  assert.doesNotMatch(multi, /Chat about this|Type something/, 'the CLI\'s own English rows are shown in the window\'s words');
  const review = render('claude-question-review');
  assert.match(review, /Review your answers/); assert.match(review, /node_modules, abc/); assert.match(review, /Submit answers/);
  const codex = render('codex-question');
  assert.match(codex, /Question 1\/2/); assert.match(codex, /Notes \(optional\)/); assert.doesNotMatch(codex, /Optionally, add details/);
});

for (const agent of ['claude', 'codex']) {
  for (const activity of ['idle', 'working', 'shell']) {
    for (const picture of ['none', 'ready', 'loading']) {
      test(`${agent}: a ${picture} picture and message send while ${activity} without opening the popup`, async t => {
        let draft = '';
        const actions = [], received = [], pasteKey = agent === 'claude' ? '\x1bv' : '\x16';
        const h = dictationHarness(t, {
          './terminal-screen': { useScreen: () => null, readScreen: () => ({ rows: composerRows(agent, activity, draft) }) },
          './agent-screen': { parseAgentScreen },
          './image-thumbnail': { thumbnail: () => picture === 'loading' ? new Promise(() => {}) : Promise.resolve('data:image/png;base64,picture') },
        });
        h.props.terminal.agent = agent; h.props.terminal.codexActivity = activity === 'idle' ? 'idle' : 'working';
        window.agentrix.writeTerminal = (id, key) => {
          assert.equal(id, h.props.terminal.id); actions.push(key);
          if (key === pasteKey) draft += '[Image #1]';
          if (key === '\x15') draft = '';
          if (key === '\r') { received.push(draft); draft = ''; }
        };
        window.agentrix.pasteTerminal = async (id, text, sessionId) => {
          assert.equal(id, h.props.terminal.id); assert.equal(sessionId, h.props.terminal.sessionId);
          actions.push(text); draft += text; return { ok: true };
        };
        if (picture !== 'none') {
          h.render().props.onPaste({ preventDefault() {}, clipboardData: { getData: () => '', items: [{ kind: 'file', type: 'image/png', getAsFile: () => ({ size: 1 }) }] } });
          await h.tick(0);
          assert.equal(draft, '[Image #1]');
        }
        h.edit('next message'); h.press('Enter'); await h.tick(0);
        assert.equal(h.popup(), undefined); assert.equal(h.node.value, '');
        assert.equal(draft, (picture === 'none' ? '' : '[Image #1]') + 'next message');
        await h.tick(399); assert.deepEqual(received, []);
        await h.tick(1); await h.tick(700); await h.tick(3000);
        assert.deepEqual(actions, [...(picture === 'none' ? [] : [pasteKey]), 'next message', '\r']);
        assert.deepEqual(received, [(picture === 'none' ? '' : '[Image #1]') + 'next message']);
        assert.deepEqual(h.echoed, [{ text: 'next message', images: picture === 'ready' ? ['data:image/png;base64,picture'] : [] }]);
        assert.equal(h.popup(), undefined);
      });
    }
  }

  test(agent + ': consecutive picture pastes keep the first placeholder while previews load', async t => {
    let draft = '';
    const h = dictationHarness(t, {
      './terminal-screen': { useScreen: () => null, readScreen: () => ({ rows: composerRows(agent, 'working', draft) }) },
      './agent-screen': { parseAgentScreen }, './image-thumbnail': { thumbnail: () => new Promise(() => {}) },
    });
    h.props.terminal.agent = agent;
    window.agentrix.writeTerminal = (id, key) => {
      h.written.push({ id, text: key });
      if (key === '\x15') draft = '';
      else draft += `[Image #${h.written.length}]`;
    };
    for (let index = 0; index < 2; index++) {
      h.render().props.onPaste({ preventDefault() {}, clipboardData: { getData: () => '', items: [{ kind: 'file', type: 'image/png', getAsFile: () => ({ size: 1 }) }] } });
      await h.tick(0);
    }
    await h.tick(1000);
    assert.deepEqual(h.written.map(item => item.text), [agent === 'claude' ? '\x1bv' : '\x16', agent === 'claude' ? '\x1bv' : '\x16']);
    assert.equal(draft, '[Image #1][Image #2]');
  });

  test(agent + ': a message already left with a picture retries Enter without clearing or pasting again', async t => {
    let draft = '[Image #1] next message';
    const h = dictationHarness(t, {
      './terminal-screen': { useScreen: () => null, readScreen: () => ({ rows: composerRows(agent, 'working', draft) }) },
      './agent-screen': { parseAgentScreen },
    });
    h.props.terminal.agent = agent;
    window.agentrix.writeTerminal = (id, key) => {
      h.written.push({ id, text: key });
      assert.equal(draft, '[Image #1] next message');
      if (h.written.length === 2) draft = '';
    };
    h.edit('next message'); h.press('Enter'); await h.tick(0);
    assert.deepEqual(h.written.map(item => item.text), ['\r']);
    await h.tick(700); await h.tick(700); await h.tick(3000);
    assert.deepEqual(h.written.map(item => item.text), ['\r', '\r']);
    assert.deepEqual(h.pasted, []); assert.equal(h.popup(), undefined);
  });

  for (const command of ['/status', '/init', '!echo SAME_OUTPUT']) {
    test(agent + ': ' + command + ' opens the live popup and types with fixed pauses without screen reads', async t => {
      const h = dictationHarness(t, { './terminal-screen': { useScreen: () => null, readScreen: () => assert.fail('typed commands never read the screen') } });
      h.props.terminal.agent = agent;
      for (let repeat = 0; repeat < 2; repeat++) {
        h.edit(command); h.press('Enter'); await h.tick(0);
        assert.equal(h.popup().props.command, command);
        assert.deepEqual(h.written.slice(repeat * 3).map(item => item.text), ['\x15']);
        await h.tick(59); assert.equal(h.written.length, repeat * 3 + 1);
        await h.tick(1); assert.equal(h.written.at(-1).text, command);
        await h.tick(149); assert.equal(h.written.length, repeat * 3 + 2);
        await h.tick(1); assert.equal(h.written.at(-1).text, '\r');
        await h.tick(30000); assert.equal(h.written.length, (repeat + 1) * 3);
        assert.equal(h.popup().props.command, command, 'the CLI returning idle never closes its popup');
        h.popup().props.onClose(); h.render();
        assert.equal(h.popup(), undefined); assert.equal(h.written.length, (repeat + 1) * 3);
      }
      assert.deepEqual(h.pasted, []); assert.deepEqual(h.echoed, []);
    });
  }

  test(agent + ': a dialog or missing prompt opens the popup with the message and attachments still in the composer', async t => {
    let rows = composerRows(agent);
    const h = dictationHarness(t, { './terminal-screen': { useScreen: () => null, readScreen: () => rows && ({ rows }) }, './agent-screen': { parseAgentScreen } });
    h.props.terminal.agent = agent;
    h.render().props.onPaste({ preventDefault() {}, clipboardData: { getData: () => '', items: [{ kind: 'file', type: 'image/png', getAsFile: () => ({ size: 1 }) }] } });
    await h.tick(0); h.written.length = 0;
    const dialog = agent === 'claude' ? ['✶ Swooping… (12s)', 'Settings  Status  Config  Usage', '❯ Auto-compact    true', 'Type to filter · Enter/↓ to select · Esc to clear']
      : ['                Usage', '                Daily limit  75% left', '                esc close', ...composerRows(agent)];
    const picker = agent === 'claude' ? ['Select model', '❯ 1. Opus', '  2. Sonnet', 'Enter to confirm · Esc to cancel']
      : [...composerRows(agent), 'Copy user message', '↑/↓ select · Enter confirm · Esc cancel'];
    for (const frame of [null, ['Settings', 'Esc to close'], dialog, picker]) {
      rows = frame;
      h.edit('keep this message'); h.press('Enter'); await h.tick(1000);
      assert.ok(h.popup()); assert.equal(h.node.value, 'keep this message');
      assert.ok(elements(h.tree()).some(element => element.props.className === 'reading-attachments'));
      assert.deepEqual(h.written, []); assert.deepEqual(h.pasted, []); assert.deepEqual(h.echoed, []);
      h.popup().props.onClose(); h.render();
    }
  });
}

test('session A to B to A, terminal selection and unmount cancel every delayed command key', async t => {
  for (const change of ['session', 'terminal', 'selection', 'unmount', 'close']) await t.test(change, async t => {
    const h = dictationHarness(t);
    h.edit('/status'); h.press('Enter'); await h.tick(0);
    assert.deepEqual(h.written.map(item => item.text), ['\x15']);
    if (change === 'session') { h.props.terminal.sessionId = 'B'; h.render(); h.props.terminal.sessionId = 'session'; h.render(); }
    if (change === 'terminal') { h.props.terminal.id = 'B'; h.render(); h.props.terminal.id = 'dictation'; h.render(); }
    if (change === 'selection') { h.props.active = false; h.render(); h.props.active = true; h.render(); }
    if (change === 'unmount') h.unmount();
    if (change === 'close') { h.popup().props.onClose(); h.render(); }
    await h.tick(60); await h.tick(150); await h.tick(30000);
    assert.deepEqual(h.written.map(item => item.text), ['\x15']);
    if (change !== 'unmount') assert.equal(h.popup(), undefined);
  });
});

test('a normal prompt paste resolving after session A to B to A never sends Enter into the returned session', async t => {
  let finishPaste;
  const h = dictationHarness(t);
  window.agentrix.pasteTerminal = () => new Promise(resolve => { finishPaste = resolve; });
  h.edit('normal prompt'); h.press('Enter');
  h.props.terminal.sessionId = 'B'; h.render(); h.props.terminal.sessionId = 'session'; h.render();
  finishPaste({ ok: true }); await h.tick(1000); await h.tick(1000);
  assert.deepEqual(h.written, []);
});

test('an external command uses the popup and leaves the composer draft alone', async t => {
  const h = dictationHarness(t);
  h.edit('keep my draft'); h.command('/usage'); await h.tick(0); await h.tick(60); await h.tick(150);
  assert.equal(h.popup().props.command, '/usage'); assert.equal(h.node.value, 'keep my draft');
  assert.deepEqual(h.written.map(item => item.text), ['\x15', '/usage', '\r']);
  h.command('/usage'); await h.tick(0); await h.tick(60); await h.tick(150);
  assert.deepEqual(h.written.map(item => item.text), ['\x15', '/usage', '\r', '\x15', '/usage', '\r']);
  assert.equal(h.node.value, 'keep my draft');
});

test('selecting or expanding the popup terminal keeps its send, and losing selection cancels it', async t => {
  const h = dictationHarness(t);
  h.props.active = false; h.render();
  h.command('/status'); await h.tick(0);
  h.props.active = true; h.props.autoFocus = true; h.render();
  await h.tick(60); await h.tick(150);
  assert.ok(h.popup()); assert.deepEqual(h.written.map(item => item.text), ['\x15', '/status', '\r']);
  h.props.autoFocus = false; h.render(); h.render();
  assert.equal(h.popup(), undefined);
});

test('/clear hides the previous entries only after submission and keeps the terminal popup open', async t => {
  const record = { id: 'before-clear', role: 'user', text: 'old conversation' };
  let shown;
  const h = dictationHarness(t, {
    './useReadingConversation': { conversationKey: () => 'clear-test', useReadingConversation: () => [record] },
    './useVisibleTail': { blocks: entries => { shown = entries; return []; }, conversationTurns: () => [], useVisibleTail: () => ({ earlier: 0, visible: [] }) },
  });
  h.props.terminal.agent = 'claude'; h.edit('/clear'); h.press('Enter'); await h.tick(0); await h.tick(60);
  assert.deepEqual(shown, [record]);
  await h.tick(150); assert.deepEqual(shown, []); assert.ok(h.popup());
});

test('local /resume keeps its session picker, and SSH /resume opens the live terminal', async t => {
  const h = dictationHarness(t);
  h.edit('/resume'); h.press('Enter'); await h.tick(1000);
  assert.equal(h.popup(), undefined); assert.deepEqual(h.written, []);
  assert.ok(elements(h.tree()).some(element => element.props.onSent));
  h.props.terminal.sessionId = 'remote'; h.props.remote = true; h.render(); h.render();
  h.edit('/resume'); h.press('Enter'); await h.tick(0); await h.tick(60); await h.tick(150);
  assert.ok(h.popup()); assert.deepEqual(h.written.map(item => item.text), ['\x15', '/resume', '\r']);
});

test('the terminal popup closes only by its button or backdrop and never translates a key', () => {
  let closes = 0;
  const hooks = { useRef: value => ({ current: value }), useLayoutEffect() {} };
  const { ReadingTerminalPopup } = loadUI('features/reading/ReadingTerminalPopup.tsx', { react: hooks, './reading-terminal': {} });
  const root = ReadingTerminalPopup({ terminalId: 't', sessionId: 's', command: '/config', onReady() {}, onClose: () => closes++, onError: assert.fail });
  for (const key of ['Escape', 'Enter', 'Tab', 'ArrowDown', 'c']) {
    const event = { key, stopPropagation() {}, preventDefault: () => assert.fail('xterm owns the key') };
    root.props.onKeyDown(event); root.props.onKeyUp(event);
  }
  root.props.onMouseDown({ button: 0, target: {}, currentTarget: {} }); assert.equal(closes, 0);
  const dialog = elements(root).find(element => element.type === 'dialog');
  assert.equal(dialog.props.open, true); let prevented = false;
  dialog.props.onCancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(closes, 0);
  // The backdrop press keeps its default focus change from landing under the closed popup.
  const backdrop = {}; let pressPrevented = false;
  root.props.onMouseDown({ button: 0, target: backdrop, currentTarget: backdrop, preventDefault() { pressPrevented = true; } });
  assert.equal(pressPrevented, true);
  elements(root).find(element => element.type === 'button').props.onClick();
  assert.equal(closes, 2);
});

test('switching to a terminal in another small card closes the popup without restoring the old composer focus', t => {
  const saved = globalThis.document, listeners = new Map(), cleanups = [], closes = [];
  globalThis.document = { addEventListener: (name, take) => listeners.set(name, take), removeEventListener: name => listeners.delete(name) };
  t.after(() => { for (const cleanup of cleanups) cleanup?.(); globalThis.document = saved; });
  let restored = 0, ready = 0;
  const hooks = { useRef: value => ({ current: value }), useLayoutEffect: effect => cleanups.push(effect()) };
  const { ReadingTerminalPopup } = loadUI('features/reading/ReadingTerminalPopup.tsx', { react: hooks, './reading-terminal': { mountReadingTerminal: () => () => restored++ } });
  ReadingTerminalPopup({ terminalId: 'A', sessionId: 's', command: '/status', onReady: () => ready++, onClose: focus => closes.push(focus), onError: assert.fail });
  assert.equal(ready, 1);
  const target = id => ({ closest: () => ({ dataset: { terminalId: id } }) });
  listeners.get('pointerdown')({ target: target('A') }); assert.deepEqual(closes, []);
  listeners.get('focusin')({ target: target('B') }); assert.deepEqual(closes, [false]);
  cleanups.shift()(); assert.equal(restored, 1);
});

test('a generated picture shows its prompt as a two-line summary and a toggle appears only when the summary is cut off', () => {
  const view = fs.readFileSync(path.join(__dirname, '../src/features/reading/ReadingView.tsx'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/features/reading/reading.css'), 'utf8');
  const figure = view.slice(view.indexOf('function GeneratedImage'), view.indexOf('// A reply card inside'));
  assert.ok(figure.includes('element.scrollHeight > element.clientHeight'), 'the clamp is measured');
  assert.ok(figure.includes('new ResizeObserver(measure)'), 'and measured again when the card changes width');
  assert.ok(figure.includes('(clipped || expanded)'), 'the toggle shows only for a cut-off or an expanded prompt');
  assert.ok(figure.includes('aria-expanded={expanded} aria-controls={captionId}'));
  assert.doesNotMatch(figure, /figcaption[^>]*title=/, 'no tooltip: the expansion replaces it');
  const caption = css.split(/\r?\n/).find(line => line.startsWith('.reading-generated figcaption {'));
  for (const part of ['-webkit-line-clamp: 2', 'font-size: calc(12px * var(--reading-text))', 'line-height: 1.5', 'color: var(--text-3)']) assert.ok(caption.includes(part), part);
  assert.ok(css.includes('.reading-generated figcaption.is-expanded { display: block; overflow: visible; white-space: pre-wrap; }'));
  assert.equal(en['展开提示词'], 'Show prompt'); assert.equal(en['收起'], 'Collapse');
});

const { latestResult, resultActions, FALLBACK_TITLES, elapsed, lastRound } = require('../src/features/reading/result-round.ts');
const roundPicture = (id, minute) => readingEntry(id, 'assistant', minute, { text: 'drawn', images: ['data:image/png;base64,AA'], generated: { path: '/home/.codex/generated_images/t/one.png', prompt: 'a prompt' } });
const roundEdit = (id, minute, written = ['/p/a.ts']) => readingTool(id, minute, { kind: 'edit', tool: 'apply_patch', written });
const idle = { idle: true, interrupted: false };

test('the latest round is detected from the entries: a picture, files, a text answer, a failure, nothing while it works', () => {
  const ask = readingEntry('u', 'user', 1, { text: 'draw it' });
  assert.equal(latestResult([], idle), null);
  assert.equal(latestResult([ask], idle), null, 'a message with no answer yet has no result');
  assert.equal(latestResult([ask, roundPicture('g', 3)], { idle: false, interrupted: false }), null, 'nothing while the agent works or waits');
  const picture = latestResult([ask, readingEntry('a', 'assistant', 2, { text: 'on it' }), roundPicture('g', 3), readingEntry('z', 'assistant', 4, { text: 'both done' })], idle);
  assert.equal(picture.kind, 'picture'); assert.equal(picture.anchor, 'g'); assert.equal(picture.picture.prompt, 'a prompt'); assert.equal(picture.reply, 'both done');
  const code = latestResult([ask, roundEdit('e', 2, ['/p/a.ts', '/p/b.ts']), readingTool('t', 3, { phrase: '运行测试' }), readingTool('x', 3, { phrase: '运行 1 条命令' }), readingEntry('z', 'assistant', 4, { text: 'done' })], idle);
  assert.equal(code.kind, 'code'); assert.equal(code.anchor, 'z'); assert.deepEqual(code.written, ['/p/a.ts', '/p/b.ts']);
  assert.deepEqual(code.checks.map(check => check.id), ['t'], 'only the steps that check work count');
  const text = latestResult([ask, readingTool('r', 2, { kind: 'read' }), readingEntry('z', 'assistant', 4, { text: 'answer' })], idle);
  assert.equal(text.kind, 'text'); assert.equal(text.anchor, 'z');
  assert.equal(latestResult([ask, readingTool('r', 2, { kind: 'read' })], idle), null, 'no reply, picture or file: nothing to hand in');
  const failed = latestResult([ask, roundEdit('e', 2), readingTool('npm test', 3, { failed: true })], idle);
  assert.equal(failed.kind, 'failed'); assert.equal(failed.failure, 'npm test');
  assert.equal(latestResult([ask, readingEntry('z', 'assistant', 4, { text: 'half' })], { idle: true, interrupted: true }).kind, 'failed', 'an interrupted round');
});

test('only your last message starts the round: an answer to a question and a queued message do not', () => {
  const entries = [readingEntry('u1', 'user', 1, { text: 'first' }), readingEntry('a1', 'assistant', 2, { text: 'old reply' }), readingEntry('u2', 'user', 3, { text: 'build it' }),
    readingEntry('q', 'user', 4, { text: 'yes', answer: true }), roundEdit('e', 5), readingEntry('z', 'assistant', 6, { text: 'built' }), readingEntry('w', 'user', 7, { text: 'later', queued: true })];
  const result = latestResult(entries, idle);
  assert.equal(result.request, 'build it'); assert.equal(result.kind, 'code');
  assert.equal(lastRound(entries).goal, 'build it');
});

test('the buttons under a result depend on its kind, a remote picture and whether the agent can be sent to', () => {
  const ask = readingEntry('u', 'user', 1, { text: 'draw' });
  const ids = (result, options) => resultActions(result, options).map(action => `${action.id}${action.disabled ? '!' : ''}`);
  const picture = latestResult([ask, roundPicture('g', 2)], idle);
  assert.deepEqual(ids(picture, { remote: false, canSend: true }), ['enlarge', 'save', 'continue']);
  assert.deepEqual(ids(picture, { remote: true, canSend: true }), ['enlarge', 'save!', 'continue'], 'a picture on another computer cannot be saved here');
  assert.deepEqual(ids(latestResult([ask, roundEdit('e', 2), readingEntry('z', 'assistant', 3, { text: 'ok' })], idle), { remote: false, canSend: true }), ['open', 'continue']);
  assert.deepEqual(ids(latestResult([ask, readingEntry('z', 'assistant', 3, { text: 'ok' })], idle), { remote: false, canSend: true }), ['ask', 'copy']);
  const failed = latestResult([ask, readingTool('npm test', 2, { failed: true })], idle);
  assert.deepEqual(ids(failed, { remote: false, canSend: true }), ['retry', 'continue']);
  assert.deepEqual(ids(failed, { remote: false, canSend: false }), ['retry!', 'continue'], 'a retry waits for the agent to sit at its input');
});

test('the title and the duration of a round come from data it already has', () => {
  assert.deepEqual(Object.keys(FALLBACK_TITLES), ['picture', 'code', 'text', 'failed'], 'a task without a title of its own is named by what the round did');
  for (const title of Object.values(FALLBACK_TITLES)) assert.ok(title in en, `${title} has an English translation`);
  assert.deepEqual(elapsed(0, 190000), { hours: 0, minutes: 3, seconds: 10 }); assert.deepEqual(elapsed(0, 3900000), { hours: 1, minutes: 5, seconds: 0 });
});

const { ResultStatus } = loadUI('features/reading/ResultCard.tsx');
function assertResultHeading(result, taskTitle, expected, label = 'Done') {
  const heading = elements(ResultStatus({ result, taskTitle, onShowTerminal() {}, onError() {} })).find(node => node.type === 'h3');
  assert.equal(heading.props.children[0].props.children, expected, 'the visible title is plain text');
  assert.equal(heading.props.title, `${expected} · ${label}`, 'the tooltip uses the same complete title');
  assert.equal(renderToStaticMarkup(heading).match(/title="([^"]*)"/)[1], `${expected} · ${label}`, 'the native HTML title attribute');
}

test('a reply stored as the task title contributes only its opening sentence to the result heading and native tooltip', t => {
  const { PromptQueue } = require('../electron/prompt-queue.cjs');
  const request = 'Explain why the updater download failed.';
  const reply = [
    'The update check worked but the download failed. Your copy is **0.8.0**, which still has the old u…',
    '',
    '**How the update works:**',
    '1. **Check:** Ask `api.github.com` for the latest release.',
    '2. **Download:** Fetch the installer from `github.com` and `objects.githubusercontent.com`.',
    '3. **Install:** Restart after the download finishes.',
    '',
    '| Host | Without proxy | With proxy |',
    '|---|---|---|',
    '| `api.github.com` | **Works** | Works |',
    '| `github.com` | Fails | Works |',
    '| `objects.githubusercontent.com` | Fails | Works |',
    '',
    '【交付】',
    '问题：The update check succeeded but the installer download failed.',
    '原因：The release API and the installer use different hosts.',
    '结果：The proxy must cover all download hosts.',
  ].join('\n');
  const queue = new PromptQueue();
  queue.start(request, 1000); queue.reply({ at: 1500, text: reply }); queue.finish(2000);
  assert.equal(queue.task.title, reply, 'the queue hands the whole delivery reply to terminal.taskTitle');
  const entries = [readingEntry('u', 'user', 1, { text: request }), readingEntry('a', 'assistant', 2, { text: reply })];
  const result = latestResult(entries, idle), expected = 'The update check worked but the download failed.';
  assert.equal(result.reply, reply, 'the reply itself remains complete');
  assertResultHeading(result, queue.task.title, expected);
  const { state, render } = readingHarness(t, entries);
  state.terminal.taskTitle = queue.task.title;
  const html = render(), heading = html.match(/<h3 class="result-title"[\s\S]*?<\/h3>/)[0];
  assert.equal(heading, `<h3 class="result-title" title="${expected} · Done"><span>${expected}</span><b> · Done</b></h3>`);
  assert.doesNotMatch(heading, /Your copy|How the update works|api\.github\.com|\*\*|\| Host|\|---/);
  assert.ok(html.includes('Your copy is **0.8.0**'), 'the reply body is still shown below the heading');
});

test('result titles remove inline Markdown and block markers before selecting the first sentence or line', () => {
  const result = latestResult([readingEntry('u', 'user', 1, { text: 'Explain the outcome.' }), readingEntry('a', 'assistant', 2, { text: 'Complete reply.' })], idle);
  for (const [source, expected] of [
    ['**Fixed** the *updater* with _retries_ and __checks__. More details.', 'Fixed the updater with retries and checks.'],
    ['## [**Read** the _release notes_](https://example.com/release). Body follows.', 'Read the release notes.'],
    ['1. **Retry** `github.com` with [the proxy](https://example.com/proxy). Next step.', 'Retry github.com with the proxy.'],
    ['- *Download* from ``objects.githubusercontent.com``', 'Download from objects.githubusercontent.com'],
    ['+ **Install** the update\nThe following line is the body.', 'Install the update'],
    ['> ### **How the update works:**\n1. **Check** the host.', 'How the update works:'],
    ['\n\t **Update**   `0.8.0`\t from `host_name`\r\nBody on the next line.', 'Update 0.8.0 from host_name'],
    ['**部署完成**。后面是详细说明。', '部署完成。'],
    ['**Ready**? More details.', 'Ready?'],
    ['**Done**! More details.', 'Done!'],
  ]) assertResultHeading(result, source, expected);
});

test('a long result title stays complete in the visible text and native tooltip', () => {
  const expected = `Updated ${Array.from({ length: 60 }, (_, index) => `component ${index}`).join(', ')} successfully.`;
  const result = latestResult([readingEntry('u', 'user', 1, { text: 'Update the components.' }), readingEntry('a', 'assistant', 2, { text: 'Done.' })], idle);
  assert.ok(expected.length > 600);
  assertResultHeading(result, `**${expected}** The rest of the reply stays out of the title.\n| Host | Without proxy |`, expected);
});

test('missing, empty Markdown and copied request titles use the round kind fallback', () => {
  const { PromptQueue } = require('../electron/prompt-queue.cjs');
  const request = 'Fix the updater. Then check the download.', reply = '**Done.** This reply has no delivery block.';
  const queue = new PromptQueue();
  queue.start(request, 1000); queue.reply({ at: 1500, text: reply }); queue.finish(2000);
  assert.equal(queue.task.title, request, 'without a delivery summary, the upstream title is still the user message');
  const result = latestResult([readingEntry('u', 'user', 1, { text: request }), readingEntry('a', 'assistant', 2, { text: reply })], idle);
  for (const kind of Object.keys(FALLBACK_TITLES)) for (const source of [undefined, '', ' \r\n ', '***', queue.task.title, '# **FIX THE UPDATER.**\nOther details.']) {
    assertResultHeading({ ...result, kind }, source, en[FALLBACK_TITLES[kind]], kind === 'failed' ? 'Interrupted' : 'Done');
  }
  assertResultHeading({ ...result, kind: 'failed', failure: 'download failed' }, undefined, en[FALLBACK_TITLES.failed], 'Failed');
});

test('the latest round alone carries the status row and the actions, and the composer invites the next step', t => {
  const entries = [readingEntry('u1', 'user', 1, { text: 'first' }), roundPicture('g1', 2), readingEntry('u2', 'user', 5, { text: 'build it' }), roundEdit('e', 6), readingEntry('z', 'assistant', 7, { text: 'built it' })];
  const { state, render } = readingHarness(t, entries);
  state.terminal.taskTitle = 'Built the app';
  let html = render();
  assert.equal((html.match(/class="result-status/g) || []).length, 1, 'one status row, for the latest round only');
  assert.match(html, /Built the app<\/span><b> · Done<\/b>/); assert.match(html, /placeholder="Keep editing, or describe the next step…"/);
  assert.equal((html.match(/class="result-actions"/g) || []).length, 1);
  assert.match(html, /<div class="reading-turn-item-body"><div class="result-status/, 'the result entry has no time stamp of its own: the status row says when it ended');
  assert.match(html, /aria-label="Open file"[^>]*>[\s\S]*aria-label="Keep editing"/);
  assert.equal((html.match(/is-latest/g) || []).length, 2, 'the last user step and the last agent step are the latest');
  assert.ok(html.indexOf('result-status') < html.indexOf('built it') && html.indexOf('built it') < html.indexOf('result-actions'), 'the reply sits between them, never repeated');
  state.terminal.codexActivity = 'working';
  html = render();
  assert.doesNotMatch(html, /result-status|result-actions/, 'no card while the agent works');
  assert.doesNotMatch(html, /placeholder="Keep editing/);
  state.terminal.codexActivity = 'idle'; state.pending = [{ id: 'p', text: 'next', at: 99, sending: false }];
  assert.doesNotMatch(render(), /result-status/, 'nor once the next message is sent');
});

test('a picture result shows the picture first, then its sentence and its prompt, and the earlier pictures keep their order', t => {
  const { state, render } = readingHarness(t, [readingEntry('u1', 'user', 1, { text: 'one' }), roundPicture('g1', 2), readingEntry('u2', 'user', 5, { text: 'two' }), roundPicture('g2', 6)]);
  const html = render(), [earlier, latest] = html.split(/(?=<div class="reading-step is-agent)/).slice(1);
  assert.ok(earlier.indexOf('drawn') < earlier.indexOf('<figure'), 'an earlier round keeps its words before the picture');
  assert.match(latest, /reading-generated is-result/);
  assert.ok(latest.indexOf('<img') < latest.indexOf('drawn') && latest.indexOf('drawn') < latest.indexOf('<figcaption'), 'picture, sentence, prompt');
  assert.ok(latest.indexOf('<figcaption') < latest.indexOf('result-actions'));
  state.terminal.codexActivity = 'interrupted';
  assert.match(render(), /Interrupted/);
});

test('the reading view keeps two vertical lines: the avatars and the reply text edge, which the composer and every row share', () => {
  const flow = fs.readFileSync(path.join(__dirname, '../src/features/reading/reading-flow.css'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/features/reading/reading.css'), 'utf8');
  const card = fs.readFileSync(path.join(__dirname, '../src/features/reading/result-card.css'), 'utf8');
  const narrow = css.slice(css.indexOf('@container (max-width: 480px)'));
  assert.match(narrow, /--reading-inset: 0px; --turn-pad: 0px;/, 'in a card narrower than 480px the content edge is the avatars edge');
  assert.ok(flow.includes('.reading-step-body > .reading-turn { margin-left: calc(var(--reading-inset) - var(--step-lead) - var(--turn-pad)); }'));
  assert.ok(flow.includes('.reading-assistant { padding: 0 16px 0 var(--turn-pad);'));
  assert.ok(flow.includes('.reading-turn-tools { position: relative; min-width: 0; padding-left: var(--turn-pad); }'), 'the pill starts on the content edge');
  assert.doesNotMatch(flow, /\.reading-turn-tools[^{]*::before|\.reading-turn-mark|\.reading-tool-icon/, 'a tool group has no icon or rail, and its opened rows no kind icon: the pill and the state marks alone');
  assert.ok(flow.includes('.reading-turn > .reading-status { margin-left: var(--turn-pad); }'));
  assert.ok(flow.includes('.reading-step-body > .reading-status { margin-left: calc(var(--reading-inset) - var(--step-lead)); }'));
  assert.ok(css.includes('.reading-composer { margin: 4px var(--reading-edge-right) 16px var(--reading-edge-left); }'));
  assert.ok(css.includes('.reading-attachments { display: flex; align-items: center; gap: 6px; margin: 0 var(--reading-edge-right) 6px var(--reading-edge-left);'));
  assert.ok(card.includes('.result-status, .result-evidence, .result-actions { box-sizing: border-box; padding-left: var(--turn-pad); padding-right: var(--reading-inset); }'));
  assert.ok(css.includes('.reading-content { gap: 16px; }') && css.includes('.reading-step.is-user:not(:first-child) { margin-top: 16px; }'), 'rounds are told apart by space');
});

test('the save-as channel is registered in the main process, the preload and the types', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert.match(read('electron/main.cjs'), /handle\('agent:saveImageAs'[\s\S]*isGeneratedImage\(file\)[\s\S]*showSaveDialog[\s\S]*copyFile/);
  assert.match(read('electron/preload.cjs'), /saveImageAs: file => ipcRenderer\.invoke\('agent:saveImageAs', file\)/);
  assert.match(read('src/shared/types.ts'), /saveImageAs\(file: string\): Promise<Result<string \| null>>/);
  for (const text of ['保存图片', '继续修改', '继续追问', '重试', '查看大图', '{time} 完成', '继续修改，或描述下一步…']) assert.ok(text in en, `${text} has an English translation`);
});
