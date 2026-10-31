const path = require('node:path');
const { DashboardRecords } = require('./records.cjs');
const { DashboardDecisions } = require('./decisions.cjs');
const { DashboardJournals } = require('./journals.cjs');
const { createDashboardWindow } = require('./window.cjs');
const { registerDashboardIpc } = require('./ipc.cjs');
const { summarize } = require('./summary.cjs');
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
  let timer = null, disposed = false, projectKey = '';
  const projectsKey = () => JSON.stringify(getProjects().map(project => [project.id, project.path, project.kind]).sort((a, b) => a[0].localeCompare(b[0])));
  const changed = () => {
    if (disposed || timer || !dashboardWindow.getWindow()) return;
    timer = setTimeout(() => {
      timer = null;
      const window = dashboardWindow.getWindow();
      if (window && !window.isDestroyed()) window.webContents.send('dashboard:changed');
    }, 1000);
    timer.unref?.();
  };
  const journals = suppliedJournals || new DashboardJournals({ getProjects, changed });
  const dashboardWindow = createDashboardWindow({ BrowserWindow, getSettings, getMainWindow, getUiZoom, backgroundColor,
    root, devUrl, platform, t, onClosed: () => { journals.stop(); clearTimeout(timer); timer = null; } });
  const unsubscribe = records.subscribe(changed);
  async function summary(input) {
    const query = checkQuery(input);
    const [runs, grades, quota, history, adopted] = await Promise.all([
      records.read('runs'), records.read('grades'), records.read('quota'), journals.read(), decisions.read(),
    ]);
    return summarize({ records: { runs, grades, quota }, journals: history, projects: getProjects(), prices, decisions: adopted, query, now: now(), t });
  }
  async function decide(id, state, query) {
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id) || !['open', 'adopted', 'dismissed'].includes(state)) throw new Error('无效的看板决策。');
    const current = await summary(query), suggestion = current.suggestions.find(suggestion => suggestion.id === id);
    if (!suggestion) throw new Error('无效的看板建议。');
    if (!await decisions.decide(id, state, suggestion.weight)) throw new Error('无法保存看板决策。');
    changed();
    return summary(query);
  }
  async function open() {
    if (disposed) return;
    projectKey = projectsKey();
    const watching = Promise.resolve(journals.start());
    try { await Promise.all([dashboardWindow.open(), watching]); } catch (error) { journals.stop(); throw error; }
  }
  const releaseIpc = registerDashboardIpc({ ipcMain, dashboardWindow, getMainWindow, summary, decide, open, devUrl, t });
  return { open, summary, decide, sync() {
    dashboardWindow.sync();
    if (!dashboardWindow.getWindow()) return;
    const key = projectsKey();
    if (key !== projectKey) { projectKey = key; void journals.sync(); }
  },
    dispose() {
      disposed = true; clearTimeout(timer); timer = null; unsubscribe(); releaseIpc(); journals.stop();
      const window = dashboardWindow.getWindow();
      if (window && !window.isDestroyed()) window.close();
    } };
}

module.exports = { createDashboard };
