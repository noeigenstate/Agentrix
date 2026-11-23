const { test } = require('node:test');
const assert = require('node:assert/strict');
const { leadSteps } = require('../src/features/terminal/lead-steps.ts');

// In conductor mode a changed lead seat reaches the running Claude Code as the commands the owner would type.
test('a lead seat that differs from what the CLI runs becomes /model and /effort; a match or an unknown model types nothing', () => {
  const running = { model: 'claude-opus-5-5', effort: 'medium', fast: false };
  assert.deepEqual(leadSteps({ model: 'claude-fable-5-2', effort: 'medium' }, running), [{ command: '/model claude-fable-5-2', confirm: true }]);
  assert.deepEqual(leadSteps({ model: 'claude-opus-5-5', effort: 'high' }, running), [{ command: '/effort high', confirm: false }]);
  assert.deepEqual(leadSteps({ model: 'sonnet', effort: 'low' }, running),
    [{ command: '/model sonnet', confirm: true }, { command: '/effort low', confirm: false }]);
  assert.deepEqual(leadSteps({ model: 'opus', effort: 'medium' }, running), [], 'an alias matches the release of its line');
  assert.deepEqual(leadSteps({ model: 'claude-opus-5-5[1m]', effort: 'medium' }, running), [], 'the context variant is the same model');
  assert.deepEqual(leadSteps({ model: 'claude-fable-5-2', effort: 'high' }, { model: null, effort: null, fast: null }), [], 'nothing before the first reply names the model');
  assert.deepEqual(leadSteps(null, running), []);
});
