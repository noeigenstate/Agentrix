const path = require('node:path');
const { DashboardRecords } = require('./records.cjs');
const { DashboardDecisions } = require('./decisions.cjs');
const { DashboardJournals } = require('./journals.cjs');
const { createDashboardWindow } = require('./window.cjs');
const { registerDashboardIpc } = require('./ipc.cjs');
const { summarize } = require('./summary.cjs');
const { liveRuns } = require('./live.cjs');
const { translate } = require('../../i18n.cjs');
const prices = require('./prices.json');

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
  decisions = new DashboardDecisions(userData), now = Date.now, t = (source, values) => translate(getSettings().language, source, values),
  journals: suppliedJournals, platform = process.platform }) {
  let timer = null, liveTimer = null, minuteTimer = null, lastPush = -Infinity, disposed = false, projectKey = '';
  let liveState = { running: [], at: 0 }, liveKey = '[]';
  const projectsKey = () => JSON.stringify(getProjects().map(project => [project.id, project.path, project.kind]).sort((a, b) => a[0].localeCompare(b[0])));
  const push = () => {
    clearTimeout(timer); clearTimeout(liveTimer); timer = null; liveTimer = null;
    const window = dashboardWindow.getWindow();
    if (disposed || !window || window.isDestroyed()) return;
    lastPush = now(); window.webContents.send('dashboard:changed');
  };
  const changed = () => {
    if (disposed || timer || !dashboardWindow.getWindow()) return;
    timer = setTimeout(push, 1000);
    timer.unref?.();
  };
  const journals = suppliedJournals || new DashboardJournals({ getProjects, changed });
  const stop = () => {
    clearTimeout(timer); clearTimeout(liveTimer); clearInterval(minuteTimer);
    timer = null; liveTimer = null; minuteTimer = null; lastPush = -Infinity;
    journals.stop();
  };
  const dashboardWindow = createDashboardWindow({ BrowserWindow, getSettings, getMainWindow, getUiZoom, backgroundColor,
    root, devUrl, platform, t, onClosed: stop });
  const unsubscribe = records.subscribe(changed);
  const unsubscribeDecisions = decisions.subscribe?.(changed);
  async function summary(input) {
    const query = checkQuery(input);
    const [runs, grades, quota, history, adopted] = await Promise.all([
      records.read('runs'), records.read('grades'), records.read('quota'), journals.read(), decisions.read(),
    ]);
    return summarize({ records: { runs, grades, quota: [...quota, ...records.latestQuota()] }, journals: history,
      projects: getProjects(), prices, decisions: adopted, live: liveState, query, now: now(), t });
  }
  async function decide(id, state, query) {
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id) || !['open', 'adopted', 'dismissed'].includes(state)) throw new Error('无效的看板决策。');
    const current = await summary(query), suggestion = current.suggestions.find(suggestion => suggestion.id === id);
    if (!suggestion) throw new Error('无效的看板建议。');
    if (!await decisions.decide(id, state, suggestion.weight)) throw new Error('无法保存看板决策。');
    return summary(query);
  }
  async function open() {
    if (disposed) return;
    projectKey = projectsKey();
    try {
      const watching = Promise.resolve(journals.start()), opening = dashboardWindow.open();
      if (!minuteTimer && dashboardWindow.getWindow()) {
        minuteTimer = setInterval(() => {
          push();
          // Reuse explicit-open discovery: successful probes stay cached and misses are retried.
          void Promise.resolve(journals.start()).catch(() => {});
        }, 60_000);
        minuteTimer.unref?.();
      }
      await Promise.all([opening, watching]);
    } catch (error) { stop(); throw error; }
  }
  const releaseIpc = registerDashboardIpc({ ipcMain, dashboardWindow, getMainWindow, summary, decide, open, devUrl, t });
  return { open, summary, decide, live(running) {
    if (disposed) return;
    const rows = liveRuns(running), key = JSON.stringify(rows);
    liveState = { running: rows, at: now() };
    if (key === liveKey) return;
    liveKey = key;
    if (liveTimer || !dashboardWindow.getWindow()) return;
    liveTimer = setTimeout(push, Math.max(1000, 5000 - (now() - lastPush)));
    liveTimer.unref?.();
  }, sync() {
    dashboardWindow.sync();
    if (!dashboardWindow.getWindow()) return;
    const key = projectsKey();
    if (key !== projectKey) { projectKey = key; void journals.sync(); }
  },
    dispose() {
      disposed = true; stop(); unsubscribe(); unsubscribeDecisions?.(); releaseIpc();
      const window = dashboardWindow.getWindow();
      if (window && !window.isDestroyed()) window.close();
    } };
}

module.exports = { createDashboard };
