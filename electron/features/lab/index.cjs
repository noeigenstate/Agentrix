const path = require('node:path');
const { createLabWindow } = require('./window.cjs');
const { registerLabIpc } = require('./ipc.cjs');
const { LabEngine } = require('./engine.cjs');
const { translate } = require('../../i18n.cjs');
const prices = require('../dashboard/prices.json');

function createLab({ app, userData = app.getPath('userData'), root = path.resolve(__dirname, '../../..'), getProjects, getSettings,
  getMainWindow, BrowserWindow, ipcMain, devUrl = null, getUiZoom, backgroundColor, records, helper = path.join(root, 'integration/dispatch.cjs'),
  t = (source, values) => translate(getSettings().language, source, values), platform = process.platform,
  safeStorage = process.versions.electron ? require('electron').safeStorage : undefined,
  engine = new LabEngine({ userData, getProjects, helper, records, prices, t, safeStorage, platform }) }) {
  let timer = null, disposed = false;
  const labWindow = createLabWindow({ BrowserWindow, getSettings, getMainWindow, getUiZoom, backgroundColor, root, devUrl, platform, t });
  const changed = () => {
    if (disposed || timer || !labWindow.getWindow()) return;
    timer = setTimeout(async () => {
      timer = null;
      try {
        const experiments = await engine.list(), window = labWindow.getWindow();
        if (!disposed && window && !window.isDestroyed()) window.webContents.send('lab:changed', experiments);
      } catch {}
    }, 250);
    timer.unref?.();
  };
  const unsubscribe = engine.subscribe(changed);
  const open = () => disposed ? Promise.resolve() : labWindow.open();
  const releaseIpc = registerLabIpc({ ipcMain, labWindow, getMainWindow, engine, open, devUrl, t });
  // Initialization failures are returned by list/start; they must not become unhandled background rejections.
  void engine.ready?.catch(() => {});
  return { open, sync: () => labWindow.sync(), waitForQuit: () => engine.waitForQuit(), dispose() {
    if (disposed) return;
    disposed = true; clearTimeout(timer); timer = null; unsubscribe(); releaseIpc(); engine.close();
    const window = labWindow.getWindow(); if (window && !window.isDestroyed()) window.close();
  } };
}

module.exports = { createLab };
