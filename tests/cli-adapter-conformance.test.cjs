const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { adapterOf, createAdapter, support } = require('../electron/features/cli-adapters/registry.cjs');
const { CAPABILITY_KEYS, UNSUPPORTED } = require('../electron/features/cli-adapters/capabilities.mjs');
const { terminalLine } = require('../electron/features/cli-adapters/terminal.cjs');
const { translate } = require('../electron/i18n.cjs');
const { createScreenSelectors } = require('../src/features/cli-screens/index.ts');
const { terminalLaunch } = require('../integration/shims/intercept.cjs');
const { readEnvelope, readKeyValue } = require('../electron/features/agents/dispatch-events.cjs');
const { screen } = require('./fixtures/terminal-example-screen.ts');

const fixture = path.join(__dirname, 'fixtures/terminal-example.cjs');
const command = 'terminal-example';
const manifest = {
  id: command, command, label: 'Terminal Example',
  install: { versionPattern: /\d+\.\d+\.\d+/, minVersion: '1.2.0' },
  words: { utilities: ['--version'] },
  supports: Object.fromEntries(CAPABILITY_KEYS.map(key => [key, key === 'terminal' ? { via: 'arg' } : { unsupported: UNSUPPORTED[key] }])),
};
const terminal = { launch: () => ({ argv: ['--interactive'], env: [] }) };
const testAdapter = createAdapter(manifest, { terminal });

test('a terminal-only adapter is found on PATH and launches without a resume facet', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-cli-conformance-'));
  const file = path.join(dir, command + (process.platform === 'win32' ? '.exe' : ''));
  t.after(() => { if (fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(dir); });
  fs.writeFileSync(file, '', { mode: 0o755 });
  // Node supplies the fixture executable on both platforms. PATH discovery and version decoding use the real adapter.
  const adapter = createAdapter(manifest, { terminal }, {
    run(executable, args, options, done) {
      assert.equal(executable, file);
      execFile(process.execPath, [fixture, ...args], options, done);
    },
  });
  assert.equal(adapterOf(command), undefined);
  assert.deepEqual(await adapter.install.locate({ PATH: dir, SystemRoot: process.env.SystemRoot }), { installed: true, version: '1.2.3', file, reason: null });
  assert.equal(terminalLine(adapter), command + '\r');
  assert.equal(terminalLine(adapter, { id: 'old' }), command + '\r');
  const lookup = id => id === command ? adapter : undefined;
  const classify = args => readKeyValue(terminalLaunch({}, command, 'classify', 'terminal', args, lookup), { format: 'agentrix.launch-route' }).route;
  assert.equal(classify([]), 'conversation');
  assert.equal(classify(['--version']), 'passthrough');
  const { value: plan } = readEnvelope(terminalLaunch({}, command, 'json', 'terminal', [], lookup), { legacy: false });
  assert.deepEqual(plan, { v: 1, type: 'launch.words', unset: [], env: {}, argv: ['--interactive'] });
  const { argv } = plan;
  const rows = execFileSync(process.execPath, [fixture, ...argv], { encoding: 'utf8' }).split(/\r?\n/);
  const selectors = createScreenSelectors(id => id === manifest.id ? screen : undefined, () => false);
  assert.equal(selectors.cliInputAvailable(command, rows), true);
  assert.equal(selectors.isCliIdle(command, rows, {}), true);
  assert.equal(selectors.isCliWorking(command, rows, {}), false);
  assert.equal(selectors.isCliIdle(command, [...rows, 'Working…'], {}), false);
  assert.equal(selectors.isCliWorking(command, [...rows, 'Working…'], {}), true);
});

test('every unavailable capability of a terminal-only adapter has an English reason', () => {
  assert.deepEqual(support(testAdapter.manifest, 'terminal'), { ok: true, via: 'arg' });
  for (const key of CAPABILITY_KEYS.filter(key => key !== 'terminal')) {
    const outcome = support(testAdapter.manifest, key);
    assert.deepEqual(outcome, { ok: false, reason: UNSUPPORTED[key] });
    assert.match(translate('en', outcome.reason), /^This CLI /, key);
  }
});
