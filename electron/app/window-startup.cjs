const path = require('node:path');
const { minWidth, minHeight } = require('../window-zoom.json');
const electronDir = path.join(__dirname, '..');

function createMainWindow({ BrowserWindow, t, windowBackgroundColor, desktopGlassWindow, desktopGlassBackend, desktopGlassOptions, root, process = globalThis.process }) {
  return new BrowserWindow({
    width: 1500, height: 940, minWidth, minHeight,
    title: t('Agentrix'), backgroundColor: windowBackgroundColor(),
    ...(desktopGlassWindow ? desktopGlassOptions(desktopGlassBackend) : {}),
    // macOS keeps its own window buttons over the title bar; Windows draws them in the page.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 12 } } : { frame: false }),
    show: false, icon: path.join(root, 'assets/icon.png'),
    webPreferences: { preload: path.join(electronDir, 'preload.cjs'), nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true,
      spellcheck: false, backgroundThrottling: false },
  });
}

async function applyWindowBackdrop(host) {
  const { window, desktopGlassWindow, runtimeDir, desktopGlassBackend, applyDesktopGlass, windowBackgroundColor } = host;
  if (desktopGlassWindow) {
    try { await applyDesktopGlass(window, runtimeDir, desktopGlassBackend); host.desktopGlassActive = true; }
    catch { window.setBackgroundColor(windowBackgroundColor()); }
  }
}

function openMainWindow(host, shellIcon) {
  const { store, desktopGlassBackend, applyNativeTheme, registerMacTitlebar, t, send, broadcast, process = globalThis.process,
    appUserModelId, relaunchDisplayName, app, root, registerWindowZoom, screen, createDashboard, BrowserWindow, ipcMain, devUrl,
    dashboard, windowBackgroundColor, syncDashboardLive, createLab, integrationDir, registerWindowContents, Menu,
    clipboard, previewResources, pictureFrom, registerWindowLifecycle, requestQuit, report, updateIndicators } = host;
  host.desktopGlassWindow = store.settings.surface === 'glass' && store.settings.glassBackground === 'desktop' && !!desktopGlassBackend;
  applyNativeTheme();
  const window = host.window = createMainWindow(host);
  host.macTitlebar = registerMacTitlebar({ window, t, send, broadcast, getShortcuts: () => store.settings.shortcuts });
  if (host.desktopGlassWindow) return applyWindowBackdrop(host).then(finish);
  finish();

  function finish() {
    if (process.platform === 'win32') window.setAppDetails({ appId: appUserModelId, appIconPath: shellIcon, appIconIndex: 0,
      relaunchCommand: app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${root}"`,
      relaunchDisplayName,
    });
    host.windowZoom = registerWindowZoom({ window, screen, getZoom: () => store.settings.uiZoom, broadcast });
    host.dashboardWindow = createDashboard({ app, root, BrowserWindow, ipcMain, devUrl, t, records: dashboard,
      getProjects: () => store.projects, getSettings: () => store.settings, getMainWindow: () => window,
      getUiZoom: () => host.windowZoom?.percent ?? 100, backgroundColor: windowBackgroundColor });
    syncDashboardLive();
    host.labWindow = createLab({ app, root, BrowserWindow, ipcMain, devUrl, t, records: dashboard, helper: path.join(integrationDir, 'dispatch.cjs'),
      getProjects: () => store.projects, getSettings: () => store.settings, getMainWindow: () => window,
      getUiZoom: () => host.windowZoom?.percent ?? 100, backgroundColor: windowBackgroundColor });
    registerWindowContents({ window, Menu, clipboard, previewResources, pictureFrom, devUrl, t,
      getActiveTerminal: () => host.activeTerminal, getActiveFileTree: () => host.activeFileTree, getShortcuts: () => store.settings.shortcuts });
    registerWindowLifecycle({ window, getSettings: () => store.settings, isQuitting: () => host.quitting, hasTray: () => !!host.tray,
      requestQuit, report, send, updateIndicators, clearAttention: () => clearTimeout(host.attentionTimer) });
  }
}

function loadMainWindow(host) {
  const { Tray, trayImage, t, trayMenu, showWindow, Menu, process = globalThis.process, macMenu, store, captureBranch, window, devUrl } = host;
  const tray = host.tray = new Tray(trayImage('icon.png'));
  tray.setToolTip(t('Agentrix'));
  trayMenu();
  tray.on('click', () => showWindow());
  Menu.setApplicationMenu(process.platform === 'darwin' ? macMenu() : null);
  for (const project of store.projects) captureBranch(project);
  return window.loadURL(devUrl || 'agentrix://app/index.html');
}

module.exports = { createMainWindow, applyWindowBackdrop, openMainWindow, loadMainWindow };
