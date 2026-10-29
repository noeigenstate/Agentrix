const { minWidth, minHeight } = require('../window-zoom.json');

function autoUiZoom({ width, height }) {
  return Math.max(80, Math.min(100, Math.floor(Math.min(width / 1500, height / 940) * 20) * 5));
}

function zoomMinimumSize(percent, { width, height }) {
  return [Math.min(width, Math.ceil(minWidth * percent / 100)), Math.min(height, Math.ceil(minHeight * percent / 100))];
}

function registerWindowZoom({ window, screen, getZoom, broadcast }) {
  const contents = window.webContents;
  let percent, minimum, timer;

  function resetZoom() { contents.setZoomFactor(percent / 100); }

  function update(force = false) {
    if (window.isDestroyed()) return false;
    const workArea = screen.getDisplayMatching(window.getBounds()).workArea;
    const next = getZoom() ?? autoUiZoom(workArea);
    const changed = percent !== next;
    percent = next;
    if (force || Math.abs(contents.getZoomFactor() - percent / 100) > 0.001) resetZoom();
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

  // Isolated mode rescales this webContents and keeps its zoom across navigation.
  // Browser zoom gestures are reset below; Ctrl+= / Ctrl+- / Ctrl+0 must still reach the terminals.
  contents.setZoomMode('isolated');
  update();
  // Before a renderer exists, a zoom request can be remembered without rescaling the page.
  contents.on('did-finish-load', () => { if (update(true)) broadcast(); });
  contents.on('zoom-changed', resetZoom);
  // Explicit zoom stays fixed; its minimum size still follows the current display's cap.
  for (const event of ['move', 'resize']) window.on(event, schedule);
  const displayEvents = ['display-metrics-changed', 'display-added', 'display-removed'];
  for (const event of displayEvents) screen.on(event, schedule);
  window.once('closed', () => {
    clearTimeout(timer);
    for (const event of displayEvents) screen.removeListener(event, schedule);
  });
  return { update, get percent() { return percent; } };
}

module.exports = { autoUiZoom, zoomMinimumSize, registerWindowZoom };
