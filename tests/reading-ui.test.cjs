const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { choiceIdentity } = require('../src/features/agents/agent-screen.ts');
const { parseAgentScreen } = require('../src/features/agents/agent-screen.ts');
const en = require('../electron/locales/en.json');
const historySnapshot = entries => ({ entries, paged: false, hasEarlier: false, loading: false, error: null, loadEarlier: async () => false, compact: async () => false });

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
    if (name === 'react' && overrides.react) return { ...React, ...overrides.react };
    // Stubbed screen modules keep their pure helpers (bindApproval, choiceIdentity) unless a test replaces them too.
    if (Object.hasOwn(overrides, key) && key === './terminal-screen') return { bindApproval: require('../src/features/terminal/terminal-screen.ts').bindApproval, ...overrides[key] };
    if (Object.hasOwn(overrides, key) && key === './agent-screen') { const { choiceIdentity, waitingTitle } = require('../src/features/agents/agent-screen.ts'); return { choiceIdentity, waitingTitle, ...overrides[key] }; }
    if (Object.hasOwn(overrides, key)) return overrides[key];
    if (name.endsWith('.css')) return {};
    if (key === './VoiceButton') return { VoiceButton: ({ disabled }) => React.createElement('button', { type: 'button', className: 'icon-button voice-button', disabled, 'aria-label': 'Voice input' }) };
    // Every icon renders as a plain svg carrying its class name.
    if (name === '@phosphor-icons/react') return new Proxy({}, { get: () => props => React.createElement('svg', { className: props.className }) });
    if (key === './i18n') return { currentLanguage: () => 'en', t: (text, values = {}) => (en[text] ?? text).replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match) };
    if (key === './platform') return { isMac: true, isLinux: false, isWindows: false };
    if (key === './dictation-send') return require('../src/features/reading/dictation-send.ts');
    if (key === './reading-command') return require('../src/features/reading/reading-command.ts');
    if (key === './reply-files') return require('../src/features/reading/reply-files.ts');
    if (key === './reading-paths') return { pathTooltip: () => 'Ctrl+click to show in File Explorer', markReadingPaths() {} };
    if (key === './PathText') return { PathText: ({ text }) => text };
    if (key === './useReadingPaths') return { useReadingPaths: () => ({ ref: (overrides.react || React).useRef(null) }) };
    if (key === './ReadingTerminalPopup') return { ReadingTerminalPopup: function ReadingTerminalPopup() { return null; } };
    if (key === './ReadingSignIn') return { ReadingSignIn: () => null };
    if (key === './AgentCommandRun') return { AgentCommandRun: () => null };
    if (key === './Markdown') return loadUI('features/reading/Markdown.tsx', overrides);
    if (key === './ConversationFeed') return loadUI('features/reading/ConversationFeed.tsx', overrides);
    if (key === './useLongMarkdown') return loadUI('features/reading/useLongMarkdown.ts', overrides);
    if (key === './useVisibleTail') return loadUI('features/reading/useVisibleTail.ts', overrides);
    if (key === './PendingPromptEntries') return loadUI('features/reading/PendingPromptEntries.tsx', overrides);
    if (key === './ReadingQuote') return loadUI('features/reading/ReadingQuote.tsx', overrides);
    if (key === './MessageMenu') return loadUI('features/reading/MessageMenu.tsx', overrides);
    if (key === './message-menu') return require('../src/features/reading/message-menu.ts');
    if (key === 'react-dom') return { createPortal: node => node };
    if (key === './message-quote') return require('../src/features/reading/message-quote.ts');
    // Its state is the point of it: every loaded view gets a fresh copy, so no test depends on another's terminals.
    if (key === './reading-ready') return loadUI('features/reading/reading-ready.ts');
    if (key === './WaitingCard') return loadUI('features/reading/WaitingCard.tsx');
    if (key === './Timeline') return loadUI('features/reading/Timeline.tsx');
    if (key === './ResultCard') return loadUI('features/reading/ResultCard.tsx');
    if (key === './result-round') return require('../src/features/reading/result-round.ts');
    if (key === './typing') return require('../src/features/reading/typing.ts');
    if (key === './composer-prefill') return require('../src/features/reading/composer-prefill.ts');
    if (key === './image-thumbnail') return require('../src/shared/image-thumbnail.ts');
    if (key === './image-input') return require('../src/features/reading/image-input.ts');
    // Width fitting needs a real box; here the composer shows its longest hint.
    if (key === './useFittingHint') return { ...require('../src/shared/useFittingHint.ts'), useFittingHint: (box, hints) => hints[0] };
    if (key === './useNativePictures') return loadUI('features/reading/useNativePictures.ts', overrides);
    if (key === './useComposerHistory') return loadUI('features/reading/useComposerHistory.ts', overrides);
    if (key === './useCommandPalette') return loadUI('features/reading/useCommandPalette.ts', overrides);
    if (key === './CommandList') return loadUI('features/reading/CommandList.tsx', overrides);
    if (key === './markdown-escape') return require('../src/features/reading/markdown-escape.ts');
    if (key === './pasted-pictures') return require('../src/features/reading/pasted-pictures.ts');
    if (key === './sign-in-screen') return require('../src/features/agents/sign-in-screen.ts');
    // Module B's split pane and its state are not under test here.
    if (key === './SubagentPane') return { SubagentPane: () => null };
    if (key === './subagent-splits.ts') return { closeSplit() {}, limitSplits() {}, splitLimit: () => 2, splitsOf: () => [], useSplits: () => [] };
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
    './native-store.ts': { useNativeEntries: () => new Map(), nativeTells: () => false },
    './ActivityPane': { ActivityPane: () => null },
    './SubagentChip': { SubagentChip: () => null },
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

// The narrow window hides the activity pane in CSS, so its sub-agent rows are reached from the header of the expanded project.
test('the sub-agent chip is in the header of an expanded project only: never on a small card, and the header stays a one-row control cluster', t => {
  const h = projectHeaderHarness(t), chips = () => h.render().filter(node => node.type?.name === 'SubagentChip');
  for (const activityOpen of [false, true]) {
    Object.assign(h.props, { focused: false, activityOpen });
    assert.equal(chips().length, 0, `a small card has no chip (activityOpen=${activityOpen})`);
    h.props.focused = true;
    const [chip] = chips();
    assert.equal(chips().length, 1, `an expanded project has one (activityOpen=${activityOpen})`);
    assert.equal(chip.props.terminal.id, 'terminal', 'for the terminal in use');
  }
  h.props.focused = true; h.props.project.terminals = [];
  assert.equal(chips().length, 0, 'no terminal, no chip');
  const css = fs.readFileSync(path.join(__dirname, '../src/features/workspace/workspace.css'), 'utf8');
  assert.match(css, /\.subagent-chip-anchor \{ display: none;/, 'hidden by default');
  assert.match(css, /@media \(max-width: 1000px\) \{ \.subagent-chip-anchor \{ display: block; \} \}/, 'shown only where the pane is hidden, at the same 1000px as the rule that hides the pane');
  assert.match(css, /@media \(max-width: 1000px\) \{[^]*?\.activity-pane, \.project-panel\.has-activity::before \{ display: none; \}/, 'the pane-hiding rule this one pairs with');
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

test('choice identity survives cursor redraws and changes for the next menu', () => {
  const choice = fakeChoice();
  assert.equal(choiceIdentity(choice), choiceIdentity({ ...choice, options: choice.options.map(option => ({ ...option, selected: !option.selected })) }));
  assert.notEqual(choiceIdentity(choice), choiceIdentity({ ...choice, title: 'Select effort' }));
  assert.notEqual(choiceIdentity(choice), choiceIdentity({ ...choice, options: choice.options.slice(1) }));
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

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  return [node, ...elements(node.props.children)];
}

const composerRows = (agent, activity = 'idle', draft = '') => [
  ...(activity === 'working' ? [agent === 'claude' ? '✶ Swooping… (12s)' : '• Working (12s • esc to interrupt)'] : []),
  ...(activity === 'shell' ? agent === 'claude' ? ['! sleep 10', '  ⎿ Running…'] : ['• Running shell command (12s · esc to interrupt)'] : []),
  ...(agent === 'claude' ? ['────', '❯ ' + draft, '────', '  ⏸ manual mode on']
    : ['› ' + draft, '', 'GPT-6.1-Sol high · C:\\work', '? for shortcuts']),
];

// Run ReadingView's composer handlers and effect cleanup without starting a browser or Electron.
function dictationHarness(t, overrides = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slots = [], effects = [], written = [], pasted = [], echoed = [], terminalFocused = [];
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
  const previousWindow = globalThis.window, previousDocument = globalThis.document, previousTextarea = globalThis.HTMLTextAreaElement;
  globalThis.HTMLTextAreaElement = class {};
  const node = Object.assign(new HTMLTextAreaElement(), { value: '', selectionStart: 0, selectionEnd: 0, dataset: {}, disabled: false,
    matches: selector => selector.split(/,\s*/).includes('textarea'),
    focus() { if (!node.disabled) document.activeElement = node; },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
  });
  const composer = { matches: () => false, focus() { document.activeElement = composer; } };
  const popupInput = { focus() { terminalFocused.push(props.terminal.id); document.activeElement = popupInput; } };
  const editables = new Set([node, composer]), readingView = { contains: target => editables.has(target) };
  globalThis.document = { activeElement: node, body: {}, getElementById: () => null, createElement: () => ({ innerHTML: '', querySelectorAll: () => [] }) };
  globalThis.window = { addEventListener: (name, take) => listeners.set(name, take), removeEventListener: name => listeners.delete(name), agentrix: {
    terminalCommands: async () => ({ ok: true, value: [] }),
    writeTerminal: (id, text) => written.push({ id, text }),
    pasteTerminal: async (id, text) => { pasted.push({ id, text }); return { ok: true }; },
  } };
  const props = { projectId: 'project', terminal: { id: 'dictation', sessionId: 'session', agent: 'codex', codexActive: true, needsInput: null },
    autoFocus: false, onShowTerminal() {}, onError: message => assert.fail(message), onOpenLink() {},
  };
  const screen = fakeScreen({ status: { model: 'fixture', effort: null, context: null, mode: null, notes: [] } });
  const { ReadingView } = loadUI('features/reading/ReadingView.tsx', {
    react: hooks, dompurify: { default: () => ({ sanitize: html => html }) },
    './action-text': {}, './cli-panel': require('../src/features/reading/cli-panel.ts'),
    './pending-prompts': require('../src/features/reading/pending-prompts.ts'),
    './voice-input': { dictateInto: (id, take) => { insert = take; return () => { insert = null; }; } },
    './terminal-screen': { useScreen: () => ({ rows: composerRows(props.terminal.agent) }), readScreen: () => ({ rows: composerRows(props.terminal.agent) }) },
    './agent-screen': { parseAgentScreen: () => screen },
    './ReadingWelcome': {}, './ReadingChoice': {}, './ReadingQuestion': {},
    './reading-mode': { setChoiceVisible() {} },
    './useStickToBottom': { useStickToBottom: () => ({ stuck: true, unseen: 0, ready: true, holdPosition() {}, toBottom() {} }) },
    './useReadingConversation': { conversationKey: (id, session) => JSON.stringify([id, session]), useReadingHistory: () => historySnapshot([]) },
    './useVisibleTail': { blocks: () => [], conversationTurns: () => [], useVisibleTail: () => ({ earlier: 0, visible: [] }) },
    './useMentions': { useMentions: () => ({ open: false, keys: () => false }) }, './MentionPalette': {},
    './usePendingPrompts': { usePendingPrompts: () => ({ pending: [], echo: (text, images) => { echoed.push({ text, images }); return null; }, cancelEcho() {} }) },
    './PendingPromptEntries': {}, './markdown-parse': {}, './FileCards': {},
    './reading-welcome': { useWelcomeStarting: () => false },
    './image-thumbnail': { thumbnail: async () => 'data:image/png;base64,picture' },
    ...overrides,
  });
  const render = () => {
    const hadPopup = root && elements(root).some(element => element.type?.name === 'ReadingTerminalPopup');
    cursor = 0; root = ReadingView(props);
    // The public component routes managed SDK sessions before mounting the legacy TUI reader.
    if (typeof root.type === 'function') root = root.type(root.props);
    if (root.props.ref) root.props.ref.current = readingView;
    const box = elements(root).find(element => element.type === 'textarea');
    box.props.ref.current = node; node.value = box.props.value; node.disabled = box.props.disabled;
    const composerBox = elements(root).find(element => /\breading-composer\b/.test(element.props.className));
    if (composerBox.props.ref) composerBox.props.ref.current = composer;
    // Removing the focused popup drops browser focus to body before the parent's layout effects run.
    if (hadPopup && !elements(root).some(element => element.type?.name === 'ReadingTerminalPopup') && document.activeElement === popupInput) document.activeElement = document.body;
    while (effects.length) effects.shift()();
    const popup = elements(root).find(element => element.type?.name === 'ReadingTerminalPopup');
    // The real popup mounts xterm and calls terminal.focus() before onReady.
    if (popup && !hadPopup && popup.props.focus !== false) popupInput.focus();
    popup?.props.onReady();
    return box;
  };
  const unmount = () => { for (const slot of slots) if (slot?.cleanup) { slot.cleanup(); slot.cleanup = undefined; } };
  // Mounting the same view again, as switching to the raw terminal and back does: the component's state is gone.
  const remount = () => { unmount(); slots.length = 0; effects.length = 0; render(); return render(); };
  t.after(() => {
    unmount(); globalThis.window = previousWindow; globalThis.document = previousDocument;
    if (previousTextarea === undefined) delete globalThis.HTMLTextAreaElement; else globalThis.HTMLTextAreaElement = previousTextarea;
  });
  render(); render();
  return { props, screen, node, composer, popupInput, editables, terminalFocused, written, pasted, echoed, render, unmount, remount, tree: () => root,
    popup: () => elements(root).find(element => element.type?.name === 'ReadingTerminalPopup'),
    command(text) { listeners.get('agentrix:command')({ detail: { terminalId: props.terminal.id, text }, preventDefault() {} }); render(); },
    dictate: (text, submit = true) => { insert(text, submit); render(); },
    edit: text => { render().props.onChange({ target: { value: text } }); render(); },
    pending: () => elements(root).some(element => /\bis-sending-soon\b/.test(element.props.className)),
    press(key, modifiers = {}) {
      const event = { key, currentTarget: node, nativeEvent: {}, ...modifiers, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
      render().props.onKeyDown(event); render(); return event;
    },
    async tick(ms) { t.mock.timers.tick(ms); for (let i = 0; i < 12; i++) await Promise.resolve(); render(); },
  };
}

test('the reading composer uses the shared microphone beside send, with the same disabled state as its input', t => {
  const VoiceButton = () => null, h = dictationHarness(t, { './VoiceButton': { VoiceButton } });
  const microphone = () => elements(h.tree()).find(node => node.type === VoiceButton).props;
  assert.deepEqual([microphone().terminalId, microphone().sessionId, microphone().size, microphone().disabled], ['dictation', 'session', 15, false]);
  h.props.handoff = { locked: true, incoming: null, offer() {}, take() {} }; h.render();
  assert.equal(microphone().disabled, h.render().props.disabled); assert.equal(microphone().disabled, true);
  h.props.handoff.locked = false; h.render(); assert.equal(microphone().disabled, false);
});

function workingComposerHarness(t, agent, overrides = {}) {
  let clock = 10000, sequence = 0;
  t.mock.method(Date, 'now', () => clock);
  const prompts = require('../src/features/reading/pending-prompts.ts');
  let state = prompts.createPendingPrompts('session');
  const view = { working: true, draft: '', records: [], accept: true, retain: false };
  const filename = agent === 'claude' ? 'claude-idle-2-1-296.txt' : 'codex-fresh-default.txt';
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/screens', filename), 'utf8').split(/\r?\n/);
  const inputRow = fixture.findLastIndex(row => /^\s*[❯›](?:\s|$)/.test(row));
  assert.ok(inputRow >= 0);
  const rows = () => view.rows ?? [
    ...(view.working ? [agent === 'claude' ? '✶ Swooping… (12s)' : '• Working (12s · esc to interrupt)'] : []),
    ...fixture.flatMap((row, index) => index === inputRow ? view.draft.split(/\r?\n/).map((line, part) => (part ? '  ' : agent === 'claude' ? '❯ ' : '› ') + line) : [row]),
  ];
  const h = dictationHarness(t, {
    './terminal-screen': { useScreen: () => ({ rows: rows() }), readScreen: () => ({ rows: rows() }) },
    './agent-screen': { parseAgentScreen },
    './useReadingConversation': { useReadingHistory: () => historySnapshot(view.records) },
    './usePendingPrompts': { usePendingPrompts: () => {
      state = prompts.reconcilePendingPrompts(state, 'session', view.records, clock);
      return { pending: state.prompts,
        echo(text, images) { const id = 'working-' + ++sequence; state = prompts.addPendingPrompt(state, id, text, clock, images); h.echoed.push({ text, images }); return id; },
        cancelEcho(id) { state = prompts.removePendingPrompt(state, id); },
      };
    } },
    ...overrides,
  });
  Object.assign(h.props.terminal, { id: 'working-' + agent, agent, codexActivity: 'working' });
  window.agentrix.terminalCommands = async () => ({ ok: true, value: [{ name: '/model', source: 'builtin', description: '', view: 'terminal' }] });
  window.agentrix.pasteTerminal = async (id, text) => { h.pasted.push({ id, text }); view.draft += text; return { ok: true }; };
  window.agentrix.writeTerminal = (id, text) => {
    h.written.push({ id, text });
    if (text === '\x15') view.draft = '';
    if (text === '\r' && view.accept && view.draft) {
      view.records.push({ id: 'receipt-' + ++sequence, role: 'user', text: view.draft, at: clock, queued: view.working });
      if (!view.retain) view.draft = '';
    }
  };
  h.render();
  return { ...h, view, async tick(ms) { clock += ms; await h.tick(ms); } };
}

for (const agent of ['claude', 'codex']) {
  test(agent + ': dialog messages queue FIFO and drain after the first idle frame without answering the dialog', async t => {
    const h = workingComposerHarness(t, agent);
    h.view.rows = ['Settings', 'Esc to close']; h.render(); h.render();
    assert.ok(h.popup()); assert.equal(h.node.disabled, false);
    h.edit('first queued instruction'); h.press('Enter');
    h.edit('second queued instruction'); h.press('Enter');
    await h.tick(1000);
    assert.deepEqual(h.written, []); assert.deepEqual(h.pasted, []);
    assert.equal(elements(h.tree()).find(node => node.props.className === 'reading-outbox').props.children[1].props.children.length, 2);
    h.remount();
    assert.equal(elements(h.tree()).find(node => node.props.className === 'reading-outbox').props.children[1].props.children.length, 2, 'the outbox survives a raw/reading remount in the same session');
    h.edit('another draft stays here');
    delete h.view.rows; h.view.working = false; h.render(); h.render();
    assert.equal(h.popup(), undefined);
    for (let step = 0; step < 8; step++) await h.tick(800);
    assert.deepEqual(h.view.records.map(record => record.text), ['first queued instruction', 'second queued instruction']);
    assert.equal(h.node.value, 'another draft stays here');
    assert.equal(elements(h.tree()).some(node => node.props.className === 'reading-outbox'), false);
  });

  test(agent + ': terminal drafts mirror immediately and local edits survive conflicting terminal changes', t => {
    const h = workingComposerHarness(t, agent);
    h.view.draft = 'typed in terminal'; h.render(); h.render();
    assert.equal(h.node.value, 'typed in terminal');
    h.view.draft = 'terminal edit'; h.render(); h.render(); assert.equal(h.node.value, 'terminal edit');
    h.edit('local edit'); h.view.draft = 'conflicting terminal edit'; h.render(); h.render();
    assert.equal(h.node.value, 'local edit');
    assert.deepEqual(h.written, []); assert.deepEqual(h.pasted, []);
  });

  test(agent + ': remounting during an outbox send preserves uncertainty instead of replaying it', async t => {
    const h = workingComposerHarness(t, agent);
    h.view.rows = ['Settings', 'Esc to close']; h.render(); h.render();
    h.edit('queued instruction'); h.press('Enter');
    delete h.view.rows; h.view.working = false; h.render(); h.render(); await h.tick(0);
    assert.equal(h.pasted.length, 1);
    const takeBack = elements(h.tree()).find(node => node.props.className === 'reading-outbox').props.children[1].props.children[0].props.children.at(-1);
    assert.equal(takeBack.props.disabled, true); takeBack.props.onClick(); h.render(); assert.equal(h.node.value, '');
    h.remount(); h.view.draft = ''; h.render();
    await h.tick(1000); await h.tick(30000);
    assert.equal(h.pasted.length, 1);
    assert.ok(elements(h.tree()).some(node => node.props.children === en['送达未确认，请在终端检查']));
  });

  test(agent + ': a dialog arriving after paste cancels the delayed Enter', async t => {
    const h = workingComposerHarness(t, agent);
    h.edit('ordinary instruction'); h.press('Enter'); await h.tick(0);
    assert.equal(h.pasted.length, 1);
    h.view.rows = ['Settings', 'Esc to close']; h.render(); await h.tick(1000);
    assert.equal(h.written.some(write => write.text === '\r'), false);
  });

  test(agent + ': a working fixture accepts typing, Shift+Enter and the Send button, and renders the CLI queue', async t => {
    const h = workingComposerHarness(t, agent);
    h.edit('first line');
    assert.equal(h.render().props.disabled, false);
    assert.match(h.render().props.placeholder, /Enter/);
    assert.equal(h.press('Enter', { shiftKey: true }).prevented, undefined);
    assert.deepEqual(h.pasted, []);
    h.edit('first line\nsecond line');
    const send = elements(h.tree()).find(element => element.props.className === 'icon-button reading-send');
    assert.equal(send.props.disabled, false); send.props.onClick(); await h.tick(0);
    assert.deepEqual(h.pasted.map(item => item.text), ['first line\nsecond line']);
    assert.equal(h.node.value, '');
    await h.tick(400);
    const card = elements(h.tree()).find(element => element.props.queued);
    assert.equal(card.props.prompts.length, 1); assert.equal(card.props.queued(card.props.prompts[0]), true);
    await h.tick(700); await h.tick(30000);
    assert.deepEqual(h.written.map(item => item.text), ['\r']);
    assert.equal(h.pasted.length, 1);
  });

  test(agent + ': working Stop and Esc interrupt, while dictation and the slash palette keep Escape priority', async t => {
    const h = workingComposerHarness(t, agent);
    const stop = () => elements(h.tree()).find(element => element.props.title === en['中断（Esc）']);
    assert.equal(stop().props.disabled, false); stop().props.onClick();
    h.edit('keep editing'); h.press('Escape');
    assert.deepEqual(h.written.map(item => item.text), ['\x1b', '\x1b']);
    assert.equal(h.node.value, 'keep editing');
    h.dictate('spoken words'); assert.equal(h.pending(), true);
    const cancel = h.press('Escape');
    assert.equal(cancel.prevented, true); assert.equal(cancel.stopped, true); assert.equal(h.pending(), false);
    assert.equal(h.written.length, 2);
    h.edit('/mo'); await h.tick(0);
    const palette = () => elements(h.tree()).find(element => element.props.role === 'listbox');
    assert.ok(palette()); h.press('Escape'); assert.equal(palette(), undefined); assert.equal(h.written.length, 2);
    h.edit('/mo'); elements(h.tree()).find(element => element.props.role === 'option').props.onClick(); h.render();
    assert.equal(h.node.value, '/model ');
    h.edit('/model'); h.press('Enter'); await h.tick(0);
    assert.equal(h.popup().props.command, '/model'); assert.equal(h.node.disabled, false); assert.equal(stop().props.disabled, true);
    const before = h.written.slice(); h.press('Escape'); h.press('Enter');
    assert.deepEqual(h.written, before, 'an open popup still owns the keys');
    h.popup().props.onClose(); h.render();
    assert.equal(h.node.disabled, false); assert.equal(stop().props.disabled, false);
  });

  test(agent + ': ↑ and ↓ walk the messages sent from the box and give back the draft that was not sent, and "/" still lists the commands', async t => {
    const h = workingComposerHarness(t, agent);
    for (const text of ['first note', 'second note']) { h.edit(text); h.press('Enter'); await h.tick(0); await h.tick(700); await h.tick(400); await h.tick(700); }
    assert.equal(h.node.value, '');
    h.edit('unsent draft');
    h.node.selectionStart = h.node.selectionEnd = 5; assert.notEqual(h.press('ArrowUp').prevented, true, 'not at the start: the caret moves');
    h.node.selectionStart = h.node.selectionEnd = 0; assert.equal(h.press('ArrowUp', { shiftKey: true }).prevented, undefined, 'a modifier keeps the arrow the box’s');
    assert.equal(h.press('ArrowUp').prevented, true); assert.equal(h.node.value, 'second note'); assert.equal(h.node.selectionStart, 0);
    h.press('ArrowUp'); assert.equal(h.node.value, 'first note'); h.press('ArrowUp'); assert.equal(h.node.value, 'first note');
    h.node.selectionStart = h.node.selectionEnd = 'first note'.length; h.press('ArrowDown'); assert.equal(h.node.value, 'second note');
    h.node.selectionStart = h.node.selectionEnd = 'second note'.length; h.press('ArrowDown'); assert.equal(h.node.value, 'unsent draft');
    h.node.selectionStart = h.node.selectionEnd = 'unsent draft'.length; assert.notEqual(h.press('ArrowDown').prevented, true, 'the walk is over');
    h.edit('/mo'); await h.tick(0); const listed = () => elements(h.tree()).some(element => element.props.role === 'listbox');
    assert.equal(listed(), true); h.edit('');
  });

  test(agent + ': working input enables the mention hook and quotes on the next ordinary message', async t => {
    let mention;
    const h = workingComposerHarness(t, agent, {
      './useMentions': { useMentions: options => { mention = options; return { open: false, keys: () => false }; } },
    });
    h.edit('@src'); assert.equal(mention.disabled, false);
    mention.edit('@src/main.ts '); h.render(); assert.equal(h.node.value, '@src/main.ts ');
    const quote = elements(h.tree()).find(element => element.props.value?.quote).props.value.quote;
    assert.equal(quote.disabled, null); quote.pick(agent, 'earlier reply'); h.render();
    assert.equal(elements(h.tree()).find(element => element.type?.name === 'QuoteChip').props.quote.excerpt, 'earlier reply');
    h.edit('@src/main.ts please fix'); h.press('Enter'); await h.tick(0);
    assert.deepEqual(h.pasted.map(item => item.text), ['> earlier reply\n\n@src/main.ts please fix']);
  });

  for (const retain of [false, true]) test(`${agent}: a queued message with ${retain ? 'retained' : 'cleared'} CLI input never retries automatically and survives the next idle send`, async t => {
    const h = workingComposerHarness(t, agent); h.view.retain = retain;
    const errors = []; h.props.onError = error => errors.push(error);
    h.edit('queued message'); h.press('Enter'); await h.tick(0); await h.tick(400);
    assert.equal(h.view.draft, retain ? 'queued message' : '');
    h.view.working = false; h.render(); await h.tick(700); await h.tick(30000);
    assert.deepEqual(h.written.map(item => item.text), ['\r']); assert.equal(h.pasted.length, 1);
    h.view.retain = false;
    h.edit('next message'); h.press('Enter'); await h.tick(0);
    if (agent === 'codex' && retain) {
      await h.tick(30000);
      assert.deepEqual(h.written.map(item => item.text), ['\r']);
      assert.deepEqual(h.pasted.map(item => item.text), ['queued message']);
      assert.equal(h.view.draft, 'queued message'); assert.equal(h.node.value, 'next message');
      assert.ok(h.popup()); assert.equal(errors.length, 1); return;
    }
    assert.equal(h.written.filter(item => item.text === '\r').length, retain ? 2 : 1, 'an idle returned input is submitted only by the next explicit send');
    await h.tick(700); await h.tick(400); await h.tick(700);
    assert.deepEqual(h.pasted.map(item => item.text), ['queued message', 'next message']);
    assert.equal(h.written.filter(item => item.text === '\r').length, retain ? 3 : 2);
    assert.equal(h.written.some(item => item.text === '\x15'), false);
  });

  test(agent + ': busy input without a receipt never retries Enter or safety-net resends', async t => {
    const h = workingComposerHarness(t, agent); h.view.accept = false;
    h.edit('not acknowledged yet'); h.press('Enter'); await h.tick(0); await h.tick(400);
    await h.tick(700); await h.tick(30000);
    assert.deepEqual(h.written.map(item => item.text), ['\r']); assert.equal(h.pasted.length, 1);
  });
}

for (const removal of ['stale', 'popAll', 'remove', 'history-only', 'history-remount']) for (const dropped of [0, 1, 4]) test(`claude: Esc restores a queued input before the next send (${removal}, ${dropped} dropped Enters)`, async t => {
  const { ConversationLog, claudeConversation } = require('../electron/conversation.cjs');
  const log = new ConversationLog(), accepted = [], first = 'RESTORED_MESSAGE', next = 'NEXT_MESSAGE';
  const h = workingComposerHarness(t, 'claude');
  Object.defineProperty(h.view, 'records', { get: () => log.list });
  let remaining = dropped, sequence = 0;
  window.agentrix.writeTerminal = (id, text) => {
    h.written.push({ id, text });
    if (text === '\x15') h.view.draft = '';
    if (text === '\x1b') {
      h.view.working = false; h.view.draft = first;
      if (removal !== 'stale') claudeConversation(log, { type: 'queue-operation', operation: removal === 'remove' ? 'remove' : 'popAll',
        timestamp: new Date(Date.now()).toISOString(), ...(removal === 'remove' ? { content: first, reason: 'cleared_on_cancel' } : {}) });
    }
    if (text !== '\r' || !h.view.draft) return;
    if (!h.view.working && remaining) { remaining--; return; }
    const content = h.view.draft, timestamp = new Date(Date.now()).toISOString();
    accepted.push(content);
    claudeConversation(log, h.view.working
      ? { type: 'queue-operation', operation: 'enqueue', uuid: 'queue-' + ++sequence, timestamp, content }
      : { type: 'user', uuid: 'user-' + ++sequence, timestamp, message: { content } });
    h.view.draft = ''; h.view.working = true;
  };
  h.edit(first); h.press('Enter'); await h.tick(0); await h.tick(400); await h.tick(700);
  assert.deepEqual(accepted, [first]);
  assert.deepEqual(log.list.filter(entry => entry.queued).map(entry => entry.text), [first]);
  h.press('Escape');
  if (removal.startsWith('history-')) { for (const entry of [...log.list]) log.drop(entry.id); h.render(); }
  if (removal === 'history-remount') h.remount();
  // Reuse the captured Claude input box and footer, with the queued words returned to its editable row.
  assert.equal(h.view.draft, first); assert.equal(h.node.disabled, false);
  const queued = () => elements(h.tree()).find(element => element.props.queued);
  assert.equal(queued().props.prompts.length, removal === 'stale' ? 1 : 0, 'cancellation retires the old card and its echo');
  await h.tick(3000);
  h.edit(next); h.press('Enter'); await h.tick(0);
  for (let attempt = 0; attempt < 5; attempt++) await h.tick(700);
  assert.equal(h.written.some(item => item.text === '\x15'), false, 'the returned queued input must never be cleared');
  if (dropped === 4) {
    assert.deepEqual(accepted, [first]); assert.equal(h.view.draft, first); assert.equal(h.node.value, next);
    assert.deepEqual(h.pasted.map(item => item.text), [first], 'do not paste the next message over an unaccepted returned draft');
    assert.deepEqual(queued().props.prompts.map(prompt => prompt.text), removal === 'stale' ? [first] : [], 'the next message has no false sent card');
  } else {
    assert.deepEqual(accepted, [first, first, next], 'submit the restored message before queueing the next one');
    assert.equal(log.list.filter(entry => entry.role === 'user' && !entry.queued && entry.text === first).length, 1);
    assert.deepEqual(queued().props.prompts.map(prompt => prompt.text), [next]);
    assert.equal(queued().props.queued(queued().props.prompts[0]), true, 'only the next message remains queued');
  }
});

test('codex: a delivered receipt with retained input never causes another Enter or clears either draft', async t => {
  const h = workingComposerHarness(t, 'codex'), errors = [];
  h.view.retain = true;
  h.props.onError = error => errors.push(error);
  h.edit('already delivered'); h.press('Enter'); await h.tick(0); await h.tick(400);
  h.view.working = false; h.view.records[0].queued = false; h.render();
  await h.tick(700); await h.tick(30000);
  assert.deepEqual(h.written.map(item => item.text), ['\r'], 'a delivery receipt also stops delayed Enter retries');
  const quote = elements(h.tree()).find(element => element.props.value?.quote).props.value.quote;
  quote.pick('Codex', 'keep this quote'); h.render();
  h.edit('next message'); h.press('Enter'); await h.tick(0);
  assert.deepEqual(h.written.map(item => item.text), ['\r']);
  assert.deepEqual(h.pasted.map(item => item.text), ['already delivered']);
  assert.equal(h.view.draft, 'already delivered'); assert.equal(h.node.value, 'next message');
  assert.equal(h.popup().props.focus, false); assert.equal(errors.length, 1);
  assert.equal(elements(h.tree()).find(element => element.type?.name === 'QuoteChip').props.quote.excerpt, 'keep this quote');
  assert.equal(elements(h.tree()).find(element => element.props.queued).props.prompts.length, 0);
});

for (const change of ['session', 'thread']) test('own send history does not cross a different ' + change, async t => {
  const h = workingComposerHarness(t, 'claude');
  h.props.terminal.readingHistory = { key: 'old', agent: 'claude', threadId: 'old' }; h.render();
  h.edit('old message'); h.press('Enter'); await h.tick(0); await h.tick(400); await h.tick(700);
  h.view.records[0].cancelled = true; h.render();
  h.view.records.length = 0; h.view.working = false; h.view.draft = 'old message';
  if (change === 'session') h.props.terminal.sessionId = 'different-session';
  else h.props.terminal.readingHistory = { key: 'new', agent: 'claude', threadId: 'new' };
  h.render(); h.render();
  h.edit('new message'); h.press('Enter'); await h.tick(80);
  assert.equal(h.written.filter(item => item.text === '\r').length, 1, 'never submit a prior session or thread through the history recovery path');
  assert.deepEqual(h.pasted.map(item => item.text), ['old message', 'new message']);
});

test('codex: picture paste cannot erase or attach to a previously delivered input', async t => {
  const h = workingComposerHarness(t, 'codex'), errors = [];
  h.props.onError = error => errors.push(error);
  h.view.draft = 'already delivered'; h.view.records.push({ id: 'delivered', role: 'user', text: h.view.draft, at: Date.now() });
  h.edit('next message');
  h.render().props.onPaste({ preventDefault() {}, clipboardData: { getData: () => '', items: [{ kind: 'file', type: 'image/png', getAsFile: () => ({ size: 1 }) }] } });
  await h.tick(0);
  assert.deepEqual(h.written, []); assert.deepEqual(h.pasted, []);
  assert.equal(h.view.draft, 'already delivered'); assert.equal(h.node.value, 'next message');
  assert.ok(h.popup()); assert.equal(errors.length, 1);
});

test('submitted dictation appears at the caret for half a second, then uses the composer send with pictures', async t => {
  const h = imageComposerHarness(t, 'codex');
  h.edit('before replace after'); h.node.setSelectionRange(7, 14);
  await h.paste(1);
  h.dictate('spoken');
  assert.equal(h.node.value, 'before spoken after');
  assert.equal(document.activeElement, h.node);
  assert.equal(h.node.selectionStart, 13); assert.equal(h.node.selectionEnd, 13);
  assert.equal(h.pending(), true);
  await h.tick(499); assert.deepEqual(h.pasted, []);
  await h.tick(1);
  assert.deepEqual(h.pasted, [{ id: 'dictation', text: 'before spoken after' }]);
  assert.deepEqual(h.echoed, [{ text: 'before spoken after', images: ['data:image/png;base64,1'] }]);
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

test('the delayed send queues text when a confirmation arrives before dictation submits', async t => {
  const h = dictationHarness(t); h.dictate('wait');
  h.screen.choice = fakeChoice(); h.render();
  await h.tick(1000);
  assert.deepEqual(h.pasted, []); assert.equal(h.node.value, ''); assert.equal(h.pending(), false);
  assert.ok(elements(h.tree()).some(node => node.props.className === 'reading-outbox'));
});

test('dictation without submit inserts and focuses without scheduling a send', async t => {
  const h = dictationHarness(t); document.activeElement = null;
  h.dictate('insert only', false);
  assert.equal(h.node.value, 'insert only'); assert.equal(document.activeElement, h.node);
  assert.equal(h.node.selectionStart, 11); assert.equal(h.pending(), false);
  await h.tick(2000); assert.deepEqual(h.pasted, []);
});

test('welcome command rows call the existing completion callback with the cached command', () => {
  const { ReadingWelcome } = loadUI('features/reading/ReadingWelcome.tsx');
  const command = { name: '/model', source: 'builtin', description: '切换模型', view: 'terminal' };
  const picked = [];
  const root = ReadingWelcome({ agent: 'claude', screen: fakeScreen(), commands: [command], complete: value => picked.push(value), disabled: false });
  elements(root).find(node => node.type === 'button').props.onClick();
  assert.deepEqual(picked, [command]);
});

function readingMode(overrides = {}) {
  return loadUI('features/reading/reading-mode.ts', { react: { useSyncExternalStore: (_subscribe, snapshot) => snapshot() }, ...overrides });
}
const terminal = (id, needsInput = 'Allow command?') => ({ id, sessionId: 'session', codexActive: true, needsInput });
const isReading = (mode, value) => mode.readingShown(value, mode.useTerminalChoice());

test('terminal screen callbacks return an automatic raw handoff immediately without another host update', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let rows = ['Settings', 'Esc to close'], notify;
  const mode = readingMode({ './terminal-screen.ts': { readScreen: () => ({ rows }), subscribeScreen: (_id, callback) => { notify = callback; return () => {}; } } });
  const value = { ...terminal('live-screen-return'), agent: 'codex' };
  mode.syncReading(value); t.mock.timers.tick(1500); assert.equal(isReading(mode, value), false);
  rows = composerRows('codex'); notify();
  assert.equal(isReading(mode, value), true);
  assert.equal(value.needsInput, 'Allow command?', 'the stale host notice did not need to change');
  mode.setReading(value.id, false); notify(); assert.equal(isReading(mode, value), false, 'manual raw selection remains the owner choice');
});

test('removed terminals release reading monitors and handoff timers without a final exit event', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const before = global.window; let inventory, screen, screenDisposals = 0, stateDisposals = 0;
  global.window = { agentrix: { onState(callback) { inventory = callback; return () => { stateDisposals++; }; } } };
  t.after(() => { global.window = before; });
  const mode = readingMode({ './terminal-screen.ts': { readScreen: () => null,
    subscribeScreen(_id, callback) { screen = callback; return () => { screenDisposals++; }; } } });
  const value = { ...terminal('removed-waiting'), agent: 'codex' };
  mode.syncReading(value); inventory({ projects: [] }); t.mock.timers.tick(2000);
  assert.equal(isReading(mode, value), true); assert.equal(screenDisposals, 1); assert.equal(stateDisposals, 1);
  mode.syncReading(value); screen({ rows: [], sessionId: null }); t.mock.timers.tick(2000);
  assert.equal(isReading(mode, value), true); assert.equal(screenDisposals, 2); assert.equal(stateDisposals, 2);
  const blank = readingMode({ './terminal-screen.ts': { readScreen: () => null,
    subscribeScreen(_id, callback) { callback({ rows: [], sessionId: null }); return () => { screenDisposals++; }; } } });
  blank.syncReading(value);
  assert.equal(screenDisposals, 3); assert.equal(stateDisposals, 2, 'a synchronous unmount cannot leave a state subscription');
});

test('a late host CLI revision cannot rearm reading-mode handoff after a newer idle event', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mode = readingMode({ './terminal-screen.ts': { readScreen: () => ({ rows: composerRows('codex') }), subscribeScreen: () => () => {} } });
  const value = { ...terminal('ordered-handoff'), agent: 'codex', cliState: { sessionId: 'session', revision: 2, updatedAt: 2000, state: 'idle' } };
  mode.syncReading(value);
  value.cliState = { ...value.cliState, revision: 1, state: 'waiting' }; mode.syncReading(value);
  t.mock.timers.tick(3000); assert.equal(isReading(mode, value), true);
});

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

test('an identity-checked restored history may show before the CLI, respects raw choice and disappears when unbound', () => {
  const mode = readingMode(), value = { ...terminal('restored-preview', null), sessionId: null, codexActive: false,
    readingHistory: { key: 'checked-session', agent: 'claude', threadId: 'restored' } };
  assert.equal(isReading(mode, value), true);
  mode.setReading(value.id, false); assert.equal(isReading(mode, value), false);
  mode.setReading(value.id, true); assert.equal(isReading(mode, value), true);
  assert.equal(isReading(mode, { ...value, readingHistory: null }), false);
});

test('the composer offers its hint longest first and shows the one that fits, so a narrow box reads a short hint instead of a cut-off one', async t => {
  const offered = [], narrow = { './useFittingHint': { ...require('../src/shared/useFittingHint.ts'), useFittingHint: (box, hints) => (offered.splice(0, offered.length, ...hints), hints.at(-1)) } };
  const h = dictationHarness(t, narrow);
  Object.assign(h.props.terminal, { codexActive: true, readingHistory: null });
  const shown = h.render().props.placeholder;
  const strictlyShorter = list => list.every((hint, index) => index === 0 || hint.length < list[index - 1].length);
  assert.equal(offered.length, 3); assert.ok(strictlyShorter(offered), 'longest first');
  assert.equal(offered[0], en['给 {agent} 发消息，/ 查看命令，@ 提及文件，Enter 发送，Shift+Enter 换行'].replace('{agent}', /Claude Code|Codex/.exec(offered[0])[0]), 'the full hint is the one that was always shown');
  assert.ok(offered.every(hint => hint.includes(/Claude Code|Codex/.exec(offered[0])[0])), 'each form still says who it is for');
  assert.equal(shown, offered[2], 'the shortest hint is the one the narrow box shows');
  const box = h.render(), note = elements(h.tree()).find(element => element.props.id === box.props['aria-describedby']);
  assert.equal(box.props.title, offered[0], 'the full hint, shortcuts included, is the narrow box’s tooltip');
  assert.match(box.props['aria-describedby'], /^reading-hint-/); assert.equal(note.props.children, offered[0], 'and its accessible description, in a hidden element');
  assert.equal(note.props.style.position, 'absolute', 'the description is not drawn');
  Object.assign(h.props.terminal, { codexActive: false });
  h.render();
  assert.equal(offered.length, 1); assert.equal(offered[0], en['会话未启动或已退出']);
});

test('a restored preview cannot send until its own CLI input is ready, and a different thread disables it again', async t => {
  let rows = [];
  const h = dictationHarness(t, { './terminal-screen': { useScreen: () => ({ rows }), readScreen: () => ({ rows }) } });
  Object.assign(h.props.terminal, { sessionId: null, codexActive: false, readingHistory: { key: 'history-a', agent: 'codex', threadId: 'restored' } });
  assert.equal(h.render().props.disabled, true);
  assert.equal(h.render().props.placeholder, en['历史预览，等待会话输入就绪']);
  h.edit('do not send before ready'); h.press('Enter'); await h.tick(1000);
  h.command('/status'); await h.tick(1000);
  h.dictate('/status', true); await h.tick(1000);
  assert.deepEqual(h.written, []); assert.deepEqual(h.pasted, []);
  Object.assign(h.props.terminal, { sessionId: 'resumed-runtime', codexActive: true });
  assert.equal(h.render().props.disabled, true);
  rows = ['› Ask Codex to do anything', '', 'gpt-6.1-sol · high · 100% context left'];
  assert.equal(h.render().props.disabled, false);
  rows = ['Working...'];
  assert.equal(h.render().props.disabled, false, 'a live session stays editable during an unrecognised redraw');
  h.props.terminal.readingHistory = { key: 'new-capability', agent: 'codex', threadId: 'restored' };
  assert.equal(h.render().props.disabled, false, 'the draft remains usable while delivery waits for the CLI input');
  h.props.terminal.readingHistory = { key: 'history-b', agent: 'codex', threadId: 'different' };
  assert.equal(h.render().props.disabled, true);
});

test('a first-turn page binding cannot cancel the pending Enter or change the pending-prompt runtime slot', async t => {
  const rows = ['› Ask Codex to do anything', '', 'gpt-6.1-sol · high · 100% context left'], owners = [];
  const h = dictationHarness(t, {
    './terminal-screen': { useScreen: () => ({ rows }), readScreen: () => ({ rows }) },
    './usePendingPrompts': { usePendingPrompts: (_id, session) => { owners.push(session); return { pending: [], echo: () => 'pending:first', cancelEcho() {} }; } },
  });
  h.edit('first turn'); h.press('Enter'); await h.tick(100);
  assert.equal(h.pasted.length, 1); assert.deepEqual(h.written, []);
  h.props.terminal.readingHistory = { key: 'first-key', agent: 'codex', threadId: 'first-thread' };
  h.render(); await h.tick(400);
  assert.equal(h.written.filter(write => write.text === '\r').length, 1);
  h.props.terminal.readingHistory = { key: 'refreshed-key', agent: 'codex', threadId: 'first-thread' };
  h.render(); await h.tick(700);
  assert.ok(owners.every(owner => owner === 'session'));
});

test('pending echoes survive a newly learned thread but a real thread or runtime switch clears them', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { usePendingPrompts } = loadUI('features/reading/usePendingPrompts.ts', { './pending-prompts': require('../src/features/reading/pending-prompts.ts'), react: {
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(), useMemo: make => make(), useLayoutEffect: run => run(),
  } });
  const id = 'pending-identity-test';
  usePendingPrompts(id, 'runtime', []).echo('still sending');
  assert.equal(usePendingPrompts(id, 'runtime', [], 'first-thread').pending.length, 1);
  assert.equal(usePendingPrompts(id, 'runtime', [], 'different-thread').pending.length, 0);
  usePendingPrompts(id, 'runtime', [], 'different-thread').echo('second send');
  assert.equal(usePendingPrompts(id, 'new-runtime', [], 'different-thread').pending.length, 0);
});

test('a read-only preview suppresses stale screen choices and approval cards', t => {
  const h = dictationHarness(t);
  h.screen.choice = { kind: 'permission', options: [], question: 'stale screen' };
  Object.assign(h.props.terminal, { codexActive: false, readingHistory: { key: 'preview', agent: 'codex', threadId: 'saved' }, nativeApprovals: [{ token: 'stale' }] });
  assert.equal(h.render().props.disabled, true);
  assert.equal(elements(h.tree()).some(node => node.props.choice || node.props.request), false);
});

// Dialog coverage uses the real ReadingView and parser, including frames that no parser recognises.
const { popupHarness } = require('./reading-popup-coverage.test.cjs');
for (const type of ['input', 'textarea', 'select', 'contenteditable']) test('a dialog opens without taking focus from a focused ' + type, t => {
  const h = popupHarness(t);
  const editable = { matches: selector => selector.split(/,\s*/).includes(type), isContentEditable: type === 'contenteditable' };
  // Textareas are also protected while typing outside the reader; other editors are within its root.
  h.tree().props.ref.current = { contains: target => target === editable };
  document.activeElement = editable;
  h.view.rows = ['Settings', 'Esc to close']; h.render();
  h.tree().props.ref.current = { contains: target => target === editable };
  h.tick(3000);
  assert.ok(h.popup()); assert.equal(h.popup().props.focus, false); assert.equal(document.activeElement, editable);
  assert.deepEqual(h.writes, []); assert.deepEqual(h.pastes, []);
});

test('the terminal surface follows reading intent even before the reading subtree exists, and respects raw choice', () => {
  const mode = readingMode(), value = { ...terminal('surface', null), title: 'Terminal', status: 'shell' };
  const { ProjectTerminals } = loadUI('features/terminal/ProjectTerminals.tsx', {
    './reading-mode': mode,
    './NativeSessionView': { NativeSessionView: () => null }, './NativePathNote': { NativePathNote: () => null },
    './native-store.ts': { useNativeEntries: () => new Map(), nativeShown: () => false, ensureNativeSession() {} },
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

test('a restored preview and live splits keep the same order and fallback selection in small and expanded cards', () => {
  const mode = readingMode(), { ProjectTerminals } = loadUI('features/terminal/ProjectTerminals.tsx', {
    './NativeSessionView': { NativeSessionView: () => null }, './NativePathNote': { NativePathNote: () => null },
    './native-store.ts': { useNativeEntries: () => new Map(), nativeShown: () => false, ensureNativeSession() {} },
    './reading-mode': mode, './ReadingView': { ReadingView: () => null }, './TerminalPane': { TerminalPane: () => null },
    './AgentLauncher': { AgentLauncher: () => null }, './useProjectReorder': { useReorder: () => ({}) },
  });
  const first = { ...terminal('preview', null), title: 'Preview', codexActive: false, sessionId: null, readingHistory: { key: 'preview-key', agent: 'codex', threadId: 'saved' } };
  const second = { ...terminal('live', null), title: 'Live' };
  for (const focused of [false, true]) {
    const html = renderToStaticMarkup(React.createElement(ProjectTerminals, {
      project: { id: 'project', name: 'Project', terminals: [first, second] }, focused, activeId: null, setActiveId() {}, fontSize: 14,
    }));
    assert.ok(html.indexOf('data-terminal-slot="preview"') < html.indexOf('data-terminal-slot="live"'));
    assert.match(html, /class="terminal-split is-active-terminal\s*"[^>]*data-terminal-id="preview"/);
  }
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
  // A sent message's quote block is laid out by the same Markdown renderer, so it gets the same stubs.
  const markdownStubs = { './markdown-escape': { readingMarked: { parse: text => { parsed.push(text); return text; } } }, dompurify: { default: () => ({ sanitize: html => html }) }, ...overrides };
  const environment = {
    './markdown-escape': markdownStubs['./markdown-escape'], dompurify: markdownStubs.dompurify,
    '@phosphor-icons/react': new Proxy({}, { get: () => icon }),
    './action-text': { stepVerb: tool => tool.kind, actionText: tool => tool.target }, './voice-input': {}, './terminal-screen': { useScreen: () => ({ rows: composerRows(state.terminal.agent, state.terminal.codexActivity === 'working' ? 'working' : 'idle') }) },
    './typing': { isTyping: () => false, hasEditingFocus: () => false },
    './agent-screen': { parseAgentScreen },
    './ReadingWelcome': { ReadingWelcome: () => React.createElement('p', null, 'welcome preserved') },
    './ReadingChoice': {}, './ReadingQuestion': {}, './reading-mode': {},
    './useStickToBottom': { useStickToBottom: () => ({ stuck: true, unseen: 0, ready: true, holdPosition() {}, toBottom() {} }) },
    './useReadingConversation': { conversationKey: () => 'session', useReadingHistory: () => historySnapshot(state.entries) },
    './useVisibleTail': tail, './reading.css': {},
    './useMentions': { useMentions: () => ({ open: false }) }, './MentionPalette': { MentionPalette: () => null },
    './pending-prompts': require('../src/features/reading/pending-prompts.ts'),
    './usePendingPrompts': { usePendingPrompts: () => ({ pending: state.pending, echo() {}, cancelEcho() {} }) },
    './PendingPromptEntries': loadUI('features/reading/PendingPromptEntries.tsx', markdownStubs),
    './markdown-parse': { parseMarkdown: async () => null, parsedMarkdown: () => undefined },
    './FileCards': { FileCards: ({ files }) => React.createElement('div', { className: 'file-cards' }, files.join(',')), previewable: () => true },
    './reading-command': require('../src/features/reading/reading-command.ts'),
    './reading-welcome': { useWelcomeStarting: () => false },
    './cli-panel': require('../src/features/reading/cli-panel.ts'),
    './i18n': { currentLanguage: () => 'en', t: (text, values) => (en[text] ?? text).replace(/\{(\w+)\}/g, (_, name) => String(values?.[name] ?? name)) },
    ...overrides,
  };
  const { ReadingView, Markdown } = loadUI('features/reading/ReadingView.tsx', environment);
  const render = () => renderToStaticMarkup(React.createElement(ReadingView, {
    projectId: 'project', terminal: state.terminal,
    autoFocus: false, onShowTerminal() {}, onError() {}, onOpenLink() {},
  }));
  return { state, render, parsed, ReadingView, Markdown, environment };
}

test('Markdown can opt into soft line breaks without changing the reading view default', t => {
  const { Markdown } = readingHarness(t, [], { './markdown-escape': require('../src/features/reading/markdown-escape.ts') });
  const text = 'First line\ncontinues here.';
  const render = softBreaks => renderToStaticMarkup(React.createElement(Markdown, { text, softBreaks }));
  assert.match(render(true), /<p>First line\ncontinues here\.<\/p>/);
  assert.match(render(false), /<p>First line<br>continues here\.<\/p>/);
  assert.match(render(undefined), /<p>First line<br>continues here\.<\/p>/);
});

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
    assert.equal((html.match(/class="reading-content\b/g) || []).length, 1, 'one content container owns the timeline rail');
    assert.match(html, /class="reading-content conversation-feed"[^>]*><div class="reading-step is-user/, 'the feed preserves direct rail children');
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

test('a sub-agent step names its role on one line with an ellipsis and the whole role in its title, never broken letter by letter', t => {
  const { render } = readingHarness(t, [readingEntry('u1', 'user', 10, { text: 'go' }), readingTool('检查现有测试覆盖', 11, { kind: 'agent', tool: 'Task', done: false, detail: 'general-purpose' })]);
  const html = render();
  assert.match(html, /<li class="[^"]*reading-tool-agent"[^>]*>[\s\S]*<small title="general-purpose">general-purpose<\/small>/);
  const flow = fs.readFileSync(path.join(__dirname, '../src/features/reading/reading-flow.css'), 'utf8');
  assert.match(flow, /\.reading-tools-tree li\.reading-tool-agent > small \{ overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
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
  const instances = new Map(); let slots, cursor, decorations = null;
  const hooks = {
    useState(initial) { const index = cursor++; if (!Object.hasOwn(slots, index)) slots[index] = typeof initial === 'function' ? initial() : initial; const own = slots; return [own[index], value => { own[index] = typeof value === 'function' ? value(own[index]) : value; }]; },
    useRef(initial) { return hooks.useState(() => ({ current: initial }))[0]; },
    useMemo(make) { return make(); }, useContext() { return decorations; }, useEffect() {}, useLayoutEffect() {},
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
      else if (node.type?.name === 'ConversationFeed') visit(run(key, node.type, node.props), key);
      else if (node.props?.value && 'start' in node.props.value) { const previous = decorations; decorations = node.props.value; visit(node.props.children, key); decorations = previous; }
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
    './useReadingConversation': { conversationKey: (id, session) => session, useReadingHistory: () => historySnapshot(records) },
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

test('a matching text receipt cannot acknowledge missing pictures, and a later image update can', () => {
  const prompts = require('../src/features/reading/pending-prompts.ts');
  const state = prompts.addPendingPrompt(prompts.createPendingPrompts('session'), 'pictures', 'describe both', 1000, [], 2);
  const record = { id: 'receipt', role: 'user', text: 'describe both', at: 1100, images: ['one'] };
  assert.equal(prompts.reconcilePendingPrompts(state, 'session', [record], 1200), state);
  const expired = prompts.reconcilePendingPrompts(state, 'session', [record], 22000);
  assert.equal(expired.prompts.length, 1); assert.equal(expired.prompts[0].sending, false);
  assert.ok(!expired.seen.includes(record.id));
  record.images.push('two');
  assert.equal(prompts.reconcilePendingPrompts(expired, 'session', [record], 23000).prompts.length, 0);
});

test('an image-only send has a pending receipt until the transcript carries its image', () => {
  const prompts = require('../src/features/reading/pending-prompts.ts');
  const state = prompts.addPendingPrompt(prompts.createPendingPrompts('session'), 'picture-only', '', 1000, [], 1);
  assert.equal(state.prompts.length, 1);
  assert.equal(prompts.reconcilePendingPrompts(state, 'session', [{ id: 'image', role: 'user', text: '', at: 1100, images: ['one'] }], 1200).prompts.length, 0);
});

test('an unconfirmed image receipt stays visible and cannot retry or resend as text only', async t => {
  const prompts = require('../src/features/reading/pending-prompts.ts');
  let clock = 30000;
  t.mock.method(Date, 'now', () => clock);
  const records = [{ id: 'text-only', role: 'user', text: 'describe this', at: 1100 }], errors = [];
  let state = prompts.addPendingPrompt(prompts.createPendingPrompts('session'), 'image-send', 'describe this', 1000, ['picture']);
  const h = dictationHarness(t, {
    './useReadingConversation': { useReadingHistory: () => historySnapshot(records) },
    './usePendingPrompts': { usePendingPrompts: () => {
      state = prompts.reconcilePendingPrompts(state, 'session', records, clock);
      return { pending: state.prompts, echo: () => assert.fail('image receipt was resent'), cancelEcho: () => assert.fail('image receipt was discarded') };
    } },
  });
  h.props.onError = error => errors.push(error);
  clock += 6000; await h.tick(6000);
  assert.deepEqual(h.pasted, []); assert.equal(state.prompts.length, 1);
  const card = elements(h.tree()).find(element => element.props?.undelivered);
  assert.equal(card.props.undelivered(state.prompts[0]), true);
  card.props.onResend(state.prompts[0]);
  assert.equal(errors.length, 1); assert.deepEqual(h.pasted, []);
  assert.match(errors[0], /Image delivery is unconfirmed\..*Check the conversation/);
});

test('an unconfirmed image receipt advises checking the conversation instead of removing a composer picture', () => {
  const { PendingPromptEntries } = loadUI('features/reading/PendingPromptEntries.tsx', { './Markdown': { Markdown: ({ text }) => text } });
  const html = renderToStaticMarkup(React.createElement(PendingPromptEntries, {
    prompts: [{ id: 'pending-image', role: 'user', text: 'describe', at: 1000, sending: false, imageCount: 1 }], undelivered: () => true,
  }));
  assert.match(html, /Image delivery is unconfirmed\./);
  assert.doesNotMatch(html, /Check and remove this image|Remove it here|Resend/);
});

// A native editor with atomic image elements, following Claude 2.1.312's Mi cursor and Codex 0.165.0's TextArea.
// It retains actual attachment identities separately from their labels, so renumbering cannot hide a wrong deletion.
let imageComposerSequence = 0;
// The key each CLI binds to "paste the clipboard picture", from https://code.claude.com/docs/en/keybindings#chat-actions.
const PASTE_KEYS = {
  claude: { win32: '\x1bv', darwin: '\x16', linux: '\x16' },
  codex: { win32: '\x16', darwin: '\x16', linux: '\x16' },
};
const PLATFORMS = { win32: { isMac: false, isLinux: false, isWindows: true }, darwin: { isMac: true, isLinux: false, isWindows: false }, linux: { isMac: false, isLinux: true, isWindows: false } };
function imageComposerHarness(t, agent, { decode = file => Promise.resolve(file.preview), remote = false, platform = 'darwin', pasteMode = 'accept' } = {}) {
  let text = '', cursor = 0, next = 0, heldScreen = null, overriddenRows;
  const attached = [], waitingPastes = [];
  const rows = () => composerRows(agent, 'idle', heldScreen ?? text);
  const h = dictationHarness(t, {
    './terminal-screen': { useScreen: () => overriddenRows === null ? null : ({ rows: overriddenRows ?? rows() }), readScreen: () => overriddenRows === null ? null : ({ rows: overriddenRows ?? rows() }) },
    './agent-screen': { parseAgentScreen }, './image-thumbnail': { ...require('../src/shared/image-thumbnail.ts'), thumbnail: decode }, './platform': PLATFORMS[platform],
  });
  h.props.terminal.agent = agent; h.props.remote = remote;
  const pasteKey = PASTE_KEYS[agent][platform];
  const chips = () => [...text.matchAll(/\[Image #(\d+)\]/g)];
  const insert = value => { text = text.slice(0, cursor) + value + text.slice(cursor); cursor += value.length; };
  const acceptPaste = image => {
    const number = agent === 'claude' ? ++next : attached.length + 1;
    attached.push({ number, image }); insert((text ? ' ' : '') + `[Image #${number}]`);
  };
  window.agentrix.writeTerminal = (id, keys) => {
    h.written.push({ id, text: keys });
    if (keys === pasteKey) {
      if (pasteMode === 'accept') acceptPaste(h.pasting);
      else if (pasteMode === 'defer') waitingPastes.push(h.pasting);
      return;
    }
    if (keys === '\x15') { text = ''; cursor = 0; attached.length = 0; return; }
    const events = keys.match(/\x1b\[1;5[CD]|\x1b\[[HFC]|[\x01\x05\x7f\r]/g) ?? [];
    assert.equal(events.join(''), keys, 'only navigation, one Backspace and submission are allowed');
    for (const event of events) {
      if (event === '\x05' || event === '\x1b[F') cursor = text.length;
      else if (event === '\x01' || event === '\x1b[H') cursor = 0;
      else if (event === '\x1b[1;5D') {
        while (cursor && /\s/.test(text[cursor - 1])) cursor--;
        const chip = chips().find(match => match.index + match[0].length === cursor);
        assert.ok(chip, 'word-left reaches a complete chip'); cursor = chip.index;
      } else if (event === '\x1b[1;5C') {
        while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++;
        const chip = chips().find(match => match.index === cursor);
        assert.ok(chip, 'word-right reaches a complete chip'); cursor += chip[0].length;
      } else if (event === '\x1b[C') {
        const chip = chips().find(match => match.index === cursor);
        cursor += chip?.[0].length ?? 1;
      } else if (event === '\x7f') {
        const chip = chips().find(match => match.index + match[0].length === cursor);
        assert.ok(chip, 'Backspace must remove an image, never typed text');
        const number = Number(chip[1]);
        text = text.slice(0, chip.index) + text.slice(cursor); cursor = chip.index;
        attached.splice(attached.findIndex(image => image.number === number), 1);
        if (agent === 'codex') {
          for (const image of attached) if (image.number > number) image.number--;
          text = text.replace(/\[Image #(\d+)\]/g, (label, n) => Number(n) > number ? `[Image #${Number(n) - 1}]` : label);
        }
      } else if (event === '\r') { h.received = { text, images: attached.map(image => image.image) }; text = ''; cursor = 0; attached.length = 0; }
    }
  };
  window.agentrix.pasteTerminal = async (id, value) => { h.pasted.push({ id, text: value }); insert(value); return { ok: true }; };
  const folder = `/remote/paste-${++imageComposerSequence}`, picturePath = image => `${folder}/image-${image}.png`;
  window.agentrix.saveImage = async (id, bytes) => ({ ok: true, value: picturePath(new Uint8Array(bytes)[0]) });
  const previews = () => elements(h.tree()).find(element => element.props.onRemove && element.props.images);
  return Object.assign(h, {
    picturePath,
    previews: () => previews()?.props.images ?? [],
    numbers: () => previews()?.props.numbers ?? [],
    remove(index) { h.render(); previews().props.onRemove(index); h.render(); },
    setPasteMode(mode) { pasteMode = mode; },
    acceptPaste() { assert.ok(waitingPastes.length); acceptPaste(waitingPastes.shift()); h.render(); },
    async paste(image, file = { size: 1, type: 'image/png', preview: `data:image/png;base64,${image}`, arrayBuffer: async () => new Uint8Array([image]).buffer }) {
      h.pasting = image;
      h.render().props.onPaste({ preventDefault() {}, clipboardData: { getData: () => '', items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] } });
      await h.tick(0);
    },
    native: () => ({ text, images: attached.map(image => image.image) }),
    editNative(value) { text = value; cursor = 0; },
    holdScreen() { heldScreen = text; },
    releaseScreen() { heldScreen = null; },
    setScreen(rows) { overriddenRows = rows; h.render(); },
    nextNumber(number) { next = number - 1; },
  });
}

// Exercise the smoke's real fixture builder and console frames without compiling or launching the Windows program.
function completionFixtureRows(withInput) {
  const filename = path.join(__dirname, '../scripts/completion-smoke.mjs');
  const script = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const builder = script.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'completionFixtureSource');
  let source = fs.readFileSync(path.join(__dirname, 'fixtures/restore-codex.cs'), 'utf8');
  if (withInput && builder) source = new Function(`return (${builder.getText(script)});`)()(source);
  return [...source.matchAll(/Console\.WriteLine\(("(?:\\.|[^"\\])*")\);/g)].flatMap(match => JSON.parse(match[1]).split(/\r?\n/));
}

async function completionPasteHarness(t) {
  const file = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
  const bytes = new Uint8Array(await file.arrayBuffer());
  assert.deepEqual([...bytes], [137, 80, 78, 71]);
  const globals = ['createImageBitmap', 'FileReader'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  let decodeCalls = 0, fallbackCalls = 0;
  globalThis.createImageBitmap = async image => { assert.equal(image, file); decodeCalls++; throw new Error('Invalid PNG'); };
  globalThis.FileReader = class {
    readAsDataURL(image) { assert.equal(image, file); fallbackCalls++; this.result = `data:${image.type};base64,${Buffer.from(bytes).toString('base64')}`; this.onload(); }
  };
  t.after(() => { for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const { thumbnail } = require('../src/shared/image-thumbnail.ts');
  const h = imageComposerHarness(t, 'claude', { platform: 'win32', pasteMode: 'ignore', decode: thumbnail }), errors = [];
  h.props.onError = error => errors.push(error);
  return { h, file, errors, decoding: () => ({ decodeCalls, fallbackCalls }) };
}

test('completion smoke: the original key-only stand-in fixture drops the exact four-byte PNG before a paste key', async t => {
  const { h, file, errors } = await completionPasteHarness(t);
  h.setScreen(completionFixtureRows(false)); await h.paste(1, file); await h.tick(0);
  assert.deepEqual(h.written, []); assert.equal(h.previews().length, 0);
  assert.equal(errors.length, 1); assert.match(errors[0], /could not be attached and was removed/);
});

test('completion smoke: a live Claude input forwards the exact four-byte PNG and announces it pending despite decode failure', async t => {
  const { h, file, errors, decoding } = await completionPasteHarness(t);
  h.setScreen(completionFixtureRows(true)); await h.paste(1, file); await h.tick(0);
  assert.deepEqual(h.written.map(item => item.text), [PASTE_KEYS.claude.win32]);
  assert.deepEqual(h.previews(), ['data:image/png;base64,iVBORw==']);
  assert.deepEqual(decoding(), { decodeCalls: 1, fallbackCalls: 1 });
  assert.deepEqual(errors, []);
  assert.ok(elements(h.tree()).some(element => element.props.className === 'reading-attachments'));
  assert.deepEqual(h.pasted, []); assert.deepEqual(h.echoed, []);
  h.edit('describe this'); h.press('Enter'); await h.tick(0);
  for (let attempt = 0; attempt < 12; attempt++) await h.tick(80);
  assert.deepEqual(h.written.map(item => item.text), [PASTE_KEYS.claude.win32]);
  assert.deepEqual(h.pasted, []); assert.deepEqual(h.echoed, []); assert.equal(h.previews().length, 1);
  assert.equal(errors.length, 1); assert.match(errors[0], /picture was not sent/);
  h.remove(0); await h.tick(0); assert.equal(h.previews().length, 0);
});

test('composer thumbnails each have the decision page remove label and 12px bold X, while message pictures only zoom', () => {
  const removed = [], opened = [];
  const { UserImages } = loadUI('features/reading/PendingPromptEntries.tsx', { './Markdown': { Markdown: ({ text }) => text }, './file-popup': { showPopup: picture => opened.push(picture) } });
  const images = ['data:image/png;base64,one', 'data:image/png;base64,two', 'data:image/png;base64,three'];
  const tree = UserImages({ images, onRemove: index => removed.push(index) }), nodes = elements(tree);
  const buttons = nodes.filter(element => element.props.className === 'reading-user-image-remove');
  assert.equal(buttons.length, 3);
  for (const button of buttons) {
    assert.equal(button.props['aria-label'], en['移除这张图片']);
    assert.equal(button.props.children.props.size, 12); assert.equal(button.props.children.props.weight, 'bold');
  }
  buttons[1].props.onClick(); assert.deepEqual(removed, [1]); assert.deepEqual(opened, []);
  nodes.find(element => element.props.className === 'reading-user-image-zoom').props.onClick();
  assert.equal(opened[0].src, images[0]);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(UserImages, { images })), /reading-user-image-remove|Remove this picture/);
});

for (const agent of ['claude', 'codex']) {
  for (const change of ['split blur', 'popup close']) for (const action of ['send', 'remove']) {
    test(`${agent}: a staged picture survives ${change} and can still ${action}`, async t => {
      const h = imageComposerHarness(t, agent);
      await h.paste(1); h.edit('keep this picture');
      if (change === 'split blur') { h.props.active = false; h.render(); h.props.active = true; h.render(); }
      else {
        h.setScreen(['Settings', 'Esc to close']); await h.tick(3000);
        assert.ok(h.popup()); h.popup().props.onClose(); h.render(); h.setScreen(undefined);
      }
      if (action === 'send') {
        h.press('Enter'); await h.tick(0); await h.tick(400);
        assert.deepEqual(h.received.images, [1]);
      } else {
        h.remove(0); await h.tick(80);
        assert.equal(h.previews().length, 0); assert.deepEqual(h.native().images, []);
        await h.paste(2); assert.deepEqual(h.native().images, [2]);
      }
    });
  }

  test(agent + ': removing a never-confirmed picture frees the composer and hints to check the terminal', async t => {
    const h = imageComposerHarness(t, agent, { pasteMode: 'ignore' }), errors = [];
    h.props.onError = error => errors.push(error);
    await h.paste(1); h.remove(0); await h.tick(0);
    assert.equal(h.previews().length, 0); assert.equal(errors.length, 1);
    assert.match(errors[0], /Removed from the message box\..*Check the terminal/);
    assert.deepEqual(h.written.map(item => item.text), [PASTE_KEYS[agent].darwin]);
    h.setPasteMode('accept'); await h.paste(2); h.edit('replacement'); h.press('Enter'); await h.tick(0); await h.tick(400);
    assert.deepEqual(h.received.images, [2]);
  });

  for (const frame of [null, ['Settings', 'Esc to close']]) test(`${agent}: failure to press the native paste key removes its preview and reports immediately (${frame ? 'dialog' : 'no input'})`, async t => {
    const h = imageComposerHarness(t, agent), errors = [];
    h.props.onError = error => errors.push(error);
    h.setScreen(frame); await h.paste(1);
    assert.equal(h.previews().length, 0); assert.equal(errors.length, 1);
    assert.match(errors[0], /could not be attached and was removed\./);
    assert.deepEqual(h.written, []);
    h.setScreen(undefined); await h.paste(2); assert.equal(h.previews().length, 1);
  });

  test(agent + ': an unknown chip format blocks the picture send but still allows local removal', async t => {
    const h = imageComposerHarness(t, agent, { pasteMode: 'ignore' }), errors = [];
    h.props.onError = error => errors.push(error);
    await h.paste(1); h.editNative('[Picture 1]'); h.edit('check the picture'); h.press('Enter'); await h.tick(0);
    for (let attempt = 0; attempt < 12; attempt++) await h.tick(80);
    assert.deepEqual(h.pasted, []); assert.equal(errors.length, 1);
    h.remove(0); await h.tick(0);
    assert.equal(h.previews().length, 0); assert.match(errors.at(-1), /Removed from the message box\./);
  });

  test(agent + ': an uncleared native draft drops the deferred picture and allows another paste', async t => {
    const h = imageComposerHarness(t, agent), errors = [];
    h.props.onError = error => errors.push(error);
    h.editNative('leftover text'); h.holdScreen(); await h.paste(1);
    for (let attempt = 0; attempt < 30; attempt++) await h.tick(80);
    await h.tick(60);
    assert.equal(h.previews().length, 0); assert.equal(errors.length, 1);
    assert.match(errors[0], /could not be attached and was removed\./);
    assert.equal(h.written.filter(item => item.text === PASTE_KEYS[agent].darwin).length, 0);
    h.releaseScreen(); await h.paste(2); assert.equal(h.previews().length, 1);
  });

  test(agent + ': a text-only send clears immediately while the terminal still holds a leftover draft', async t => {
    const h = imageComposerHarness(t, agent);
    h.editNative('old native draft'); h.edit('first message'); h.press('Enter');
    assert.equal(h.node.value, ''); assert.deepEqual(h.pasted, []);
    h.edit('second message'); await h.tick(80); await h.tick(400);
    assert.equal(h.node.value, 'second message');
    assert.deepEqual(h.pasted.map(item => item.text), ['first message']);
  });

  test(agent + ': a text-only send clears immediately while pasteTerminal is pending', async t => {
    const h = imageComposerHarness(t, agent);
    let finish;
    window.agentrix.pasteTerminal = () => new Promise(resolve => { finish = resolve; });
    h.edit('first message'); h.press('Enter');
    assert.equal(h.node.value, ''); h.edit('second message');
    finish({ ok: true }); await h.tick(0); await h.tick(400);
    assert.equal(h.node.value, 'second message');
  });

  test(agent + ': a pending SSH upload survives split blur and still sends its path', async t => {
    const h = imageComposerHarness(t, agent, { remote: true });
    let finish;
    window.agentrix.saveImage = () => new Promise(resolve => { finish = resolve; });
    await h.paste(1); h.props.active = false; h.render(); h.props.active = true; h.render();
    finish({ ok: true, value: h.picturePath(1) }); await h.tick(0);
    h.edit('keep the upload'); h.press('Enter'); await h.tick(0); await h.tick(400);
    assert.deepEqual(h.pasted.map(item => item.text), [`${h.picturePath(1)} keep the upload`]);
  });

  test(agent + ': an unaccepted picture stays in the composer instead of sending a false image echo', async t => {
    const h = imageComposerHarness(t, agent, { pasteMode: 'ignore' }), errors = [];
    h.props.onError = error => errors.push(error);
    await h.paste(1); h.edit('describe this'); h.press('Enter'); await h.tick(0);
    for (let attempt = 0; attempt < 12; attempt++) await h.tick(80);
    assert.deepEqual(h.pasted, []); assert.deepEqual(h.echoed, []);
    assert.equal(h.received, undefined); assert.equal(h.node.value, 'describe this');
    assert.equal(h.previews().length, 1); assert.equal(errors.length, 1);
    assert.match(errors[0], /The picture was not sent\. Remove it here and paste again\./);
    assert.ok(h.written.every(({ text }) => text !== '\r' && text !== '\x15'));
  });

  test(agent + ': an old native image cannot acknowledge another picture whose paste was refused', async t => {
    const h = imageComposerHarness(t, agent), errors = [];
    h.props.onError = error => errors.push(error);
    await h.paste(1); h.setPasteMode('ignore'); await h.paste(2);
    h.edit('both pictures'); h.press('Enter'); await h.tick(0);
    for (let attempt = 0; attempt < 12; attempt++) await h.tick(80);
    assert.deepEqual(h.pasted, []); assert.deepEqual(h.echoed, []);
    assert.deepEqual(h.native().images, [1]); assert.equal(h.previews().length, 2);
    assert.equal(h.node.value, 'both pictures'); assert.equal(errors.length, 1);
  });

  test(agent + ': sending waits for a delayed native picture acknowledgment', async t => {
    const h = imageComposerHarness(t, agent, { pasteMode: 'defer' });
    await h.paste(1); h.edit('wait for the picture'); h.press('Enter'); await h.tick(0);
    assert.deepEqual(h.pasted, []); assert.deepEqual(h.echoed, []);
    h.acceptPaste(); await h.tick(80);
    assert.deepEqual(h.pasted.map(item => item.text), ['wait for the picture']);
    await h.tick(400);
    assert.deepEqual(h.received.images, [1]); assert.equal(h.previews().length, 0);
  });

  test(agent + ': Send waits for the first picture paste after clearing a leftover native draft', async t => {
    const h = imageComposerHarness(t, agent);
    h.editNative('left over after interruption'); await h.paste(1);
    h.edit('new words'); h.press('Enter'); await h.tick(0);
    assert.deepEqual(h.pasted, []);
    await h.tick(80); await h.tick(60); await h.tick(0);
    assert.deepEqual(h.pasted.map(item => item.text), ['new words']);
    await h.tick(400);
    assert.deepEqual(h.received.images, [1]); assert.ok(h.received.text.endsWith('new words'));
  });

  test(agent + ': a picture accepted after the timeout can be sent without reading the clipboard again', async t => {
    const h = imageComposerHarness(t, agent, { pasteMode: 'defer' }), errors = [];
    h.props.onError = error => errors.push(error);
    await h.paste(1); h.edit('try once accepted'); h.press('Enter'); await h.tick(0);
    for (let attempt = 0; attempt < 12; attempt++) await h.tick(80);
    assert.equal(errors.length, 1); assert.equal(h.previews().length, 1);
    h.acceptPaste(); h.press('Enter'); await h.tick(0); await h.tick(400);
    assert.deepEqual(h.received.images, [1]);
    assert.equal(h.written.filter(item => item.text === PASTE_KEYS[agent].darwin).length, 1);
  });

  for (const clearFirst of [false, true]) test(`${agent}: another paste during uncertain acceptance cannot substitute clipboard contents (${clearFirst ? 'clearing' : 'waiting'})`, async t => {
    const h = imageComposerHarness(t, agent, { pasteMode: 'defer' }), errors = [];
    h.props.onError = error => errors.push(error);
    if (clearFirst) h.editNative('old draft');
    await h.paste(1); await h.paste(2);
    assert.equal(errors.length, 1); assert.equal(h.previews().length, 1);
    await h.tick(80); await h.tick(60);
    if (clearFirst) {
      assert.equal(h.previews().length, 0); assert.match(errors.at(-1), /could not be attached and was removed\./);
      assert.equal(h.written.filter(item => item.text === PASTE_KEYS[agent].darwin).length, 0);
      h.setPasteMode('accept'); await h.paste(3); h.edit('replacement'); h.press('Enter'); await h.tick(0); await h.tick(400);
      assert.deepEqual(h.received.images, [3]); return;
    }
    if (!clearFirst) h.acceptPaste();
    h.edit('keep the original picture'); h.press('Enter'); await h.tick(0);
    for (let attempt = 0; attempt < 12; attempt++) await h.tick(80);
    assert.deepEqual(h.pasted, []); assert.deepEqual(h.echoed, []); assert.equal(h.received, undefined);
    assert.equal(h.written.filter(item => item.text === PASTE_KEYS[agent].darwin).length, clearFirst ? 0 : 1);
    assert.equal(h.previews().length, 1); assert.equal(h.node.value, 'keep the original picture');
  });

  test(agent + ': a failed message paste preserves the acknowledged picture and the text', async t => {
    const h = imageComposerHarness(t, agent), errors = [];
    h.props.onError = error => errors.push(error);
    await h.paste(1);
    window.agentrix.pasteTerminal = async () => ({ ok: false, error: 'message paste failed' });
    h.edit('keep both'); h.press('Enter'); await h.tick(0);
    assert.deepEqual(errors, ['message paste failed']); assert.equal(h.node.value, 'keep both');
    assert.equal(h.previews().length, 1); assert.deepEqual(h.native().images, [1]);
    assert.equal(h.received, undefined);
  });

  for (const command of ['/status', 'another task']) test(`${agent}: an external ${command} cannot consume a picture waiting in the composer`, async t => {
    const h = imageComposerHarness(t, agent), errors = [];
    h.props.onError = error => errors.push(error);
    await h.paste(1); h.edit('my picture message'); h.command(command); await h.tick(0);
    assert.equal(errors.length, 1); assert.deepEqual(h.native().images, [1]);
    assert.match(errors[0], /before sending this message\./);
    assert.doesNotMatch(errors[0], /picture was not sent/);
    assert.deepEqual(h.written.map(item => item.text), [PASTE_KEYS[agent].darwin]);
    assert.deepEqual(h.pasted, []); assert.deepEqual(h.echoed, []);
    assert.equal(h.node.value, 'my picture message');
    h.press('Enter'); await h.tick(0); await h.tick(400);
    assert.deepEqual(h.received.images, [1]); assert.ok(h.received.text.endsWith('my picture message'));
  });

  test(agent + ': losing the native picture before Enter keeps it visibly unsent', async t => {
    const h = imageComposerHarness(t, agent), errors = [];
    h.props.onError = error => errors.push(error);
    await h.paste(1); h.edit('keep this picture'); h.press('Enter'); await h.tick(0);
    h.editNative('keep this picture'); await h.tick(400);
    assert.equal(h.received, undefined); assert.equal(h.previews().length, 1);
    assert.equal(h.node.value, 'keep this picture'); assert.equal(errors.length, 1);
  });

  test(agent + ': waiting for native picture acknowledgment cannot send keys after session A to B to A', async t => {
    const h = imageComposerHarness(t, agent, { pasteMode: 'defer' });
    await h.paste(1); h.edit('cancel this send'); h.press('Enter'); await h.tick(0);
    const written = h.written.length;
    h.props.terminal.sessionId = 'B'; h.render(); h.props.terminal.sessionId = 'session'; h.render();
    h.acceptPaste(); await h.tick(80); await h.tick(400); await h.tick(1000);
    assert.equal(h.written.length, written); assert.equal(h.received, undefined);
    assert.deepEqual(h.pasted, []); assert.deepEqual(h.echoed, []);
  });

  test(agent + ': SSH Send waits for pending uploads and keeps their paste order', async t => {
    const h = imageComposerHarness(t, agent, { remote: true }), uploads = new Map();
    window.agentrix.saveImage = (id, bytes) => new Promise(resolve => uploads.set(new Uint8Array(bytes)[0], resolve));
    for (const image of [1, 2]) await h.paste(image);
    h.edit('describe both'); h.press('Enter'); await h.tick(0);
    assert.deepEqual(h.pasted, []); assert.deepEqual(h.echoed, []);
    uploads.get(2)({ ok: true, value: h.picturePath(2) }); await h.tick(0);
    assert.deepEqual(h.pasted, []);
    uploads.get(1)({ ok: true, value: h.picturePath(1) }); await h.tick(0);
    assert.deepEqual(h.pasted.map(item => item.text), [`${h.picturePath(1)} ${h.picturePath(2)} describe both`]);
    await h.tick(400);
    assert.equal(h.received.text, `${h.picturePath(1)} ${h.picturePath(2)} describe both`);
    assert.equal(h.previews().length, 0);
  });

  test(agent + ': SSH upload failure preserves the picture and text instead of sending text alone', async t => {
    const h = imageComposerHarness(t, agent, { remote: true }), errors = [];
    h.props.onError = error => errors.push(error);
    let finish;
    window.agentrix.saveImage = () => new Promise(resolve => { finish = resolve; });
    await h.paste(1); h.edit('keep this upload'); h.press('Enter'); await h.tick(0);
    finish({ ok: false, error: 'upload failed' }); await h.tick(0); await h.tick(1000);
    assert.deepEqual(h.pasted, []); assert.deepEqual(h.echoed, []); assert.equal(h.received, undefined);
    assert.equal(h.node.value, 'keep this upload'); assert.equal(h.previews().length, 1);
    assert.ok(errors.includes('upload failed'));
  });

  test(agent + ': removing a pending SSH picture prevents a late upload from reviving it', async t => {
    const h = imageComposerHarness(t, agent, { remote: true });
    let finish;
    window.agentrix.saveImage = () => new Promise(resolve => { finish = resolve; });
    await h.paste(1); assert.equal(h.previews().length, 1); h.remove(0);
    finish({ ok: true, value: h.picturePath(1) }); await h.tick(0);
    assert.equal(h.previews().length, 0);
    h.edit('words only'); h.press('Enter'); await h.tick(0);
    assert.deepEqual(h.pasted.map(item => item.text), ['words only']);
  });

  test(agent + ': an SSH thumbnail decoded after submission still decorates its recorded remote path', async t => {
    let decode;
    const h = imageComposerHarness(t, agent, { remote: true, decode: () => new Promise(resolve => { decode = resolve; }) });
    await h.paste(1); h.edit('describe'); h.press('Enter'); await h.tick(0); await h.tick(400);
    assert.equal(h.previews().length, 0);
    decode('data:image/png;base64,late'); await h.tick(0);
    assert.deepEqual(require('../src/features/reading/pasted-pictures.ts').withPictures(h.picturePath(1)).images, ['data:image/png;base64,late']);
  });

  for (const change of ['session', 'selection', 'unmount']) test(`${agent}: pending SSH upload is cancelled by ${change} without late submission`, async t => {
    const h = imageComposerHarness(t, agent, { remote: true });
    let finish;
    window.agentrix.saveImage = () => new Promise(resolve => { finish = resolve; });
    await h.paste(1); h.edit('cancel upload send'); h.press('Enter'); await h.tick(0);
    if (change === 'session') { h.props.terminal.sessionId = 'B'; h.render(); h.props.terminal.sessionId = 'session'; h.render(); }
    if (change === 'selection') { h.props.active = false; h.render(); h.props.active = true; h.render(); }
    if (change === 'unmount') h.unmount();
    finish({ ok: true, value: h.picturePath(1) }); await h.tick(0); await h.tick(400); await h.tick(1000);
    assert.deepEqual(h.pasted, []); assert.deepEqual(h.written, []); assert.deepEqual(h.echoed, []);
  });

  test(agent + ': removing the second native image preserves the other attachments and typed composer text on send', async t => {
    const h = imageComposerHarness(t, agent);
    for (const image of [1, 2, 3]) await h.paste(image);
    h.edit('keep these words'); h.remove(1);
    const end = '\x05\x1b[F'.repeat(composerRows(agent).length + 1);
    assert.equal(h.written.at(-1).text, end + '\x1b[1;5D'.repeat(2) + '\x1b[C\x7f' + end);
    assert.deepEqual(h.previews(), [1, 2, 3].map(image => `data:image/png;base64,${image}`), 'wait for the CLI redraw');
    await h.tick(80);
    assert.deepEqual(h.previews(), [1, 3].map(image => `data:image/png;base64,${image}`));
    assert.deepEqual(h.native(), { text: agent === 'claude' ? '[Image #1]  [Image #3]' : '[Image #1]  [Image #2]', images: [1, 3] });
    assert.deepEqual(h.numbers(), agent === 'claude' ? [1, 3] : [1, 2]);
    assert.equal(h.node.value, 'keep these words'); assert.equal(document.activeElement, h.node);
    h.press('Enter'); await h.tick(0); await h.tick(400);
    assert.deepEqual(h.received.images, [1, 3]);
    assert.ok(h.received.text.endsWith('keep these words'));
    assert.deepEqual(h.echoed, [{ text: 'keep these words', images: [1, 3].map(image => `data:image/png;base64,${image}`) }]);
    assert.ok(h.written.every(({ text }) => !text.includes('\x15')));
  });

  test(agent + ': consecutive removals reread shifted labels, and a later paste keeps native image identities', async t => {
    const h = imageComposerHarness(t, agent);
    for (const image of [1, 2, 3]) await h.paste(image);
    h.remove(1); await h.tick(80);
    await h.paste(4);
    h.remove(1); await h.tick(80);
    assert.deepEqual(h.previews(), [1, 4].map(image => `data:image/png;base64,${image}`));
    assert.deepEqual(h.native(), { text: agent === 'claude' ? '[Image #1]   [Image #4]' : '[Image #1]   [Image #2]', images: [1, 4] });
  });

  test(agent + ': removing the last image clears the attachment count and disables an empty send', async t => {
    const h = imageComposerHarness(t, agent);
    await h.paste(1); h.remove(0); await h.tick(80);
    assert.deepEqual(h.native().images, []);
    assert.ok(!elements(h.tree()).some(element => element.props.className === 'reading-attachments'));
    assert.equal(elements(h.tree()).find(element => element.props.className === 'icon-button reading-send').props.disabled, true);
  });

  test(agent + ': a failed native deletion keeps its previews and surfaces a terminal check without destructive retries', async t => {
    const h = imageComposerHarness(t, agent), errors = [];
    h.props.onError = message => errors.push(message);
    for (const image of [1, 2, 3]) await h.paste(image);
    window.agentrix.writeTerminal = (id, text) => h.written.push({ id, text });
    h.remove(1);
    for (let attempt = 0; attempt < 10; attempt++) await h.tick(80);
    assert.equal(errors.length, 1); assert.equal(h.previews().length, 3); assert.deepEqual(h.native().images, [1, 2, 3]);
    assert.equal(h.written.length, 4, 'three pastes and exactly one removal attempt');
  });

  test(agent + ': ambiguous prose on both sides of an image never causes guessed editing keystrokes', async t => {
    const h = imageComposerHarness(t, agent), errors = [];
    h.props.onError = message => errors.push(message);
    for (const image of [1, 2, 3]) await h.paste(image);
    h.editNative('before ' + h.native().text + ' after'); h.remove(1); await h.tick(1000);
    assert.equal(errors.length, 1); assert.equal(h.written.length, 3);
    assert.equal(h.previews().length, 3); assert.deepEqual(h.native().images, [1, 2, 3]);
  });

  for (const position of ['before', 'after']) test(`${agent}: native text ${position} the images is preserved from an arbitrary cursor position`, async t => {
    const h = imageComposerHarness(t, agent);
    for (const image of [1, 2, 3]) await h.paste(image);
    const words = 'keep  native 文本', native = h.native().text;
    h.editNative(position === 'before' ? words + ' ' + native : native + ' ' + words);
    h.remove(1); await h.tick(80);
    assert.deepEqual(h.native().images, [1, 3]); assert.ok(h.native().text.includes(words));
    assert.deepEqual(h.previews(), [1, 3].map(image => `data:image/png;base64,${image}`));
  });

  test(agent + ': a slow or removed preview cannot reorder images or reappear when decoding finishes', async t => {
    const decoding = new Map();
    const h = imageComposerHarness(t, agent, { decode: file => new Promise(resolve => decoding.set(file.preview, resolve)) });
    for (const image of [1, 2, 3]) await h.paste(image);
    decoding.get('data:image/png;base64,3')('data:image/png;base64,3'); await h.tick(0);
    assert.deepEqual(h.previews(), ['', '', 'data:image/png;base64,3']);
    h.remove(1); await h.tick(80);
    for (const image of [2, 1]) decoding.get(`data:image/png;base64,${image}`)(`data:image/png;base64,${image}`);
    await h.tick(0);
    assert.deepEqual(h.previews(), [1, 3].map(image => `data:image/png;base64,${image}`));
    assert.deepEqual(h.native().images, [1, 3]);
  });

  test(agent + ': native removal waits for acknowledgment and sends no extra keys after session A to B to A', async t => {
    const h = imageComposerHarness(t, agent);
    for (const image of [1, 2, 3]) await h.paste(image);
    h.holdScreen(); h.remove(1); await h.tick(80);
    assert.equal(h.previews().length, 3);
    h.edit('wait'); h.press('Enter'); await h.tick(0); assert.deepEqual(h.pasted, []);
    const written = h.written.length;
    h.props.terminal.sessionId = 'B'; h.render(); h.props.terminal.sessionId = 'session'; h.render();
    h.releaseScreen(); await h.tick(1000);
    assert.equal(h.written.length, written); assert.equal(h.previews().length, 0, 'the former session cannot retain composer pictures');
  });

  test(agent + ': the four-image limit cannot leave a fifth invisible native attachment', async t => {
    const h = imageComposerHarness(t, agent), errors = [];
    h.props.onError = message => errors.push(message);
    for (const image of [1, 2, 3, 4, 5]) await h.paste(image);
    assert.equal(h.previews().length, 4); assert.deepEqual(h.native().images, [1, 2, 3, 4]); assert.equal(errors.length, 1);
  });

  test(agent + ': SSH removes only the second saved path, preserves the other previews and sends no removal keystrokes', async t => {
    const h = imageComposerHarness(t, agent, { remote: true });
    for (const image of [1, 2, 3]) await h.paste(image);
    h.edit('keep these words'); h.remove(1); await h.tick(0);
    assert.deepEqual(h.previews(), [1, 3].map(image => `data:image/png;base64,${image}`));
    assert.deepEqual(h.written, []); assert.equal(h.node.value, 'keep these words'); assert.equal(document.activeElement, h.node);
    h.press('Enter'); await h.tick(0);
    assert.deepEqual(h.pasted, [{ id: h.props.terminal.id, text: `${h.picturePath(1)} ${h.picturePath(3)} keep these words` }]);
  });

  test(agent + ': SSH thumbnails finishing out of order still remove the corresponding saved path', async t => {
    const decoding = new Map();
    const h = imageComposerHarness(t, agent, { remote: true, decode: file => new Promise(resolve => decoding.set(file.preview, resolve)) });
    for (const image of [1, 2, 3]) await h.paste(image);
    for (const image of [3, 1]) decoding.get(`data:image/png;base64,${image}`)(`data:image/png;base64,${image}`);
    await h.tick(0);
    assert.deepEqual(h.previews(), ['data:image/png;base64,1', '', 'data:image/png;base64,3']);
    h.remove(1); decoding.get('data:image/png;base64,2')('data:image/png;base64,2'); await h.tick(0);
    h.edit('describe'); h.press('Enter'); await h.tick(0);
    assert.deepEqual(h.pasted.map(item => item.text), [`${h.picturePath(1)} ${h.picturePath(3)} describe`]);
    assert.deepEqual(h.written, []);
  });

  for (const activity of ['idle', 'working', 'shell']) {
    for (const picture of ['none', 'ready', 'loading']) {
      test(`${agent}: a ${picture} picture and message send while ${activity} without opening the popup`, async t => {
        let draft = '';
        const actions = [], received = [], pasteKey = PASTE_KEYS[agent].darwin;
        const h = dictationHarness(t, {
          './terminal-screen': { useScreen: () => ({ rows: composerRows(agent, activity, draft) }), readScreen: () => ({ rows: composerRows(agent, activity, draft) }) },
          './agent-screen': { parseAgentScreen },
          './image-thumbnail': { thumbnail: () => picture === 'loading' ? new Promise(() => {}) : Promise.resolve('data:image/png;base64,picture') },
          './platform': PLATFORMS.darwin,
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
        assert.equal(h.render().props.disabled, false);
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
      './terminal-screen': { useScreen: () => ({ rows: composerRows(agent, 'idle', draft) }), readScreen: () => ({ rows: composerRows(agent, 'idle', draft) }) },
      './agent-screen': { parseAgentScreen }, './image-thumbnail': { thumbnail: () => new Promise(() => {}) }, './platform': PLATFORMS.darwin,
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
    assert.deepEqual(h.written.map(item => item.text), [PASTE_KEYS[agent].darwin, PASTE_KEYS[agent].darwin]);
    assert.equal(draft, '[Image #1][Image #2]');
  });

  test(agent + ': a message already left with a picture retries Enter without clearing or pasting again', async t => {
    let draft = '[Image #1] next message';
    const h = dictationHarness(t, {
      './terminal-screen': { useScreen: () => ({ rows: composerRows(agent, 'idle', draft) }), readScreen: () => ({ rows: composerRows(agent, 'idle', draft) }) },
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
      const h = dictationHarness(t, { './terminal-screen': { useScreen: () => ({ rows: composerRows(agent) }), readScreen: () => assert.fail('typed commands never read the screen') } });
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

  test(agent + ': a dialog preserves staged pictures and a locked draft until the owner returns to input', async t => {
    const h = imageComposerHarness(t, agent); await h.paste(1); h.edit('keep this message'); h.written.length = 0;
    h.setScreen(['Settings', 'Esc to close']); await h.tick(3000); assert.ok(h.popup()); assert.equal(h.popup().props.focus, false);
    h.press('Enter'); await h.tick(1000); assert.equal(h.node.value, 'keep this message'); assert.equal(h.previews().length, 1);
    assert.deepEqual(h.written, []); assert.deepEqual(h.pasted, []);
    h.popup().props.onClose(); h.render(); h.setScreen(undefined); h.press('Enter'); await h.tick(0); await h.tick(400);
    assert.deepEqual(h.received.images, [1]);
  });
}

for (const [agent, keys] of Object.entries(PASTE_KEYS)) {
  for (const [platform, expected] of Object.entries(keys)) {
    test(`${agent} on ${platform}: a pasted picture presses ${JSON.stringify(expected)} to attach it`, async t => {
      const h = imageComposerHarness(t, agent, { platform });
      await h.paste(1);
      assert.deepEqual(h.written.map(item => item.text), [expected]);
      assert.equal(h.numbers().length, 1, 'the CLI acknowledged the key with a picture');
    });
  }
}

test('Claude paste IDs can begin above one and remain visible after deleting the middle image', async t => {
  const h = imageComposerHarness(t, 'claude');
  h.nextNumber(17);
  for (const image of [1, 2, 3]) await h.paste(image);
  assert.deepEqual(h.numbers(), [17, 18, 19]);
  h.remove(1); await h.tick(80);
  assert.deepEqual(h.numbers(), [17, 19]); assert.deepEqual(h.native().images, [1, 3]);
});

test('a typed command waits for a transient pending xterm frame without losing its remaining keys', async t => {
  let pending = false;
  const h = dictationHarness(t, { './terminal-screen': { useScreen: () => ({ rows: composerRows('claude'), pending }) } });
  h.props.terminal.agent = 'claude'; h.render();
  window.agentrix.writeTerminal = (id, text) => { h.written.push({ id, text }); if (text === '\x15') { pending = true; h.render(); } };
  h.edit('/status'); h.press('Enter'); await h.tick(0); await h.tick(60);
  assert.deepEqual(h.written.map(item => item.text), ['\x15']);
  pending = false; h.render(); await h.tick(20); await h.tick(150);
  assert.deepEqual(h.written.map(item => item.text), ['\x15', '/status', '\r']);
  assert.deepEqual(h.pasted, []);
});

test('a real dialog cancels a typed command during its pending-frame wait', async t => {
  let pending = false, rows = composerRows('claude');
  const h = dictationHarness(t, { './terminal-screen': { useScreen: () => ({ rows, pending }) } });
  h.props.terminal.agent = 'claude'; h.render();
  window.agentrix.writeTerminal = (id, text) => { h.written.push({ id, text }); if (text === '\x15') { pending = true; h.render(); } };
  h.edit('/status'); h.press('Enter'); await h.tick(0); await h.tick(60);
  rows = ['Settings', 'Esc to close']; pending = false; h.render(); await h.tick(20);
  rows = composerRows('claude'); h.render(); await h.tick(150); await h.tick(2000);
  assert.deepEqual(h.written.map(item => item.text), ['\x15']); assert.deepEqual(h.pasted, []);
});

test('cancellation queued as readiness settles still prevents the next typed-command key', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let active = true, reads = 0; const writes = [];
  const sending = require('../src/features/reading/reading-command.ts').typeReadingCommand('/status', key => writes.push(key), () => active, () => {
    if (++reads === 2) queueMicrotask(() => { active = false; });
    return true;
  });
  t.mock.timers.tick(60); for (let i = 0; i < 6; i++) await Promise.resolve();
  t.mock.timers.tick(150); await sending;
  assert.deepEqual(writes, ['\x15']);
});

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
  h.popup().props.onClose(); h.render(); h.command('/usage'); await h.tick(0); await h.tick(60); await h.tick(150);
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
    './useReadingConversation': { conversationKey: () => 'clear-test', useReadingHistory: () => historySnapshot([record]) },
    './useVisibleTail': { blocks: entries => { shown = entries; return []; }, conversationTurns: () => [], useVisibleTail: () => ({ earlier: 0, visible: [] }) },
  });
  h.props.terminal.agent = 'claude'; h.edit('/clear'); h.press('Enter'); await h.tick(0); await h.tick(60);
  assert.deepEqual(shown, [record]);
  await h.tick(150); assert.deepEqual(shown, []); assert.ok(h.popup());
});

test('/resume opens the live terminal like every slash command, here and over SSH: no session card', async t => {
  const h = dictationHarness(t);
  for (const remote of [false, true]) {
    h.props.remote = remote; h.written.length = 0; h.render();
    h.edit('/resume'); h.press('Enter'); await h.tick(0); await h.tick(60); await h.tick(150);
    assert.equal(h.popup().props.command, '/resume');
    assert.deepEqual(h.written.map(item => item.text), ['\x15', '/resume', '\r']);
    assert.equal(elements(h.tree()).some(element => element.props.onSent), false);
    h.popup().props.onClose(); h.render();
  }
});

test('the terminal popup closes only by its button or backdrop and never translates a key', () => {
  let closes = 0;
  const hooks = { useRef: value => ({ current: value }), useLayoutEffect() {} };
  const { ReadingTerminalPopup } = loadUI('features/reading/ReadingTerminalPopup.tsx', { react: hooks, './terminal-popup': {} });
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
  const { ReadingTerminalPopup } = loadUI('features/reading/ReadingTerminalPopup.tsx', { react: hooks, './terminal-popup': { mountReadingTerminal: () => () => restored++ } });
  ReadingTerminalPopup({ terminalId: 'A', sessionId: 's', command: '/status', onReady: () => ready++, onClose: focus => closes.push(focus), onError: assert.fail });
  assert.equal(ready, 1);
  const target = id => ({ closest: () => ({ dataset: { terminalId: id } }) });
  listeners.get('pointerdown')({ target: target('A') }); assert.deepEqual(closes, []);
  listeners.get('focusin')({ target: target('B') }); assert.deepEqual(closes, [false]);
  cleanups.shift()(); assert.equal(restored, 1);
});

test('a generated picture shows its prompt as a two-line summary and a toggle appears only when the summary is cut off', () => {
  const view = fs.readFileSync(path.join(__dirname, '../src/features/reading/ConversationFeed.tsx'), 'utf8');
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

test('the buttons under a result depend on its kind and whether the agent can be sent to; a remote picture can be saved too', () => {
  const ask = readingEntry('u', 'user', 1, { text: 'draw' });
  const ids = (result, options) => resultActions(result, options).map(action => `${action.id}${action.disabled ? '!' : ''}`);
  const picture = latestResult([ask, roundPicture('g', 2)], idle);
  assert.deepEqual(ids(picture, { canSend: true }), ['enlarge', 'save', 'continue']);
  assert.deepEqual(ids(latestResult([ask, roundEdit('e', 2), readingEntry('z', 'assistant', 3, { text: 'ok' })], idle), { canSend: true }), ['open', 'continue']);
  assert.deepEqual(ids(latestResult([ask, readingEntry('z', 'assistant', 3, { text: 'ok' })], idle), { canSend: true }), ['ask', 'copy']);
  const failed = latestResult([ask, readingTool('npm test', 2, { failed: true })], idle);
  assert.deepEqual(ids(failed, { canSend: true }), ['retry', 'continue']);
  assert.deepEqual(ids(failed, { canSend: false }), ['retry!', 'continue'], 'a retry waits for the agent to sit at its input');
});

test('the title and the duration of a round come from data it already has', () => {
  assert.deepEqual(Object.keys(FALLBACK_TITLES), ['picture', 'code', 'text', 'failed'], 'a task without a title of its own is named by what the round did');
  for (const title of Object.values(FALLBACK_TITLES)) assert.ok(title in en, `${title} has an English translation`);
  assert.deepEqual(elapsed(0, 190000), { hours: 0, minutes: 3, seconds: 10 }); assert.deepEqual(elapsed(0, 3900000), { hours: 1, minutes: 5, seconds: 0 });
});

const { ResultStatus } = loadUI('features/reading/ResultCard.tsx');
function assertResultHeading(result, taskTitle, expected, label = '') {
  const html = renderToStaticMarkup(ResultStatus({ result, taskTitle, onShowTerminal() {}, onError() {} }));
  const heading = html.match(/<h3 class="result-title"[\s\S]*?<\/h3>/)[0], title = label ? `${expected} · ${label}` : expected;
  assert.equal(heading.replace(/<[^>]*>/g, '').replace(/\u00a0/g, ' '), title, 'the full visible title is plain text');
  assert.equal(heading.match(/title="([^"]*)"/)[1], title, 'the native HTML title uses the same complete title');
  assert.ok(html.includes(`role="status" aria-label="${label || 'Done'}"`), 'the status announces the translated result label');
}

test('completed text, code and picture headings omit the completion suffix and keep completion accessible', () => {
  const ask = readingEntry('u', 'user', 1, { text: 'Finish the task.' });
  for (const entry of [readingEntry('a', 'assistant', 2, { text: 'Done.' }), roundEdit('e', 2), roundPicture('g', 2)]) {
    const result = latestResult([ask, entry], idle);
    assertResultHeading(result, '**Finished** the task. More details.', 'Finished the task.');
  }
});

test('a round’s facts from its source (a native session) change only the row’s duration, spend, tokens and sentence; a terminal round draws exactly as before', () => {
  const ask = readingEntry('u', 'user', 1, { text: 'Finish the task.' }), reply = readingEntry('a', 'assistant', 3, { text: 'Done.' });
  const plain = latestResult([ask, reply], idle), row = result => renderToStaticMarkup(ResultStatus({ result, taskTitle: undefined, onError() {} }));
  assert.equal('facts' in plain, false, 'no facts, no field');
  assert.ok(row(plain).includes('<span class="result-took"> · took 2 min 0 s</span>'), 'the time between the steps, as ever');
  assert.equal(row(plain).split('result-sub').length, 2, 'and no second line');
  const facts = { durationMs: 83000, spend: '约 $0.12', tokens: '输入 52,000 · 输出 300' }, told = latestResult([ask, reply], { ...idle, facts });
  assert.ok(row(told).includes('<span class="result-took"> · took 1 min 23 s · 约 $0.12 · 输入 52,000 · 输出 300</span>'), 'the duration the source measured wins');
  const failed = (options) => latestResult([ask, readingTool('npm test', 3, { failed: true })], { ...idle, ...options });
  assert.equal(failed({}).failure, 'npm test'); assert.equal(failed({ interrupted: true, stopped: true }).failure, '', 'a source that says the round was stopped makes it stopped even when its last step failed');
  assert.equal(failed({ interrupted: true }).failure, 'npm test', 'a terminal round keeps its earlier reading');
  const stopped = failed({ interrupted: true, stopped: true, facts: { message: 'Stopped at the turn limit.' } });
  assert.match(row(stopped), /aria-label="Interrupted"/); assert.ok(row(stopped).includes('<p class="result-sub">Stopped at the turn limit.</p>'));
  assert.doesNotMatch(row(failed({ facts: { durationMs: 1000 } })), /result-sub">Stopped/);
});

test('failed and interrupted headings retain their visible labels and native tooltips', () => {
  const result = latestResult([readingEntry('u', 'user', 1, { text: 'Run checks.' }), readingTool('npm test', 2, { failed: true })], idle);
  for (const [failure, label] of [['npm test', 'Failed'], ['', 'Interrupted']]) {
    assertResultHeading({ ...result, failure }, 'Run the checks', 'Run the checks', label);
  }
});

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
  assert.equal(heading, `<h3 class="result-title" title="${expected}"><span>${expected}</span></h3>`);
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
    assertResultHeading({ ...result, kind }, source, en[FALLBACK_TITLES[kind]], kind === 'failed' ? 'Interrupted' : '');
  }
  assertResultHeading({ ...result, kind: 'failed', failure: 'download failed' }, undefined, en[FALLBACK_TITLES.failed], 'Failed');
});

test('the latest round alone carries the status row and the actions, and the composer invites the next step', t => {
  const entries = [readingEntry('u1', 'user', 1, { text: 'first' }), roundPicture('g1', 2), readingEntry('u2', 'user', 5, { text: 'build it' }), roundEdit('e', 6), readingEntry('z', 'assistant', 7, { text: 'built it' })];
  const { state, render } = readingHarness(t, entries);
  state.terminal.taskTitle = 'Built the app';
  let html = render();
  assert.equal((html.match(/class="result-status/g) || []).length, 1, 'one status row, for the latest round only');
  assert.match(html, /Built the app<\/span><\/h3>/); assert.match(html, /placeholder="Keep editing, or describe the next step…"/);
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
  assert.ok(css.includes('.reading-attachments { display: flex; align-items: center; gap: 8px; margin: 0 var(--reading-edge-right) 8px var(--reading-edge-left);'));
  assert.ok(card.includes('.result-status, .result-evidence, .result-actions { box-sizing: border-box; padding-left: var(--turn-pad); padding-right: var(--reading-inset); }'));
  assert.ok(css.includes('.reading-content { gap: 16px; }') && css.includes('.reading-step.is-user:not(:first-child) { margin-top: 16px; }'), 'rounds are told apart by space');
});

test('the save-as channel is registered in the main process, the preload and the types', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert.match(read('electron/main.cjs'), /handle\('agent:saveImageAs'[\s\S]*isGeneratedImage\(file\)[\s\S]*remoteProjectImage\(projectId, file\)[\s\S]*showSaveDialog[\s\S]*writeFile\(target, bytes\) : fs\.promises\.copyFile/);
  assert.match(read('electron/preload.cjs'), /saveImageAs: \(file, projectId\) => ipcRenderer\.invoke\('agent:saveImageAs', file, projectId\)/);
  assert.match(read('src/shared/types.ts'), /saveImageAs\(file: string, projectId\?: string\): Promise<Result<string \| null>>/);
  for (const text of ['保存图片', '继续修改', '继续追问', '重试', '查看大图', '{time} 完成', '继续修改，或描述下一步…']) assert.ok(text in en, `${text} has an English translation`);
});

test('list markers take the running agent\'s colour: Claude orange for Claude Code, the usage teal for Codex and anything else', t => {
  const { state, render } = readingHarness(t, [readingEntry('a1', 'assistant', 1, { text: '- one' })]);
  for (const [agent, expected] of [['claude', 'claude'], ['codex', 'codex'], ['future-agent', 'codex']]) {
    state.terminal.agent = agent;
    assert.match(render(), new RegExp(`<div class="reading-view" data-agent="${expected}"`), `${agent} marks the reading root`);
  }
  const css = fs.readFileSync(path.join(__dirname, '../src/features/reading/reading.css'), 'utf8');
  const themes = fs.readFileSync(path.join(__dirname, '../src/shared/styles/themes.css'), 'utf8');
  assert.match(css, /:is\(\.reading-view, \.conversation-feed\)\[data-agent="claude"\] \{ --list-marker: var\(--agent-claude\); --list-number: var\(--agent-claude-text\); \}/);
  assert.doesNotMatch(css, /data-agent="codex"/, 'Codex keeps the default');
  assert.match(css, /ul > li::before \{[^}]*background: var\(--list-marker, var\(--usage\)\)/);
  assert.match(css, /ul ul > li::before \{[^}]*inset 0 0 0 1\.5px var\(--list-marker, var\(--usage\)\)/);
  assert.match(css, /ol > li::marker \{ color: var\(--list-number, var\(--usage\)\)/);
  assert.doesNotMatch(css.match(/\.reading-markdown ul > li[\s\S]*?ol > li::marker[^\n]*/)[0], /(?<!, )var\(--usage\)(?!\))/, 'no marker rule names the teal without the fallback');
  // The numeral is text: its token reaches 4.5:1 on every light reading surface; dark keeps the brand orange.
  const token = (block, name) => block.match(new RegExp(`${name}: (#[0-9a-f]{6})`))[1];
  const light = themes.slice(themes.indexOf(':root[data-theme="light"] {')), dark = themes.slice(0, themes.indexOf(':root[data-theme="light"] {'));
  const channel = value => { const c = parseInt(value, 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = hex => 0.2126 * channel(hex.slice(1, 3)) + 0.7152 * channel(hex.slice(3, 5)) + 0.0722 * channel(hex.slice(5, 7));
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const numeral = token(light, '--agent-claude-text');
  for (const surface of [token(light, '--bg-card'), token(light, '--bg-app'), token(light, '--bg-hover')]) assert.ok(ratio(numeral, surface) >= 4.5, `${numeral} on ${surface}`);
  assert.match(dark, /--agent-claude-text: var\(--agent-claude\)/);
  assert.equal(token(dark, '--agent-claude'), '#d97757');
});

test('ConversationFeed shows a step’s output by default; hideToolOutput (the native view’s) keeps the row, one reason for a failed step, and the output of a "!" card, a diff and the plan', t => {
  readingHarness(t);
  const common = { './action-text': { stepVerb: step => step.kind }, './Markdown': { Markdown: ({ text }) => React.createElement('p', null, text) }, './FileCards': { FileCards: () => null, previewable: () => false } };
  const { ConversationFeed } = loadUI('features/reading/ConversationFeed.tsx', common);
  const entries = [readingTool('ran-ok', 2, { output: 'LONG_OUTPUT_OK', done: false }), readingTool('ran-bad', 3, { output: '\nboom: first line\nsecond line', failed: true, detail: '退出码 1' }),
    readingTool('shell:s1', 4, { output: 'BANG_OUTPUT' }), readingTool('f1', 5, { kind: 'edit', output: '+DIFF_LINE' }), readingTool('native:plan', 6, { kind: 'other', output: 'PLAN_WORDS' })];
  const draw = hide => renderToStaticMarkup(React.createElement(ConversationFeed, { entries, agent: 'claude', projectId: 'fixture', live: true, ...(hide ? { hideToolOutput: true } : {}), onError: assert.fail }));
  const terminal = draw(false);
  for (const word of ['LONG_OUTPUT_OK', 'boom: first line', 'second line', 'BANG_OUTPUT', 'DIFF_LINE', 'PLAN_WORDS']) assert.match(terminal, new RegExp(word), `the terminal reading view keeps ${word}`);
  assert.doesNotMatch(terminal, /reading-tool-reason/);
  const native = draw(true);
  assert.doesNotMatch(native, /LONG_OUTPUT_OK|second line/, 'no output box for a running or a finished step');
  assert.match(native, /<code title="ran-ok">/); assert.match(native, /<code title="ran-bad">/, 'the rows stay');
  assert.match(native, /<small class="reading-tool-reason" title="boom: first line">boom: first line<\/small>/, 'a failed step says why in one line');
  assert.equal((native.match(/reading-tool-reason/g) || []).length, 1, 'only the failed step has a reason line');
  for (const word of ['BANG_OUTPUT', 'DIFF_LINE', 'PLAN_WORDS']) assert.match(native, new RegExp(word), `${word} stays`);
});

test('ConversationFeed works without a terminal or composer and forwards project links', t => {
  readingHarness(t);
  const entries = [readingEntry('feed-user', 'user', 1, { text: 'Inspect the fixture' }), readingTool('feed-tool', 2, { done: true }), readingEntry('feed-reply', 'assistant', 3, { text: 'Done' })];
  const common = { './action-text': { stepVerb: step => step.kind }, './Markdown': { Markdown: ({ text }) => React.createElement('p', null, text) }, './FileCards': { FileCards: () => null, previewable: () => false } };
  const { ConversationFeed } = loadUI('features/reading/ConversationFeed.tsx', common);
  const html = renderToStaticMarkup(React.createElement(ConversationFeed, { entries, agent: 'codex', projectId: 'fixture', live: false, onError: assert.fail }));
  assert.match(html, /conversation-feed/); assert.equal((html.match(/class="reading-step is-/g) || []).length, 2);
  assert.match(html, /Inspect the fixture/); assert.match(html, /reading-tools/); assert.doesNotMatch(html, /textarea|reading-composer|reading-choice-option/);
  const links = [], hooks = { useMemo: make => make(), useRef: value => ({ current: value }), useContext: () => null };
  const component = loadUI('features/reading/ConversationFeed.tsx', { ...common, react: hooks }).ConversationFeed;
  const root = component({ entries: [], agent: 'codex', projectId: 'fixture', live: false, onError: assert.fail, onOpenLink: target => links.push(target) });
  let prevented = false;
  root.props.onClick({ target: { closest: selector => selector === '.reading-markdown a' ? { getAttribute: () => 'https://example.invalid/fixture' } : null }, preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.deepEqual(links, ['https://example.invalid/fixture']);
});

test('an automatic stalled resend with a missing native input never opens or focuses a terminal', async t => {
  let now = 10000; t.mock.method(Date, 'now', () => now);
  const h = dictationHarness(t, {
    './terminal-screen': { useScreen: () => ({ rows: composerRows('codex') }), readScreen: () => null },
    './usePendingPrompts': { usePendingPrompts: () => ({ pending: [{ id: 'stalled', text: 'old send', at: 1, sending: false }], echo() {}, cancelEcho() {} }) },
  });
  h.edit('keep writing'); now += 6000; await h.tick(6000);
  assert.equal(h.popup(), undefined); assert.deepEqual(h.terminalFocused, []); assert.equal(h.node.value, 'keep writing');
  assert.deepEqual(h.written, []); assert.deepEqual(h.pasted, []);
});

test('a popup also preserves focus in another project composer after its typing grace expired', t => {
  const h = popupHarness(t), editable = { matches: selector => selector.split(/,\s*/).includes('textarea') };
  document.body.contains = target => target === editable; document.activeElement = editable;
  h.view.rows = ['Settings', 'Esc to close']; h.render(); h.tick(3000);
  assert.ok(h.popup()); assert.equal(h.popup().props.focus, false); assert.equal(document.activeElement, editable);
  assert.deepEqual(h.writes, []);
});

// Message quotes (round r7 F). A quote is a bounded "> " block the next ordinary message carries.
function quoteHarness(t, overrides = {}) {
  const records = [{ id: 'u1', role: 'user', text: 'earlier', at: 1000 }];
  const h = dictationHarness(t, {
    './useReadingConversation': { conversationKey: (id, session) => session, useReadingHistory: () => historySnapshot(records) },
    ...overrides,
  });
  // The reader hands every message the same 引用 action through the feed's decorations.
  const pick = (who, text) => { elements(h.tree()).find(element => element.props.value?.quote).props.value.quote.pick(who, text); h.render(); };
  const chip = () => elements(h.tree()).find(element => element.type?.name === 'QuoteChip');
  return { h, pick, chip };
}

test('a quote goes before the words of the next ordinary message once, and the pending echo carries it', async t => {
  const { h, pick, chip } = quoteHarness(t);
  pick('Codex', 'the plan:\n\nstep one\nstep two');
  assert.deepEqual(chip().props.quote, { who: 'Codex', excerpt: 'the plan:\n\nstep one\nstep two' });
  h.edit('please fix'); h.press('Enter'); await h.tick(0);
  assert.deepEqual(h.pasted.map(item => item.text), ['> the plan:\n>\n> step one\n> step two\n\nplease fix']);
  assert.equal(h.echoed[0].text, h.pasted[0].text);
  assert.equal(chip(), undefined);
});

test('one quote at a time: the newest wins and the chip removes it', t => {
  const { h, pick, chip } = quoteHarness(t);
  pick('你', 'first'); pick('Codex', 'second');
  assert.equal(chip().props.quote.excerpt, 'second');
  chip().props.onRemove(); h.render();
  assert.equal(chip(), undefined);
});

test('a command is typed as it is and keeps the quote for the next message', async t => {
  const { h, pick, chip } = quoteHarness(t);
  pick('Codex', 'keep me');
  h.edit('/status'); h.press('Enter'); await h.tick(0);
  assert.deepEqual(h.written.map(item => item.text), ['\x15']);
  assert.deepEqual(h.pasted, []); assert.deepEqual(h.echoed, []);
  assert.equal(chip().props.quote.excerpt, 'keep me');
});

test('a quote without words of its own is not sent', async t => {
  const { h, pick, chip } = quoteHarness(t);
  pick('Codex', 'alone');
  h.press('Enter'); await h.tick(0);
  assert.deepEqual(h.pasted, []); assert.deepEqual(h.echoed, []);
  assert.equal(chip().props.quote.excerpt, 'alone');
});

test('a message sent again carries its own quote and takes no second one', async t => {
  const prompts = require('../src/features/reading/pending-prompts.ts');
  let clock = 30000;
  t.mock.method(Date, 'now', () => clock);
  const records = [{ id: 'unrelated', role: 'user', text: 'DIFFERENT_MESSAGE', at: 2000 }];
  let state = prompts.addPendingPrompt(prompts.createPendingPrompts('session'), 'lost', 'NEVER_DELIVERED', 1000);
  state = prompts.reconcilePendingPrompts(state, 'session', records, clock);
  const { h, pick, chip } = quoteHarness(t, {
    './useReadingConversation': { conversationKey: (id, session) => session, useReadingHistory: () => historySnapshot(records) },
    './usePendingPrompts': { usePendingPrompts: () => {
      state = prompts.reconcilePendingPrompts(state, 'session', records, clock);
      return { pending: state.prompts, echo(text, images) { state = prompts.addPendingPrompt(state, 'again', text, clock, images); return 'again'; },
        cancelEcho(id) { state = prompts.removePendingPrompt(state, id); } };
    } },
  });
  pick('Codex', 'for the next message');
  h.props.terminal.codexActivity = 'idle';
  clock += 6000; await h.tick(6000);
  assert.deepEqual(h.pasted.map(item => item.text), ['NEVER_DELIVERED']);
  assert.equal(chip().props.quote.excerpt, 'for the next message');
});

test('the quote is dropped when the terminal or session changes', t => {
  const { h, pick, chip } = quoteHarness(t);
  pick('Codex', 'old session');
  h.props.terminal.sessionId = 'other'; h.render(); h.render();
  assert.equal(chip(), undefined);
});

for (const newer of [false, true]) test(`a failed paste returns the quote with the draft${newer ? ' unless a newer quote was picked' : ''}`, async t => {
  const { h, pick, chip } = quoteHarness(t), errors = [];
  let fail;
  h.props.onError = error => errors.push(error);
  window.agentrix.pasteTerminal = () => new Promise(resolve => { fail = resolve; });
  pick('Codex', 'first');
  h.edit('words'); h.press('Enter');
  assert.equal(chip(), undefined);
  if (newer) pick('Codex', 'newer');
  fail({ ok: false, error: 'no paste' }); await h.tick(0);
  assert.deepEqual(errors, ['no paste']);
  assert.equal(chip().props.quote.excerpt, newer ? 'newer' : 'first');
});

test('only a message with words of its own opens the 引用 / 复制 menu, no message carries a quote button, and the standalone feed offers none', t => {
  const { state, render, environment } = readingHarness(t, [
    readingEntry('u1', 'user', 10, { text: 'first prompt' }), readingTool('cmd', 11),
    readingEntry('a1', 'assistant', 12, { text: 'a reply' }), readingEntry('a2', 'assistant', 13, { text: 'too big', omitted: true }),
    readingEntry('a3', 'assistant', 14, { images: ['picture'] }),
  ]);
  const html = render();
  assert.equal((html.match(/<div[^>]*data-reading-entry[^>]*aria-haspopup="menu"/g) || []).length, 2, 'the owner message and the reply with words');
  assert.equal((html.match(/<div[^>]*data-reading-entry="(?:u1|a1)"[^>]*tabindex="0"/g) || []).length, 2, 'focusable, so the menu key opens it');
  assert.doesNotMatch(html, /reading-quote-action|aria-label="Quote this message"/, 'no quote button on any message');
  assert.doesNotMatch(html, /role="menu"/, 'the menu is closed until the right click');
  const { ConversationFeed } = loadUI('features/reading/ConversationFeed.tsx', environment);
  const standalone = renderToStaticMarkup(React.createElement(ConversationFeed, { entries: state.entries, agent: 'codex', projectId: 'project', live: false, onError() {} }));
  assert.match(standalone, /a reply/); assert.doesNotMatch(standalone, /aria-haspopup|tabindex/);
});

// MessageCard and MessageMenu run here with stand-in hooks, so the handlers and the effect can be driven without a window.
function messageMenuHarness(t, { selection = '', selectionInside = true } = {}) {
  const previous = { window: globalThis.window, document: globalThis.document };
  t.after(() => {
    for (const name of ['window', 'document']) if (previous[name] === undefined) delete globalThis[name]; else globalThis[name] = previous[name];
  });
  const slots = [], listeners = {}, calls = [], focusLog = [];
  let cursor = 0;
  const node = { contains: n => n === 'inside' };
  const hooks = {
    useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], v => { slots[i] = v; }]; },
    useRef: initial => { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect: callback => { hooks.effect = callback; },
  };
  globalThis.document = {
    activeElement: { isConnected: true, focus: () => focusLog.push('restored') },
    addEventListener: (type, fn, capture) => { (listeners[type] ??= []).push({ fn, capture }); },
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] ?? []).filter(item => item.fn !== fn); },
  };
  globalThis.window = {
    innerWidth: 1000, innerHeight: 800,
    getSelection: () => ({ isCollapsed: !selection, anchorNode: selectionInside ? 'inside' : 'outside', focusNode: selectionInside ? 'inside' : 'outside', toString: () => `  ${selection}  ` }),
    agentrix: { copy: async text => { calls.push(['copy', text]); return { ok: true }; } },
  };
  const { MessageCard, MessageMenu } = loadUI('features/reading/MessageMenu.tsx', { react: hooks });
  const quote = { disabled: null, pick: (who, text) => calls.push(['quote', who, text]) };
  const card = (props = {}) => {
    cursor = 0; slots[1] = { current: node };
    return MessageCard({ id: 'm1', className: 'reading-user', text: 'whole message', who: 'You', quote, onError() {}, children: 'x', ...props });
  };
  const event = (extra = {}) => ({ target: { closest: () => null }, clientX: 300, clientY: 200, prevented: false, preventDefault() { this.prevented = true; }, ...extra });
  const menuItems = (place, props = {}) => {
    cursor = 100; hooks.effect = null;
    const element = MessageMenu({ place, text: 'whole message', who: 'You', quote, onCopy: text => calls.push(['copy', text]), onClose: () => calls.push(['close']), ...props });
    const buttons = [];
    (function walk(n) { if (n?.type === 'button') buttons.push(n); [].concat(n?.props?.children ?? []).forEach(walk); })(element);
    return { element, buttons };
  };
  return { card, event, calls, slots, listeners, menuItems, hooks, focusLog };
}

test('right-clicking a message opens the menu at the pointer; a link, picture, code block or control keeps its own right click', t => {
  const h = messageMenuHarness(t);
  const tree = h.card();
  assert.equal(tree.props.tabIndex, 0);
  const plain = h.event(); tree.props.onContextMenu(plain);
  assert.equal(plain.prevented, true);
  assert.deepEqual(h.slots[0], { x: 300, y: 200, selected: '' });
  for (const tag of ['a', 'img', 'pre', '.reading-code', 'button']) {
    h.slots[0] = null;
    const other = h.event({ target: { closest: selector => selector.split(', ').includes(tag) ? {} : null } });
    h.card().props.onContextMenu(other);
    assert.equal(other.prevented, false, `${tag} keeps its own right click`); assert.equal(h.slots[0], null);
  }
  h.card().props.onContextMenu(h.event({ clientX: 990, clientY: 790 }));
  assert.deepEqual([h.slots[0].x, h.slots[0].y], [1000 - 182 - 8, 800 - 88 - 8], 'kept inside the window');
});

test('the menu key and Shift+F10 open the same menu from the message itself, and only from the message', t => {
  const h = messageMenuHarness(t);
  const tree = h.card();
  const self = { getBoundingClientRect: () => ({ left: 100, top: 50 }) };
  const key = (extra, target = self) => ({ key: 'x', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, target, currentTarget: self, prevented: false, preventDefault() { this.prevented = true; }, ...extra });
  for (const extra of [{ key: 'ContextMenu' }, { key: 'F10', shiftKey: true }]) {
    h.slots[0] = null; const press = key(extra); tree.props.onKeyDown(press);
    assert.equal(press.prevented, true); assert.deepEqual(h.slots[0], { x: 116, y: 66, selected: '' });
  }
  for (const extra of [{ key: 'F10' }, { key: 'Enter' }, { key: 'F10', shiftKey: true, ctrlKey: true }]) {
    h.slots[0] = null; const press = key(extra); tree.props.onKeyDown(press);
    assert.equal(press.prevented, false); assert.equal(h.slots[0], null);
  }
  h.slots[0] = null; tree.props.onKeyDown(key({ key: 'ContextMenu' }, {}));
  assert.equal(h.slots[0], null, 'a control inside keeps the key');
});

test('without a quote action, or a message with no words of its own, the card is plain', t => {
  const h = messageMenuHarness(t);
  for (const props of [{ quote: undefined }, { text: undefined }, { text: '' }]) {
    const tree = h.card(props);
    assert.equal(tree.props.tabIndex, undefined); assert.equal(tree.props.onContextMenu, undefined); assert.equal(tree.props['data-reading-entry'], 'm1');
  }
});

test('the menu has 引用 and 复制 only; with words selected inside the message they act on those words, otherwise on the whole message', t => {
  for (const [selection, expected] of [['picked words', 'picked words'], ['', 'whole message']]) {
    const h = messageMenuHarness(t, { selection });
    h.card().props.onContextMenu(h.event());
    const place = h.slots[0]; assert.equal(place.selected, selection);
    const { element, buttons } = h.menuItems(place);
    assert.equal(element.props.role, 'menu'); assert.match(element.props.className, /\bdropdown\b/, 'the standard dropdown');
    assert.deepEqual(buttons.map(button => button.props.role), ['menuitem', 'menuitem']);
    assert.deepEqual(buttons.map(button => button.props.children.at(-1)), ['Quote', 'Copy']);
    h.calls.length = 0; buttons[0].props.onClick();
    assert.deepEqual(h.calls, [['close'], ['quote', 'You', expected]]);
    h.calls.length = 0; buttons[1].props.onClick();
    assert.deepEqual(h.calls, [['close'], ['copy', expected]]);
  }
});

test('a selection that reaches outside the message is ignored, so the whole message is acted on', t => {
  const h = messageMenuHarness(t, { selection: 'elsewhere', selectionInside: false });
  h.card().props.onContextMenu(h.event());
  assert.equal(h.slots[0].selected, '');
});

test('Copy writes plain text through the app clipboard and reports a failure; Quote is disabled with its reason while the composer is unavailable', async t => {
  const h = messageMenuHarness(t), errors = [];
  window.agentrix.copy = async text => { h.calls.push(['copy', text]); return { ok: false, error: 'no clipboard' }; };
  h.card().props.onContextMenu(h.event());
  const menu = h.card({ onError: error => errors.push(error) }).props.children[1];
  menu.props.onCopy('plain words'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls, [['copy', 'plain words']]); assert.deepEqual(errors, ['no clipboard']);
  const blocked = h.menuItems({ x: 0, y: 0, selected: '' }, { quote: { disabled: 'busy', pick() { throw new Error('must not quote'); } } }).buttons[0];
  assert.equal(blocked.props.disabled, true); assert.equal(blocked.props.title, 'busy');
});

test('Escape and a press outside close the menu, Escape alone (the composer Escape would stop the agent); focus returns', t => {
  const h = messageMenuHarness(t);
  h.menuItems({ x: 0, y: 0, selected: '' });
  const cleanup = h.hooks.effect();
  const key = h.listeners.keydown[0], down = h.listeners.pointerdown[0];
  assert.equal(key.capture, true, 'capture phase, ahead of the composer');
  h.calls.length = 0;
  const other = { key: 'a', prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} };
  key.fn(other); assert.equal(other.prevented, false); assert.deepEqual(h.calls, []);
  const escape = { key: 'Escape', prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  key.fn(escape); assert.deepEqual([escape.prevented, escape.stopped], [true, true]); assert.deepEqual(h.calls, [['close']]);
  h.calls.length = 0; down.fn({ target: 'outside' }); assert.deepEqual(h.calls, [['close']]);
  cleanup(); assert.deepEqual(h.focusLog, ['restored']); assert.equal(h.listeners.keydown.length, 0);
});

test('a sent message shows its quote as a block, in the timeline and while pending', t => {
  const { state, render } = readingHarness(t, [readingEntry('u1', 'user', 10, { text: '> quoted line\n> second\n\nmy question' })]);
  state.pending = [{ id: 'p', role: 'user', text: '> pending quote\n\nmy echo', at: new Date(2026, 9, 17, 16, 20).getTime(), sending: true }];
  const html = render();
  assert.match(html, /<blockquote class="reading-user-quote"><div class="reading-markdown">quoted line\nsecond<\/div><\/blockquote>/);
  assert.match(html, /<blockquote class="reading-user-quote"><div class="reading-markdown">pending quote<\/div><\/blockquote>/);
  assert.match(html, /my question/); assert.match(html, /my echo/);
  assert.doesNotMatch(html, /&gt; quoted|&gt; pending/);
});

test('a sent quote is laid out as Markdown: inline code and lists are not shown raw', t => {
  const { render } = readingHarness(t, [readingEntry('u1', 'user', 10, { text: '> 读了 `parser.cjs`：\n> 1. 第一点\n> 2. 第二点\n\n同意' })],
    { './markdown-escape': require('../src/features/reading/markdown-escape.ts') });
  const html = render();
  assert.match(html, /<blockquote class="reading-user-quote">[\s\S]*<code>parser\.cjs<\/code>[\s\S]*<ol>[\s\S]*<li>第一点<\/li>[\s\S]*<li>第二点<\/li>[\s\S]*<\/blockquote>/);
  assert.doesNotMatch(html, /`parser|1\. 第一点/);
});

test('a locked composer looks locked: no input fill, the quiet divider edge and a readable draft, in theme tokens only', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/features/reading/reading.css'), 'utf8');
  const locked = /\.reading-composer:has\(textarea:disabled\) \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(locked, /background: transparent;/); assert.match(locked, /border-color: var\(--divider\);/);
  assert.match(css, /\.reading-composer textarea:disabled \{ color: var\(--text-2\); \}/, 'the draft kept in it stays readable');
  assert.doesNotMatch(locked, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'tokens only');
});
