// G8: a test proves order and causality with events, injected clocks and fake processes. It never counts event-loop
// turns, spins on the clock, sleeps a fixed time, or asserts an elapsed-time bound. Violations that existed when this
// guard was written are frozen in tests/fixtures/test-hygiene-allow.json: the list can only shrink.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const allowFile = 'tests/fixtures/test-hygiene-allow.json';
const CLOCK = String.raw`(?:Date\.now|performance\.now|process\.hrtime)`;
// A sleep inside a polling loop (for or while on the same line) waits for a condition with a bound; it is not a stand-in.
const SLEEP = new RegExp(String.raw`\bsetTimeout\(\s*(?:resolve|res|r|done|ok|\(\)\s*=>\s*\w+\(\))\s*,\s*\d|\b(?:sleep|delay|pause)\(\s*\d|\bawait\s+(?:timers\.)?setTimeout\(\s*\d|\bAtomics\.wait\(`);
const RULES = {
  // A turn of the event loop is not a unit of causality: wait for the event itself.
  setImmediate: line => /\bsetImmediate\b/.test(line),
  // A loop that spins until the clock passes a time holds the thread for that long.
  'busy-loop': line => new RegExp(String.raw`\bwhile\s*\((?:[^()]|\(\))*${CLOCK}(?:[^()]|\(\))*\)\s*(?:;|\{\s*\})`).test(line),
  'fixed-sleep': line => SLEEP.test(line) && !/\b(?:for|while)\s*\(/.test(line),
  // Elapsed time depends on the machine; inject the clock and compare what it was told.
  'elapsed-bound': line => new RegExp(String.raw`\belapsed\w*\s*[<>]=?|\.elapsedMs\s*[<>]=?|\bassert\w*(?:\.\w+)?\([^\n]*${CLOCK}\(\)\s*-`).test(line),
};

const violationsIn = source => {
  const counts = {};
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
    for (const [rule, matches] of Object.entries(RULES)) if (matches(line)) counts[rule] = (counts[rule] || 0) + 1;
  }
  return counts;
};
const scanTests = () => fs.readdirSync(__dirname).filter(name => name.endsWith('.test.cjs') && name !== path.basename(__filename)).sort()
  .flatMap(name => Object.entries(violationsIn(fs.readFileSync(path.join(__dirname, name), 'utf8'))).map(([rule, count]) => ({ file: `tests/${name}`, rule, count })));
const key = ({ file, rule }) => `${file} ${rule}`;

test('the rules see each kind of violation and none of the allowed waits', () => {
  assert.deepEqual(violationsIn('await new Promise(resolve => setImmediate(resolve));'), { setImmediate: 1 });
  assert.deepEqual(violationsIn('const end = Date.now() + 60; while (Date.now() < end);'), { 'busy-loop': 1 });
  assert.deepEqual(violationsIn('await new Promise(resolve => setTimeout(resolve, 50)); await sleep(300);'), { 'fixed-sleep': 1 });
  assert.deepEqual(violationsIn('assert.ok(timedOut.elapsedMs >= 20); assert.ok(Date.now() - started < 500);'), { 'elapsed-bound': 1 });
  assert.deepEqual(violationsIn('for (let n = 0; n < 100 && !done(); n++) await new Promise(resolve => setTimeout(resolve, 2));'), {});
  assert.deepEqual(violationsIn('// await sleep(100)\nconst wait = ms => new Promise(resolve => setTimeout(resolve, ms));\nt.mock.timers.tick(3000);'), {});
});

test('no test waits on setImmediate chains, busy loops, fixed sleeps or elapsed-time bounds outside the frozen allowlist, which can only shrink', () => {
  const allowed = JSON.parse(fs.readFileSync(path.join(root, allowFile), 'utf8')).entries;
  assert.deepEqual(allowed.map(key), [...allowed.map(key)].sort(), 'the allowlist is sorted by file, then rule');
  assert.equal(new Set(allowed.map(key)).size, allowed.length, 'every file and rule appears once');
  const found = new Map(scanTests().map(entry => [key(entry), entry.count]));
  const problems = [];
  for (const [name, count] of found) {
    const was = allowed.find(entry => key(entry) === name)?.count || 0;
    if (count > was) problems.push(`${name}: ${count} violation(s), ${was} allowed. Wait for the event or inject the clock; do not add to the allowlist.`);
  }
  for (const entry of allowed) {
    const count = found.get(key(entry)) || 0;
    if (count < entry.count) problems.push(`${key(entry)}: ${count} left, ${entry.count} listed. Lower the allowlist entry to ${count}${count ? '' : ' (remove it)'}.`);
  }
  assert.deepEqual(problems, []);
});
