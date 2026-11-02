const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { parseAgentScreen } = require('../src/features/agents/agent-screen.ts');
const panel = require('../src/features/reading/cli-panel.ts');

const settle = () => new Promise(resolve => setImmediate(resolve));
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures/screens', name + '.txt'), 'utf8').split(/\r?\n/);

function agentHarness(t, agent, { draft = '', working = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const writes = [], pastes = [], received = [], input = { draft, working, rows: null, present: true, accept: true, error: null };
  const rows = () => input.rows ?? [
    ...(input.working ? [agent === 'claude' ? '✻ Working…' : '• Working (5s · esc to interrupt)'] : []),
    ...(agent === 'claude' ? ['────', '❯ ' + input.draft, '────', '  ⏸ manual mode on']
      : ['› ' + input.draft, '', '  GPT-6.1-Sol high · C:\\work\\demo']),
  ];
  const bridge = {
    writeTerminal(id, key) {
      writes.push([id, key]);
      if (key === '\x15') input.draft = '';
      if (key === '\r' && input.accept) { received.push(input.draft); input.draft = ''; }
    },
    async pasteTerminal(...args) {
      pastes.push(args);
      if (input.error) return { ok: false, error: input.error };
      input.draft += args[1]; return { ok: true };
    },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { agentrix: bridge } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; });
  const filename = path.join(__dirname, '..', 'src/features/home/send-to-agent.ts'), mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod), dependencies = {
    '../agents/agent-screen': { parseAgentScreen }, '../reading/cli-panel': panel,
    '../terminal/terminal-screen': { readScreen: () => input.present ? { rows: rows() } : null },
    '../reading/pending-prompts': require('../src/features/reading/pending-prompts.ts'),
    '../../shared/i18n': { t: text => text },
  };
  mod.require = name => dependencies[name] ?? original(name);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
  return { ...mod.exports, bridge, input, writes, pastes, received, rows,
    async tick(ms) { await settle(); t.mock.timers.tick(ms); await settle(); },
    async finish(promise) { for (const ms of [60, 400, 700, 700, 700]) { await this.tick(ms); } return promise; },
  };
}

if (require.main === module) {
  for (const agent of ['claude', 'codex']) {
    test(agent + ': a working CLI with its input drawn accepts a queued message', async t => {
      const h = agentHarness(t, agent, { working: true });
      assert.equal(panel.isAtPrompt(agent, h.rows(), parseAgentScreen(agent, h.rows())), false);
      assert.equal(await h.finish(h.sendToAgent('t1', 's1', agent, 'next task')), null);
      assert.deepEqual(h.pastes, [['t1', 'next task', 's1']]);
      assert.deepEqual(h.writes, [['t1', '\r']]); assert.deepEqual(h.received, ['next task']);
    });
    test(agent + ': an ordinary owner send still replaces the CLI draft', async t => {
      const h = agentHarness(t, agent, { draft: 'old draft' });
      assert.equal(await h.finish(h.sendToAgent('t1', 's1', agent, 'owner message')), null);
      assert.deepEqual(h.writes, [['t1', '\x15'], ['t1', '\r']]);
      assert.deepEqual(h.received, ['owner message']);
    });
    for (const working of [false, true]) test(agent + ': preserving a draft refuses before any paste, clear or Enter while ' + (working ? 'working' : 'idle'), async t => {
      const h = agentHarness(t, agent, { draft: 'unfinished owner message', working });
      const error = await h.sendToAgent('t1', 's1', agent, 'relay', { preserveDraft: true });
      assert.match(error, /草稿/); assert.equal(h.input.draft, 'unfinished owner message');
      assert.deepEqual(h.pastes, []); assert.deepEqual(h.writes, []);
    });
    test(agent + ': a draft typed while a relay waits for Enter is never submitted', async t => {
      const h = agentHarness(t, agent, { working: true });
      const sent = h.sendToAgent('t1', 's1', agent, 'relay', { preserveDraft: true });
      await settle(); assert.equal(h.pastes.length, 1); h.input.draft = 'new owner draft';
      assert.match(await h.finish(sent), /草稿/);
      assert.equal(h.input.draft, 'new owner draft'); assert.deepEqual(h.writes, []); assert.deepEqual(h.received, []);
    });
    test(agent + ': a dialog drawn after the relay paste receives no Enter', async t => {
      const h = agentHarness(t, agent, { working: true });
      const sent = h.sendToAgent('t1', 's1', agent, 'relay', { preserveDraft: true });
      await settle(); h.input.rows = fixture(agent + '-permission');
      assert.match(await h.finish(sent), /终端/); assert.deepEqual(h.writes, []);
    });
    test(agent + ': a stalled relay retries only its own message and never a newer draft', async t => {
      const h = agentHarness(t, agent, { working: true }); h.input.accept = false;
      const sent = h.sendToAgent('t1', 's1', agent, 'relay', { preserveDraft: true });
      await h.tick(400); await h.tick(700);
      assert.deepEqual(h.writes, [['t1', '\r'], ['t1', '\r']]);
      h.input.draft = 'owner took over'; await h.tick(700);
      assert.match(await sent, /草稿/); assert.equal(h.input.draft, 'owner took over');
      assert.equal(h.writes.length, 2);
    });
    test(agent + ': missing input and dialogs reject a send without writing keys', async t => {
      const h = agentHarness(t, agent);
      for (const rows of [[], ['Unknown dialog'], fixture(agent + '-permission'), fixture(agent + '-model-menu'),
        fixture(agent + '-mention'), fixture(agent + '-shortcuts')]) {
        h.input.rows = rows;
        assert.match(await h.sendToAgent('t1', 's1', agent, 'next task'), /终端/);
        assert.deepEqual(h.pastes, []); assert.deepEqual(h.writes, []);
      }
      h.input.present = false;
      assert.match(await h.sendToAgent('t1', 's1', agent, 'next task'), /终端/);
    });
    test(agent + ': a refused paste sends no Enter', async t => {
      const h = agentHarness(t, agent); h.input.error = 'session changed';
      assert.equal(await h.sendToAgent('t1', 's1', agent, 'next task', { preserveDraft: true }), 'session changed');
      assert.deepEqual(h.writes, []);
    });
  }
}
module.exports = { agentHarness };
