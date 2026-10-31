const { createIpcAdapter } = require('../../shared/ipc.cjs');

function registerDashboardIpc({ ipcMain, dashboardWindow, getMainWindow, summary, decide, open, devUrl, t }) {
  const handles = [], listeners = [];
  const mainUrl = devUrl ? devUrl.replace(/\/$/, '') : 'agentrix://app/index.html';
  function allowedWindow(dashboard) {
    const window = dashboard ? dashboardWindow.getWindow() : getMainWindow();
    if (!window || window.isDestroyed()) return null;
    const source = new URL(window.webContents.mainFrame.url), expected = new URL(dashboard ? dashboardWindow.url : mainUrl);
    const mainPaths = devUrl ? [expected.pathname, `${expected.pathname.replace(/\/$/, '')}/`, `${expected.pathname.replace(/\/$/, '')}/index.html`] : [expected.pathname];
    if (source.protocol !== expected.protocol || source.host !== expected.host ||
      (dashboard ? source.pathname !== expected.pathname : !mainPaths.includes(source.pathname))) throw new Error('看板请求来源无效。');
    return window;
  }
  // Preserve the bridge's Result on sender rejection; the shared adapter checks exact webContents/main-frame identity.
  const registration = {
    handle(channel, listener) {
      ipcMain.handle(channel, async (...args) => {
        try { return await listener(...args); }
        catch { return { ok: false, error: t('看板请求来源无效。') }; }
      });
      handles.push(channel);
    },
    on(channel, listener) { ipcMain.on(channel, listener); listeners.push([channel, listener]); },
  };
  const adapter = dashboard => createIpcAdapter({ ipcMain: registration, getWindow: () => allowedWindow(dashboard),
    devUrl: devUrl?.replace(/\/$/, ''), t, report() {} });
  adapter(false).handle('dashboard:open', open);
  const ipc = adapter(true);
  ipc.handle('dashboard:summary', summary);
  ipc.handle('dashboard:decide', decide);
  ipc.handle('dashboard:appearance', dashboardWindow.appearance);
  for (const action of ['close', 'minimize', 'maximize']) {
    ipc.listen(`dashboard:${action}`, () => {
      const window = dashboardWindow.getWindow();
      if (action === 'maximize') { if (window.isMaximized()) window.unmaximize(); else window.maximize(); }
      else window[action]();
    });
  }
  return () => {
    for (const channel of handles) ipcMain.removeHandler(channel);
    for (const [channel, listener] of listeners) ipcMain.removeListener(channel, listener);
  };
}

module.exports = { registerDashboardIpc };
