const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');

const APP_ID = 'local.projectgrid.desktop';
const APP_NAME = 'Agentrix';

function windowsAppId({ packaged, installed, profile }) {
  // Profile directories isolate the single-instance lock; tests share one shell identity.
  if (profile) return `${APP_ID}.test`;
  if (!packaged) return `${APP_ID}.development`;
  return installed ? APP_ID : `${APP_ID}.portable`;
}

function windowsDisplayName({ packaged, installed, profile }) {
  if (profile) return `${APP_NAME} Test`;
  if (!packaged) return `${APP_NAME} Dev`;
  return installed ? APP_NAME : `${APP_NAME} Portable`;
}

async function registerNotificationIdentity({ appUserModelId, displayName, icon, execFile: execute = execFile }) {
  if (appUserModelId === APP_ID) return;
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${appUserModelId}`;
  const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  const run = args => new Promise(resolve => execute(reg, args, { windowsHide: true, timeout: 5000 }, (error, stdout) => resolve(error ? '' : stdout)));
  try {
    for (const [name, value] of [['DisplayName', displayName], ['IconUri', icon]]) {
      // Match data inside reg.exe so Unicode paths do not depend on its output code page.
      const current = await run(['query', key, '/f', value, '/d', '/e', '/c']);
      if (new RegExp(`^\\s+${name}\\s+REG_(?:EXPAND_)?SZ\\s`, 'mi').test(current)) continue;
      await run(['add', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f']);
    }
  } catch { /* Shell branding must never prevent startup. */ }
}

function materializeIcon(iconSource, userData) {
  const iconBytes = fs.readFileSync(iconSource);
  const iconFolder = path.join(userData, 'shell-icons');
  fs.mkdirSync(iconFolder, { recursive: true });
  const icon = path.join(iconFolder, `agentrix-${createHash('sha256').update(iconBytes).digest('hex').slice(0, 12)}.ico`);
  if (!fs.existsSync(icon)) fs.writeFileSync(icon, iconBytes);
  return icon;
}

function refreshSearchIcons({ localAppData, userData, iconSource }) {
  const changes = [], warnings = [];
  if (!localAppData) return { changes, warnings };
  const revision = createHash('sha256').update(fs.readFileSync(iconSource)).digest('hex');
  const marker = path.join(userData, 'shell-icons', 'search-cache-v1.json');
  try { if (JSON.parse(fs.readFileSync(marker, 'utf8')).revision === revision) return { changes, warnings }; } catch {}
  const packages = path.resolve(localAppData, 'Packages');
  // Search keeps a separate icon bitmap keyed by AppUserModelID. Updating a
  // shortcut or refreshing Explorer does not invalidate this bitmap.
  const ownedNames = new Set([APP_ID, `${APP_ID}.portable`].map(id => id.replaceAll('.', '_')));
  try {
    for (const entry of fs.readdirSync(packages, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^Microsoft\.Windows\.(Search|Cortana)_[a-z0-9]+$/i.test(entry.name)) continue;
      const cache = path.join(packages, entry.name, 'LocalState', 'AppIconCache');
      if (!fs.existsSync(cache)) continue;
      for (const scale of fs.readdirSync(cache, { withFileTypes: true })) {
        if (!scale.isDirectory() || !/^\d+$/.test(scale.name)) continue;
        for (const name of ownedNames) {
          const source = path.resolve(cache, scale.name, name);
          if (!source.startsWith(cache + path.sep) || !fs.existsSync(source)) continue;
          const backupFolder = path.join(userData, 'shortcut-backups', 'search-icons');
          const backup = path.join(backupFolder, `${entry.name}-${scale.name}-${name}-${Date.now()}`);
          try {
            if (!fs.lstatSync(source).isFile()) continue;
            fs.mkdirSync(backupFolder, { recursive: true });
            fs.copyFileSync(source, backup, fs.constants.COPYFILE_EXCL);
            fs.unlinkSync(source);
            changes.push({ action: 'refresh-search-icon', source, backup });
          } catch (error) { warnings.push(String(error.message)); }
        }
      }
    }
  } catch (error) { if (error.code !== 'ENOENT') warnings.push(String(error.message)); }
  if (!warnings.length) {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ revision }));
  }
  return { changes, warnings };
}

function repairShortcuts({ shell, executable, iconSource, userData, programs, commonPrograms, desktop, commonDesktop, createDesktop = false }) {
  const changes = [], warnings = [];
  const icon = materializeIcon(iconSource, userData);
  const read = filename => { try { return shell.readShortcutLink(filename); } catch { return null; } };
  const same = (a, b) => typeof a === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const ensure = (filename, create) => {
    const exists = fs.existsSync(filename), previous = exists ? read(filename) : null;
    if (!exists && !create) return;
    if (exists && (!previous || previous.appUserModelId !== APP_ID && !same(previous.target, executable))) return;
    const wanted = { target: executable, cwd: path.dirname(executable), description: 'Agentrix · 面向未来的 AI 编辑器', icon, iconIndex: 0, appUserModelId: APP_ID };
    if (previous && Object.entries(wanted).every(([key, value]) => previous[key] === value)) return;
    try {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      if (!shell.writeShortcutLink(filename, exists ? 'update' : 'create', wanted)) throw new Error(`无法写入快捷方式：${filename}`);
      changes.push({ action: exists ? 'repair-shortcut' : 'create-shortcut', path: filename });
    } catch (error) { warnings.push(String(error.message)); }
  };
  ensure(path.join(programs, `${APP_NAME}.lnk`), true);
  if (commonPrograms) ensure(path.join(commonPrograms, `${APP_NAME}.lnk`), false);
  if (desktop) ensure(path.join(desktop, `${APP_NAME}.lnk`), createDesktop);
  if (commonDesktop) ensure(path.join(commonDesktop, `${APP_NAME}.lnk`), false);
  return { icon, changes, warnings };
}

module.exports = { APP_ID, windowsAppId, windowsDisplayName, registerNotificationIdentity, materializeIcon, repairShortcuts, refreshSearchIcons };
