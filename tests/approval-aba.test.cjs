const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const vm = require('node:vm');
const { ApprovalGuard, approvalStamp } = require('../electron/features/terminal/approval-guard.cjs');
const { registerTerminalIpc } = require('../electron/features/terminal/ipc.cjs');
const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');

const fixture = (agent, kind = 'permission') => fs.readFileSync(path.join(__dirname, `fixtures/screens/${agent}-${kind === 'menu' ? 'model-menu' : 'permission'}.txt`), 'utf8').split(/\r?\n/);
const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : React.isValidElement(node) ? [node, ...nodes(node.props.children)] : [];

function backend(agent) {
  const writes = [], handles = {}, listeners = {};
  let scheduled = 0, raw, current;
  const s = current = { sessionId: 'session', terminalId: 'aba', projectId: 'p', status: 'codex', codexActive: true, agent,
    approval: new ApprovalGuard('session'), gate: { open: 0, held: [], input: key => writes.push(key), output() {} },
    terminal: { write: key => writes.push(key) }, submissions: { write: () => false, sent: [] },
    titles: { write: () => [] }, chunks: [], bytes: 0, pending: '', seq: 0 };
  approvalStamp(s);
  registerTerminalIpc({ handle: (name, fn) => { handles[name] = fn; }, listen: (name, fn) => { listeners[name] = fn; },
    getSession: () => current, getProjectById: () => ({ id: 'p' }), scheduleState: () => scheduled++,
    applyActivity: () => assert.fail('approval must not interrupt the round'), getActiveTerminal: () => null });
  // Exercise the production raw-output callback, before its 16 ms flush. No Electron or PTY is loaded.
  const context = vm.createContext({ terminal: { onData(fn) { raw = fn; } }, s, id: 'aba', sessions: new Map([['aba', s]]),
    setTimeout: () => 1, flush() {}, onEvent() {}, store: {}, wholeThread: () => false });
  const start = main.indexOf('  terminal.onData(data => {');
  vm.runInContext(main.slice(start, main.indexOf('  terminal.onExit(', start)), context);
  return { s, writes, raw: data => raw(data), handles, listeners, scheduled: () => scheduled,
    session(value) { current = value; },
    send(key, stamp = s.approval.stamp(), actionId = 'action') { return handles['terminal:approval']('aba', key, stamp, actionId); },
    async invoke(_id, key, stamp, actionId) {
      try { return { ok: true, value: handles['terminal:approval']('aba', key, stamp, actionId) }; }
      catch (error) { return { ok: false, error: error.message }; }
    },
  };
}

// Keep the real cards mounted. Only React/DOM and terminal IO are stand-ins. A/B/A is actually drawn,
// without a React render or a 100 ms screen publication.
function cardHarness(t, agent, view = 'reading', kind = 'permission') {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const before = globalThis.window, slots = [], effects = [], errors = [], done = [], b = backend(agent), writes = b.writes;
  let cursor = 0, parsed, rows = fixture(agent, kind);
  const opened = [], approvalCalls = [];
  globalThis.window = { setTimeout, agentrix: { writeTerminal: (_id, key) => writes.push(key),
    writeApproval: (...args) => { approvalCalls.push(args); return b.invoke(...args); }, terminalFocus() {} } };
  const service = require('../src/features/terminal/terminal-screen.ts');
  const terminal = { get rows() { return rows.length; }, buffer: { active: { baseY: 0, getLine: i => ({ translateToString: () => rows[i] ?? '' }) } },
    onWriteParsed(fn) { parsed = fn; return { dispose() {} }; }, onResize() { return { dispose() {} }; },
    write(data, done) { rows = JSON.parse(data); parsed(); done?.(); } };
  const unregister = service.registerScreen('aba', terminal, 'session');
  const draw = next => {
    b.raw(JSON.stringify(next)); rows = next;
    if (service.writeScreen) service.writeScreen('aba', JSON.stringify(next), b.s.approval.stamp());
    else parsed();
  };
  draw(rows);
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; },
    useEffect(fn, deps) {
      const i = cursor++, previous = slots[i];
      if (previous && deps && deps.every((value, at) => value === previous.deps?.[at])) return;
      const slot = slots[i] = { deps, cleanup: previous?.cleanup };
      effects.push(() => { slot.cleanup?.(); slot.cleanup = fn(); });
    },
  };
  const filename = path.join(__dirname, view === 'reading' ? '../src/features/reading/ReadingChoice.tsx' : '../src/features/home/DecisionCard.tsx'), mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  mod.require = name => name === 'react' ? hooks : name === '@phosphor-icons/react' ? new Proxy({}, { get: () => () => null })
    : name.endsWith('/i18n') ? { t: text => text, currentLanguage: () => 'en' } : name === './decisions' ? { snooze() {} }
    : /ReviewCard|ReadingQuestion|NativeApprovalCard/.test(name) ? {} : name.startsWith('.') ? original(name + '.ts') : original(name);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  const choice = () => service.screenChoice(agent, service.readScreen('aba'));
  let root;
  const render = () => {
    cursor = 0; const c = choice();
    const props = { choice: c, terminalId: 'aba', agent, onShowTerminal: () => opened.push('aba'), onError: error => errors.push(error) };
    const decision = { id: `${c.approval?.instance}:${c.title}`, kind: kind === 'permission' ? 'approval' : 'choice', terminalId: 'aba', agent, choice: c,
      identity: require('../src/features/reading/choice-keys.ts').choiceIdentity(c), title: c.title, context: c.context, projectName: 'fixture' };
    root = view === 'reading' ? mod.exports.ReadingChoice(props) : mod.exports.DecisionCard({ decision, now: 1, onOpen: d => opened.push(d.terminalId), onDone: message => done.push(message), onError: props.onError });
    if (root.props.ref) root.props.ref.current = { focus() {}, querySelector() {} };
    while (effects.length) effects.shift()();
    return root;
  };
  render();
  t.after(() => { for (const slot of slots) if (typeof slot?.cleanup === 'function') slot.cleanup(); unregister(); globalThis.window = before; });
  return { service, writes, errors, done, opened, approvalCalls, root: () => root, choice, draw, render, backend: b,
    paint(next) { rows = next; parsed(); },
    async tick(ms) { for (let i = 0; i < 20; i++) await Promise.resolve(); t.mock.timers.tick(ms); for (let i = 0; i < 20; i++) await Promise.resolve(); },
    a: rows, b: rows.map(row => row.replaceAll('hello.txt', 'different.txt')),
  };
}


const terminalOnly = { mode: 'terminal-only', reason: 'native-request-identity-unavailable' };
for (const agent of ['claude', 'codex']) {
  for (const view of ['reading', 'decision']) {
    test(`${agent}/${view}: permission cards are informative, terminal-only and open their source without keys`, async t => {
      const h = cardHarness(t, agent, view), root = h.root();
      assert.equal(root.props['data-approval-mode'], 'terminal-only');
      assert.ok(nodes(root).some(n => n.type === 'pre' && n.props.children.includes('hello.txt')));
      const options = nodes(root).filter(n => (n.type === 'button' && /reading-choice-option/.test(n.props.className)) || n.type === 'input');
      // The decision card lists the terminal's options as plain text; the reading card shows them disabled.
      if (view === 'decision') { assert.equal(options.length, 0); assert.ok(nodes(root).filter(n => n.type === 'li').length > 0); }
      else { assert.ok(options.length > 0); assert.ok(options.every(n => n.props.disabled)); }
      assert.ok(nodes(root).some(n => n.props.children === 'Confirm or reject this request in the source terminal. Permission cards cannot safely send approval keys.'));
      const open = nodes(root).find(n => n.props['data-approval-open-terminal']);
      assert.ok(open); open.props.onClick(); assert.deepEqual(h.opened, ['aba']);
      // Retain the mounted A's callbacks, then draw B and byte-identical A without publication.
      const held = nodes(root).filter(n => n.props.disabled && n.props.onClick).map(n => n.props.onClick);
      if (view === 'reading') for (const key of ['Enter', 'Escape', 'ArrowUp', 'ArrowDown', '1', '2', '3']) {
        root.props.onKeyDown({ key, nativeEvent: {}, preventDefault() {}, stopPropagation() {} });
      }
      for (const n of nodes(root).filter(n => n.type === 'input')) n.props.onChange();
      h.draw(h.b); h.draw(h.a);
      for (const callback of held) callback();
      h.render();
      for (const n of nodes(h.root()).filter(n => n.props.disabled && n.props.onClick)) n.props.onClick();
      if (view === 'reading') for (const key of ['Enter', 'Escape', 'ArrowUp', 'ArrowDown', '1']) {
        root.props.onKeyDown({ key, nativeEvent: {}, preventDefault() {}, stopPropagation() {} });
        h.root().props.onKeyDown({ key, nativeEvent: {}, preventDefault() {}, stopPropagation() {} });
      }
      await h.tick(100);
      assert.deepEqual(h.writes, []); assert.deepEqual(h.done, []); assert.deepEqual(h.approvalCalls, []);
    });
    test(`${agent}/${view}: ordinary model menus remain interactive`, async t => {
      const h = cardHarness(t, agent, view, 'menu'), choice = h.choice();
      assert.equal(choice.kind, 'menu');
      assert.equal(h.root().props['data-approval-mode'], undefined);
      const selected = Math.max(0, choice.options.findIndex(option => option.selected));
      if (view === 'reading') {
        nodes(h.root()).filter(n => n.type === 'button' && /reading-choice-option/.test(n.props.className))[selected].props.onClick();
      } else {
        nodes(h.root()).filter(n => n.type === 'input')[selected].props.onChange(); h.render();
        nodes(h.root()).find(n => n.props.className === 'button primary').props.onClick();
      }
      await h.tick(100);
      assert.deepEqual(h.writes, ['\r']); assert.deepEqual(h.errors, []); assert.deepEqual(h.approvalCalls, []);
    });
  }
  test(`${agent}: retained permission dispatch rejects all targets even with fresh, absent or fabricated identity`, async t => {
    const h = cardHarness(t, agent), { writeApprovalAction } = require('../src/features/reading/approval-action.ts');
    const held = h.choice();
    for (const choice of [held, { ...held, approval: undefined }, { ...held, approval: { instance: 999, stamp: { sessionId: 'fake-native-request', revision: 1 } } }]) {
      for (const target of [0, 1, 2, 'cancel', -1, 999]) {
        assert.deepEqual(await writeApprovalAction('aba', agent, choice, target, () => true), terminalOnly);
      }
    }
    h.draw(h.b); h.draw(h.a);
    assert.deepEqual(await writeApprovalAction('aba', agent, held, 0, () => true), terminalOnly);
    assert.deepEqual(await writeApprovalAction('aba', agent, h.choice(), 'cancel', () => true), terminalOnly);
    await h.tick(100); assert.deepEqual(h.writes, []); assert.deepEqual(h.approvalCalls, []);
  });
  test(`${agent}: backend independently returns terminal-only for every key, identity, gate and session state`, () => {
    const h = backend(agent);
    const states = [h.s, { ...h.s, approvalRemote: true }, { ...h.s, gate: { open: 1, held: ['pending'] } }, { ...h.s, status: 'exited' }, { ...h.s, status: 'starting' }, { ...h.s, approval: undefined }, null];
    for (const state of states) {
      h.session(state);
      for (const key of ['\r', '\x1b', '\x1b[A', '\x1b[B', 'y', '1', '\r\r', '\x1b[B\r', 'echo hello\r']) {
        for (const identity of [undefined, null, {}, h.s.approval.stamp(), { requestId: 'fake', sessionId: 'session', turnId: 'fake', revision: 1 }]) {
          assert.deepEqual(h.handles['terminal:approval']('aba', key, identity, 'fake-request-id'), terminalOnly);
        }
      }
    }
    assert.deepEqual(h.writes, []); assert.equal(h.scheduled(), 0);
  });
  test(`${agent}: unobserved and coalesced A/B/A cannot authorize a card; manual terminal keys still work`, () => {
    const h = backend(agent), old = h.s.approval.stamp(), a = fixture(agent).join('\n');
    // No native identity exists: even a completely invisible replacement must be safe.
    for (const stamp of [old, { ...old }]) assert.deepEqual(h.send('\r', stamp), terminalOnly);
    h.raw(a.replaceAll('hello.txt', 'different.txt') + a);
    assert.equal(h.s.approval.matches(old), false, 'raw output still invalidates observation stamps');
    for (const key of ['\r', '\x1b', '\x1b[A', '\x1b[B']) assert.deepEqual(h.send(key, old), terminalOnly);
    assert.deepEqual(h.writes, []);
    for (const key of ['manual text', '\x1b[A', '\x1b[B', '\r', '\x1b']) h.listeners['terminal:write']('aba', key);
    assert.deepEqual(h.writes, ['manual text', '\x1b[A', '\x1b[B', '\r', '\x1b']);
    h.listeners['terminal:write']('aba', 'sign-in-code', true);
    assert.equal(h.writes.at(-1), 'sign-in-code');
    h.s.approvalRemote = true; h.listeners['terminal:write']('aba', 'manual SSH input');
    assert.equal(h.writes.at(-1), 'manual SSH input');
  });
  test(`${agent}: parsed A/B/A and A/absent/A retain distinct observation instances`, t => {
    const h = cardHarness(t, agent), first = h.choice();
    h.paint(h.b); h.paint(h.a);
    assert.equal(h.choice().approval.stamp.revision, first.approval.stamp.revision);
    assert.notEqual(h.choice().approval.instance, first.approval.instance);
    const second = h.choice(); h.paint([]); h.paint(h.a);
    assert.notEqual(h.choice().approval.instance, second.approval.instance);
  });
  test(`${agent}: raw repaint, manual input, resize and live binding still invalidate observation epochs`, t => {
    const h = cardHarness(t, agent), first = h.choice();
    h.paint(h.a); assert.deepEqual(h.choice().approval, first.approval);
    h.draw(h.a);
    assert.equal(h.choice().approval.instance, first.approval.instance);
    assert.notEqual(h.choice().approval.stamp.revision, first.approval.stamp.revision);
    const b = h.backend, guard = b.s.approval, beforeInput = guard.stamp();
    b.listeners['terminal:write']('aba', 'manual'); assert.equal(guard.matches(beforeInput), false);
    b.s.terminal.resize = () => {};
    const beforeResize = guard.stamp(); b.listeners['terminal:resize']('aba', 80, 24);
    assert.equal(guard.matches(beforeResize), false);
    for (const change of [{ sessionId: 'next' }, { agent: agent === 'codex' ? 'claude' : 'codex' }, { rootThreadId: 'next-thread' }]) {
      const before = approvalStamp(b.s); Object.assign(b.s, change); approvalStamp(b.s);
      assert.equal(guard.matches(before), false);
    }
  });
  test(`${agent}: production activity identity catches session/turn ABA and ignores duplicate observations`, () => {
    const h = backend(agent), s = h.s;
    Object.assign(s, { activitySince: 0, activityInputAt: 0, promptQueue: {} });
    const context = vm.createContext({ sessions: new Map([['aba', s]]), summarizeTask: () => '',
      store: { setRestore() {} }, broadcast() {} });
    const start = main.indexOf('function applyActivity(');
    vm.runInContext(main.slice(start, main.indexOf('// Claude Code hooks:', start)), context);
    const observe = (threadId, turnId) => context.applyActivity({ id: 'p' }, s, { threadId, turnId, state: 'working', updatedAt: 100 });
    observe('thread-A', 'turn-A'); const first = s.approval.stamp();
    observe('thread-A', 'turn-A'); assert.deepEqual(s.approval.stamp(), first);
    observe('thread-A', 'turn-B'); observe('thread-A', 'turn-A');
    assert.throws(() => h.s.approval.send(first, '\r', 'old', key => h.writes.push(key)), /审批操作已失效/);
    const second = s.approval.stamp();
    observe('thread-B', 'turn-A'); observe('thread-A', 'turn-A');
    assert.throws(() => h.s.approval.send(second, '\r', 'old', key => h.writes.push(key)), /审批操作已失效/); assert.deepEqual(h.writes, []);
  });
}

test('observation guard still rejects stale epochs, competing transactions and consumed final stamps', () => {
  const guard = new ApprovalGuard('session'), writes = [], write = key => writes.push(key), old = guard.stamp();
  guard.invalidate(); assert.throws(() => guard.send(old, '\r', 'a', write), /\u5ba1\u6279\u64cd\u4f5c\u5df2\u5931\u6548/);
  const fresh = guard.stamp(); guard.send(fresh, '\x1b[B', 'a', write);
  assert.throws(() => guard.send(fresh, '\r', 'b', write), /\u53e6\u4e00\u9879\u5ba1\u6279/);
  guard.send(fresh, '\r', 'a', write);
  assert.throws(() => guard.send(fresh, '\r', 'a', write), /\u5ba1\u6279\u64cd\u4f5c\u5df2\u5931\u6548/);
  assert.deepEqual(writes, ['\x1b[B', '\r']);
  for (const malformed of [undefined, null, {}, { sessionId: 'other', revision: guard.revision }, { sessionId: 'session', revision: NaN }, { sessionId: 'session', revision: '1' }]) {
    assert.equal(guard.matches(malformed), false);
  }
});

test('Decide Open terminal switches the source terminal after accepted navigation, without sending input', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8').replace(/\r\n/g, '\n'), start = source.indexOf('  const openDecision =');
  const body = source.slice(start, source.indexOf('\n\n', start)).replace('const openDecision =', 'globalThis.openDecision =');
  const calls = [], frames = [];
  let accepted = true;
  const context = vm.createContext({ useCallback: fn => fn, focusProject: async id => { calls.push(['project', id]); return accepted; },
    setReading: (...args) => calls.push(['reading', ...args]), focusTerminalWhenReady: id => calls.push(['focus', id]), requestAnimationFrame: fn => frames.push(fn) });
  vm.runInContext(ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const decision = { kind: 'approval', projectId: 'project', terminalId: 'source-split' };
  context.openDecision(decision); await Promise.resolve();
  assert.deepEqual(calls, [['project', 'project'], ['reading', 'source-split', false]]);
  assert.equal(frames.length, 1); frames.shift()(); assert.deepEqual(calls.at(-1), ['focus', 'source-split']);
  calls.length = 0; accepted = false; context.openDecision(decision); await Promise.resolve();
  assert.deepEqual(calls, [['project', 'project']]); assert.deepEqual(frames, []);
  calls.length = 0; accepted = true; context.openDecision({ ...decision, kind: 'signin' }); await Promise.resolve();
  assert.deepEqual(calls, [['project', 'project']]); assert.deepEqual(frames, []);
});
test('queued ordinary input still invalidates observation epochs at InputGate release', () => {
  const { InputGate, isTerminalResponse } = require('../electron/terminal-input.cjs');
  const h = backend('codex'), s = h.s;
  const context = vm.createContext({ s, id: 'aba', sessions: new Map([['aba', s]]), terminal: s.terminal, InputGate, isTerminalResponse });
  const start = main.indexOf('  s.gate = new InputGate(');
  vm.runInContext(main.slice(start, main.indexOf('  s.promptQueue =', start)), context);
  s.gate.afterPrompt('queued-input'); const before = s.approval.stamp();
  assert.deepEqual(h.send('\r', before), terminalOnly);
  s.gate.release(); assert.equal(s.approval.matches(before), false);
  assert.deepEqual(h.writes, ['queued-input']); s.gate.dispose();
});

test('xterm pending writes and late callbacks cannot bind a new epoch to stale rows or a remounted terminal', t => {
  const service = require('../src/features/terminal/terminal-screen.ts'), before = globalThis.window;
  globalThis.window = { setTimeout };
  let rows = fixture('codex'), parsed; const queued = [];
  const terminal = { get rows() { return rows.length; }, buffer: { active: { baseY: 0, getLine: i => ({ translateToString: () => rows[i] ?? '' }) } },
    onWriteParsed(fn) { parsed = fn; return { dispose() {} }; }, onResize() { return { dispose() {} }; }, write(data, done) { queued.push({ data, done }); } };
  const off = service.registerScreen('queue', terminal, 'one');
  service.writeScreen('queue', 'first', { sessionId: 'one', revision: 1 });
  service.writeScreen('queue', 'second', { sessionId: 'one', revision: 2 });
  assert.equal(service.readScreen('queue').approval, null);
  queued[0].done(); parsed(); assert.equal(service.readScreen('queue').approval, null);
  queued[1].done(); parsed(); assert.deepEqual(service.readScreen('queue').approval, { sessionId: 'one', revision: 2 });
  const first = service.screenChoice('codex', service.readScreen('queue'));
  service.writeScreen('queue', 'stale', { sessionId: 'one', revision: 3 });
  off(); const again = service.registerScreen('queue', terminal, 'two'); t.after(again);
  queued[2].done();
  assert.equal(service.readScreen('queue').approval, null);
  assert.notEqual(service.screenChoice('codex', service.readScreen('queue')).approval.instance, first.approval.instance);
  t.after(() => { globalThis.window = before; });
});
