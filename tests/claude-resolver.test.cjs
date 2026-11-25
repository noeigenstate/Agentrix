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
    for (const name of required) assert.ok(['node:fs', 'node:path', 'node:crypto', './facts.cjs', '../../shared/reason.cjs', '../cli-adapters/workers.cjs', './locator.cjs'].includes(name), `${file} requires ${name}`);
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

// A resolver whose settings files are a map the test edits.
function statted() {
  const stats = new Map();
  const stat = file => { if (!stats.has(file)) throw Object.assign(new Error('absent'), { code: 'ENOENT' }); return stats.get(file); };
  const spec = { cwd: path.join(root, 'project'), env: { HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home') } };
  return { stats, stat, spec, touch: file => stats.set(file, { size: (stats.get(file)?.size || 0) + 1, mtimeMs: 7 }) };
}
const running = { running: true };

test('a running session keeps its billing refusal while Claude Code rewrites its settings files; only a new session decides again', () => {
  const files = statted(), resolver = resolverOf({ stat: files.stat });
  resolver.observe({ kind: 'failure', scope: 'p', code: 'billing_identity_mismatch', message: 'another credential', observed: resolver.generation(), spec: files.spec });
  // Claude Code itself writes ~/.claude/settings.json (/model) and .claude/settings.local.json ("always allow").
  for (const file of [settingsChain(files.spec)[0], settingsChain(files.spec).at(-1)]) files.touch(file);
  assert.deepEqual(resolver.facts('p'), [], 'the next new session checks again (N1)');
  assert.deepEqual(codes(resolver.facts('p', 'card', running)), ['claude.billing_identity_mismatch'], 'a running card is not offered the API again');
  assert.equal(decide(resolver.facts('p', 'card', running), {}, running).path, 'terminal');
});

test('a test with no project ends only the billing refusals seen before it began', () => {
  const resolver = resolverOf(), spec = { cwd: path.join(root, 'project') };
  const fail = (scope, observed) => resolver.observe({ kind: 'failure', scope, code: 'billing_identity_mismatch', observed, spec });
  fail('older', resolver.generation());
  const tested = resolver.generation();  // the test begins
  fail('fresher', resolver.generation());  // a session in another project is refused while the test runs
  resolver.observe({ kind: 'identity', scope: '', observed: tested, tested: true, everywhere: true });
  assert.deepEqual(resolver.facts('older'), []);
  assert.deepEqual(codes(resolver.facts('fresher')), ['claude.billing_identity_mismatch'], 'a refusal seen after the test began stands');
});

test('a test with no project that finds another credential tells it in its answer and holds it for no scope', async t => {
  const f = routeFixture(t, { billing: '/login managed key' });
  const tested = await f.native.testConnection();
  assert.equal(tested.billing.status, 'mismatch'); assert.equal(tested.path, 'terminal'); assert.equal(tested.reason, 'billing_identity_mismatch');
  assert.deepEqual(f.runtime.facts('').filter(value => value.name === 'billing'), [], 'no project means no project to hold it for');
  assert.equal(f.runtime.apiState('p').status, 'ready');
});

test('a key refusal the connection test saw keeps new sessions off the API until the key changes and never stops a running one', () => {
  let version = 0; const resolver = resolverOf({ keyVersion: () => version });
  resolver.observe({ kind: 'key', status: 'invalid', observed: resolver.generation() });
  assert.deepEqual(codes(resolver.facts('p')), ['claude.invalid_key'], 'a new session in any project');
  assert.deepEqual(resolver.facts('p', 'card', running), [], 'a running session keeps its route');
  // A session that sees the key refused holds it for every session for a minute, and another project's identity ends that.
  resolver.observe({ kind: 'failure', scope: 'p', code: 'invalid_key', observed: resolver.generation() });
  assert.deepEqual(codes(resolver.facts('q', 'card', running)), ['claude.invalid_key']);
  resolver.observe({ kind: 'identity', scope: 'q', observed: resolver.generation() });
  assert.deepEqual(resolver.facts('p', 'card', running), []);
  assert.deepEqual(codes(resolver.facts('p')), ['claude.invalid_key'], 'the test\u2019s refusal still holds for new sessions');
  resolver.observe({ kind: 'key', status: 'ok', observed: resolver.generation() });
  assert.deepEqual(resolver.facts('p'), [], 'a test that the key passes ends it');
  resolver.observe({ kind: 'key', status: 'invalid', observed: resolver.generation() }); version++;
  assert.deepEqual(resolver.facts('p'), [], 'and so does another key');
});

test('a start looks again at a Claude Code the last check could not run before deciding by it', async () => {
  const time = clock(); let checks = 0, found = { status: 'missing', reason: 'not_found' };
  const resolver = resolverOf({ now: time.now, inspectCli: async () => { checks++; return found; } });
  await resolver.trackCli(Promise.resolve(found));
  assert.deepEqual(codes(resolver.facts('p')), ['claude.native_cli_required']);
  found = { status: 'ok', version: '2.1.318', file: 'claude.exe' };  // installed since
  time.advance(10000); await resolver.refresh();
  assert.equal(checks, 1); assert.deepEqual(resolver.facts('p'), [], 'the new session decides by what is there now');
  time.advance(10000);
  await resolver.refresh(); assert.equal(checks, 1, 'a Claude Code that runs is not checked again at every start');
});

test('starts within ten seconds of a failed CLI check share it; a start after that checks again', async () => {
  const time = clock(); let checks = 0;
  const resolver = resolverOf({ now: time.now, inspectCli: async () => { checks++; return { status: 'missing', reason: 'timeout', found: 'claude.exe' }; } });
  await resolver.trackCli(Promise.resolve({ status: 'missing', reason: 'timeout', found: 'claude.exe' }));
  time.advance(10000); await resolver.refresh(); assert.equal(checks, 1, 'a start once the last check is ten seconds old checks again');
  time.advance(9999); await resolver.refresh(); await resolver.refresh();
  assert.equal(checks, 1, 'two starts within ten seconds of that check wait for none');
  time.advance(1); await resolver.refresh(); assert.equal(checks, 2, 'a start after the window checks again');
});

test('a turn the provider accepts ends the key refusal the connection test saw', () => {
  const resolver = resolverOf();
  resolver.observe({ kind: 'key', status: 'invalid', observed: resolver.generation() });
  resolver.observe({ kind: 'identity', scope: 'p', observed: resolver.generation() });
  assert.deepEqual(codes(resolver.facts('q')), ['claude.invalid_key'], 'Claude Code reporting the key is not proof it works');
  resolver.observe({ kind: 'success', scope: 'p', card: 'A', observed: resolver.generation() });
  assert.deepEqual(resolver.facts('q'), [], 'a running session just used the key: new sessions may again');
});
