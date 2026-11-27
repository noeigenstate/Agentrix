const path = require('node:path');
const { DashboardRecords } = require('./records.cjs');
const { createDashboardWindow } = require('./window.cjs');
const { registerDashboardIpc } = require('./ipc.cjs');
const { summarize } = require('./summary.cjs');
const { translate } = require('../../i18n.cjs');

function checkQuery(query) {
  if (!query || Array.isArray(query) || Object.keys(query).sort().join(',') !== 'projectId,range' ||
    !['7d', '30d', 'all'].includes(query.range) || query.projectId !== null &&
    (typeof query.projectId !== 'string' || !query.projectId.length || query.projectId.length > 160 || /[\x00-\x1f\x7f]/.test(query.projectId))) {
    throw new Error('无效的看板筛选条件。');
  }
  return { projectId: query.projectId, range: query.range };
}

function createDashboard({ app, userData = app.getPath('userData'), root = path.resolve(__dirname, '../../..'), getProjects, getSettings,
  getMainWindow, BrowserWindow, ipcMain, devUrl = null, getUiZoom, backgroundColor, records = new DashboardRecords(userData),
  now = Date.now, t = (source, values) => translate(getSettings().language, source, values), platform = process.platform }) {
  let timer = null, minuteTimer = null, disposed = false;
  const push = () => {
    clearTimeout(timer); timer = null;
    const window = dashboardWindow.getWindow();
    if (disposed || !window || window.isDestroyed()) return;
    window.webContents.send('dashboard:changed');
  };
  const changed = () => {
    if (disposed || timer || !dashboardWindow.getWindow()) return;
    timer = setTimeout(push, 1000);
    timer.unref?.();
  };
  const stop = () => {
    clearTimeout(timer); clearInterval(minuteTimer);
    timer = null; minuteTimer = null;
  };
  const dashboardWindow = createDashboardWindow({ BrowserWindow, getSettings, getMainWindow, getUiZoom, backgroundColor,
    root, devUrl, platform, t, onClosed: stop });
  const unsubscribe = records.subscribe(kind => { if (kind === 'runs') changed(); });
  async function summary(input) {
    const query = checkQuery(input);
    return summarize({ runs: await records.read('runs'), projects: getProjects(), query, now: now() });
  }
  async function open() {
    if (disposed) return;
    try {
      const opening = dashboardWindow.open();
      // The time range moves with the clock, so an open window reads again each minute.
      if (!minuteTimer && dashboardWindow.getWindow()) {
        minuteTimer = setInterval(push, 60_000);
        minuteTimer.unref?.();
      }
      await opening;
    } catch (error) { stop(); throw error; }
  }
  const releaseIpc = registerDashboardIpc({ ipcMain, dashboardWindow, getMainWindow, summary, open, devUrl, t });
  return { open, summary, sync: () => dashboardWindow.sync(),
    dispose() {
      disposed = true; stop(); unsubscribe(); releaseIpc();
      const window = dashboardWindow.getWindow();
      if (window && !window.isDestroyed()) window.close();
    } };
}

module.exports = { createDashboard };
