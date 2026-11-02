const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

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
const relay = (id, patch = {}) => ({ id, terminalId: 't1', sessionId: 's1', agent: 'claude', text: 'also update the docs', ...patch });

function bridge() {
  const results = [], hear = { listener: null, off: 0 };
  return { results, hear, onAgentRelay: listener => { hear.listener = listener; return () => { hear.off++; hear.listener = null; }; },
    agentRelayResult: async (id, error) => { results.push([id, error]); return { ok: true, value: undefined }; } };
}

test('each relay is sent to its terminal the normal way and the outcome goes back by id: null for sent, the text for an error', async () => {
  const sends = [], answers = [null, 'Handle the screen first.'], link = bridge();
  const started = startRelay(async (...args) => { sends.push(args); return answers.shift(); }, link);
  try {
    link.hear.listener(relay(1)); await settle();
    link.hear.listener(relay(2, { terminalId: 't2', sessionId: 's2', agent: 'codex', text: 'stop the refactor' })); await settle();
    assert.deepEqual(sends, [['t1', 's1', 'claude', 'also update the docs'], ['t2', 's2', 'codex', 'stop the refactor']]);
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
