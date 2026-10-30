const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');

const home = path.join(__dirname, '../src/features/home');
const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : React.isValidElement(node) ? [node, ...nodes(node.props.children)] : [];
const words = node => [node.props.children].flat(Infinity).filter(child => typeof child === 'string').join('');
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// The real ReviewCard and review-history, compiled as the renderer would; React, the browser and the card's neighbours
// are stand-ins. Only the grade call and what the review does around it are under test.
function mountCard(t, { acknowledge = async () => ({ ok: true }), send = async () => undefined, grade }) {
  const slots = [], effects = [], calls = { done: [], errors: [], acknowledged: 0, graded: [], sent: [] }, store = new Map();
  let cursor = 0;
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; },
    useMemo(fn) { cursor++; return fn(); },
    useEffect(fn) { cursor++; effects.push(fn); },
  };
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) };
  const savedStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), savedWindow = globalThis.window;
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  const agentrix = {
    terminalConversation: async () => ({ ok: true, value: [] }), terminalActions: async () => ({ ok: true, value: [] }), gitStatus: async () => ({ ok: false, error: 'none' }),
    acknowledge: async projectId => { calls.acknowledged++; return acknowledge(projectId); },
  };
  if (grade) agentrix.gradeDelivery = payload => { calls.graded.push(payload); return grade(payload); };
  globalThis.window = { agentrix };
  t.after(() => {
    globalThis.window = savedWindow;
    if (savedStorage) Object.defineProperty(globalThis, 'localStorage', savedStorage); else delete globalThis.localStorage;
  });

  const neighbours = {
    './DecisionCard': { decisionTitle: decision => decision.title, waited: () => '等了 1 分钟' },
    '../reading/ReadingView': { Markdown: () => null },
    '../reading/FileCards': { FileCards: () => null, previewable: () => false },
    '../reading/reply-files': { replyFiles: () => [] },
    '../reading/result-round': { CHECKS: new Set(), changeLabel: () => '', lastRound: () => ({ goal: '', reply: '', written: [] }) },
    './send-to-agent': { atPrompt: () => true, sendToAgent: async (...args) => { calls.sent.push(args); return send(...args); } },
    './delivery': { parseDelivery: () => null },
    '../files/file-popup': { showPopup() {} },
    '../voice/VoiceButton': { VoiceButton: () => null },
    '../voice/voice-input': { useDictatedBox() {} },
    '../../shared/i18n': { t: text => text },
    '@phosphor-icons/react': new Proxy({}, { get: () => () => null }),
  };
  const loaded = new Map();
  const load = name => {
    if (!loaded.has(name)) {
      const filename = path.join(home, name), mod = new Module(filename, module);
      mod.filename = filename; mod.paths = Module._nodeModulePaths(home);
      mod.require = request => request === 'react' ? hooks : request in neighbours ? neighbours[request]
        : request === './review-history' ? load('review-history.ts') : require(request);
      mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
      loaded.set(name, mod.exports);
    }
    return loaded.get(name);
  };
  const { ReviewCard } = load('ReviewCard.tsx'), { reviewHistory } = load('review-history.ts');
  const decision = { id: 'd1', kind: 'review', projectId: 'p1', projectName: 'Proj', terminalId: 't1', sessionId: 's1', terminalTitle: 'T', multipleTerminals: false,
    agent: 'codex', title: 'Task', context: [], choice: null, identity: null, message: '', since: 0 };
  const render = () => {
    cursor = 0;
    const root = ReviewCard({ decision, now: 1, kind: null, onOpen() {}, onDone: message => calls.done.push(message), onError: message => calls.errors.push(message) });
    while (effects.length) effects.shift()();
    return root;
  };
  const button = label => nodes(render()).find(node => node.type === 'button' && words(node) === label);
  const click = async label => { button(label).props.onClick(); await settle(); };
  const sendBack = async note => {
    await click('打回修改');
    nodes(render()).find(node => node.type === 'textarea').props.onChange({ target: { value: note } });
    await click('打回并发送批语');
  };
  return { calls, click, sendBack, history: () => reviewHistory('p1'), stored: () => store.get('agentrix.review.p1') };
}

test('passing a delivery reports a passed grade with the submission the card shows', async t => {
  const card = mountCard(t, { grade: async () => ({ ok: true, value: undefined }) });
  await card.click('通过');
  assert.deepEqual(card.calls.graded, [{ projectId: 'p1', terminalId: 't1', outcome: 'passed', submission: 1 }]);
  assert.equal(card.calls.done.length, 1);
  assert.deepEqual(card.calls.errors, []);
});

test('sending back reports the note, and the next hand-in is submission 2', async t => {
  const card = mountCard(t, { grade: async () => ({ ok: true, value: undefined }) });
  await card.sendBack('error text clearer');
  assert.deepEqual(card.calls.graded, [{ projectId: 'p1', terminalId: 't1', outcome: 'sent-back', submission: 1, note: 'error text clearer' }]);
  assert.equal(card.history().submission, 2);
  await card.click('通过');
  assert.deepEqual(card.calls.graded.at(-1), { projectId: 'p1', terminalId: 't1', outcome: 'passed', submission: 2 });
  assert.equal(card.stored(), undefined, 'passing starts the history over');
});

const failures = {
  'a rejected call': { grade: async () => { throw new Error('ipc closed'); } },
  'an error result': { grade: async () => ({ ok: false, error: 'unknown terminal' }) },
  'a call that throws at once': { grade: () => { throw new Error('bridge gone'); } },
  'a bridge without the call': {},
};
for (const [name, options] of Object.entries(failures)) {
  test(`${name} changes nothing in the review`, async t => {
    const working = mountCard(t, { grade: async () => ({ ok: true, value: undefined }) });
    await working.sendBack('again');

    const card = mountCard(t, options);
    await card.sendBack('again');
    assert.deepEqual(card.history().notes.map(note => note.text), ['again']);
    assert.equal(card.history().submission, 2);
    assert.deepEqual(card.calls.done, working.calls.done);
    assert.equal(card.calls.sent.length, 1);
    await card.click('通过');
    assert.equal(card.calls.done.length, 2);
    assert.deepEqual(card.calls.errors, []);
    assert.equal(card.stored(), undefined);
    assert.equal(card.calls.acknowledged, 2);
  });
}

test('a delivery that is not acknowledged or not sent back is not graded', async t => {
  const refused = mountCard(t, { acknowledge: async () => ({ ok: false, error: 'busy' }), grade: async () => ({ ok: true, value: undefined }) });
  await refused.click('通过');
  assert.deepEqual(refused.calls.graded, []);
  assert.deepEqual(refused.calls.errors, ['busy']);

  const unsent = mountCard(t, { send: async () => 'terminal is not at its prompt', grade: async () => ({ ok: true, value: undefined }) });
  await unsent.sendBack('fix it');
  assert.deepEqual(unsent.calls.graded, []);
  assert.deepEqual(unsent.calls.errors, ['terminal is not at its prompt']);
  assert.equal(unsent.stored(), undefined);
});
