function registerTitlebarOffset({ window, screen, broadcast, platform = process.platform }) {
  if (platform !== 'darwin') return { offset: 0 };
  const menuBarHeights = new Map();
  let offset = 24;

  function update() {
    if (window.isDestroyed()) return false;
    const bounds = window.getBounds();
    const display = screen.getDisplayMatching(bounds);
    if (!display) return false;
    const fullScreen = window.isFullScreen();
    // Full screen can report a hidden menu bar; only windowed measurements belong in the cache.
    if (!fullScreen) {
      const height = display.workArea?.y - display.bounds.y;
      if (Number.isFinite(height) && height >= 0) menuBarHeights.set(display.id, height);
    }
    const height = menuBarHeights.get(display.id) ?? 24;
    // Notch displays already place the full-screen window below some or all of the menu bar.
    const next = fullScreen ? Math.max(0, height - (bounds.y - display.bounds.y)) : height;
    if (next === offset) return false;
    offset = next;
    return true;
  }

  const refresh = () => { if (update()) broadcast(); };
  update();
  for (const event of ['move', 'enter-full-screen', 'leave-full-screen']) window.on(event, refresh);
  const displayEvents = ['display-metrics-changed', 'display-added', 'display-removed'];
  for (const event of displayEvents) screen.on(event, refresh);
  window.once('closed', () => {
    for (const event of displayEvents) screen.removeListener(event, refresh);
  });
  return { get offset() { return offset; } };
}

module.exports = { registerTitlebarOffset };
