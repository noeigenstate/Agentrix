function autoUiZoom({ width, height }) {
  return Math.max(80, Math.min(100, Math.floor(Math.min(width / 1500, height / 940) * 20) * 5));
}

function zoomMinimumSize(percent, { width, height }) {
  return [Math.min(width, Math.ceil(820 * percent / 100)), Math.min(height, Math.ceil(560 * percent / 100))];
}

function registerWindowZoom({ window, screen, getZoom, broadcast }) {
  const contents = window.webContents;
  let percent, minimum, timer;

  function resetZoom() { contents.setZoomFactor(percent / 100); }

  function update() {
    if (window.isDestroyed()) return false;
    const workArea = screen.getDisplayMatching(window.getBounds()).workArea;
    const next = getZoom() ?? autoUiZoom(workArea);
    const changed = percent !== next;
    percent = next;
    if (contents.getZoomFactor() !== percent / 100) resetZoom();
    const size = zoomMinimumSize(percent, workArea);
    if (!minimum || size.some((value, index) => value !== minimum[index])) {
      minimum = size;
      window.setMinimumSize(...size);
    }
    return changed;
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; if (update()) broadcast(); }, 150);
  }

  // Manual mode keeps the app's zoom across navigation and ignores browser zoom requests (Ctrl+wheel, pinch);
  // Ctrl+= / Ctrl+- / Ctrl+0 have no menu accelerator here and must still reach the terminals.
  contents.setZoomMode('manual');
  void contents.setVisualZoomLevelLimits(1, 1);
  update();
  contents.on('zoom-changed', resetZoom);
  // Explicit zoom stays fixed; its minimum size still follows the current display's cap.
  for (const event of ['moved', 'resized']) window.on(event, schedule);
  screen.on('display-metrics-changed', schedule);
  window.once('closed', () => {
    clearTimeout(timer);
    screen.removeListener('display-metrics-changed', schedule);
  });
  return { update, get percent() { return percent; } };
}

module.exports = { autoUiZoom, zoomMinimumSize, registerWindowZoom };
