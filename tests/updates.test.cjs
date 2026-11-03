const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { CancellationToken } = require('builder-util-runtime');
const { BETA_AGREEMENT_VERSION, UpdateManager, isInstalledBuild, distributionOf } = require('../electron/updates.cjs');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function available(version) {
  return { isUpdateAvailable: true, updateInfo: { version }, cancellationToken: new CancellationToken() };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function fakeUpdater() {
  const updater = new EventEmitter();
  updater.checks = 0;
  updater.installs = [];
  updater.downloads = [];
  updater.checkForUpdates = async () => { updater.checks++; updater.emit('checking-for-update'); updater.emit('update-not-available'); return { isUpdateAvailable: false }; };
  updater.downloadUpdate = async token => { updater.downloads.push(token); return []; };
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
  const download = deferred(), result = available('0.2.7');
  updater.checkForUpdates = async () => { updater.checks++; return result; };
  updater.downloadUpdate = token => { updater.downloads.push(token); return download.promise; };
  const states = [];
  const manager = new UpdateManager({ updater, version: '0.2.6', onChange: state => states.push(state) });
  assert.equal(updater.autoDownload, false, 'the manager starts background downloads after validating the check');
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.allowPrerelease, false);
  const a = manager.check();
  const b = manager.check();
  assert.equal(a, b);
  await a;
  assert.equal(updater.checks, 1);
  assert.equal(manager.getState().status, 'downloading');
  assert.deepEqual(updater.downloads, [result.cancellationToken]);
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
  download.resolve([]);
  manager.dispose();
});

test('failed update checks and background downloads can be retried without unhandled rejections', async () => {
  const updater = fakeUpdater();
  const manager = new UpdateManager({ updater, version: '0.2.6' });
  updater.checkForUpdates = async () => { throw new Error('offline'); };
  assert.equal((await manager.check()).status, 'error');
  updater.checkForUpdates = async () => {
    return available('0.2.7');
  };
  updater.downloadUpdate = async () => { throw new Error('download interrupted'); };
  await manager.check();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.getState().status, 'error');
  assert.equal(manager.canInstall(), false);
  updater.checkForUpdates = async () => ({ isUpdateAvailable: false });
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

test('prereleases require both the beta channel and the current agreement, even on a beta build', () => {
  for (const channel of ['stable', 'beta']) {
    for (const betaAgreement of [null, 'old-agreement', BETA_AGREEMENT_VERSION]) {
      const updater = fakeUpdater();
      updater.allowPrerelease = true;
      updater.allowDowngrade = true;
      const manager = new UpdateManager({ updater, version: '1.3.27-beta.1', channel, betaAgreement });
      assert.equal(updater.allowPrerelease, channel === 'beta' && betaAgreement === BETA_AGREEMENT_VERSION);
      assert.equal(updater.allowDowngrade, false);
      assert.equal(manager.getState().channel, channel);
      assert.equal(manager.getState().agreed, betaAgreement === BETA_AGREEMENT_VERSION);
      assert.equal(manager.getState().agreementVersion, BETA_AGREEMENT_VERSION);
      manager.dispose();
    }
  }
});

test('switching to stable mid-check discards the old beta result before it can download', async () => {
  const updater = fakeUpdater(), old = deferred(), states = [];
  updater.checkForUpdates = () => ++updater.checks === 1 ? old.promise : Promise.resolve({ isUpdateAvailable: false });
  const manager = new UpdateManager({ updater, version: '1.3.26', channel: 'beta', betaAgreement: BETA_AGREEMENT_VERSION, onChange: state => states.push(state) });
  const checking = manager.check();
  await flush();
  const switched = manager.setChannel('stable');
  assert.equal(updater.allowPrerelease, false);
  assert.equal(manager.canInstall(), false);
  assert.equal(updater.checks, 1, 'the replacement does not coalesce into the old check');
  assert.equal(manager.check(), switched);
  const result = available('1.3.27-beta.1');
  updater.emit('update-available', result.updateInfo);
  old.resolve(result);
  await Promise.all([checking, switched]);
  assert.equal(result.cancellationToken.cancelled, true);
  assert.equal(updater.checks, 2);
  assert.equal(updater.downloads.length, 0);
  assert.equal(manager.getState().status, 'current');
  assert(states.some(state => state.channel === 'stable' && state.status === 'idle' && state.version === null));
  assert(states.filter(state => state.channel === 'stable').every(state => state.version === null));
  manager.dispose();
});

test('switching to beta mid-check rechecks instead of using an old stable result', async () => {
  const updater = fakeUpdater(), old = deferred(), download = deferred(), flags = [];
  updater.checkForUpdates = () => {
    flags.push(updater.allowPrerelease);
    return ++updater.checks === 1 ? old.promise : Promise.resolve(available('1.3.27-beta.1'));
  };
  updater.downloadUpdate = token => { updater.downloads.push(token); return download.promise; };
  const manager = new UpdateManager({ updater, version: '1.3.26' });
  const checking = manager.check();
  await flush();
  const switched = manager.setChannel('beta', BETA_AGREEMENT_VERSION);
  old.resolve(available('1.3.27'));
  await Promise.all([checking, switched]);
  assert.deepEqual(flags, [false, true]);
  assert.equal(updater.downloads.length, 1);
  assert.equal(manager.getState().version, '1.3.27-beta.1');
  updater.emit('update-downloaded', { version: '1.3.27' });
  assert.equal(manager.canInstall(), false, 'an old check cannot mark its different version ready');
  updater.emit('update-downloaded', { version: '1.3.27-beta.1' });
  assert.equal(manager.canInstall(), true);
  download.resolve([]);
  manager.dispose();
});

test('switching to stable cancels a beta download and ignores its late progress, completion and rejection', async () => {
  const updater = fakeUpdater(), download = deferred(), result = available('1.3.27-beta.1'), states = [];
  updater.checkForUpdates = async () => ++updater.checks === 1 ? result : { isUpdateAvailable: false };
  updater.downloadUpdate = () => download.promise;
  const manager = new UpdateManager({ updater, version: '1.3.26', channel: 'beta', betaAgreement: BETA_AGREEMENT_VERSION, onChange: state => states.push(state) });
  await manager.check();
  const switched = manager.setChannel('stable');
  assert.equal(result.cancellationToken.cancelled, true);
  updater.emit('download-progress', { percent: 100 });
  updater.emit('update-downloaded', result.updateInfo);
  updater.emit('error', new Error('cancelled beta'));
  assert.equal(manager.getState().version, null);
  assert.equal(manager.getState().percent, 0);
  assert.throws(() => manager.install(), /未下载完成/);
  assert.equal(updater.checks, 1, 'the old download must release electron-updater before the next check');
  download.reject(new Error('cancelled beta'));
  await switched;
  assert.equal(updater.checks, 2);
  assert.equal(manager.getState().status, 'current');
  assert.equal(updater.installs.length, 0);
  assert(states.filter(state => state.channel === 'stable').every(state => !['ready', 'downloading', 'error'].includes(state.status)));
  manager.dispose();
});

test('a downloaded beta is no longer installable after switching to stable, including late completion events', async () => {
  const updater = fakeUpdater();
  updater.checkForUpdates = async () => ++updater.checks === 1 ? available('1.3.27-beta.2') : { isUpdateAvailable: false };
  updater.downloadUpdate = async () => { updater.emit('update-downloaded', { version: '1.3.27-beta.2' }); return []; };
  const manager = new UpdateManager({ updater, version: '1.3.27-beta.1', channel: 'beta', betaAgreement: BETA_AGREEMENT_VERSION });
  await manager.check();
  assert.equal(manager.canInstall(), true);
  await manager.setChannel('stable');
  updater.emit('update-downloaded', { version: '1.3.27-beta.2' });
  assert.equal(updater.allowDowngrade, false);
  assert.equal(manager.getState().version, null);
  assert.equal(manager.canInstall(), false);
  assert.throws(() => manager.install(), /未下载完成/);
  assert.equal(updater.installs.length, 0);
  manager.dispose();
});

test('older, equal, malformed and unaccepted beta candidates never download or install', async () => {
  for (const version of ['1.3.26', '1.3.27-beta.1', '1.3.27-beta.2', 'invalid']) {
    const updater = fakeUpdater();
    updater.checkForUpdates = async () => available(version);
    const manager = new UpdateManager({ updater, version: '1.3.27-beta.1' });
    assert.equal((await manager.check()).status, 'current');
    assert.equal(updater.downloads.length, 0);
    assert.throws(() => manager.install(), /未下载完成/);
    manager.dispose();
  }
});

test('a newer stable replaces an installed beta without enabling downgrade', async () => {
  const updater = fakeUpdater();
  updater.checkForUpdates = async () => available('1.3.27');
  updater.downloadUpdate = async () => { updater.emit('update-downloaded', { version: '1.3.27' }); return []; };
  const manager = new UpdateManager({ updater, version: '1.3.27-beta.1' });
  assert.equal((await manager.check()).status, 'ready');
  manager.install();
  assert.deepEqual(updater.installs, [[true, true]]);
  assert.equal(updater.allowDowngrade, false);
  manager.dispose();
});

test('stale agreement keeps beta selected but stops a previously allowed download', async () => {
  const updater = fakeUpdater(), download = deferred();
  const result = available('1.3.27-beta.1');
  updater.checkForUpdates = async () => ++updater.checks === 1 ? result : available('1.3.27-beta.2');
  updater.downloadUpdate = token => { updater.downloads.push(token); return download.promise; };
  const manager = new UpdateManager({ updater, version: '1.3.26', channel: 'beta', betaAgreement: BETA_AGREEMENT_VERSION });
  await manager.check();
  const changed = manager.setChannel('beta', 'old-agreement');
  assert.equal(result.cancellationToken.cancelled, true);
  download.resolve([]);
  await changed;
  assert.equal(manager.getState().channel, 'beta');
  assert.equal(manager.getState().agreed, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.downloads.length, 1);
  assert.equal(manager.getState().version, null);
  manager.dispose();
});

test('rapid switches discard superseded queued checks and old failures', async () => {
  const updater = fakeUpdater(), old = deferred();
  updater.checkForUpdates = () => ++updater.checks === 1 ? old.promise : Promise.resolve({ isUpdateAvailable: false });
  const manager = new UpdateManager({ updater, version: '1.3.26' });
  const original = manager.check();
  await flush();
  const beta = manager.setChannel('beta', BETA_AGREEMENT_VERSION);
  const stable = manager.setChannel('stable');
  old.reject(new Error('old network failure'));
  await Promise.all([original, beta, stable]);
  assert.equal(updater.checks, 2);
  assert.equal(manager.getState().channel, 'stable');
  assert.equal(manager.getState().status, 'current');
  assert.equal(manager.getState().error, null);
  manager.dispose();
});
