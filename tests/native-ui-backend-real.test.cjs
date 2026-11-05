require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, opening, textBlock, finish } = require('./fixtures/claude-real.cjs');
const skip = !process.env.AGENTRIX_REAL_CLAUDE && 'set AGENTRIX_REAL_CLAUDE';
const { inputQueue } = require('../electron/features/claude-sdk/query.cjs');
const { turnResult } = require('../electron/features/claude-sdk/result.cjs');
const { createNormalizer } = require('../electron/features/claude-sdk/normalize.cjs');

test('D3 D5 real CLI local command results and identities drive completion and visible output', { skip, timeout: 60000 }, async t => {
  const f = await harness(t, data => [opening(data), ...textBlock(0, 'LOCAL COMMAND PROBE'), ...finish('end_turn')]);
  const queue = inputQueue(), options = f.options(), query = f.sdk.query({ prompt: queue, options });
  const commands = ['warmup', '/compact', '/context', '/model', '/model claude-haiku-4-5', 'control-model'];
  const rounds = commands.map(() => []); let index = 0;
  queue.push({ type: 'user', message: { role: 'user', content: commands[0] } });
  try {
    for await (const message of query) {
      rounds[index].push(message);
      if (message.type !== 'result') continue;
      if (++index === commands.length) break;
      if (commands[index] === 'control-model') {
        await query.setModel('claude-sonnet-4-5');
        queue.push({ type: 'user', message: { role: 'user', content: '/context' } });
      } else queue.push({ type: 'user', message: { role: 'user', content: commands[index] } });
    }
  } finally { options.abortController.abort(); }
  for (const [i, command] of commands.entries()) t.diagnostic(JSON.stringify({ command, records: rounds[i].filter(message =>
    message.type === 'result' || message.local_command_run || message.isReplay && message.message?.content?.startsWith?.('<local-command-stdout>'))
    .map(message => ({ type: message.type, subtype: message.subtype, isReplay: message.isReplay, local_command_run: message.local_command_run,
      local_command: message.local_command, terminal_reason: message.terminal_reason, stop_reason: message.stop_reason,
      is_error: message.is_error, model: message.message?.model })) }));
  for (const [i, command] of commands.entries()) {
    const result = rounds[i].find(message => message.type === 'result');
    assert.equal(turnResult(result).status, 'completed', `${command} successful result completes`);
    const visible = [], normalize = createNormalizer((type, payload) => { if (type === 'item.upsert' && payload.kind === 'agent-message') visible.push(payload.content.text); });
    for (const message of rounds[i]) normalize(message, { live: true });
    if (command === '/compact' || command.startsWith('/model ')) assert.deepEqual(visible, [], 'UI already reports this local command');
    if (command === '/context' || command === '/model' || command === 'control-model') assert.equal(visible.length, 1, 'read-only local command output remains visible exactly once');
  }
});
