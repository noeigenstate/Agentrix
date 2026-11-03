const { createIpcAdapter } = require('../../shared/ipc.cjs');

function registerLabIpc({ ipcMain, labWindow, getMainWindow, engine, open, devUrl, t }) {
  const handles = [], listeners = [], mainUrl = devUrl ? devUrl.replace(/\/$/, '') : 'agentrix://app/index.html';
  function allowedWindow(lab) {
    const window = lab ? labWindow.getWindow() : getMainWindow();
    if (!window || window.isDestroyed()) return null;
    const source = new URL(window.webContents.mainFrame.url), expected = new URL(lab ? labWindow.url : mainUrl);
    const prefix = expected.pathname.replace(/\/$/, '');
    const paths = lab || !devUrl ? [expected.pathname] : [expected.pathname, prefix + '/', prefix + '/index.html'];
    if (source.protocol !== expected.protocol || source.host !== expected.host || !paths.includes(source.pathname)) throw new Error('实验室请求来源无效。');
    return window;
  }
  const registration = {
    handle(channel, listener) {
      ipcMain.handle(channel, async (...args) => {
        try { return await listener(...args); } catch { return { ok: false, error: t('实验室请求来源无效。') }; }
      }); handles.push(channel);
    },
    on(channel, listener) { ipcMain.on(channel, listener); listeners.push([channel, listener]); },
  };
  const adapter = lab => createIpcAdapter({ ipcMain: registration, getWindow: () => allowedWindow(lab), devUrl: devUrl?.replace(/\/$/, ''), t, report() {} });
  adapter(false).handle('lab:open', open);
  const ipc = adapter(true);
  for (const action of ['list', 'projects', 'sample', 'estimate', 'start', 'stop', 'remove']) ipc.handle(`lab:${action}`, engine[action].bind(engine));
  ipc.handle('lab:appearance', labWindow.appearance);
  for (const action of ['close', 'minimize', 'maximize']) ipc.listen(`lab:${action}`, () => {
    const window = labWindow.getWindow();
    if (action === 'maximize') { if (window.isMaximized()) window.unmaximize(); else window.maximize(); }
    else window[action]();
  });
  return () => {
    for (const channel of handles) ipcMain.removeHandler(channel);
    for (const [channel, listener] of listeners) ipcMain.removeListener(channel, listener);
  };
}

module.exports = { registerLabIpc };
