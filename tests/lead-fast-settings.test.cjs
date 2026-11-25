const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerLeadFastSettings } = require('../electron/features/terminal/lead-fast-settings.cjs');
const { writeFileAtomic } = require('../electron/atomic-write.cjs');

function fixture(t, atomic = writeFileAtomic, options = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-fast-settings-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'settings.json');
  let handler, quit, remote = false;
  const session = { sessionId: 'pty', agent: 'claude', cliActive: true, usageEnv: { CLAUDE_CONFIG_DIR: folder } };
  registerLeadFastSettings({
    handle: (channel, fn) => { assert.equal(channel, 'terminal:leadFastSettings'); handler = fn; },
    getSession: () => session, findProject: () => ({ kind: remote ? 'ssh' : 'local' }), claudeConfigDir: () => folder, writeFileAtomic: atomic,
    onQuit: callback => { quit = callback; }, ...options,
  });
  return { file, session, quit, setRemote: () => { remote = true; },
    begin: (target, sessionId = 'pty') => handler('terminal', { sessionId, target }),
    end: (token, confirmed = true) => handler('terminal', { token, confirmed }),
    read: () => fs.readFileSync(file, 'utf8'), write: text => fs.writeFileSync(file, text),
  };
}

test('an unacknowledged settings change restores at 90 seconds without further IPC', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const start = Date.now(), f = fixture(t, writeFileAtomic, { now: () => start });
  f.write('{"theme":"dark","fastMode":false}');
  fs.utimesSync(f.file, new Date(start - 1000), new Date(start - 1000));
  f.begin(true);
  f.write('{"theme":"light","fastMode":true}');
  fs.utimesSync(f.file, new Date(start + 1000), new Date(start + 1000));
  t.mock.timers.tick(89_999);
  assert.equal(JSON.parse(f.read()).fastMode, true);
  t.mock.timers.tick(1);
  assert.deepEqual(JSON.parse(f.read()), { theme: 'light', fastMode: false });
});

test('quit restores only a matching write in the switch window and reports a locked file', t => {
  const start = Date.now(), reports = [];
  let locked = true;
  const f = fixture(t, (...args) => { if (locked) throw new Error('locked'); return writeFileAtomic(...args); },
    { now: () => start, report: error => reports.push(error.message) });
  const write = (data, offset) => {
    f.write(JSON.stringify(data));
    fs.utimesSync(f.file, new Date(start + offset), new Date(start + offset));
  };
  write({ fastMode: true }, -1000);
  f.begin(false);
  write({}, 1000);
  f.quit();
  assert.equal(reports.length, 1);
  assert.deepEqual(JSON.parse(f.read()), {});
  locked = false;
  f.quit();
  assert.deepEqual(JSON.parse(f.read()), { fastMode: true });
  f.begin(false);
  write({ fastMode: false, theme: 'user' }, 2000);
  f.quit();
  assert.deepEqual(JSON.parse(f.read()), { fastMode: false, theme: 'user' });
  f.begin(true);
  write({ fastMode: true, theme: 'later' }, 91_000);
  f.quit();
  assert.deepEqual(JSON.parse(f.read()), { fastMode: true, theme: 'later' });
  assert.equal(reports.length, 1);
});

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

test('SSH fast settings stays on the originating channel and masks remote errors', async t => {
  const f = fixture(t), calls = [], remoteToken = 'a'.repeat(32);
  f.setRemote();
  f.write('{"fastMode":false}');
  f.session.usageEnv = null;
  f.session.terminal = { connected: true, async request(op, data, options) {
    calls.push([op, data, options]);
    if (data.target === false || data.confirmed === false) throw new Error('/remote/private/settings.json');
    return data.token ? null : remoteToken;
  } };
  assert.throws(() => f.begin(true, 'stale'));
  const token = await f.begin(true);
  assert.notEqual(token, remoteToken);
  const origin = f.session.terminal;
  f.session.terminal = { connected: true, request() { assert.fail('replacement channel'); } };
  assert.equal(await f.end(token), null);
  assert.throws(() => f.end(token));
  f.session.terminal = origin;
  await assert.rejects(f.begin(false), error => !error.message.includes('/remote/') && /Claude Code/.test(error.message));
  await assert.rejects(f.end(await f.begin(true), false), error => !error.message.includes('/remote/') && /Claude Code/.test(error.message));
  assert.deepEqual(calls, [{ target: true }, { token: remoteToken, confirmed: true }, { target: false },
    { target: true }, { token: remoteToken, confirmed: false }].map(data => ['claude-fast-settings', data, { timeout: 3000 }]));
  assert.equal(f.read(), '{"fastMode":false}');
});
