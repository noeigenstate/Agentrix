function registerDashboardIpc({ ipcMain, dashboardWindow, getMainWindow, summary, decide, open, devUrl, t }) {
  const handles = [], listeners = [];
  const mainUrl = devUrl ? devUrl.replace(/\/$/, '') : 'agentrix://app/index.html';
  function check(event, window, dashboard) {
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('看板请求来源无效。');
    const source = new URL(event.senderFrame.url), expected = new URL(dashboard ? dashboardWindow.url : mainUrl);
    const mainPaths = devUrl ? [expected.pathname, `${expected.pathname.replace(/\/$/, '')}/`, `${expected.pathname.replace(/\/$/, '')}/index.html`] : [expected.pathname];
    if (source.protocol !== expected.protocol || source.host !== expected.host ||
      (dashboard ? source.pathname !== expected.pathname : !mainPaths.includes(source.pathname))) throw new Error('看板请求来源无效。');
  }
  const handle = (channel, fn, main = false) => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        check(event, main ? getMainWindow() : dashboardWindow.getWindow(), !main);
        return { ok: true, value: await fn(...args) };
      } catch (error) { return { ok: false, error: t(String(error?.message || error)) }; }
    });
    handles.push(channel);
  };
  handle('dashboard:open', open, true);
  handle('dashboard:summary', summary);
  handle('dashboard:decide', decide);
  handle('dashboard:appearance', dashboardWindow.appearance);
  for (const action of ['close', 'minimize', 'maximize']) {
    const channel = `dashboard:${action}`;
    const listener = event => {
      const window = dashboardWindow.getWindow();
      try { check(event, window, true); } catch { return; }
      if (action === 'maximize') { if (window.isMaximized()) window.unmaximize(); else window.maximize(); }
      else window[action]();
    };
    ipcMain.on(channel, listener); listeners.push([channel, listener]);
  }
  return () => {
    for (const channel of handles) ipcMain.removeHandler(channel);
    for (const [channel, listener] of listeners) ipcMain.removeListener(channel, listener);
  };
}

module.exports = { registerDashboardIpc };
