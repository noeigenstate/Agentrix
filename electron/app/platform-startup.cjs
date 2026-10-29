const path = require('node:path');
const { execFile } = require('node:child_process');
const { isInstalledBuild } = require('../updates.cjs');
const { windowsAppId, windowsDisplayName, registerNotificationIdentity, materializeIcon, repairShortcuts, refreshSearchIcons } = require('../windows-integration.cjs');
const { findShell, prepareZshStartup, withoutAppImage, loginShellPath, mergePath } = require('../zsh-terminal.cjs');

function configureApplication(app) {
  if (process.env.AGENTRIX_DATA_DIR) app.setPath('userData', path.resolve(process.env.AGENTRIX_DATA_DIR));
  else if (app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'Agentrix'));
  else {
    // `npm run dev` / `npm start` run beside the installed app, often from one of its own terminals.
    const devProfile = path.join(app.getPath('appData'), 'Agentrix Dev');
    require('../dev-profile.cjs').seedDevProfile(path.join(app.getPath('appData'), 'Agentrix'), devProfile);
    app.setPath('userData', devProfile);
  }
  // Downloaded voice models are shared with the installed app instead of being fetched again for a dev profile.
  const voiceDirectory = path.join(!app.isPackaged && !process.env.AGENTRIX_DATA_DIR ? path.join(app.getPath('appData'), 'Agentrix') : app.getPath('userData'), 'voice');
  app.setName('Agentrix');
  const installed = isInstalledBuild(app.isPackaged, process.execPath);
  const build = { packaged: app.isPackaged, installed, profile: process.env.AGENTRIX_DATA_DIR };
  const appUserModelId = windowsAppId(build);
  if (process.platform === 'win32') app.setAppUserModelId(appUserModelId);
  return { installed, appUserModelId, relaunchDisplayName: windowsDisplayName(build), voiceDirectory };
}

function prepareWindowIcon({ app, shell, root, installed, appUserModelId, relaunchDisplayName }) {
  let shellIcon = path.join(root, 'assets/icon.ico');
  if (process.platform !== 'win32') return shellIcon;
  shellIcon = materializeIcon(shellIcon, app.getPath('userData'));
  void registerNotificationIdentity({ appUserModelId, displayName: relaunchDisplayName, icon: shellIcon });
  const refreshIcons = () => execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/ie4uinit.exe'), ['-show'], { windowsHide: true, timeout: 5000 }, () => {});
  if (installed && !process.env.AGENTRIX_DATA_DIR) {
    try {
      const repaired = repairShortcuts({ shell, executable: process.execPath, iconSource: shellIcon, userData: app.getPath('userData'),
        programs: path.join(app.getPath('appData'), 'Microsoft/Windows/Start Menu/Programs'),
        commonPrograms: process.env.ProgramData ? path.join(process.env.ProgramData, 'Microsoft/Windows/Start Menu/Programs') : null,
        desktop: app.getPath('desktop'), commonDesktop: process.env.PUBLIC ? path.join(process.env.PUBLIC, 'Desktop') : null,
      });
      shellIcon = repaired.icon;
      if (repaired.changes.length) refreshIcons();
    } catch (error) { console.warn('Windows shortcut repair:', error.message); }
  }
  if (app.isPackaged && !process.env.AGENTRIX_DATA_DIR) {
    try {
      const refreshed = refreshSearchIcons({ localAppData: process.env.LOCALAPPDATA, userData: app.getPath('userData'), iconSource: shellIcon });
      if (refreshed.changes.length) refreshIcons();
    } catch (error) { console.warn('Windows Search icon refresh:', error.message); }
  }
  return shellIcon;
}

function prepareShellIntegration({ app, integrationDir, agents }) {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  const startup = prepareZshStartup(path.join(app.getPath('userData'), 'zsh'), integrationDir);
  // Started from the Dock or a desktop launcher, this process may have only the system PATH; codex, claude and
  // npm are found with the login shell's. Terminals build their own from the user's start-up files.
  loginShellPath(process.platform === 'linux' ? { shell: process.env.SHELL || findShell('bash') || '/bin/bash', env: withoutAppImage(process.env) } : undefined).then(value => { if (value) process.env.PATH = mergePath(value, process.env.PATH); agents.changed(); }).catch(() => {});
  return startup;
}

module.exports = { configureApplication, prepareWindowIcon, prepareShellIntegration };
