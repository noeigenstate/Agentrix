// R2: the resolver holds each fact with its scope, fingerprint and expiry (I2), and starts nothing itself (I6). Fakes
// only: injected clocks, timers and stats, temporary homes; no real API, CLI or ~/.claude.
require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createResolver, settingsChain, testFacts, overlay } = require('../electron/features/claude-runtime/resolver.cjs');
const { decide } = require('../electron/features/claude-runtime/decide.cjs');
const { routeFixture } = require('./fixtures/claude-route.cjs');

const root = path.join(__dirname, '..');
const codes = facts => facts.map(value => value.reason.code);
// A clock and timers the test moves by hand.
function clock() {
  let time = 1000; const pending = new Set();
  return { now: () => time, advance: ms => { time += ms; }, timers: { setTimeout: (run, ms) => { const timer = { run, at: time + ms }; pending.add(timer); return timer; },
    clearTimeout: timer => pending.delete(timer) }, fire: () => { for (const timer of [...pending]) if (timer.at <= time) { pending.delete(timer); timer.run(); } } };
}
const resolverOf = (fields = {}) => createResolver({ keySaved: () => true, inspectCli: async () => ({ status: 'ok', version: '2.1.318' }), ...fields });

test('N1: changing only ~/.claude/settings.json makes the next new session decide again', async t => {
  const f = routeFixture(t, { billing: '/login managed key' });
  assert.equal((await f.native.testConnection('p')).billing.status, 'mismatch');
  assert.equal((await f.newSession('before')).path, 'terminal', 'the refusal is held for the project');
  // The owner fixes the user settings: the key, the run mode and the CLI are as they were.
  fs.mkdirSync(path.join(f.home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(f.home, '.claude', 'settings.json'), '{}');
  assert.equal(f.runtime.apiState('p').status, 'ready');
  assert.equal((await f.newSession('after')).path, 'api');
});

test('N2: billing follows its fingerprint, and a test without a project lets every project check again', async t => {
  const f = routeFixture(t, { billing: '/login managed key' });
  await f.native.testConnection('p'); await f.native.testConnection('other');
  for (const project of ['p', 'other']) assert.equal(f.runtime.apiState(project).status, 'billing_identity_mismatch');
  assert.equal(f.runtime.apiState('third').status, 'ready', 'billing is each project’s own');
  // A project's own settings file is part of its fingerprint too.
  fs.mkdirSync(path.join(f.project, '.claude')); fs.writeFileSync(path.join(f.project, '.claude', 'settings.local.json'), '{}');
  for (const project of ['p', 'other']) assert.equal(f.runtime.apiState(project).status, 'ready');
  await f.native.testConnection('p'); await f.native.testConnection('other');
  f.billing('ANTHROPIC_API_KEY');
  assert.equal((await f.native.testConnection()).billing.status, 'ok', 'the test with no project open passes');
  for (const project of ['p', 'other']) {
    assert.equal(f.runtime.apiState(project).status, 'ready', `${project} checks again on its next new session`);
    assert.equal((await f.native.usage(project)).agents.claude.next.path, 'api');
  }
});

test('credits belong to the key: cleared by success, a test or a new key, with one ten-minute trial', () => {
  const time = clock(); let version = 0;
  const resolver = resolverOf({ now: time.now, timers: time.timers, keyVersion: () => version });
  const refuse = () => resolver.observe({ kind: 'failure', scope: 'p', code: 'credits_exhausted', message: 'console balance', observed: resolver.generation() });
  refuse();
  for (const project of ['p', 'q', '']) assert.deepEqual(codes(resolver.facts(project)), ['claude.credits_exhausted'], `${project} meets the key's limit`);
  assert.equal(decide(resolver.facts('q')).path, 'terminal');
  assert.equal(decide(resolver.facts('q'), {}, { owner: 'dispatch' }).path, 'api', 'a worker is not stopped by the owner’s credits');
  assert.equal(resolver.claimTrial(), null, 'no trial within ten minutes');
  time.advance(600000);
  const trial = resolver.claimTrial();
  assert.equal(typeof trial, 'string'); assert.equal(resolver.claimTrial(), null, 'one trial at a time');
  assert.equal(decide(resolver.facts('q'), {}, { trial }).path, 'api'); assert.equal(decide(resolver.facts('q')).path, 'terminal');
  resolver.observe({ kind: 'identity', scope: 'q', observed: resolver.generation() });
  assert.equal(resolver.facts('q').length, 1, 'Claude Code reporting the key is not proof the account can pay');
  resolver.observe({ kind: 'success', scope: 'q', observed: resolver.generation() });
  assert.deepEqual(resolver.facts('p'), [], 'a turn the provider accepted ends the limit everywhere');
  refuse(); resolver.observe({ kind: 'identity', scope: 'p', observed: resolver.generation(), tested: true });
  assert.deepEqual(resolver.facts('p'), [], 'so does a passing connection test');
  refuse(); version++;
  assert.deepEqual(resolver.facts('p'), [], 'another key is another account');
});

test('one fingerprint, one check: concurrent resolves share it, and an unknown billing result is never held', async () => {
  let checks = 0; const stats = new Map();
  const stat = file => { if (!stats.has(file)) throw Object.assign(new Error('absent'), { code: 'ENOENT' }); return stats.get(file); };
  const resolver = resolverOf({ stat, inspectCli: async () => { checks++; return { status: 'ok', version: '2.1.318' }; } });
  const spec = { cwd: path.join(root, 'project'), env: { HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home') } };
  resolver.observe({ kind: 'failure', scope: 'p', code: 'billing_identity_mismatch', message: 'another credential', observed: resolver.generation(), spec });
  await Promise.all([resolver.refresh(), resolver.refresh(), resolver.refresh()]);
  assert.equal(checks, 1, 'three resolves while one check runs share it');
  await resolver.refresh(); assert.equal(checks, 2, 'a later one checks again');
  // The fingerprint is the settings chain: a file that appears or changes anywhere on it ends the fact.
  assert.deepEqual(codes(resolver.facts('p')), ['claude.billing_identity_mismatch']);
  stats.set(settingsChain(spec).at(-1), { size: 2, mtimeMs: 5 });
  assert.deepEqual(resolver.facts('p'), []);
  await resolver.refresh(); assert.equal(checks, 2, 'with no billing refusal held there is nothing to look at again');
  for (const code of ['billing_unconfirmed', 'sdk_startup_failed', 'sdk_initialization_timeout', 'sdk_failed']) {
    resolver.observe({ kind: 'failure', scope: 'q', code, observed: resolver.generation(), spec });
  }
  assert.deepEqual(resolver.facts('q'), [], 'a billing answer that could not be read is not a fact');
  const tested = overlay(resolver.facts('q'), testFacts({ key: { status: 'ok' }, cli: { status: 'ok' }, billing: { status: 'unknown' } }));
  assert.deepEqual(codes(tested), ['claude.billing_unconfirmed'], 'the test that saw it says so for its own answer');
  assert.deepEqual(resolver.facts('q'), []);
});

test('a final rate limit holds only its card for a minute', () => {
  const time = clock(), resolver = resolverOf({ now: time.now, timers: time.timers });
  let told = 0; resolver.subscribe(() => { told++; });
  resolver.observe({ kind: 'failure', scope: 'p', code: 'rate_limited', observed: resolver.generation(), card: 'A' });
  assert.deepEqual(codes(resolver.facts('p', 'A')), ['claude.rate_limited']);
  assert.deepEqual(resolver.facts('p', 'B'), [], 'another card in the project keeps the API');
  assert.deepEqual(resolver.facts('p'), [], 'and so does a new session');
  resolver.observe({ kind: 'failure', scope: 'p', code: 'rate_limited', observed: resolver.generation() });
  assert.equal(told, 1, 'a rate limit with no card holds nothing');
  time.advance(59999); time.fire(); assert.equal(resolver.facts('p', 'A').length, 1); assert.equal(told, 1);
  time.advance(1); time.fire();
  assert.deepEqual(resolver.facts('p', 'A'), []); assert.equal(told, 2, 'the end of the minute itself is told');
});

test('the resolver starts no session, spends no tokens and writes no user file', () => {
  for (const file of ['resolver.cjs', 'facts.cjs', 'decide.cjs']) {
    const source = fs.readFileSync(path.join(root, 'electron/features/claude-runtime', file), 'utf8');
    const required = [...source.matchAll(/require\('([^']+)'\)/g)].map(match => match[1]);
    for (const name of required) assert.ok(['node:fs', 'node:path', 'node:crypto', './facts.cjs', '../../shared/reason.cjs'].includes(name), `${file} requires ${name}`);
    assert.doesNotMatch(source, /\b(?:writeFile|appendFile|mkdir|rmSync|unlink|rename|spawn|execFile|fork|loadSdk|credentials\.read|query\()/, file);
  }
  // Every observation it takes changes only what it holds: its only reach outside is the stat of a settings file.
  const touched = [], resolver = resolverOf({ stat: file => { touched.push(file); throw Object.assign(new Error(), { code: 'ENOENT' }); } });
  const spec = { cwd: path.join(root, 'project'), env: { HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home') } };
  for (const observation of [{ kind: 'failure', code: 'billing_identity_mismatch', spec }, { kind: 'failure', code: 'invalid_key' },
    { kind: 'key', status: 'invalid' }, { kind: 'identity' }, { kind: 'success', card: 'A' }]) resolver.observe({ scope: 'p', ...observation, observed: resolver.generation() });
  resolver.facts('p', 'A');
  assert.ok(touched.length > 0 && touched.every(file => settingsChain(spec).includes(file)));
});
