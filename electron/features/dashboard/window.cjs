const path = require('node:path');

function createDashboardWindow({ BrowserWindow, getSettings, getMainWindow, getUiZoom, backgroundColor, devUrl,
  root = path.resolve(__dirname, '../../..'), platform = process.platform, t, onClosed = () => {} }) {
  let window = null, loading = null, lastAppearance = '';
  const url = devUrl ? `${devUrl.replace(/\/$/, '')}/dashboard.html` : 'agentrix://app/dashboard.html';
  function appearance() {
    const settings = getSettings(), main = getMainWindow();
    const zoom = getUiZoom?.() ?? (main && !main.isDestroyed() ? main.webContents.getZoomFactor() * 100 : settings.uiZoom ?? 100);
    return { theme: settings.theme, language: settings.language, uiZoom: zoom };
  }
  function sync(force = false) {
    if (!window || window.isDestroyed()) return;
    const value = appearance(), signature = JSON.stringify(value);
    window.setBackgroundColor(backgroundColor ? backgroundColor() : value.theme === 'light' ? '#f8f9fb' : '#181818');
    const contents = window.webContents;
    if (Math.abs(contents.getZoomFactor() - value.uiZoom / 100) > 0.001 || force) contents.setZoomFactor(value.uiZoom / 100);
    if (signature !== lastAppearance || force) { lastAppearance = signature; contents.send('dashboard:appearance-changed', value); }
  }
  async function open() {
    if (!window || window.isDestroyed()) {
      const settings = getSettings();
      const created = new BrowserWindow({ width: 1180, height: 820, minWidth: 820, minHeight: 600,
        title: t('数据看板'), backgroundColor: backgroundColor ? backgroundColor() : settings.theme === 'light' ? '#f8f9fb' : '#181818',
        ...(platform === 'darwin' ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 12 } } : { frame: false }),
        show: false, icon: path.join(root, 'assets/icon.png'),
        webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, nodeIntegrationInSubFrames: false,
          contextIsolation: true, sandbox: true, spellcheck: false, backgroundThrottling: false } });
      window = created; lastAppearance = '';
      const contents = created.webContents;
      contents.setZoomMode('isolated');
      for (const event of ['will-navigate', 'will-frame-navigate', 'will-attach-webview']) contents.on(event, event => event.preventDefault());
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('did-finish-load', () => { if (window === created) sync(true); });
      contents.on('zoom-changed', () => sync(true));
      created.once('closed', () => {
        if (window !== created) return;
        window = null; loading = null; lastAppearance = ''; onClosed();
      });
      loading = Promise.resolve().then(() => created.loadURL(url)).catch(error => { if (!created.isDestroyed()) created.close(); throw error; });
    }
    const selected = window;
    await loading;
    if (selected !== window || selected.isDestroyed()) return;
    sync();
    if (selected.isMinimized()) selected.restore();
    selected.show(); selected.focus();
  }
  return { open, sync, appearance, getWindow: () => window, url };
}

module.exports = { createDashboardWindow };
