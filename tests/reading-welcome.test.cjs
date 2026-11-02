const { test } = require('node:test');
const assert = require('node:assert/strict');
const { welcomeStarting, hasStatusFooter } = require('../src/features/reading/reading-welcome.ts');

test('welcome settles after four seconds with a parsed footer, even without banner metadata', () => {
  const screen = { banner: null, status: { model: 'Opus 5.5', effort: 'high', context: null, mode: null, notes: [] } };
  assert.equal(hasStatusFooter(screen), true);
  assert.equal(welcomeStarting(screen, 1000, 4999, true), true);
  assert.equal(welcomeStarting(screen, 1000, 5000, true), false);
  assert.equal(welcomeStarting(screen, 1000, 5000, false), true);
  assert.equal(welcomeStarting({ ...screen, banner: { product: 'Claude Code' } }, 1000, 1001, false), false);
  const blank = { banner: null, status: { model: null, effort: null, context: null, mode: null, notes: [] } };
  assert.equal(hasStatusFooter(blank), false);
  assert.equal(welcomeStarting(blank, 1000, 8000, true), false, 'a footer that scrolled away does not rearm startup');
});
