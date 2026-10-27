const fs = require('node:fs');
const path = require('node:path');

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
  constructor({ updater, version, distribution = 'portable', onChange = () => {} }) {
    this.updater = updater;
    this.onChange = onChange;
    this.state = { supported: !!updater, currentVersion: version, distribution, status: updater ? 'idle' : 'unavailable', version: null, percent: 0, error: null };
    this.request = null;
    this.disposed = false;
    if (!updater) return;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    updater.logger = null;
    updater.on('checking-for-update', () => this.update({ status: 'checking', error: null }));
    updater.on('update-available', info => this.update({ status: 'downloading', version: info.version, percent: 0, error: null }));
    updater.on('update-not-available', () => this.update({ status: 'current', version: null, percent: 0, error: null }));
    updater.on('download-progress', info => this.update({ status: 'downloading', percent: Number.isFinite(info.percent) ? Math.max(0, Math.min(100, Math.round(info.percent))) : 0 }));
    updater.on('update-downloaded', info => this.update({ status: 'ready', version: info.version, percent: 100, error: null }));
    // Keep an error listener until process exit, including during shutdown.
    updater.on('error', () => this.update({ status: 'error', error: '检查或下载更新失败，请检查网络后重试。' }));
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
    this.update({ status: 'checking', error: null });
    this.request = Promise.resolve().then(() => this.updater.checkForUpdates())
      .then(result => { result?.downloadPromise?.catch(() => this.update({ status: 'error', error: '更新下载失败，请检查网络后重试。' })); })
      .catch(() => this.update({ status: 'error', error: '检查或下载更新失败，请检查网络后重试。' }))
      .then(() => this.getState()).finally(() => { this.request = null; });
    return this.request;
  }

  canInstall() { return !!this.updater && !this.disposed && this.state.status === 'ready'; }
  install() {
    if (!this.canInstall()) throw new Error('更新尚未下载完成。');
    this.updater.quitAndInstall(true, true);
  }
  dispose() { this.disposed = true; clearTimeout(this.initialTimer); clearInterval(this.interval); }
}

module.exports = { UpdateManager, isInstalledBuild, distributionOf };
