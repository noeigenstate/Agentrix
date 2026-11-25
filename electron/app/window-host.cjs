const { buildMacMenuTemplate } = require('./mac-menu.cjs');
const { translate } = require('../i18n.cjs');

const createTranslator = getStore => (text, values) => translate(getStore()?.settings.language, text, values);

function createWindowHost(host) {
  const platform = () => host.process?.platform ?? process.platform;

  function windowBackgroundColor() { return host.store.settings.theme === 'light' ? '#f8f9fb' : '#181818'; }
  // A first launch (no workspace file) follows this; read before applyNativeTheme, which overrides it on macOS.
  function systemTheme() { try { return host.nativeTheme.shouldUseDarkColors ? 'dark' : 'light'; } catch { return 'light'; } }
  // macOS draws its own window parts (the full-screen title strip, menus, dialogs) in the system appearance unless given the theme's.
  function applyNativeTheme() { if (platform() === 'darwin') host.nativeTheme.themeSource = host.store.settings.theme === 'light' ? 'light' : 'dark'; }
  function updateStoreSettings(patch) {
    const { store, sessions, updateBootstrapBackground, RemoteConnection, report, window, desktopGlassActive, windowZoom, macTitlebar } = host;
    const { theme, uiZoom, language, shortcuts, claudeBackgroundTasks } = store.settings || {};
    store.updateSettings(patch);
    if (claudeBackgroundTasks !== store.settings?.claudeBackgroundTasks) for (const session of sessions.values()) {
      if (session.bootstrapFile) {
        void Promise.resolve(updateBootstrapBackground(session.bootstrapFile, store.settings?.claudeBackgroundTasks)).catch(error => report(error));
      }
      const remote = session.remoteConnection || (session.terminal instanceof RemoteConnection ? session.terminal : null);
      remote?.setBackgroundTasks?.(store.settings?.claudeBackgroundTasks).catch(error => report(error));
    }
    if (theme !== store.settings.theme) applyNativeTheme();
    // An active system backdrop needs its transparent ground, including when the theme changes.
    if (theme !== store.settings.theme && window && !window.isDestroyed() && !desktopGlassActive) window.setBackgroundColor(windowBackgroundColor());
    // The settings IPC broadcasts after applying the window's new zoom.
    if (uiZoom !== store.settings.uiZoom) windowZoom?.update();
    const languageChanged = language !== store.settings.language;
    if (languageChanged) trayMenu();
    if (languageChanged || JSON.stringify(shortcuts) !== JSON.stringify(store.settings.shortcuts)) {
      macTitlebar?.refresh();
      if (platform() === 'darwin') rebuildMacMenu();
    }
  }
  function updateIndicators() {
    const { store, window, tray, t } = host;
    const unread = store.projects.filter(p => p.unread > 0).length;
    if (window && !window.isDestroyed()) {
      window.setTitle(platform() === 'darwin' && window.isFullScreen() ? '' : `${unread ? `(${unread}) ` : ''}${t('Agentrix')}`);
      if (!unread) window.flashFrame(false);
    }
    if (tray && !tray.isDestroyed()) {
      tray.setImage(trayImage(unread ? 'icon-alert.png' : 'icon.png'));
      tray.setToolTip(unread ? t('Agentrix · {count} 个项目待查看', { count: unread }) : t('Agentrix'));
    }
  }
  // The macOS menu bar draws an image at its own size in points, so the 256-pixel icon is scaled to fit it.
  function trayImage(name) {
    const { nativeImage, path, root } = host;
    const image = nativeImage.createFromPath(path.join(root, 'assets', name));
    return platform() === 'darwin' ? image.resize({ width: 18, height: 18 }) : image;
  }
  // macOS: the application menu gives ⌘Q, ⌘H and ⌘M their usual meaning. Copy and paste stay with the window's
  // own key handling (before-input-event and the terminals), so there is no Edit menu to compete with it.
  function macMenu() {
    const { Menu, app, t, store, updateManager, send, requestQuit, report } = host;
    return Menu.buildFromTemplate(buildMacMenuTemplate({
      appName: app.name, t, shortcuts: store?.settings.shortcuts,
      updateReady: updateManager?.getState().status === 'ready', command: command => {
        showWindow();
        send('menu:command', command);
      },
      quit: () => { showWindow(); requestQuit().catch(report); }, close: () => host.window?.close(),
      // A separate window: no need to show the main one. Errors reach the main window like the other main-process failures.
      openDashboard: () => host.dashboardWindow?.open().catch(report),
      openLab: () => host.labWindow?.open().catch(report),
    }));
  }

  function rebuildMacMenu() {
    if (platform() === 'darwin') host.Menu.setApplicationMenu(macMenu());
  }

  // Rebuilt when the language changes; Electron menus keep the labels they were built with.
  function trayMenu() {
    const { tray, Menu, t, requestQuit, report } = host;
    if (!tray || tray.isDestroyed()) return;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: t('打开 Agentrix'), click: () => showWindow() },
      { type: 'separator' },
      { label: t('退出应用'), click: () => { showWindow(); requestQuit().catch(report); } },
    ]));
  }

  function showWindow(id) {
    const { window, send } = host;
    if (!window || window.isDestroyed()) return;
    window.show();
    if (window.isMinimized()) window.restore();
    window.focus();
    if (id) send('project:focus', id);
  }

  function notifyCompletion(project) {
    const { window, store, Notification, t, path, root } = host;
    if (!window.isFocused()) {
      window.flashFrame(true); clearTimeout(host.attentionTimer);
      host.attentionTimer = setTimeout(() => { if (host.window && !host.window.isDestroyed()) host.window.flashFrame(false); }, 9000);
      host.attentionTimer.unref?.();
    }
    if (store.settings.notifications && Notification.isSupported()) {
      const note = new Notification({
        title: t('{name} · 本轮已完成', { name: project.name }),
        body: t('这一轮任务已结束，点击查看终端。'),
        icon: path.join(root, 'assets/icon-alert.png'),
        silent: !store.settings.sound,
      });
      note.on('click', () => showWindow(project.id));
      note.on('failed', () => {});
      note.show();
    }
  }

  function updateListener() {
    let menuUpdateReady = false;
    return state => {
      host.updatesIpc?.onStateChange(state);
      host.send('updates:changed', state);
      const ready = state.status === 'ready';
      if (ready !== menuUpdateReady) {
        menuUpdateReady = ready;
        rebuildMacMenu();
      }
    };
  }

  return { windowBackgroundColor, systemTheme, applyNativeTheme, updateStoreSettings, updateIndicators,
      trayImage, macMenu, rebuildMacMenu, trayMenu, showWindow, notifyCompletion, updateListener };
}

module.exports = { createWindowHost, createTranslator };
