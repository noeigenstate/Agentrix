const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const integration = require('../electron/windows-integration.cjs');

function startup({ packaged = false, installed = false, profile, platform = 'win32' } = {}) {
  const registrations = [], shortcuts = [], paths = { appData: path.resolve('isolated-app-data'), userData: path.resolve('isolated-user-data'), desktop: path.resolve('isolated-desktop') };
  const app = { isPackaged: packaged, getPath: name => paths[name], setPath: (name, value) => { paths[name] = value; }, setName() {}, setAppUserModelId: id => { app.aumid = id; } };
  const modules = {
    'node:path': path,
    'node:child_process': { execFile() { assert.fail('startup tests must never run shell tools'); } },
    '../updates.cjs': { isInstalledBuild: () => installed },
    '../dev-profile.cjs': { seedDevProfile() {} },
    '../zsh-terminal.cjs': {},
    '../windows-integration.cjs': { ...integration,
      materializeIcon: (source, userData) => path.join(userData, 'shell-icons', 'agentrix-fixture.ico'),
      registerNotificationIdentity: options => { registrations.push(options); return new Promise(() => {}); },
      repairShortcuts: options => { shortcuts.push(options); return { icon: options.iconSource, changes: [] }; },
      refreshSearchIcons: () => ({ changes: [] }),
    },
  };
  const context = { module: { exports: {} }, process: { platform, execPath: 'Agentrix.exe', env: { AGENTRIX_DATA_DIR: profile } }, require: name => {
    assert.ok(Object.hasOwn(modules, name), `unexpected dependency: ${name}`);
    return modules[name];
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/app/platform-startup.cjs'), 'utf8'), context);
  return { app, paths, registrations, shortcuts, ...context.module.exports };
}

test('Windows startup uses the materialized icon and relaunch identity without waiting for registry I/O', () => {
  for (const options of [{}, { packaged: true }, { profile: '/isolated/profile-a' }, { packaged: true, installed: true, profile: '/isolated/profile-b' }]) {
    const fixture = startup(options), { app } = fixture;
    const identity = fixture.configureApplication(app);
    const icon = fixture.prepareWindowIcon({ app, root: '/fixture', ...identity });
    assert.equal(typeof icon, 'string', 'startup returns while registration is still pending');
    assert.equal(icon, path.join(app.getPath('userData'), 'shell-icons', 'agentrix-fixture.ico'));
    assert.equal(fixture.registrations.length, 1);
    const registration = fixture.registrations[0];
    assert.equal(registration.appUserModelId, app.aumid);
    assert.equal(registration.displayName, identity.relaunchDisplayName);
    assert.equal(registration.icon, icon);
    assert.deepEqual(fixture.shortcuts, []);
  }
});

test('a shared test AUMID preserves distinct userData directories', () => {
  const first = startup({ profile: '/isolated/profile-a' }), second = startup({ profile: '/isolated/profile-b' });
  assert.equal(first.configureApplication(first.app).appUserModelId, second.configureApplication(second.app).appUserModelId);
  assert.notEqual(first.paths.userData, second.paths.userData);
  assert.equal(first.paths.userData, path.resolve('/isolated/profile-a'));
  assert.equal(second.paths.userData, path.resolve('/isolated/profile-b'));
});

test('other platforms never register a Windows notification identity', () => {
  for (const platform of ['darwin', 'linux']) {
    const fixture = startup({ platform, profile: '/isolated/profile' }), { app } = fixture;
    const identity = fixture.configureApplication(app);
    assert.equal(fixture.prepareWindowIcon({ app, root: '/fixture', ...identity }), path.join('/fixture', 'assets/icon.ico'));
    assert.equal(app.aumid, undefined);
    assert.deepEqual(fixture.registrations, []);
  }
});
