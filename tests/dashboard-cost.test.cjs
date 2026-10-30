const { test } = require('node:test');
const assert = require('node:assert/strict');
const { estimateCost } = require('../electron/features/dashboard/cost.cjs');
const shipped = require('../electron/features/dashboard/prices.json');

const row = (inputPerM, cachedInputPerM, outputPerM) => ({ inputPerM, cachedInputPerM, outputPerM, currency: 'USD', source: 'https://example.test/pricing', checkedAt: '2026-10-30' });
const prices = { updated: '2026-10-30', models: { 'claude-sonnet-5-5': row(3, 0.3, 15), 'gpt-6.1-sol': row(2, null, 8) } };
const run = (extra = {}) => ({ model: 'claude-sonnet-5-5', inputTokens: 1_000_000, cachedTokens: 2_000_000, outputTokens: 100_000, reportedCostUsd: null, ...extra });

test('a reported cost wins over any estimate, zero included', () => {
  assert.deepEqual(estimateCost(run({ reportedCostUsd: 1.25 }), prices), { usd: 1.25, basis: 'reported' });
  assert.deepEqual(estimateCost(run({ reportedCostUsd: 0 }), prices), { usd: 0, basis: 'reported' });
  assert.deepEqual(estimateCost({ model: 'unlisted', reportedCostUsd: 0.5 }, prices), { usd: 0.5, basis: 'reported' });
});

test('an estimate charges input, cache reads and output once each', () => {
  const { usd, basis } = estimateCost(run(), prices);
  assert.equal(basis, 'estimated');
  assert.ok(Math.abs(usd - (3 + 0.6 + 1.5)) < 1e-9);
});

test('zero is a reported count: a cached price is only needed when cache was read', () => {
  const none = estimateCost({ model: 'gpt-6.1-sol', inputTokens: 500_000, cachedTokens: 0, outputTokens: 0 }, prices);
  assert.equal(none.basis, 'estimated');
  assert.ok(Math.abs(none.usd - 1) < 1e-9);
  assert.deepEqual(estimateCost({ model: 'gpt-6.1-sol', inputTokens: 1, cachedTokens: 1, outputTokens: 1 }, prices), { usd: null, basis: 'unknown' });
});

test('anything unreported or unpriced is unknown, never zero', () => {
  const unknown = { usd: null, basis: 'unknown' };
  for (const missing of ['inputTokens', 'cachedTokens', 'outputTokens']) {
    assert.deepEqual(estimateCost(run({ [missing]: null }), prices), unknown, missing);
    assert.deepEqual(estimateCost(run({ [missing]: undefined }), prices), unknown, missing);
  }
  assert.deepEqual(estimateCost(run({ model: 'not-in-the-table' }), prices), unknown);
  assert.deepEqual(estimateCost(run({ model: null }), prices), unknown);
  assert.deepEqual(estimateCost(run({ inputTokens: -1 }), prices), unknown);
  assert.deepEqual(estimateCost(run(), { models: { 'claude-sonnet-5-5': row(null, null, null) } }), unknown);
  assert.deepEqual(estimateCost(run(), { models: { 'claude-sonnet-5-5': { ...row(3, 0.3, 15), currency: 'EUR' } } }), unknown);
  assert.deepEqual(estimateCost(run(), null), unknown);
  assert.deepEqual(estimateCost(null, prices), unknown);
});

test('model ids match after trimming context and date suffixes and case', () => {
  for (const model of ['claude-sonnet-5-5[1m]', 'claude-sonnet-5-5-20260101', 'claude-sonnet-5-5-20260101[1m]', ' Claude-Sonnet-5-5 ']) {
    assert.equal(estimateCost(run({ model }), prices).basis, 'estimated', model);
  }
  assert.equal(estimateCost(run({ model: 'claude-sonnet-5-5-mini' }), prices).basis, 'unknown');
  assert.equal(estimateCost(run({ model: 'claude-sonnet-5' }), prices).basis, 'unknown');
});

test('prices.json lists the routed models, and a source is present exactly when prices are', () => {
  assert.match(shipped.updated, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(Object.keys(shipped.models).sort(), ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol', 'gpt-6.1-terra']);
  for (const [id, price] of Object.entries(shipped.models)) {
    assert.deepEqual(Object.keys(price).sort(), ['cachedInputPerM', 'checkedAt', 'currency', 'inputPerM', 'outputPerM', 'source'], id);
    assert.equal(price.currency, 'USD', id);
    const rates = [price.inputPerM, price.cachedInputPerM, price.outputPerM];
    assert.ok(rates.every(rate => rate === null || (Number.isFinite(rate) && rate >= 0)), id);
    const sourced = typeof price.source === 'string' && price.source.length > 0;
    assert.equal(sourced, rates.some(rate => rate !== null), `${id}: source exactly when a price is given`);
    assert.equal(typeof price.checkedAt === 'string', sourced, `${id}: checkedAt exactly when sourced`);
  }
});
