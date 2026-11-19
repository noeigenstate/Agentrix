const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clean, cleanStored, checkReview, levers, makeRows, resolve } = require('../electron/features/skills/operation-slots.cjs');
const { catalog } = require('../electron/features/skills/model-seats.cjs');
const { LOOKUP_AGENT } = require('../electron/features/claude-sdk/lookup-agent.cjs');

const installed = { claude: true, codex: true };
const models = catalog(installed, [
  { model: 'claude-haiku-5-5', alias: 'haiku' }, { model: 'claude-sonnet-5-5', alias: 'sonnet' },
  { model: 'gpt-6.2-sol', efforts: ['medium', 'high'] }, { model: 'gpt-6.3-sol' },
  { model: 'gpt-6.9-mini' }, { model: 'gpt-6.10-mini' }, { model: 'gpt-6.11-mini', listed: false },
]);
const choice = model => ({ model });

test('operation defaults leave the environment and config empty and keep the existing lookup preset', () => {
  const defaults = levers({}, {}, models, installed);
  assert.deepEqual(defaults.values, { lookup: { model: 'haiku', effort: 'high' }, background: choice('haiku'), subagent: 'follow', memory: 'follow', review: 'follow' });
  assert.deepEqual(defaults.claude, { env: {}, lookupAgent: { model: LOOKUP_AGENT.model, effort: LOOKUP_AGENT.effort } });
  assert.deepEqual(defaults.codex, { config: {} });
  const rows = makeRows(defaults, models);
  assert.deepEqual(rows.filter(row => row.editable).map(row => row.id), ['lookup', 'background', 'subagent', 'memory', 'review']);
  assert.deepEqual(rows.filter(row => !row.editable).map(row => row.id), ['compaction', 'titles']);
  assert.equal(rows.find(row => row.id === 'memory').suggestion, 'gpt-6.10-mini');
  assert.equal(makeRows(defaults, models.filter(row => row.rank === 3)).find(row => row.id === 'memory').suggestion, undefined);
});

test('operation validation identifies each invalid slot and preserves other stored choices', () => {
  for (const [slot, value, code] of [
    ['unknown', choice('haiku'), 'unknown-operation'], ['lookup', choice('-invalid'), 'invalid-model'],
    ['lookup', { model: 'gpt-6.2-sol', effort: 'low' }, 'invalid-effort'],
    ['subagent', { model: 'sonnet', effort: 'high' }, 'invalid-effort'],
    ['background', choice('gpt-6.2-sol'), 'family-not-allowed'], ['review', choice('opus'), 'family-not-allowed'],
    ['lookup', 'follow', 'follow-not-allowed'], ['background', 'follow', 'follow-not-allowed'],
  ]) assert.throws(() => clean({ [slot]: value }, models), { operation: slot, code });
  assert.deepEqual(clean({ lookup: { model: 'gpt-custom', effort: 'xhigh' }, subagent: 'follow' }, models),
    { lookup: { model: 'gpt-custom', effort: 'xhigh' }, subagent: 'follow' });
  assert.deepEqual(cleanStored({ lookup: { model: '-bad' }, background: choice('sonnet'), invalid: 'follow', memory: 'follow' }),
    { background: choice('sonnet'), memory: 'follow' });
});

test('background override resolves its aliases and pins Haiku lookup only when a concrete Haiku is listed', () => {
  const values = { background: choice('sonnet'), subagent: choice('haiku') };
  const active = levers(values, {}, models, installed);
  assert.deepEqual(active.claude, { lookupAgent: { model: 'claude-haiku-5-5', effort: 'high' },
    env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-sonnet-5-5', CLAUDE_CODE_SUBAGENT_MODEL: 'claude-haiku-5-5' } });
  const missing = levers(values, {}, models.filter(row => row.model !== 'claude-haiku-5-5'), installed);
  assert.equal(missing.pinnedHaiku, undefined);
  assert.equal(missing.claude.lookupAgent.model, 'haiku');
  assert.deepEqual(missing.claude.env, { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' });
  assert.deepEqual(missing.agents.background.claude, { state: 'not-effective', reason: 'No concrete Haiku version is listed.' });
});

test('review follows the Codex reviewer and enforces independence for explicit overrides', () => {
  const developer = choice('gpt-6.2-sol'), reviewer = choice('gpt-6.3-sol');
  const seats = { developer, reviewer };
  assert.equal(checkReview(resolve(), seats, models), null);
  assert.equal(levers({}, seats, models, installed).codex.config.review_model, reviewer.model);
  assert.deepEqual(levers({}, { ...seats, reviewer: choice('opus') }, models, installed).codex.config, {});
  const explicit = { review: developer };
  assert.deepEqual(checkReview(explicit, seats, models), {
    ok: false, code: 'review-same-model', operation: 'review',
    message: 'Choose a reviewer different from developer when another available model is at least as strong.',
  });
  assert.equal(checkReview(explicit, seats, models.filter(row => row.model === developer.model)), null);
  const values = { lookup: reviewer, subagent: { ...developer, effort: 'medium' }, memory: choice('gpt-6.10-mini'), review: reviewer };
  const active = levers(values, seats, models, installed);
  assert.deepEqual(active.claude, { env: {} });
  assert.deepEqual(active.codex.config, {
    'agents.default_subagent_model': developer.model, 'agents.default_subagent_reasoning_effort': 'medium',
    'memories.extract_model': 'gpt-6.10-mini', 'memories.consolidation_model': 'gpt-6.10-mini', review_model: reviewer.model,
  });
});
