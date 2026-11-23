const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerLeadFastSettings } = require('../electron/features/terminal/lead-fast-settings.cjs');
const { writeFileAtomic } = require('../electron/atomic-write.cjs');

function fixture(t, atomic = writeFileAtomic) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-fast-settings-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'settings.json');
  let handler, remote = false;
  const session = { sessionId: 'pty', agent: 'claude', codexActive: true, usageEnv: { CLAUDE_CONFIG_DIR: folder } };
  registerLeadFastSettings({
    handle: (channel, fn) => { assert.equal(channel, 'terminal:leadFastSettings'); handler = fn; },
    getSession: () => session, findProject: () => ({ kind: remote ? 'ssh' : 'local' }), claudeConfigDir: () => folder, writeFileAtomic: atomic,
  });
  return { file, session, setRemote: () => { remote = true; },
    begin: (target, sessionId = 'pty') => handler('terminal', { sessionId, target }),
    end: (token, confirmed = true) => handler('terminal', { token, confirmed }),
    read: () => fs.readFileSync(file, 'utf8'), write: text => fs.writeFileSync(file, text),
  };
}

test('fast settings restores the original bytes if only fastMode changed, on or off', t => {
  const f = fixture(t);
  for (const [target, before, after] of [
    [true, '\uFEFF{ "theme" : "dark" }\r\n', '{"theme":"dark","fastMode":true}'],
    [false, '{ "fastMode": true, "theme" : "dark" }\r\n', '{"theme":"dark"}'],
  ]) {
    f.write(before);
    const token = f.begin(target);
    f.write(after);
    f.end(token);
    assert.equal(f.read(), before);
    assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['settings.json']);
  }
});

test('fast settings leaves untouched, unconfirmed and conflicting key values alone', t => {
  const f = fixture(t), before = '{ "theme":"dark", "fastMode": false }';
  f.write(before);
  let token = f.begin(true);
  const stat = fs.statSync(f.file);
  f.end(token);
  assert.equal(fs.statSync(f.file).ino, stat.ino);
  assert.equal(f.read(), before);
  token = f.begin(true);
  f.write('{"theme":"light","fastMode":true}');
  f.end(token, false);
  assert.equal(f.read(), '{"theme":"light","fastMode":true}');
  token = f.begin(true);
  f.write('{"theme":"dark","fastMode":false}');
  f.end(token);
  assert.equal(f.read(), '{"theme":"dark","fastMode":false}');
});

test('fast settings preserves other keys edited in the interval and binds the request to a local terminal', t => {
  const f = fixture(t);
  f.write('{"theme":"dark","fastMode":false}');
  assert.throws(() => f.begin(true, 'stale'));
  const token = f.begin(true);
  assert.throws(() => f.begin(true), 'only one automatic write can be active for the settings file');
  f.write('{"theme":"light","fastMode":true,"effortLevel":"max"}');
  f.end(token);
  assert.deepEqual(JSON.parse(f.read()), { theme: 'light', fastMode: false, effortLevel: 'max' });
  assert.throws(() => f.end(token));
  f.session.nativeStructured = true;
  assert.throws(() => f.begin(true));
  f.session.nativeStructured = false;
  f.setRemote();
  assert.throws(() => f.begin(true));
});

test('fast settings re-reads concurrent edits before replacing the staged file', t => {
  let raced = false;
  const f = fixture(t, (file, bytes, confirm) => writeFileAtomic(file, bytes, () => {
    if (!raced) { raced = true; f.write('{"theme":"light","fastMode":true}'); }
    return confirm();
  }));
  f.write('{"theme":"dark"}');
  const token = f.begin(true);
  f.write('{"theme":"dark","fastMode":true}');
  f.end(token);
  assert.equal(raced, true);
  assert.deepEqual(JSON.parse(f.read()), { theme: 'light' });
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['settings.json']);
});
