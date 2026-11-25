const { createUsageHost } = require('../electron/features/agents/usage-host.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resetCreditMessage } = require('../electron/features/agents/codex-account-usage.cjs');

test('real terminal composition reports reset in the conversation, never writes PTY input, and honors SSH/off/stale bindings', async () => {
  const project = {}, messages = []; let calls = 0, enabled = true;
  const terminal = { terminalId: 't', agent: 'codex', cliActive: true, conversation: { put: entry => messages.push(entry) }, terminal: { write() { assert.fail('must not type after reset'); } } };
  const context = { sessions: new Map([['t', terminal]]), nativeSessions: { getSettings: () => ({ codexAutoReset: enabled }) },
    codexAccounts: { resetAtLimit: async () => { calls++; return { status: 'redeemed', confirmed: true, remaining: 2 }; } },
    resetCreditMessage, t: (text, values) => text.replace('{n}', values?.n), randomUUID: () => 'notice', Date, scheduleState() {}, report: error => { throw error; } };
  const { resetTerminalCodex } = createUsageHost(context);
  await resetTerminalCodex(project, terminal, {});
  assert.equal(calls, 1); assert.equal(messages.length, 1); assert.match(messages[0].text, /还剩 2 次/);
  enabled = false; await resetTerminalCodex(project, terminal, {});
  enabled = true; await resetTerminalCodex({ kind: 'ssh' }, terminal, {});
  context.sessions.clear(); await resetTerminalCodex(project, terminal, {});
  assert.equal(calls, 1);
});
