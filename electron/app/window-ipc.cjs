function registerWindowIpc({ handle, listen, getWindow, requestQuit }) {
  listen('window:minimize', () => getWindow().minimize());
  listen('window:maximize', () => getWindow().isMaximized() ? getWindow().unmaximize() : getWindow().maximize());
  listen('window:fullscreen', () => getWindow().setFullScreen(!getWindow().isFullScreen()));
  listen('window:close', () => getWindow().close());
  handle('window:is-fullscreen', () => getWindow().isFullScreen());
  handle('app:quit', requestQuit);
}

module.exports = { registerWindowIpc };
