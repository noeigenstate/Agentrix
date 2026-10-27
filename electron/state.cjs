const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { normalizeSSH } = require('./ssh-config.cjs');
const { sanitizeProjectSvg } = require('./project-svg.cjs');
const { MODELS: VOICE_MODELS, DEFAULT_MODEL: DEFAULT_VOICE_MODEL } = require('./voice.cjs');

// Local folders once opened as projects, newest first, so a removed project can be added again in one click.
const HISTORY_LIMIT = 30;
const folderKey = folder => process.platform === 'win32' ? folder.toLowerCase() : folder;
function cleanHistory(input) {
  const seen = new Set();
  return (Array.isArray(input) ? input : []).filter(item => {
    if (!item || typeof item.path !== 'string' || item.path.length > 4096 || !path.isAbsolute(item.path) || seen.has(folderKey(item.path))) return false;
    seen.add(folderKey(item.path)); return true;
  }).slice(0, HISTORY_LIMIT).map(item => ({ path: item.path, name: String(item.name || path.basename(item.path) || item.path).slice(0, 120), lastOpenedAt: Number.isSafeInteger(item.lastOpenedAt) ? item.lastOpenedAt : 0 }));
}

// SSH projects once opened, the same way: the host and remote folder, to add again in one click (connecting anew).
const sshKey = item => `${item.host}\n${item.path}`;
function cleanSSHHistory(input) {
  const seen = new Set();
  return (Array.isArray(input) ? input : []).flatMap(item => {
    let connection;
    try { connection = normalizeSSH({ host: item?.host, path: item?.path }); } catch { return []; }
    if (seen.has(sshKey(connection))) return [];
    seen.add(sshKey(connection));
    return [{ host: connection.host, path: connection.path, name: String(item.name || connection.host).slice(0, 120), lastOpenedAt: Number.isSafeInteger(item.lastOpenedAt) ? item.lastOpenedAt : 0 }];
  }).slice(0, HISTORY_LIMIT);
}

// Which coding agent a terminal restores (Codex unless recorded as Claude Code), whether its last Claude turn was
// left unfinished. Only non-default values are stored.
const agentFields = restore => ({ ...(restore?.agent === 'claude' ? { agent: 'claude' } : {}), ...(restore?.interrupted === true ? { interrupted: true } : {}) });

function cleanRestore(input, kind) {
  return {
    terminal: input?.terminal === true, codex: input?.codex === true,
    cwd: typeof input?.cwd === 'string' && (kind === 'ssh' ? input.cwd.startsWith('/') : path.isAbsolute(input.cwd)) ? input.cwd : null,
    ...(/^[a-f\d-]{36}$/i.test(input?.threadId || '') ? { threadId: input.threadId } : {}),
    ...agentFields(input),
  };
}

// Where the window opens: the decisions to make (the home page) or the grid of projects. Isolated test profiles
// open on the grid they exercise unless they ask for the home page.
const DEFAULT_START = process.env.AGENTRIX_DATA_DIR && process.env.AGENTRIX_TEST_HOME !== '1' ? 'workspace' : 'decisions';
const defaults = { startView: DEFAULT_START, surface: 'glass', glassBackground: 'theme', glassTransparency: null, terminalRenderer: 'gpu', autoSave: true, activityPane: true, notifications: true, sound: true, language: 'en', theme: 'mono', shortcuts: {}, guideVersion: '', shell: 'powershell', closeToTray: true, explorerCollapsed: false, hideTreeNoise: false, fontSize: 12, terminalFontWeight: 400, terminalFontFamily: '', terminalCjkFontFamily: '', userAvatar: '', restoreSessions: true, focusAnimation: 'smooth', voiceModel: DEFAULT_VOICE_MODEL };

// Keyboard shortcuts the user changed, by action; defaults live in the window (src/features/shortcuts/shortcuts.ts).
// "Ctrl+Shift+F": Ctrl, Alt and Shift in that order, then one letter, digit, F-key or punctuation key.
// The user's picture is a small data URL made in the window (256x256 WebP, about 20 KB); anything else is dropped.
const AVATAR_URL = /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
const AVATAR_MAX_LENGTH = 200_000;
const PROJECT_IMAGE_MODES = new Set(['auto', 'custom', 'number']);
const SHORTCUT_ACTIONS = ['search', 'addProject', 'voice', 'overview', 'decisions', 'explorer', 'settings', 'nextProject', 'previousProject', 'projectAbove', 'projectBelow', 'maximize', 'fullscreen', 'newTerminal', 'removeProject'];
const SHORTCUT = /^(?:(?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?(?:F(?:[1-9]|1[0-2]))|(?=Ctrl\+|Alt\+)(?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?(?:[A-Z0-9,./;'[\]\\=`-]|Space|Tab|Enter|Left|Right|Up|Down))$/;
function cleanShortcuts(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return Object.fromEntries(SHORTCUT_ACTIONS.filter(action => typeof input[action] === 'string' && SHORTCUT.test(input[action])).map(action => [action, input[action]]));
}

// Persist only bounded raster snapshots or canonical static SVGs, never external paths.
function validProjectImage(input) {
  if (typeof input === 'string' && input.startsWith('data:image/svg+xml;')) return sanitizeProjectSvg(input) === input;
  if (typeof input !== 'string' || input.length > AVATAR_MAX_LENGTH || !AVATAR_URL.test(input)) return false;
  const [type, data] = input.slice(5).split(';base64,');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) return false;
  const chunk = bytes.toString('ascii', 12, 16);
  if (type === 'image/png') return bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && chunk === 'IHDR';
  if (type === 'image/jpeg') return bytes.length >= 20 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.readUInt32LE(4) + 8 !== bytes.length || bytes.toString('ascii', 8, 12) !== 'WEBP') return false;
  return ['VP8 ', 'VP8L'].includes(chunk) || chunk === 'VP8X' && bytes.length >= 30 && !(bytes[20] & 2);
}

function cleanSettings(input = {}) {
  return {
    fontSize: Number.isInteger(input.fontSize) && input.fontSize >= 10 && input.fontSize <= 20 ? input.fontSize : defaults.fontSize,
    terminalFontWeight: [400, 500, 600].includes(input.terminalFontWeight) ? input.terminalFontWeight : defaults.terminalFontWeight,
    terminalFontFamily: typeof input.terminalFontFamily === 'string' && input.terminalFontFamily.length <= 80 && !/[\u0000-\u001f\u007f]/.test(input.terminalFontFamily) ? input.terminalFontFamily.trim() : defaults.terminalFontFamily,
    terminalCjkFontFamily: typeof input.terminalCjkFontFamily === 'string' && input.terminalCjkFontFamily.length <= 80 && !/[\u0000-\u001f\u007f]/.test(input.terminalCjkFontFamily) ? input.terminalCjkFontFamily.trim() : defaults.terminalCjkFontFamily,
    userAvatar: typeof input.userAvatar === 'string' && input.userAvatar.length <= AVATAR_MAX_LENGTH && AVATAR_URL.test(input.userAvatar) ? input.userAvatar : defaults.userAvatar,
    focusAnimation: ['smooth', 'system', 'off'].includes(input.focusAnimation) ? input.focusAnimation : defaults.focusAnimation,
    startView: ['decisions', 'workspace'].includes(input.startView) ? input.startView : defaults.startView,
    language: ['zh', 'en'].includes(input.language) ? input.language : defaults.language,
    // Ids of src/shared/themes.ts; a profile that holds a removed theme gets the first.
    theme: ['mono', 'light'].includes(input.theme) ? input.theme : defaults.theme,
    // glass: translucent panes over the wallpaper. solid: opaque panes, on which Windows draws text with
    // ClearType and nothing is blurred behind them.
    surface: input.surface === 'solid' ? 'solid' : 'glass',
    // Kept when toggling solid/glass.
    glassBackground: input.glassBackground === 'desktop' ? 'desktop' : 'theme',
    glassTransparency: Number.isInteger(input.glassTransparency) && input.glassTransparency >= 0 && input.glassTransparency <= 100 ? input.glassTransparency : defaults.glassTransparency,
    terminalRenderer: input.terminalRenderer === 'dom' ? 'dom' : 'gpu',
    // The offline recognizer for dictation (voice.cjs).
    voiceModel: Object.hasOwn(VOICE_MODELS, input.voiceModel) ? input.voiceModel : defaults.voiceModel,
    shortcuts: cleanShortcuts(input.shortcuts),
    // Shell for local terminals: PowerShell or Command Prompt on Windows, Bash or zsh on Linux (until one is
    // chosen there, the login shell's kind). SSH projects always use Bash on the server.
    shell: ['cmd', 'bash', 'zsh'].includes(input.shell) ? input.shell : 'powershell',
    // The app version whose usage guide was last shown; a newer version shows it again.
    guideVersion: typeof input.guideVersion === 'string' && /^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(input.guideVersion) ? input.guideVersion : '',
    // Spoken completion phrase; empty uses the built-in phrases. {项目} or {project} is the project name.
    ...Object.fromEntries(['notifications', 'sound', 'closeToTray', 'explorerCollapsed', 'hideTreeNoise', 'restoreSessions', 'autoSave', 'activityPane'].map(key => [key, typeof input[key] === 'boolean' ? input[key] : defaults[key]])),
  };
}

class WorkspaceStore {
  constructor(filename) {
    this.filename = filename;
    this.projects = [];
    this.history = [];
    this.sshHistory = [];
    this.settings = { ...defaults };
    this.warning = null;
    if (!fs.existsSync(filename)) return;
    try {
      const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (value.version !== 2 || !Array.isArray(value.projects)) throw new Error('Unsupported workspace format');
      const ids = new Set();
      this.projects = value.projects.filter(p => {
        if (!p || typeof p.id !== 'string' || typeof p.path !== 'string' || ids.has(p.id)) return false;
        if (p.kind === 'ssh') { try { normalizeSSH({ ...p.ssh, path: p.path }); } catch { return false; } }
        else if (!path.isAbsolute(p.path)) return false;
        ids.add(p.id); return true;
      }).map(p => {
        const image = validProjectImage(p.image) ? p.image : '';
        const imageMode = PROJECT_IMAGE_MODES.has(p.imageMode) && (p.imageMode !== 'custom' || image) ? p.imageMode : null;
        return {
          id: p.id, name: String(p.name || path.basename(p.path)).slice(0, 120), path: p.path,
          kind: p.kind === 'ssh' ? 'ssh' : 'local',
          ...(image && imageMode !== 'number' ? { image } : {}),
          ...(imageMode ? { imageMode } : {}),
          ...(p.kind === 'ssh' ? { ssh: { host: p.ssh.host, configFile: p.ssh.configFile || null } } : {}),
          primaryTerminalClosed: p.primaryTerminalClosed === true,
          restore: p.restore && typeof p.restore === 'object' ? cleanRestore(p.restore, p.kind) : null,
          terminals: Array.isArray(p.terminals) ? p.terminals.filter(item => item && /^[a-f\d-]{36}$/i.test(item.id || '')).map(item => ({ id: item.id, restore: cleanRestore(item.restore, p.kind) })) : [],
          unread: Number.isSafeInteger(p.unread) && p.unread > 0 ? p.unread : 0,
          lastCompletedAt: typeof p.lastCompletedAt === 'number' ? p.lastCompletedAt : null,
          completionArmed: p.completionArmed === true,
          seenEvents: Array.isArray(p.seenEvents) ? p.seenEvents.filter(x => typeof x === 'string').slice(-128) : [],
          // The order its terminals were dragged into, when they were (ids it no longer has are ignored).
          ...(Array.isArray(p.terminalOrder) ? { terminalOrder: p.terminalOrder.filter(id => typeof id === 'string' && /^[a-f\d-]{36}$/i.test(id)).slice(0, 64) } : {}),
        };
      });
      this.settings = cleanSettings(value.settings);
      this.history = cleanHistory(value.history);
      this.sshHistory = cleanSSHHistory(value.sshHistory);
      const terminalIds = new Set(this.projects.map(project => project.id));
      for (const project of this.projects) project.terminals = project.terminals.filter(item => { if (terminalIds.has(item.id)) return false; terminalIds.add(item.id); return true; });
    } catch {
      const backup = `${filename}.unreadable-${Date.now()}`;
      fs.copyFileSync(filename, backup);
      this.warning = `工作区配置无法读取，原文件已保留在 ${backup}`;
    }
  }

  add(folder, name) {
    const canonical = fs.realpathSync(folder);
    if (!fs.statSync(canonical).isDirectory()) throw new Error('请选择项目文件夹。');
    const key = folderKey(canonical);
    const existing = this.projects.find(p => p.kind !== 'ssh' && folderKey(p.path) === key);
    if (existing) return { project: existing, added: false };
    const project = { id: randomUUID(), name: String(name || path.basename(canonical) || canonical).slice(0, 120), path: canonical, kind: 'local', primaryTerminalClosed: false, restore: { terminal: false, codex: false }, unread: 0, lastCompletedAt: null, completionArmed: false, seenEvents: [] };
    this.projects.push(project);
    this.remember(project);
    this.save();
    return { project, added: true };
  }

  // Record a project as recently opened. Called when it is added and again when it is removed.
  remember(project, now = Date.now()) {
    if (project.kind === 'ssh') {
      const entry = { host: project.ssh.host, path: project.path, name: project.name, lastOpenedAt: now };
      this.sshHistory = [entry, ...this.sshHistory.filter(item => sshKey(item) !== sshKey(entry))].slice(0, HISTORY_LIMIT);
      return;
    }
    const key = folderKey(project.path);
    this.history = [{ path: project.path, name: project.name, lastOpenedAt: now }, ...this.history.filter(item => folderKey(item.path) !== key)].slice(0, HISTORY_LIMIT);
  }

  // Recent folders that are not open as a project right now.
  recentProjects() {
    const open = new Set(this.projects.filter(p => p.kind !== 'ssh').map(p => folderKey(p.path)));
    return this.history.filter(item => !open.has(folderKey(item.path)));
  }

  recentEntry(folder) { return typeof folder === 'string' ? this.history.find(item => folderKey(item.path) === folderKey(folder)) : undefined; }
  isRecent(folder) { return !!this.recentEntry(folder); }
  forget(folder) { if (typeof folder !== 'string') return; this.history = this.history.filter(item => folderKey(item.path) !== folderKey(folder)); this.save(); }
  clearHistory() { this.history = []; this.save(); }
  // SSH connections once opened that are not open as a project right now.
  recentSSH() {
    const open = new Set(this.projects.filter(p => p.kind === 'ssh').map(p => sshKey({ host: p.ssh.host, path: p.path })));
    return this.sshHistory.filter(item => !open.has(sshKey(item)));
  }
  forgetSSH(host, folder) { this.sshHistory = this.sshHistory.filter(item => sshKey(item) !== sshKey({ host, path: folder })); this.save(); }
  clearSSHHistory() { this.sshHistory = []; this.save(); }

  addSSH(input) {
    const connection = normalizeSSH(input);
    const existing = this.projects.find(p => p.kind === 'ssh' && p.ssh.host === connection.host && p.ssh.configFile === connection.configFile && p.path === connection.path);
    if (existing) return { project: existing, added: false };
    const base = path.posix.basename(connection.path);
    const project = { id: randomUUID(), name: String(input.name || (base === '~' ? connection.host : base) || connection.host).slice(0, 120), kind: 'ssh', path: connection.path, ssh: { host: connection.host, configFile: connection.configFile }, primaryTerminalClosed: false, restore: { terminal: false, codex: false }, unread: 0, lastCompletedAt: null, completionArmed: false, seenEvents: [] };
    this.projects.push(project); this.remember(project); this.save(); return { project, added: true };
  }

  setProjectImage(id, image, mode = image ? 'custom' : 'number') {
    const project = this.projects.find(item => item.id === id);
    if (!project) throw new Error('项目不存在。');
    if (!PROJECT_IMAGE_MODES.has(mode) || mode === 'number' && image !== '' || mode === 'custom' && !image) throw new Error('无效的项目图片模式。');
    if (image !== '' && !validProjectImage(image)) throw new Error('请选择有效的项目图片：WebP、PNG、JPEG 不超过 150 KB，静态 SVG 不超过 100 KB。');
    if ((project.image || '') === image && project.imageMode === mode) return;
    const previous = project.image, previousMode = project.imageMode;
    if (image) project.image = image;
    else delete project.image;
    project.imageMode = mode;
    try { this.save(); }
    catch (error) {
      if (previous) project.image = previous;
      else delete project.image;
      if (previousMode) project.imageMode = previousMode;
      else delete project.imageMode;
      throw error;
    }
  }

  setRestore(id, patch) {
    const found = this.findTerminal(id);
    if (!found) return;
    const { project, record } = found;
    const next = { terminal: record.restore?.terminal === true, codex: record.restore?.codex === true, cwd: record.restore?.cwd || null, ...(record.restore?.threadId ? { threadId: record.restore.threadId } : {}), ...agentFields(record.restore) };
    if (typeof patch.terminal === 'boolean') next.terminal = patch.terminal;
    if (typeof patch.codex === 'boolean') next.codex = patch.codex;
    if (typeof patch.cwd === 'string' && patch.cwd.length <= 4096 && !/[\0\r\n]/.test(patch.cwd) && (project.kind === 'ssh' ? patch.cwd.startsWith('/') : path.isAbsolute(patch.cwd))) next.cwd = patch.cwd;
    if (patch.threadId === null) delete next.threadId;
    else if (/^[a-f\d-]{36}$/i.test(patch.threadId || '')) next.threadId = patch.threadId;
    if (patch.agent === 'codex' || patch.agent === 'claude') { delete next.agent; delete next.interrupted; Object.assign(next, agentFields({ ...record.restore, agent: patch.agent })); }
    if (typeof patch.interrupted === 'boolean') { delete next.interrupted; Object.assign(next, agentFields({ interrupted: patch.interrupted })); }
    const wasClosed = project.primaryTerminalClosed;
    if (record === project) {
      if (patch.terminal === true) project.primaryTerminalClosed = false;
      else if (patch.primaryClosed === true) project.primaryTerminalClosed = true;
    }
    if (JSON.stringify(next) === JSON.stringify(record.restore) && wasClosed === project.primaryTerminalClosed) return;
    record.restore = next;
    this.save();
  }

  findTerminal(id) {
    for (const project of this.projects) {
      if (project.id === id) return { project, record: project };
      const record = project.terminals?.find(item => item.id === id);
      if (record) return { project, record };
    }
    return null;
  }

  addTerminal(projectId) {
    const project = this.projects.find(item => item.id === projectId);
    if (!project) throw new Error('项目不存在。');
    const terminal = { id: randomUUID(), restore: { terminal: true, codex: false, cwd: project.path } };
    project.terminals ||= []; project.terminals.push(terminal); this.save(); return terminal.id;
  }

  removeTerminal(id) {
    const found = this.findTerminal(id);
    if (!found) return;
    if (found.project.id === id) this.setRestore(id, { terminal: false, codex: false, threadId: null, primaryClosed: true });
    else { found.project.terminals = found.project.terminals.filter(item => item.id !== id); this.save(); }
  }

  setTerminalOrder(projectId, ids) {
    const project = this.projects.find(item => item.id === projectId);
    if (!project) throw new Error('项目不存在。');
    project.terminalOrder = [...ids]; this.save();
  }

  reorderProjects(ids) {
    const records = new Map(this.projects.map(project => [project.id, project]));
    if (!Array.isArray(ids) || ids.length !== this.projects.length || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !records.has(id))) throw new Error('项目列表已变化，请重新拖动排序。');
    this.projects = ids.map(id => records.get(id));
    this.save();
  }

  expectCompletion(id, expected = true) {
    const project = this.projects.find(p => p.id === id);
    if (!project || project.completionArmed === expected) return;
    project.completionArmed = expected;
    this.save();
  }

  complete(id, eventId, now = Date.now()) {
    const project = this.projects.find(p => p.id === id);
    if (!project || typeof eventId !== 'string' || !eventId || eventId.length > 256 || project.seenEvents.includes(eventId)) return false;
    project.seenEvents = [...project.seenEvents, eventId].slice(-128);
    // Background callbacks can use a different thread/turn ID without any new
    // instruction. Remember those IDs too, but grant only one alert per input.
    if (!project.completionArmed) { this.save(); return false; }
    project.completionArmed = false;
    project.unread += 1;
    project.lastCompletedAt = now;
    this.save();
    return true;
  }

  acknowledge(id) {
    const project = this.projects.find(p => p.id === id);
    if (project) project.unread = 0;
    this.save();
  }

  remove(id) {
    const project = this.projects.find(p => p.id === id);
    if (project) this.remember(project);
    this.projects = this.projects.filter(p => p.id !== id); this.save();
  }
  updateSettings(patch) { this.settings = cleanSettings({ ...this.settings, ...patch }); this.save(); }
  save() {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    const tmp = `${this.filename}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 2, projects: this.projects, settings: this.settings, history: this.history, sshHistory: this.sshHistory }, null, 2));
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(tmp, this.filename); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code) || attempt >= 4) throw error;
        // Brief Windows reader/indexer locks must not lose a newly captured
        // session ID. Retain atomic replacement and stop after 100ms total.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, (attempt + 1) * 10);
      }
    }
  }
}

module.exports = { WorkspaceStore, cleanSettings };
