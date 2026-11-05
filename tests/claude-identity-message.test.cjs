const { test } = require('node:test'), assert = require('node:assert/strict');
const { startupFailure } = require('../electron/features/claude-sdk/identity.cjs');
test('startup identity failures name user and project settings separately without echoing untrusted text', () => {
  const error = startupFailure({ code: 'user_api_key_override', message: 'SECRET' });
  assert.match(error.message, /用户设置/); assert.doesNotMatch(error.message, /项目|SECRET/);
  assert.match(startupFailure({ code: 'project_api_key_override' }).message, /项目/);
});
