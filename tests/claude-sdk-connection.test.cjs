const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createConnectionTest, listModels } = require('../electron/features/claude-sdk/connection.cjs');
const key = 'sk-ant-api03-offline-connection-only';
function http(statusCode, body = { data: [{ id: 'claude-test-model' }] }) {
  const calls = [];
  return { calls, request(url, options, callback) {
    calls.push({ url, options });
    const request = new EventEmitter(); request.destroy = () => {}; request.end = () => queueMicrotask(() => {
      const response = new PassThrough(); response.statusCode = statusCode; callback(response); response.end(JSON.stringify(body));
    }); return request;
  } };
}
for (const [code, expected] of [[200, 'ok'], [401, 'invalid'], [403, 'forbidden'], [429, 'rate_limited'], [500, 'error']]) {
  test(`connection test maps HTTP ${code} to ${expected} without returning error content`, { timeout: 1000 }, async () => {
    const fake = http(code, code === 200 ? undefined : { error: { message: key, headers: { authorization: key } } });
    const check = createConnectionTest({ credentials: { read: () => key }, inspectCli: async () => ({ status: 'ok', version: '2.1.317', required: '2.1.317' }), request: fake.request });
    assert.equal(fake.calls.length, 0);
    const value = await check(); assert.equal(value.key.status, expected);
    assert.ok(value.key.latencyMs >= 0); assert.ok(!JSON.stringify(value).includes(key));
    assert.equal(fake.calls[0].url, 'https://api.anthropic.com/v1/models?limit=100');
    assert.equal(fake.calls[0].options.method, 'GET'); assert.equal(fake.calls[0].options.headers['x-api-key'], key);
    assert.deepEqual(value.models, code === 200 ? ['claude-test-model'] : null);
  });
}
test('missing keys never issue a request, and CLI status still gets checked', async () => {
  const check = createConnectionTest({ credentials: { read: () => null, status: () => ({ saved: false }) },
    request: () => assert.fail('unexpected HTTP'), inspectCli: async () => ({ status: 'too_old', version: '2.1.316', required: '2.1.317' }) });
  const value = await check(); assert.equal(value.key.status, 'missing'); assert.equal(value.key.latencyMs, null); assert.equal(value.cli.status, 'too_old');
});
test('network errors and a silent peer settle without exposing exception messages', { timeout: 1000 }, async () => {
  for (const fail of [true, false]) {
    let destroyed = false;
    const result = await listModels(key, { timeoutMs: 20, request() {
      const req = new EventEmitter(); req.destroy = () => { destroyed = true; };
      req.end = () => { if (fail) queueMicrotask(() => req.emit('error', new Error(key))); }; return req;
    } });
    assert.deepEqual(result, { status: 'unreachable', models: null }); assert.equal(destroyed, true);
  }
});
test('malformed and oversized model lists never return reflected credentials', { timeout: 1000 }, async () => {
  for (const body of [{ data: [{ id: key }] }, { data: [{ id: 'x'.repeat(300000) }] }, { arbitrary: key }]) {
    const value = await listModels(key, { request: http(200, body).request });
    assert.equal(value.status, 'error'); assert.ok(!JSON.stringify(value).includes(key));
  }
});
test('concurrent clicks coalesce and the reported latency excludes CLI inspection', async () => {
  let time = 10, inspections = 0;
  const fake = http(200), request = (...args) => { time = 25; return fake.request(...args); };
  const check = createConnectionTest({ credentials: { read: () => key }, request, now: () => time,
    inspectCli: async () => { inspections++; time = 100; return { status: 'ok', version: '2.1.317', required: '2.1.317' }; } });
  const [first, second] = await Promise.all([check(), check()]);
  assert.equal(fake.calls.length, 1); assert.equal(inspections, 1); assert.deepEqual(first, second);
  assert.equal(first.key.latencyMs, 15);
});
