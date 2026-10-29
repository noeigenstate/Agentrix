const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { APP_ID, windowsAppId, windowsDisplayName, registerNotificationIdentity, repairShortcuts, refreshSearchIcons } = require('../electron/windows-integration.cjs');

test('development, portable and isolated test windows never reuse the installed application identity', () => {
  assert.equal(windowsAppId({ packaged: true, installed: true }), APP_ID);
  assert.notEqual(windowsAppId({ packaged: false }), APP_ID);
  assert.notEqual(windowsAppId({ packaged: true, installed: false }), APP_ID);
  const testId = windowsAppId({ packaged: true, installed: true, profile: '/test/profile-a' });
  assert.notEqual(testId, APP_ID);
  assert.equal(testId, `${APP_ID}.test`);
  assert.equal(testId, windowsAppId({ packaged: false, profile: '/test/profile-b' }));
});

function registry(values = {}) {
  const calls = [];
  const execFile = (executable, args, options, callback) => {
    calls.push({ executable, args, options });
    setImmediate(() => {
      if (args[0] === 'query') {
        const matches = Object.entries(values).filter(([, value]) => value === args[3]);
        callback(matches.length ? null : new Error('not found'), matches.map(([name, value]) => `    ${name}    REG_SZ    ${value}\r\n`).join(''));
      } else {
        assert.equal(args[0], 'add');
        values[args[3]] = args[7];
        callback(null, '');
      }
    });
  };
  return { values, calls, execFile };
}

const builds = [
  { build: { packaged: false }, id: `${APP_ID}.development`, name: 'Agentrix Dev' },
  { build: { packaged: true, installed: false }, id: `${APP_ID}.portable`, name: 'Agentrix Portable' },
  { build: { packaged: false, profile: '/test/profile-a' }, id: `${APP_ID}.test`, name: 'Agentrix Test' },
  { build: { packaged: true, installed: true, profile: '/test/profile-b' }, id: `${APP_ID}.test`, name: 'Agentrix Test' },
  { build: { packaged: true, installed: true }, id: APP_ID, name: 'Agentrix' },
];

for (const { build, id, name } of builds) {
  test(`notification registry identity: ${name} (${build.packaged ? 'packaged' : 'source'})`, async () => {
    const mock = registry(), icon = path.resolve('isolated profile', 'shell-icons', 'agentrix-fixture.ico');
    assert.equal(windowsAppId(build), id);
    assert.equal(windowsDisplayName(build), name);
    const options = { appUserModelId: windowsAppId(build), displayName: windowsDisplayName(build), icon, execFile: mock.execFile };
    await registerNotificationIdentity(options);
    if (id === APP_ID) { assert.deepEqual(mock.calls, []); return; }
    const key = `HKCU\\Software\\Classes\\AppUserModelId\\${id}`;
    assert.deepEqual(mock.values, { DisplayName: name, IconUri: icon });
    assert.deepEqual(mock.calls.map(call => call.args), [
      ['query', key, '/f', name, '/d', '/e', '/c'],
      ['add', key, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', name, '/f'],
      ['query', key, '/f', icon, '/d', '/e', '/c'],
      ['add', key, '/v', 'IconUri', '/t', 'REG_SZ', '/d', icon, '/f'],
    ]);
    for (const { executable, options } of mock.calls) {
      assert.equal(executable, path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'));
      assert.deepEqual(options, { windowsHide: true, timeout: 5000 });
    }
    mock.calls.length = 0;
    await registerNotificationIdentity(options);
    assert.deepEqual(mock.calls.map(call => call.args[0]), ['query', 'query'], 'correct values are never rewritten');
  });
}

test('notification registration repairs only a missing or changed value', async () => {
  const icon = path.resolve('隔离 配置', 'shell-icons', 'agentrix-fixture.ico');
  for (const previous of [{ DisplayName: 'Electron', IconUri: icon }, { DisplayName: 'Agentrix Test' }, { DisplayName: 'Agentrix Test', IconUri: 'old.ico' }]) {
    const mock = registry({ ...previous });
    await registerNotificationIdentity({ appUserModelId: `${APP_ID}.test`, displayName: 'Agentrix Test', icon, execFile: mock.execFile });
    assert.deepEqual(mock.values, { DisplayName: 'Agentrix Test', IconUri: icon });
    const writes = mock.calls.filter(call => call.args[0] === 'add');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].args[3], previous.DisplayName === 'Electron' ? 'DisplayName' : 'IconUri');
  }
});

test('isolated profiles update one shared test registry key', async () => {
  const mock = registry();
  for (const profile of ['/test/profile-a', '/test/profile-b']) {
    await registerNotificationIdentity({ appUserModelId: windowsAppId({ profile }), displayName: 'Agentrix Test', icon: path.join(profile, 'shell-icons', 'agentrix.ico'), execFile: mock.execFile });
  }
  assert.deepEqual([...new Set(mock.calls.map(call => call.args[1]))], [`HKCU\\Software\\Classes\\AppUserModelId\\${APP_ID}.test`]);
  assert.equal(mock.calls.filter(call => call.args[0] === 'add' && call.args[3] === 'DisplayName').length, 1);
  assert.equal(mock.values.IconUri, path.join('/test/profile-b', 'shell-icons', 'agentrix.ico'));
});

test('notification identity registration tolerates denied queries, failed writes and spawn failures', async () => {
  const options = { appUserModelId: `${APP_ID}.development`, displayName: 'Agentrix Dev', icon: 'agentrix.ico' };
  for (const execute of [
    (file, args, options, callback) => setImmediate(() => callback(new Error('access denied or timed out'), '')),
    () => { throw new Error('reg.exe unavailable'); },
  ]) await assert.doesNotReject(registerNotificationIdentity({ ...options, execFile: execute }));
});

test('search refresh backs up only this application cached icons and runs once per icon revision', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-search-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userData = path.join(root, 'profile'), iconSource = path.join(root, 'icon.ico');
  const cache = path.join(root, 'Packages', 'Microsoft.Windows.Search_cw5n1h2txyewy', 'LocalState', 'AppIconCache', '150');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(iconSource, 'new app icon');
  const owned = path.join(cache, 'local_projectgrid_desktop');
  const foreign = path.join(cache, 'other_application');
  fs.writeFileSync(owned, 'old Electron bitmap'); fs.writeFileSync(foreign, 'foreign icon');
  const options = { localAppData: root, userData, iconSource };
  const result = refreshSearchIcons(options);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.changes.length, 1);
  assert.equal(fs.existsSync(owned), false);
  assert.equal(fs.readFileSync(result.changes[0].backup, 'utf8'), 'old Electron bitmap');
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign icon');
  fs.writeFileSync(owned, 'regenerated branded bitmap');
  assert.deepEqual(refreshSearchIcons(options).changes, []);
  assert.equal(fs.readFileSync(owned, 'utf8'), 'regenerated branded bitmap');
});

test('repair keeps an idempotent branded search entry and leaves other shortcuts alone', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-shortcuts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folders = Object.fromEntries(['userData', 'programs', 'commonPrograms', 'desktop'].map(name => { const folder = path.join(root, name); fs.mkdirSync(folder); return [name, folder]; }));
  const executable = path.join(root, 'Agentrix.exe'), iconSource = path.join(root, 'icon.ico');
  fs.writeFileSync(iconSource, 'fixture icon');
  const foreign = path.join(folders.commonPrograms, 'Electron.lnk'), menu = path.join(folders.programs, 'Agentrix.lnk');
  fs.writeFileSync(foreign, JSON.stringify({ target: path.join(root, 'electron.exe'), appUserModelId: 'another.application' }));
  fs.writeFileSync(menu, JSON.stringify({ target: executable, appUserModelId: APP_ID, args: '--preserve-user-argument' }));
  const shell = { readShortcutLink: file => JSON.parse(fs.readFileSync(file)), writeShortcutLink: (file, mode, options) => { const previous = mode === 'update' ? JSON.parse(fs.readFileSync(file)) : {}; fs.writeFileSync(file, JSON.stringify({ ...previous, ...options })); return true; } };
  const options = { ...folders, executable, iconSource, shell };
  const result = repairShortcuts(options);
  assert.deepEqual(result.warnings, []);
  assert.equal(shell.readShortcutLink(foreign).appUserModelId, 'another.application');
  assert.equal(shell.readShortcutLink(menu).icon, result.icon);
  assert.equal(shell.readShortcutLink(menu).target, executable);
  assert.equal(shell.readShortcutLink(menu).args, '--preserve-user-argument');
  assert.equal(fs.existsSync(path.join(folders.desktop, 'Agentrix.lnk')), false, 'startup does not recreate a desktop shortcut the user removed');
  assert.deepEqual(repairShortcuts(options).changes, []);
});
