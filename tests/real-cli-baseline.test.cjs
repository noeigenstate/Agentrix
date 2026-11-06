const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { claudeExecutable } = require('../scripts/real-cli-tests.cjs');
const { compareSystem, compareTools } = require('./fixtures/claude-parity.cjs');

test('real CLI baseline requires the locked native package and never searches the installed PATH', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-locked-cli-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const name = '@anthropic-ai/claude-agent-sdk-win32-x64', version = '0.3.317';
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { [`node_modules/${name}`]: { version } } }));
  const options = { root, platform: 'win32', arch: 'x64' };
  assert.throws(() => claudeExecutable(options), /Locked Claude CLI is missing/);
  const directory = path.join(root, 'node_modules', name); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'claude.exe'), 'inert fixture, never executed');
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '0.3.318' }));
  assert.throws(() => claudeExecutable(options), /must match package-lock/);
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version }));
  assert.equal(claudeExecutable(options).file, path.join(directory, 'claude.exe'));
  assert.equal(claudeExecutable({ ...options, prefix: root }).source, `locked ${name}@${version}`);
  assert.throws(() => claudeExecutable({ ...options, override: path.join(root, 'missing') }), /Explicit Claude CLI is missing/);
  assert.equal(claudeExecutable({ ...options, override: path.join(directory, 'claude.exe') }).source, 'explicit installed CLI');
});

test('versioned parity admits only reviewed versions and exact transport differences', () => {
  const system = version => [{ type: 'text', text: `x-anthropic-billing-header: cc_version=${version}.abc; cc_entrypoint=sdk-ts;` }, { type: 'text', text: 'same instructions' }];
  for (const version of ['2.1.317', '2.1.318']) {
    assert.equal(compareSystem(system(version), system(version)), version);
    compareTools([{ name: 'Bash', description: 'same' }], [{ name: 'Bash', description: 'same' }], version);
    assert.throws(() => compareTools([{ name: 'Bash', description: 'new SDK description' }], [{ name: 'Bash', description: 'new terminal description' }], version), /new tool\/schema/);
    const changed = system(version); changed[1].text += ' unexpected instruction';
    assert.throws(() => compareSystem(system(version), changed), /unexpected system-prompt/);
    assert.throws(() => compareTools([{ name: 'Bash', newField: true }], [{ name: 'Bash' }], version), /new tool\/schema/);
  }
  assert.throws(() => compareSystem(system('2.1.317'), system('2.1.318')), /same CLI version/);
  assert.throws(() => compareSystem(system('2.1.999'), system('2.1.999')), /new CLI version/);
  assert.throws(() => compareTools([], [], '2.1.999'), /new CLI version/);
});
