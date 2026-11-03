const path = require('node:path');
const { createLabWindow } = require('./window.cjs');
const { registerLabIpc } = require('./ipc.cjs');
const { translate } = require('../../i18n.cjs');

function createLab({ app, userData = app.getPath('userData'), root = path.resolve(__dirname, '../../..'), getProjects, getSettings,
  getMainWindow, BrowserWindow, ipcMain, devUrl = null, getUiZoom, backgroundColor, records, helper = path.join(root, 'integration/dispatch.cjs'),
  t = (source, values) => translate(getSettings().language, source, values), platform = process.platform,
  safeStorage, engine, engineFactory = options => {
    const { LabEngine } = require('./engine.cjs');
    return new LabEngine({ ...options, prices: require('../dashboard/prices.json'),
      safeStorage: options.safeStorage ?? (process.versions.electron ? require('electron').safeStorage : undefined) });
  } }) {
  let timer = null, starter = null, disposed = false, instance = engine, initializing = null, unsubscribe = null;
  const labWindow = createLabWindow({ BrowserWindow, getSettings, getMainWindow, getUiZoom, backgroundColor, root, devUrl, platform, t });
  const changed = () => {
    if (disposed || timer || !labWindow.getWindow()) return;
    timer = setTimeout(async () => {
      timer = null;
      try {
        const experiments = await instance.list(), window = labWindow.getWindow();
        if (!disposed && window && !window.isDestroyed()) window.webContents.send('lab:changed', experiments);
      } catch {}
    }, 250);
    timer.unref?.();
  };
  const connect = selected => {
    // Initialization failures belong to lab requests, not to the application's startup promise.
    void selected.ready?.catch(() => {});
    if (disposed) { selected.close(); throw new Error(t('实验室已关闭。')); }
    instance = selected; unsubscribe = selected.subscribe(changed);
    return selected;
  };
  const initialize = async () => {
    if (disposed) return Promise.reject(new Error(t('实验室已关闭。')));
    if (!initializing) initializing = instance ? Promise.resolve(connect(instance)) : Promise.resolve().then(() =>
      engineFactory({ userData, getProjects, helper, records, t, safeStorage, platform })).then(connect);
    return initializing;
  };
  const schedule = () => {
    if (disposed || starter || initializing) return;
    starter = setImmediate(() => { starter = null; void initialize().catch(() => {}); });
    starter.unref?.();
  };
  const main = getMainWindow();
  if (main?.isVisible?.()) schedule();
  else main?.once('show', schedule);
  const open = async () => {
    if (disposed) return;
    await labWindow.open();
    void initialize().catch(() => {});
  };
  const deferred = Object.fromEntries(['list', 'projects', 'sources', 'aaKey', 'sample', 'estimate', 'start', 'stop', 'remove']
    .map(action => [action, (...args) => initialize().then(selected => selected[action](...args))]));
  const releaseIpc = registerLabIpc({ ipcMain, labWindow, getMainWindow, engine: deferred, open, devUrl, t });
  return { open, sync: () => labWindow.sync(), waitForQuit: () => instance?.waitForQuit() ?? null, dispose() {
    if (disposed) return;
    disposed = true; clearTimeout(timer); clearImmediate(starter); timer = null; starter = null;
    main?.removeListener('show', schedule); unsubscribe?.(); releaseIpc(); instance?.close();
    const window = labWindow.getWindow(); if (window && !window.isDestroyed()) window.close();
  } };
}

module.exports = { createLab };
