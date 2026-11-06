const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const jsx = require('react/jsx-runtime');
const { hookHarness } = require('./helpers/hook-harness.cjs');
const { parseAgentScreen, waitingTitle } = require('../src/features/agents/agent-screen.ts');
const panel = require('../src/features/reading/cli-panel.ts');
const { blocks } = require('../src/features/reading/useVisibleTail.ts');
const { DIALOG_SETTLE } = require('../src/features/reading/reading-ready.ts');
const elements = node => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements(node.props.children)] : [];
const idle = { codex: ['>'], claude: [] };
idle.codex = ['› Ask Codex to do anything', '', 'gpt-6.1-sol · high · 100% context left'];
idle.claude = ['────', '❯ ', '────', '  Opus 5.5 · 0% context'];
const read = file => fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8').split(/\r?\n/);
idle.claude = read('screens/claude-idle-2-1-296.txt');
let nextId = 0;

function popupHarness(t, agent = 'codex', rows = idle[agent], activity = 'complete') {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const previous = { window: global.window, document: global.document, textarea: global.HTMLTextAreaElement };
  global.HTMLTextAreaElement = class {};
  const writes = [], pastes = [], view = { rows }, root = { contains: target => target === node || target === composer };
  const node = Object.assign(new HTMLTextAreaElement(), { value: '', dataset: {}, disabled: false, selectionStart: 0, selectionEnd: 0,
    matches: selector => selector.split(/,\s*/).includes('textarea'), setSelectionRange() {}, focus() { if (!this.disabled) document.activeElement = this; } });
  const composer = { focus() { document.activeElement = this; }, matches: () => false };
  global.document = { body: {}, activeElement: null, getElementById: () => null };
  document.activeElement = document.body;
  global.window = { addEventListener() {}, removeEventListener() {}, agentrix: {
    terminalCommands: async () => ({ ok: true, value: [] }), terminalFocus() {},
    writeTerminal: (...args) => writes.push(args), pasteTerminal: async (...args) => { pastes.push(args); return { ok: true }; },
  } };
  function ReadingTerminalPopup() {} function ConversationFeed() {}
  const noop = () => null, compact = async () => {}, entries = [];
  // Commit the mock DOM before layout effects; a disabled textarea must reject focus until that commit.
  const runtime = Object.fromEntries(['jsx', 'jsxs'].map(name => [name, (...args) => {
    const tree = jsx[name](...args);
    if (tree.props.className === 'reading-view') {
      tree.props.ref.current = root;
      const box = elements(tree).find(element => element.type === 'textarea');
      box.props.ref.current = node; node.value = box.props.value; node.disabled = box.props.disabled;
      elements(tree).find(element => element.props.className?.startsWith('reading-composer')).props.ref.current = composer;
    }
    return tree;
  }]));
  const harness = hookHarness('src/features/reading/ReadingView.tsx', {
    'react/jsx-runtime': runtime,
    '@phosphor-icons/react': new Proxy({}, { get: () => noop }),
    './action-text': { actionText: () => '' },
    './dictation-send': require('../src/features/reading/dictation-send.ts'),
    './reading-command': require('../src/features/reading/reading-command.ts'),
    './image-thumbnail': { thumbnail: async () => '', dataUrl: async () => '' },
    './pasted-pictures': { rememberPicture() {} },
    './typing': require('../src/features/reading/typing.ts'),
    './pending-prompts': require('../src/features/reading/pending-prompts.ts'),
    './composer-prefill': { onComposerPrefill: () => () => {} },
    './terminal-screen': { useScreen: () => ({ rows: view.rows, ...view.frame }), bindApproval: choice => choice },
    './agent-screen': { parseAgentScreen, waitingTitle }, './cli-panel': panel,
    './reading-mode': { setChoiceVisible() {} }, './reading.css': {}, './reading-flow.css': {},
    './Markdown': { Markdown: noop }, './ConversationFeed': { ConversationFeed, ConversationDecorations: React.createContext(null) },
    './ReadingQuote': { QuoteChip: noop }, './message-quote': require('../src/features/reading/message-quote.ts'),
    './ReadingTerminalPopup': { ReadingTerminalPopup }, './WaitingCard': { WaitingCard: function WaitingCard() {} },
    './ReadingWelcome': { ReadingWelcome: noop }, './reading-welcome': { useWelcomeStarting: () => false },
    './reading-ready': require('../src/features/reading/reading-ready.ts'),
    './useReadingConversation': { useReadingHistory: () => ({ entries, compact }) },
    './useStickToBottom': { useStickToBottom: () => ({ stuck: true, unseen: 0, ready: true, holdPosition() {}, toBottom() {} }) },
    './useVisibleTail': { blocks, useVisibleTail: grouped => ({ visible: grouped, earlier: 0, hasEarlier: false }) },
    './useFittingHint': { ...require('../src/shared/useFittingHint.ts'), useFittingHint: (box, hints) => hints[0] },
    './useNativePictures': { useNativePictures: () => ({ images: [], clear() {}, readInput: () => null }) },
    './usePendingPrompts': { usePendingPrompts: () => ({ pending: [], echo: noop, cancelEcho() {} }) },
    './useMentions': { useMentions: () => ({ open: false, keys: () => false }) },
    './MentionPalette': { MentionPalette: noop }, './PendingPromptEntries': { PendingPromptEntries: noop, UserImages: noop },
    './Timeline': { TimelineStep: noop, AgentMark: noop },
    './ResultCard': { ResultActions: noop, ResultChecks: noop, ResultStatus: noop, WorkingLine: noop },
    './result-round': { latestResult: () => null }, './AgentCommandRun': { AgentCommandRun: noop },
    './voice-input': { dictateInto: () => () => {} },
    './VoiceButton': { VoiceButton() { return null; } },
    './i18n': { t: (text, values = {}) => text.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match) },
  });
  const props = { projectId: 'fixture', terminal: { id: 'popup-fixture-' + ++nextId, sessionId: 'fixture-session', agent,
    codexActive: true, codexActivity: activity, status: 'codex', needsInput: null }, active: true, autoFocus: false,
    onShowTerminal() {}, onError: assert.fail, onOpenLink() {} };
  let tree;
  const render = () => {
    tree = harness.render('ReadingView', props).result;
    return tree;
  };
  t.after(() => { harness.dispose(); global.window = previous.window; global.document = previous.document;
    if (previous.textarea === undefined) delete global.HTMLTextAreaElement; else global.HTMLTextAreaElement = previous.textarea; });
  render();
  return { props, view, node, writes, pastes, render, tree: () => tree,
    popup: () => elements(tree).find(element => element.type === ReadingTerminalPopup),
    waiting: () => elements(tree).find(element => element.type?.name === 'WaitingCard'),
    edit(value) { node.focus(); elements(tree).find(element => element.type === 'textarea').props.onChange({ target: { value } }); render(); },
    tick(ms) { t.mock.timers.tick(ms); render(); },
    keys(key) { elements(tree).find(element => element.type === 'textarea').props.onKeyDown({ key, currentTarget: node, nativeEvent: {}, preventDefault() {}, stopPropagation() {} }); render(); },
  };
}

if (require.main === module) {
  // All captured dialog variants, not just the parser's successfully recognised choices.
  const screenDir = path.join(__dirname, 'fixtures/screens'), questionDir = path.join(__dirname, 'fixtures/questions');
  const screens = fs.readdirSync(screenDir).filter(name => /(?:sign-in|trust-folder|permission|model-menu|mention|shortcuts|resume-(?:inside|linux|start|empty)|investigation-(?:question|single|multi|tabs|review|plan|mcp|trust|bash|edit|write|web|patch|permissions|command|script|api-key|tall)|memories-dialog|plugins-view|(?:config|usage)-working|2-1-302-(?:status|config)|0-163-(?:model|plugins|permissions|memories))/.test(name) && !name.endsWith('-before.txt'));
  const fixtures = [...screens.map(name => ['screens/' + name, name.startsWith('claude') ? 'claude' : 'codex']),
    ...fs.readdirSync(questionDir).filter(name => name.endsWith('.txt')).map(name => ['questions/' + name, name.startsWith('claude') ? 'claude' : 'codex'])];
  for (const [file, agent] of fixtures) for (const activity of ['complete', 'working']) for (const typing of [false, true]) {
    test(file + ' while ' + activity + (typing ? ' and typing' : '') + ': the actual reading view opens its terminal and never emits answer keys', t => {
      const h = popupHarness(t, agent, typing ? idle[agent] : read(file), activity);
      if (typing) { h.edit('draft retained'); h.view.rows = read(file); h.render(); }
      h.tick(DIALOG_SETTLE * 2);
      assert.ok(h.popup(), file); assert.equal(h.node.disabled, false);
      if (typing) { assert.equal(h.popup().props.focus, false); assert.equal(h.node.value, 'draft retained'); }
      assert.equal(elements(h.tree()).some(element => /^(ReadingChoice|ReadingQuestion|NativeApprovalCard|NativeQuestionCard)$/.test(element.type?.name)), false);
      assert.deepEqual(h.writes, []); assert.deepEqual(h.pastes, []);
    });
  }
  for (const file of ['codex-plugins-view-before.txt', 'codex-memories-dialog-before.txt']) test(file + ': the pre-dialog capture is still an idle prompt', t => {
    const h = popupHarness(t, 'codex', read('screens/' + file)); h.tick(DIALOG_SETTLE * 2);
    assert.equal(h.popup(), undefined); assert.equal(h.node.disabled, false);
  });
  for (const agent of ['claude', 'codex']) {
    for (const activity of ['complete', 'working']) {
      test(agent + ': an explicit panel key strip opens immediately while ' + activity + ', without a parsed choice or notice', t => {
        const h = popupHarness(t, agent, ['Settings', 'Esc to close'], activity);
        const wait = DIALOG_SETTLE * (activity === 'working' ? 2 : 1);
        assert.ok(h.popup()); h.tick(wait - 1); assert.ok(h.popup());
        h.tick(1); assert.ok(h.popup()); assert.deepEqual(h.writes, []); assert.deepEqual(h.pastes, []);
      });
      test(agent + ': an idle input stays available despite ' + activity + ' activity', t => {
        const h = popupHarness(t, agent, idle[agent], activity); h.tick(DIALOG_SETTLE * 3);
        assert.equal(h.popup(), undefined); assert.equal(h.node.disabled, false);
      });
      test(agent + ': working output with its input drawn stays in the reader while ' + activity, t => {
        const line = agent === 'claude' ? '✻ Working…' : '• Working (5s · esc to interrupt)';
        const h = popupHarness(t, agent, [line, ...idle[agent]], activity); h.tick(DIALOG_SETTLE * 3);
        assert.equal(h.popup(), undefined); assert.equal(h.node.disabled, false);
        assert.deepEqual(h.writes, []); assert.deepEqual(h.pastes, []);
      });
    }
    test(agent + ': a working line without an input box cannot hide an explicit panel', t => {
      const line = agent === 'claude' ? '✻ Working…' : '• Working (5s · esc to interrupt)';
      const h = popupHarness(t, agent, [line, 'Settings', 'Esc to close'], 'working'); h.tick(DIALOG_SETTLE * 2);
      assert.ok(h.popup()); assert.deepEqual(h.writes, []); assert.deepEqual(h.pastes, []);
    });
    if (agent === 'claude') for (const name of ['claude-bang-running', 'claude-bang-empty-running', 'claude-bang-empty-model-working', 'claude-wrapped-draft']) {
      for (const activity of ['complete', 'working']) test(name + ': actual working input stays in the reader despite ' + activity + ' activity', t => {
        const h = popupHarness(t, agent, read('screens/' + name + '.txt'), activity); h.tick(DIALOG_SETTLE * 3);
        assert.equal(h.popup(), undefined); assert.equal(h.node.disabled, false);
        assert.deepEqual(h.writes, []); assert.deepEqual(h.pastes, []);
      });
    }
    test(agent + ': an idle prompt with its footer keeps the composer available', t => {
      const file = agent === 'claude' ? 'screens/claude-idle-2-1-296.txt' : 'screens/codex-fresh-default.txt';
      const h = popupHarness(t, agent, read(file)); h.tick(DIALOG_SETTLE * 2);
      assert.equal(h.popup(), undefined); assert.equal(h.node.disabled, false);
    });
    for (const activity of ['complete', 'working']) test(agent + ': while ' + activity + ' and typing an explicit panel opens without xterm focus and preserves the draft', t => {
      const h = popupHarness(t, agent, idle[agent], activity);
      h.edit('keep this draft'); h.view.rows = ['Settings', 'Esc to close']; h.render(); h.tick(DIALOG_SETTLE * (activity === 'working' ? 2 : 1));
      assert.ok(h.popup()); assert.equal(h.popup().props.focus, false); assert.equal(h.node.value, 'keep this draft');
      assert.equal(h.node.disabled, false); h.keys('Enter'); h.keys('Tab');
      assert.deepEqual(h.writes, []); assert.deepEqual(h.pastes, []);
    });
    for (const restoreFocus of [true, false]) test(agent + ': closing /status at idle ' + (restoreFocus ? 'focuses the enabled composer after commit' : 'leaves another editor focused'), async t => {
      const rows = agent === 'claude' ? ['────', '❯ ', '────', '  ⏸ manual mode on'] : idle.codex;
      const h = popupHarness(t, agent, rows);
      h.edit('/status'); h.keys('Enter');
      assert.equal(h.popup().props.command, '/status'); assert.equal(h.node.disabled, false);
      const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
      h.popup().props.onReady(); await flush();
      h.tick(59); await flush(); assert.deepEqual(h.writes.map(([, text]) => text), ['\x15']);
      h.tick(1); await flush(); assert.deepEqual(h.writes.map(([, text]) => text), ['\x15', '/status']);
      h.tick(149); await flush(); assert.equal(h.writes.length, 2);
      h.tick(1); await flush();
      assert.deepEqual(h.writes.map(([, text]) => text), ['\x15', '/status', '\r']);
      const before = h.writes.slice(), otherEditor = { matches: () => true };
      document.activeElement = restoreFocus ? document.body : otherEditor;
      h.popup().props.onClose(restoreFocus);
      assert.equal(h.node.disabled, false, 'the composer stays editable while the popup closes');
      h.render();
      assert.equal(h.node.disabled, false); assert.equal(h.popup(), undefined);
      assert.equal(document.activeElement, restoreFocus ? h.node : otherEditor);
      h.tick(DIALOG_SETTLE * 2);
      assert.equal(h.popup(), undefined); assert.deepEqual(h.writes, before); assert.deepEqual(h.pastes, []);
    });
    test(agent + ': a popup opened while typing preserves focus and draft, then restores the composer when closed at idle', t => {
      const h = popupHarness(t, agent);
      h.edit('keep this draft'); h.view.rows = ['Settings', 'Esc to close']; h.render(); h.tick(DIALOG_SETTLE);
      assert.equal(h.popup().props.focus, false); assert.equal(document.activeElement, h.node);
      h.view.rows = idle[agent]; h.render();
      assert.equal(h.popup(), undefined);
      assert.equal(h.node.disabled, false); assert.equal(document.activeElement, h.node); assert.equal(h.node.value, 'keep this draft');
      assert.deepEqual(h.writes, []); assert.deepEqual(h.pastes, []);
    });
  }
  test('an inactive dialog opens when activated; dismissal and redraw do not rearm it', t => {
    const h = popupHarness(t); h.props.active = false; h.view.rows = ['Settings', 'Esc to close']; h.render(); h.tick(DIALOG_SETTLE);
    assert.equal(h.popup(), undefined); h.props.active = true; h.render(); assert.ok(h.popup());
    h.popup().props.onClose(); h.render(); assert.ok(h.waiting());
    for (let i = 0; i < 5; i++) { h.view.rows = ['Settings ' + i, 'Esc to close']; h.render(); h.tick(DIALOG_SETTLE); assert.equal(h.popup(), undefined); }
    h.waiting().props.onOpenTerminal(); h.render(); assert.ok(h.popup());
  });
  // What the closed popup leaves: the dialog's own heading, and nothing at all rather than the tail of a wrapped paragraph.
  const wrappedModelMenu = ['  Select model', '  Switch between Claude models. Your pick becomes', '  the default for new sessions. For other/previous', '  model names, specify with --model.', '',
    ...read('screens/claude-model-menu-narrow.txt').slice(2)];
  for (const [what, rows, title] of [['the heading in view', wrappedModelMenu, 'Select model'], ['the heading scrolled off', read('screens/claude-model-menu-narrow.txt'), null]]) {
    test('claude: /model closed again leaves ' + (title ? 'its heading' : 'no title') + ' as the notice with ' + what + ', never a wrapped line of the paragraph', t => {
      const h = popupHarness(t, 'claude', rows); h.tick(DIALOG_SETTLE * 2);
      h.popup().props.onClose(); h.render();
      assert.equal(h.waiting().props.title, title);
    });
  }
  for (const agent of ['claude', 'codex']) test(agent + ': while a dialog waits the queueing composer says so in its hint, and its draft stays', t => {
    const h = popupHarness(t, agent, idle[agent]);
    h.edit('keep this draft'); h.view.rows = ['Settings', 'Esc to close']; h.render(); h.tick(DIALOG_SETTLE);
    const box = elements(h.tree()).find(element => element.type === 'textarea').props;
    assert.equal(box.disabled, false); assert.equal(box.value, 'keep this draft');
    assert.equal(box.placeholder, '等终端处理完后发送');
    h.view.rows = idle[agent]; h.popup()?.props.onClose(); h.render();
    assert.notEqual(elements(h.tree()).find(element => element.type === 'textarea').props.placeholder, '等终端处理完后发送', 'the hint goes with the dialog');
  });
  test('busy output and a transient redraw do not open a dialog, and returning to input cancels the timer', t => {
    const h = popupHarness(t, 'codex', ['• Working (5s · esc to interrupt)', ...idle.codex], 'working'); h.tick(DIALOG_SETTLE * 3);
    assert.equal(h.popup(), undefined); h.view.rows = ['Settings', 'Esc to close']; h.render(); h.tick(DIALOG_SETTLE - 1);
    h.view.rows = idle.codex; h.render(); h.tick(DIALOG_SETTLE * 2); assert.equal(h.popup(), undefined); assert.equal(h.node.disabled, false);
  });
  test('finishing activity shortens a pending unknown dialog wait, without suppressing it or sending keys', t => {
    const h = popupHarness(t, 'codex', ['Settings', 'Esc to close'], 'working'); h.tick(DIALOG_SETTLE);
    assert.ok(h.popup()); h.props.terminal.codexActivity = 'complete'; h.render();
    assert.ok(h.popup()); assert.deepEqual(h.writes, []); assert.deepEqual(h.pastes, []);
  });
}
module.exports = { popupHarness, elements, idle };
