const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { agentHarness } = require('./send-to-agent.test.cjs');

// The relay of an owner's word for a sub-agent to the planner's own terminal: main asks, this window sends the normal way and reports.
function startRelay(sendToAgent, bridge) {
  const filename = path.join(__dirname, '..', 'src', 'features', 'agents', 'parent-relay.ts');
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  mod.require = name => name === '../home/send-to-agent' ? { sendToAgent } : original(name);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { agentrix: bridge } });
  const stop = mod.exports.startParentRelay();
  return { stop, restore() { if (saved) Object.defineProperty(globalThis, 'window', saved); else delete globalThis.window; } };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const relay = (id, patch = {}) => ({ id, terminalId: 't1', sessionId: 's1', agent: 'claude', text: 'also update the docs', deadline: Date.now() + 3000, ...patch });

function bridge() {
  const results = [], hear = { listener: null, off: 0 };
  return { results, hear, onAgentRelay: listener => { hear.listener = listener; return () => { hear.off++; hear.listener = null; }; },
    agentRelayResult: async (id, error) => { results.push([id, error]); return { ok: true, value: undefined }; } };
}

test('each relay is sent to its terminal the normal way and the outcome goes back by id: null for sent, the text for an error', async () => {
  const sends = [], answers = [null, 'Handle the screen first.'], link = bridge();
  const started = startRelay(async (...args) => { sends.push(args); return answers.shift(); }, link);
  try {
    const first = relay(1), second = relay(2, { terminalId: 't2', sessionId: 's2', agent: 'codex', text: 'stop the refactor' });
    link.hear.listener(first); await settle();
    link.hear.listener(second); await settle();
    assert.deepEqual(sends, [['t1', 's1', 'claude', 'also update the docs', { preserveDraft: true, deadline: first.deadline }],
      ['t2', 's2', 'codex', 'stop the refactor', { preserveDraft: true, deadline: second.deadline }]]);
    assert.deepEqual(link.results, [[1, null], [2, 'Handle the screen first.']]);
  } finally { started.stop(); started.restore(); }
});

test('a send that throws is an error for main, never a missing answer, and stopping lets go of the listener', async () => {
  const link = bridge(), started = startRelay(async () => { throw new Error('terminal gone'); }, link);
  try {
    link.hear.listener(relay(7)); await settle();
    assert.deepEqual(link.results, [[7, 'terminal gone']]);
    started.stop();
    assert.deepEqual([link.hear.off, link.hear.listener], [1, null]);
  } finally { started.restore(); }
});

for (const agent of ['claude', 'codex']) {
  test(agent + ': a relay to a working planner with an empty input is sent and acknowledged', async t => {
    const h = agentHarness(t, agent, { working: true }), link = { ...h.bridge, ...bridge() };
    const started = startRelay(h.sendToAgent, link);
    try {
      await h.finish(link.hear.listener(relay(10, { agent })));
      assert.deepEqual(link.results, [[10, null]]); assert.deepEqual(h.received, ['also update the docs']);
      assert.deepEqual(h.writes, [['t1', '\r']]);
    } finally { started.stop(); started.restore(); }
  });
  test(agent + ': a relay received after main timed out cannot paste or submit a message', async t => {
    const h = agentHarness(t, agent), link = { ...h.bridge, ...bridge() }, request = relay(12, { agent });
    const started = startRelay(h.sendToAgent, link);
    try {
      await h.tick(3001); await h.finish(link.hear.listener(request));
      assert.equal(link.results.length, 1); assert.equal(link.results[0][0], 12); assert.match(link.results[0][1], /超时/);
      assert.deepEqual(h.pastes, []); assert.deepEqual(h.writes, []);
    } finally { started.stop(); started.restore(); }
  });
  test(agent + ': main timing out mid-loop prevents any subsequent Enter and reports the pasted input', async t => {
    const h = agentHarness(t, agent), link = { ...h.bridge, ...bridge() }, request = relay(13, { agent });
    const writesAt = [], write = link.writeTerminal;
    link.writeTerminal = (...args) => { writesAt.push(Date.now()); write(...args); };
    const started = startRelay(h.sendToAgent, link); h.input.accept = false;
    let timedOut = false;
    setTimeout(() => { timedOut = true; }, 3000);
    try {
      await h.tick(1400);
      const sending = link.hear.listener(request);
      await h.tick(400); await h.tick(700);
      assert.equal(timedOut, false); assert.equal(h.writes.length, 2);
      await h.tick(700); await sending;
      assert.equal(timedOut, true); assert.equal(h.writes.length, 2);
      assert.ok(writesAt.every(at => at <= request.deadline - 300));
      assert.equal(link.results.length, 1); assert.equal(link.results[0][0], 13); assert.match(link.results[0][1], /已粘贴.*终端/);
      assert.equal(h.input.draft, request.text); assert.deepEqual(h.received, []);
    } finally { started.stop(); started.restore(); }
  });
  for (const working of [false, true]) test(agent + ': a relay refuses a planner draft and reports the error without clearing or submitting it while ' + (working ? 'working' : 'idle'), async t => {
    const h = agentHarness(t, agent, { draft: 'keep my unfinished prompt', working }), link = { ...h.bridge, ...bridge() };
    const started = startRelay(h.sendToAgent, link);
    try {
      await link.hear.listener(relay(11, { agent }));
      assert.equal(link.results.length, 1); assert.equal(link.results[0][0], 11); assert.match(link.results[0][1], /草稿/);
      assert.equal(h.input.draft, 'keep my unfinished prompt'); assert.deepEqual(h.writes, []); assert.deepEqual(h.pastes, []);
    } finally { started.stop(); started.restore(); }
  });
}
