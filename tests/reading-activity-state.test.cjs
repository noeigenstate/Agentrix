const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { cliStateFor } = require('../src/features/agents/agent-screen-state.ts');

function activity(terminal, frame) {
  const filename = path.join(__dirname, '../src/features/agents/ActivityPane.tsx'), mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  const stubs = {
    '../../shared/i18n': { t: text => text }, '../../shared/model-name': require('../src/shared/model-name.ts'), '../../shared/useNow': { useNow: () => 10000 },
    '../terminal/terminal-screen.ts': { ...require('../src/features/terminal/terminal-screen.ts'), readScreen: () => frame, subscribeScreen: () => () => {} },
    '../home/send-to-agent': { sendToAgent: () => assert.fail('state display never sends input') },
    './AgentBrandIcon': require('../src/features/agents/AgentBrandIcon.ts'), './action-text': { actionText: () => 'step' },
    './ApiUsage': { ApiUsage: () => null }, './ResetCountdown': { ResetCountdown: () => null }, './reset-count': require('../src/features/agents/reset-count.ts'),
    './subagent-splits.ts': { useSplits: () => [], isSplitOpen: () => false, toggleSplit() {} },
  };
  mod.require = name => name.endsWith('.css') ? {} : name === '@phosphor-icons/react' ? new Proxy({}, { get: () => () => React.createElement('svg') }) : stubs[name] ?? original(name);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  return renderToStaticMarkup(React.createElement(mod.exports.ActivityPane, { terminal }));
}

test('the activity monitor and reading view agree on host waiting, fresh input and fresh work', () => {
  const terminal = { id: 't', sessionId: 'pty', agent: 'claude', codexActive: true, codexActivity: 'working',
    mainTurn: { state: 'working', updatedAt: 9000 }, prompts: [{ id: 'old', state: 'working', summary: 'old task', text: 'old task', at: 9000 }],
    cliState: { sessionId: 'pty', revision: 1, state: 'waiting', message: 'Approve current tool', updatedAt: 10000 } };
  const frame = { sessionId: 'pty', revision: 1, updatedAt: 9999, rows: ['────', '❯ ', '────'] };
  assert.equal(cliStateFor('claude', frame, terminal).waiting, true); assert.match(activity(terminal, frame), /Approve current tool/);
  frame.revision++; frame.updatedAt = 10001;
  assert.equal(cliStateFor('claude', frame, terminal).waiting, false);
  const idle = activity(terminal, frame); assert.doesNotMatch(idle, /Approve current tool|class="is-working"/); assert.match(idle, /本轮已完成/);
  frame.revision++; frame.updatedAt++; frame.rows.unshift('✶ Working…');
  assert.equal(cliStateFor('claude', frame, terminal).working, true); assert.match(activity(terminal, frame), /class="is-working"/);
  terminal.cliState = { ...terminal.cliState, revision: 2, state: 'idle', updatedAt: 10003 };
  assert.equal(cliStateFor('claude', frame, terminal).working, false); assert.doesNotMatch(activity(terminal, frame), /class="is-working"/);
});
