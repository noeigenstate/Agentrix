const { hookHarness } = require('./hook-harness.cjs');
const { elements, stubGlobals } = require('./renderer-fixtures.cjs');

function quotaView(t) {
  const noop = () => {}, commands = [], sends = [];
  const ResetCountdown = () => null;
  const view = hookHarness('src/features/agents/ResetQuota.tsx', {
    '@phosphor-icons/react': { ArrowCounterClockwise: noop },
    './i18n': { t: text => text },
    './terminal-screen.ts': { readScreen: noop, subscribeScreen: () => noop },
    './send-to-agent': { sendToAgent: async (...args) => { sends.push(args); } },
    './ResetCountdown': { ResetCountdown },
    './reset-count': require('../../src/features/agents/reset-count.ts'),
  });
  t.after(() => view.dispose());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  stubGlobals(t, { window: {
    setTimeout: (...args) => setTimeout(...args),
    dispatchEvent(event) { commands.push(event); return !event.defaultPrevented; },
  } });
  const terminal = { id: 'terminal', agent: 'codex', cliActive: true, sessionId: 'session', agentUsage: { resets: { left: 2 } } };
  const render = () => elements(view.render('ResetQuota', { terminal }).result);
  return {
    commands, sends, render, row: () => render().find(node => node.type === 'button'),
    countdown: () => render().find(node => node.type === ResetCountdown),
    tick() { t.mock.timers.tick(1000); render(); },
  };
}

module.exports = { quotaView };
