const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
// Use the updater's runtime dependency, which is also present in packaged builds.
const semver = createRequire(require.resolve('electron-updater/package.json'))('semver');

const BETA_AGREEMENT_VERSION = '2026-11-03';

function assertUpdateChannel(channel) {
  if (!['stable', 'beta'].includes(channel)) throw new Error('未知的更新通道。');
}

function isInstalledBuild(isPackaged, executablePath, exists = fs.existsSync) {
  return !!isPackaged && exists(path.join(path.dirname(executablePath), 'Uninstall Agentrix.exe'));
}

// How this copy of the app was distributed, for the update page: a run from source (`npm run dev`), a Windows build with
// the installer's uninstaller beside it (installed, the only one that updates itself), a Windows build without it (the unpacked
// folder or a zip: portable), or a packaged macOS / Linux build.
function distributionOf({ isPackaged, platform, installed }) {
  if (!isPackaged) return 'development';
  if (platform === 'darwin') return 'macos';
  if (platform !== 'win32') return 'linux';
  return installed ? 'installed' : 'portable';
}

class UpdateManager {
  constructor({ updater, version, distribution = 'portable', channel = 'stable', betaAgreement = null, onChange = () => {} }) {
    assertUpdateChannel(channel);
    this.updater = updater;
    this.onChange = onChange;
    this.state = { supported: !!updater, currentVersion: version, distribution, ...this.configure(channel, betaAgreement), status: updater ? 'idle' : 'unavailable', version: null, percent: 0, error: null };
    this.request = null;
    this.pending = Promise.resolve();
    this.revision = 0;
    this.active = null;
    this.disposed = false;
    if (!updater) return;
    // Start background downloads only after accepting the check for the current channel. An old check can outlive a switch.
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.disableWebInstaller = true;
    updater.logger = null;
    updater.on('download-progress', info => {
      if (this.current(this.active) && this.state.status === 'downloading') this.update({ percent: Number.isFinite(info.percent) ? Math.max(0, Math.min(100, Math.round(info.percent))) : 0 });
    });
    updater.on('update-downloaded', info => {
      if (this.current(this.active) && info.version === this.active.version && this.allows(info.version)) this.update({ status: 'ready', version: info.version, percent: 100, error: null });
    });
    // Check/download rejections belong to their operation; only installation errors have no promise. Keep this listener through shutdown.
    updater.on('error', () => {
      if (this.installing) { this.installing = false; this.update({ status: 'error', error: '检查或下载更新失败，请检查网络后重试。' }); }
    });
  }

  configure(channel, betaAgreement) {
    this.betaAgreement = betaAgreement;
    const agreed = betaAgreement === BETA_AGREEMENT_VERSION;
    if (this.updater) {
      this.updater.allowPrerelease = channel === 'beta' && agreed;
      this.updater.allowDowngrade = false;
    }
    return { channel, agreementVersion: BETA_AGREEMENT_VERSION, agreed };
  }

  setChannel(channel, betaAgreement = this.betaAgreement) {
    assertUpdateChannel(channel);
    this.revision++;
    this.active?.cancellationToken?.cancel();
    this.request = null;
    this.update({ ...this.configure(channel, betaAgreement), status: this.updater ? 'idle' : 'unavailable', version: null, percent: 0, error: null });
    return this.check();
  }

  current(operation) { return !!operation && operation.revision === this.revision && !this.disposed; }
  allows(version) {
    return typeof version === 'string' && !!semver.valid(version) && semver.gt(version, this.state.currentVersion) &&
      (!semver.prerelease(version) || this.state.channel === 'beta' && this.state.agreed);
  }

  getState() { return { ...this.state }; }
  update(patch) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.onChange(this.getState());
  }

  start() {
    if (!this.updater || this.initialTimer || this.disposed) return;
    this.initialTimer = setTimeout(() => { void this.check(); }, 20000);
    this.interval = setInterval(() => { void this.check(); }, 4 * 60 * 60 * 1000);
    this.initialTimer.unref?.(); this.interval.unref?.();
  }

  check() {
    if (!this.updater || this.disposed || ['downloading', 'ready'].includes(this.state.status)) return Promise.resolve(this.getState());
    if (this.request) return this.request;
    const operation = { revision: this.revision, version: null, cancellationToken: null, download: null };
    this.update({ status: 'checking', version: null, percent: 0, error: null });
    // electron-updater coalesces checks and downloads. Drain the cancelled operation before starting its replacement.
    const checked = this.pending.then(() => {
      if (!this.current(operation)) return;
      this.active = operation;
      return this.runCheck(operation);
    });
    this.pending = checked.then(() => operation.download).finally(() => { if (this.active === operation) this.active = null; });
    const request = checked.then(() => this.getState()).finally(() => { if (this.request === request) this.request = null; });
    this.request = request;
    return request;
  }

  async runCheck(operation) {
    try {
      const result = await this.updater.checkForUpdates();
      operation.cancellationToken = result?.cancellationToken;
      if (!this.current(operation)) { operation.cancellationToken?.cancel(); return; }
      if (!result?.isUpdateAvailable || !this.allows(result.updateInfo?.version)) {
        this.update({ status: 'current', version: null, percent: 0, error: null });
        return;
      }
      operation.version = result.updateInfo.version;
      this.update({ status: 'downloading', version: operation.version, percent: 0, error: null });
      operation.download = Promise.resolve(this.updater.downloadUpdate(operation.cancellationToken)).catch(() => {
        if (this.current(operation)) this.update({ status: 'error', error: '更新下载失败，请检查网络后重试。' });
      });
    } catch {
      if (this.current(operation)) this.update({ status: 'error', error: '检查或下载更新失败，请检查网络后重试。' });
    }
  }

  canInstall() { return !!this.updater && !this.disposed && this.state.status === 'ready' && this.allows(this.state.version); }
  install() {
    if (!this.canInstall()) throw new Error('更新尚未下载完成。');
    this.installing = true;
    this.updater.quitAndInstall(true, true);
  }
  dispose() { this.disposed = true; this.active?.cancellationToken?.cancel(); clearTimeout(this.initialTimer); clearInterval(this.interval); }
}

module.exports = { BETA_AGREEMENT_VERSION, assertUpdateChannel, UpdateManager, isInstalledBuild, distributionOf };
