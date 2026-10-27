const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { UpdateManager, isInstalledBuild, distributionOf } = require('../electron/updates.cjs');

function fakeUpdater() {
  const updater = new EventEmitter();
  updater.checks = 0;
  updater.installs = [];
  updater.checkForUpdates = async () => { updater.checks++; updater.emit('checking-for-update'); updater.emit('update-not-available'); return null; };
  updater.quitAndInstall = (...args) => updater.installs.push(args);
  return updater;
}

test('only an installed build with an uninstaller enables automatic updates', () => {
  assert.equal(isInstalledBuild(false, 'C:\\app\\Agentrix.exe', () => true), false);
  assert.equal(isInstalledBuild(true, 'C:\\app\\Agentrix.exe', () => false), false);
  assert.equal(isInstalledBuild(true, 'C:\\app\\Agentrix.exe', candidate => candidate.endsWith('Uninstall Agentrix.exe')), true);
});

test('the distribution is told from how the app runs, and only an installed Windows build can update itself', () => {
  assert.equal(distributionOf({ isPackaged: false, platform: 'win32', installed: false }), 'development');
  assert.equal(distributionOf({ isPackaged: false, platform: 'darwin', installed: false }), 'development');
  assert.equal(distributionOf({ isPackaged: true, platform: 'win32', installed: true }), 'installed');
  assert.equal(distributionOf({ isPackaged: true, platform: 'win32', installed: false }), 'portable');
  assert.equal(distributionOf({ isPackaged: true, platform: 'darwin', installed: false }), 'macos');
  assert.equal(distributionOf({ isPackaged: true, platform: 'linux', installed: false }), 'linux');
  assert.equal(new UpdateManager({ updater: null, version: '1.0.0', distribution: 'portable' }).getState().distribution, 'portable');
});

test('portable builds never check, download, or install updates', async () => {
  const manager = new UpdateManager({ updater: null, version: '0.2.6' });
  manager.start();
  assert.equal((await manager.check()).status, 'unavailable');
  assert.equal(manager.initialTimer, undefined);
  assert.throws(() => manager.install(), /未下载完成/);
  manager.dispose();
});

test('update checks deduplicate and downloads never restart running work automatically', async () => {
  const updater = fakeUpdater();
  const states = [];
  const manager = new UpdateManager({ updater, version: '0.2.6', onChange: state => states.push(state) });
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.allowPrerelease, false);
  const a = manager.check();
  const b = manager.check();
  assert.equal(a, b);
  await a;
  assert.equal(updater.checks, 1);
  assert.equal(manager.getState().status, 'current');
  updater.emit('update-available', { version: '0.2.7' });
  updater.emit('download-progress', { percent: 47.2 });
  assert.equal(manager.getState().percent, 47);
  await manager.check();
  assert.equal(updater.checks, 1);
  assert.throws(() => manager.install(), /未下载完成/);
  updater.emit('update-downloaded', { version: '0.2.7' });
  assert.equal(manager.canInstall(), true);
  assert.equal(updater.installs.length, 0);
  manager.install();
  assert.deepEqual(updater.installs, [[true, true]]);
  assert.equal(states.at(-1).status, 'ready');
  manager.dispose();
});

test('failed update checks and background downloads can be retried without unhandled rejections', async () => {
  const updater = fakeUpdater();
  const manager = new UpdateManager({ updater, version: '0.2.6' });
  updater.checkForUpdates = async () => { throw new Error('offline'); };
  assert.equal((await manager.check()).status, 'error');
  updater.checkForUpdates = async () => {
    updater.emit('update-available', { version: '0.2.7' });
    return { downloadPromise: Promise.reject(new Error('download interrupted')) };
  };
  await manager.check();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.getState().status, 'error');
  assert.equal(manager.canInstall(), false);
  updater.checkForUpdates = async () => { updater.emit('update-not-available'); };
  assert.equal((await manager.check()).status, 'current');
  manager.dispose();
});

test('shutdown prevents new checks, notifications, and installs', async () => {
  const updater = fakeUpdater();
  const notifications = [];
  const manager = new UpdateManager({ updater, version: '0.2.6', onChange: value => notifications.push(value) });
  manager.start();
  manager.dispose();
  await manager.check();
  updater.emit('update-downloaded', { version: '0.2.7' });
  assert.equal(updater.checks, 0);
  assert.equal(notifications.length, 0);
  assert.equal(manager.canInstall(), false);
});
