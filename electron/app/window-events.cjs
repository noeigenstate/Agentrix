const DEFAULT_SHORTCUTS = require('../shortcuts.json');

// The same "Ctrl+Shift+F" form the window records (src/features/shortcuts/shortcuts.ts), from an Electron input event.
const SHORTCUT_KEYS = { Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`', Space: 'Space', Tab: 'Tab', Enter: 'Enter', NumpadEnter: 'Enter', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down' };
function isAppShortcut(input, shortcuts) {
  const code = String(input.code || '');
  const key = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : /^F([1-9]|1[0-2])$/.test(code) ? code : SHORTCUT_KEYS[code];
  if (!key) return false;
  const pressed = [input.control && 'Ctrl', input.alt && 'Alt', input.shift && 'Shift', key].filter(Boolean).join('+');
  return Object.values({ ...DEFAULT_SHORTCUTS, ...shortcuts }).includes(pressed);
}

function registerWindowContents({ window, Menu, clipboard, previewResources, pictureFrom, devUrl, t, getActiveTerminal, getActiveFileTree, getShortcuts }) {
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // A picture copies as an image every program pastes (a chat, a document, a paint program): its own bytes, from
  // where the page loaded it (a project's preview, a data URL, the web), decoded to a bitmap. Chromium's copy of what
  // is under the pointer is only the fallback: inside a web page's frame the menu's point is not the picture's.
  const copyPicture = async params => {
    try {
      const image = await pictureFrom(contents, params.srcURL);
      if (image && !image.isEmpty()) { clipboard.writeImage(image); return; }
    } catch { /* fall back to Chromium's copy */ }
    contents.copyImageAt(params.x, params.y);
  };
  contents.on('context-menu', (_event, params) => {
    // A picture (one enlarged in its popup, one in a reply) copies whole, as a browser's "Copy image" does.
    const picture = params.mediaType === 'image' && params.hasImageContents;
    if (!picture && (getActiveTerminal() || (!params.isEditable && !params.selectionText))) return;
    const items = picture ? [{ label: t('复制图片'), click: () => void copyPicture(params) }] : params.isEditable ? [
      { label: t('撤销'), role: 'undo' }, { label: t('重做'), role: 'redo' }, { type: 'separator' },
      { label: t('剪切'), role: 'cut' }, { label: t('复制'), role: 'copy' }, { label: t('粘贴'), role: 'paste' }, { type: 'separator' }, { label: t('全选'), role: 'selectAll' },
    ] : [{ label: t('复制'), role: 'copy' }];
    Menu.buildFromTemplate(items).popup({ window });
  });
  // A frameless window has no Edit menu accelerators. Explicitly retain
  // standard editing shortcuts for inputs, including SSH password fields.
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || getActiveTerminal() || input.alt) return;
    // An app shortcut (Ctrl+Shift+N adds a project by default) reaches the window, which keeps the usual
    // editing meaning inside text boxes and runs the action elsewhere.
    if (isAppShortcut(input, getShortcuts())) return;
    const key = input.key.toLowerCase();
    if (getActiveFileTree() && (((input.control || input.meta) && ['a', 'c', 'v'].includes(key)) || ['delete', 'f2'].includes(key) || (key === 'insert' && (input.control || input.shift)))) return;
    let action;
    if (process.platform === 'darwin' ? input.meta : input.control || input.meta) action = { c: 'copy', x: 'cut', v: input.shift ? 'pasteAndMatchStyle' : 'paste', a: 'selectAll', z: input.shift ? 'redo' : 'undo', y: 'redo', insert: 'copy' }[key];
    else if (input.shift && key === 'insert') action = 'paste';
    if (action) { event.preventDefault(); contents[action](); }
  });
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-frame-navigate', event => {
    if (!event.isMainFrame && event.url !== 'about:blank' && !previewResources.hasUrl(event.url)) event.preventDefault();
  });
  const allowPlayerFullscreen = (source, permission, details) => permission === 'fullscreen' && source === contents && details.isMainFrame === true;
  const isAppFrame = (source, details) => source === contents && details.isMainFrame === true && (devUrl ? source.getURL().startsWith(devUrl + '/') : source.getURL().startsWith('agentrix://app/'));
  contents.session.setPermissionRequestHandler((source, permission, callback, details) => callback(allowPlayerFullscreen(source, permission, details) || permission === 'media' && isAppFrame(source, details) && details.mediaTypes?.length > 0 && details.mediaTypes.every(type => type === 'audio')));
  contents.session.setPermissionCheckHandler((source, permission, _origin, details) => allowPlayerFullscreen(source, permission, details) || permission === 'media' && isAppFrame(source, details) && details.mediaType === 'audio');
}

function registerWindowLifecycle({ window, getSettings, isQuitting, hasTray, requestQuit, report, send, clearAttention }) {
  // Native fullscreen can temporarily mark a visible window as occluded.
  // Keep its live terminals and zoom painting; throttle only after hiding it.
  for (const event of ['hide', 'minimize']) window.on(event, () => window.webContents.setBackgroundThrottling(true));
  for (const event of ['show', 'restore']) window.on(event, () => window.webContents.setBackgroundThrottling(false));
  window.once('ready-to-show', () => window.show());
  window.on('focus', () => { clearAttention(); window.flashFrame(false); });
  window.on('enter-full-screen', () => send('window:fullscreen-changed', true));
  window.on('leave-full-screen', () => send('window:fullscreen-changed', false));
  // The reason (crashed, oom, killed…) and exit code are kept in the log before the window loads again.
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error(`Window renderer gone: ${JSON.stringify({ reason: details.reason, exitCode: details.exitCode, terminalRenderer: getSettings().terminalRenderer })}`);
    if (!isQuitting() && details.reason !== 'clean-exit') window.reload();
  });
  window.on('close', event => {
    if (isQuitting()) return;
    event.preventDefault();
    if (getSettings().closeToTray && hasTray()) window.hide();
    else requestQuit().catch(report);
  });
}

module.exports = { registerWindowContents, registerWindowLifecycle };
