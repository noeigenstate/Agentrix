const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { createRequire } = require('node:module');
const updaterRequire = createRequire(require.resolve('electron-updater/package.json'));
const semver = updaterRequire('semver');
const { CancellationToken, HttpError } = updaterRequire('builder-util-runtime');
const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider');
const { AppUpdater } = require('electron-updater/out/AppUpdater');
const { BETA_AGREEMENT_VERSION, UpdateManager } = require('../electron/updates.cjs');

const publish = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).build.publish[0];
const stable = '1.3.26', beta = '1.3.27-beta.2';
const prefix = `/${publish.owner}/${publish.repo}/releases`;
const installer = version => `Agentrix-Setup-${version}-x64.exe`;

function fixture(currentVersion) {
  const updater = new EventEmitter(), requests = [], downloads = [];
  updater.currentVersion = semver.parse(currentVersion);
  updater.isUpdateSupported = () => true;
  updater.isUserWithinRollout = () => true;
  updater.quitAndInstall = () => {};
  const feed = `<feed xmlns="http://www.w3.org/2005/Atom">${[beta, stable].map(version => `<entry><title>${version}</title><link href="https://github.com${prefix}/tag/v${version}"/><content>Changes</content></entry>`).join('')}</feed>`;
  const executor = { request: async options => {
    assert.equal(options.hostname, 'github.com', 'all requests are mocked and GitHub API requests are forbidden');
    requests.push(options.path);
    if (options.path === `${prefix}.atom`) return feed;
    if (options.path === `${prefix}/latest`) return JSON.stringify({ tag_name: `v${stable}` });
    if (options.path.endsWith('/beta.yml')) throw new HttpError(404, 'No beta.yml; GitHub releases carry latest.yml');
    for (const version of [beta, stable]) {
      if (options.path === `${prefix}/download/v${version}/latest.yml`) {
        return JSON.stringify({ version, path: installer(version), sha512: Buffer.alloc(64).toString('base64'), files: [{ url: installer(version), sha512: Buffer.alloc(64).toString('base64'), size: 100, blockMapSize: 10 }] });
      }
    }
    throw new Error(`Unexpected mocked request: ${options.path}`);
  } };
  const provider = new GitHubProvider(publish, updater, { executor, platform: 'win32' });
  updater.checkForUpdates = async () => {
    const updateInfo = await provider.getLatestVersion();
    return { isUpdateAvailable: await AppUpdater.prototype.isUpdateAvailable.call(updater, updateInfo), updateInfo, cancellationToken: new CancellationToken() };
  };
  updater.downloadUpdate = async () => {
    const info = await provider.getLatestVersion();
    downloads.push(info.version);
    updater.emit('update-downloaded', info);
    return [];
  };
  return { updater, provider, requests, downloads };
}

test('GitHub prereleases with latest.yml resolve the Windows installer and its blockmap offline', async () => {
  for (const currentVersion of [stable, '1.3.27-beta.1']) {
    const { updater, provider, requests } = fixture(currentVersion);
    updater.allowPrerelease = true;
    updater.allowDowngrade = false;
    const info = await provider.getLatestVersion();
    assert.equal(info.version, beta);
    assert.equal(await AppUpdater.prototype.isUpdateAvailable.call(updater, info), true);
    assert(requests.includes(`${prefix}/download/v${beta}/beta.yml`));
    assert(requests.includes(`${prefix}/download/v${beta}/latest.yml`));
    assert.equal(requests.includes(`${prefix}/latest`), false);
    const [file] = provider.resolveFiles(info);
    assert.equal(file.url.href, `https://github.com${prefix}/download/v${beta}/${installer(beta)}`);
    const [, blockmap] = provider.getBlockMapFiles(file.url, currentVersion, beta);
    assert.equal(blockmap.href, `${file.url.href}.blockmap`);
  }
});

test('stable selection on an installed beta ignores prereleases and rejects an older stable', async () => {
  const { updater, provider, requests } = fixture('1.3.27-beta.1');
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  const info = await provider.getLatestVersion();
  assert.equal(info.version, stable);
  assert.equal(await AppUpdater.prototype.isUpdateAvailable.call(updater, info), false);
  assert(requests.includes(`${prefix}/latest`));
  assert.equal(requests.some(url => url.includes(`/download/v${beta}/`)), false);
});

test('the manager and real GitHub provider download beta only with the current agreement', async () => {
  for (const betaAgreement of [null, 'old-agreement', BETA_AGREEMENT_VERSION]) {
    const { updater, downloads } = fixture(stable);
    const manager = new UpdateManager({ updater, version: stable, channel: 'beta', betaAgreement });
    const downloaded = betaAgreement === BETA_AGREEMENT_VERSION ? once(updater, 'update-downloaded') : null;
    await manager.check();
    if (downloaded) await downloaded;
    const state = manager.getState();
    assert.equal(state.channel, 'beta');
    assert.equal(state.agreed, betaAgreement === BETA_AGREEMENT_VERSION);
    assert.deepEqual(downloads, betaAgreement === BETA_AGREEMENT_VERSION ? [beta] : []);
    assert.equal(state.status, betaAgreement === BETA_AGREEMENT_VERSION ? 'ready' : 'current');
    manager.dispose();
  }
});
