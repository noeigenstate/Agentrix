const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./fixtures/claude-real.cjs');
const { rateLimits } = require('../electron/features/claude-sdk/limits.cjs');
const skip = !process.env.AGENTRIX_REAL_CLAUDE && 'real CLI runs only in CI with a throwaway profile and local stub';
for (const [name, status, type, message, code] of [
  ['credits exhausted', 400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API', 'credits_required'],
  ['final rate limit', 429, 'rate_limit_error', 'Too many requests', 'rate_limited'],
  ['account spend limit', 400, 'invalid_request_error', 'enforced_spend_limit_reached', 'spend_limit'],
]) test(`real CLI: ${name} is reported without a budget argument`, { skip, timeout: 60000 }, async t => {
  const f = await harness(t, () => ({ status, body: { type: 'error', error: { type, message } } }));
  const notices = [], argv = [], spawn = f.options().spawnClaudeCodeProcess;
  const result = await f.run({ spawnClaudeCodeProcess(options) { argv.push(options.args); return spawn(options); } }, event => {
    const observed = rateLimits(event, null, 'offline', Date.now()); if (observed?.notice) notices.push(observed.notice);
  });
  assert.equal(result.is_error, true); assert.ok(notices.some(notice => notice.code === code));
  assert.ok(argv.length > 0);
  for (const args of argv) assert.equal(args.some(arg => arg.startsWith('--max-budget-usd')), false);
  for (const notice of notices) assert.doesNotMatch(notice.message, /credit balance is too low|Too many requests|enforced_spend_limit_reached/i);
});
