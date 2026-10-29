const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { autoUiZoom, zoomMinimumSize, registerWindowZoom } = require('../electron/app/window-zoom.cjs');
const { cleanSettings } = require('../electron/state.cjs');
const { registerWorkspaceIpc } = require('../electron/features/workspace/ipc.cjs');

test('automatic zoom fits the 1500 by 940 design in DIPs, floors to 5%, and stays within 80–100%', () => {
  for (const [width, height, expected] of [
    [1366, 728, 80], [1280, 680, 80], [1920, 1032, 100], [2560, 1392, 100],
    [1500, 940, 100], [1500, 893, 95], [1350, 846, 90], [1275, 799, 85],
    [1424, 940, 90], [1500, 892, 90], [800, 500, 80],
  ]) assert.equal(autoUiZoom({ width, height }), expected, `${width} by ${height}`);
});

test('minimum window size preserves the CSS viewport and caps each dimension at the work area', () => {
  const large = { width: 2560, height: 1392 };
  for (const [percent, expected] of [
    [80, [656, 448]], [85, [697, 476]], [90, [738, 504]], [95, [779, 532]],
    [100, [820, 560]], [110, [902, 616]], [125, [1025, 700]], [150, [1230, 840]],
  ]) assert.deepEqual(zoomMinimumSize(percent, large), expected, String(percent));
  assert.deepEqual(zoomMinimumSize(150, { width: 1280, height: 680 }), [1230, 680]);
  assert.deepEqual(zoomMinimumSize(150, { width: 1000, height: 900 }), [1000, 840]);
  assert.deepEqual(zoomMinimumSize(80, { width: 600, height: 400 }), [600, 400]);
});

function fixture(t, zoom = null, workArea = { width: 1280, height: 680 }) {
  const state = { settings: cleanSettings({ uiZoom: zoom }), workArea, factor: 1.35, factors: [], minimums: [], broadcasts: [], bounds: { x: 0, y: 0, width: 1500, height: 940 } };
  const contents = Object.assign(new EventEmitter(), {
    getZoomFactor: () => state.factor,
    setZoomFactor: value => { state.factor = value; state.factors.push(value); },
    setZoomMode: mode => { state.mode = mode; },
    setVisualZoomLevelLimits: async (...limits) => { state.limits = limits; },
  });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents, isDestroyed: () => !!state.destroyed, getBounds: () => state.bounds,
    setMinimumSize: (...size) => { state.minimums.push(size); },
  });
  const screen = Object.assign(new EventEmitter(), {
    getDisplayMatching: bounds => { state.matchedBounds = { ...bounds }; return { workArea: state.workArea, scaleFactor: 1.5 }; },
  });
  const broadcast = () => state.broadcasts.push(controller.percent);
  const controller = registerWindowZoom({ window, screen, getZoom: () => state.settings.uiZoom, broadcast });
  t.after(() => { state.destroyed = true; window.emit('closed'); });
  return { state, contents, window, screen, controller, broadcast };
}

test('registration applies auto or explicit page zoom immediately without multiplying the display scale', t => {
  for (const [setting, expected] of [[null, 80], [80, 80], [90, 90], [100, 100], [110, 110], [125, 125], [150, 150]]) {
    const { state, controller } = fixture(t, setting);
    assert.equal(controller.percent, expected);
    assert.deepEqual(state.factors, [expected / 100]);
    assert.deepEqual(state.minimums, [zoomMinimumSize(expected, state.workArea)]);
    assert.deepEqual(state.matchedBounds, state.bounds);
    assert.equal(state.mode, 'manual');
    assert.deepEqual(state.limits, [1, 1]);
    assert.deepEqual(state.broadcasts, [], 'initial zoom is available in the first workspace snapshot');
  }
});

test('display moves, resizes and metric changes debounce auto zoom and broadcast only effective changes', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { state, window, screen, controller } = fixture(t);
  state.workArea = { width: 1920, height: 1032 };
  state.bounds.x = 1920;
  window.emit('moved');
  t.mock.timers.tick(100);
  window.emit('resized');
  screen.emit('display-metrics-changed', {}, {}, ['scaleFactor', 'workArea']);
  t.mock.timers.tick(149);
  assert.equal(controller.percent, 80);
  t.mock.timers.tick(1);
  assert.equal(controller.percent, 100);
  assert.equal(state.matchedBounds.x, 1920);
  assert.deepEqual(state.minimums.at(-1), [820, 560]);
  assert.deepEqual(state.broadcasts, [100]);
  window.emit('resized');
  t.mock.timers.tick(150);
  assert.deepEqual(state.broadcasts, [100]);
  assert.equal(state.minimums.length, 2, 'unchanged constraints do not cause resize loops');
  state.workArea = { width: 1366, height: 728 };
  screen.emit('display-metrics-changed');
  t.mock.timers.tick(150);
  assert.deepEqual(state.broadcasts, [100, 80]);
});

test('explicit zoom survives display changes while minimum size follows the current work area cap', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { state, window, screen, controller } = fixture(t, 150);
  assert.deepEqual(state.minimums.at(-1), [1230, 680]);
  state.workArea = { width: 1000, height: 600 };
  window.emit('moved');
  screen.emit('display-metrics-changed');
  t.mock.timers.tick(150);
  assert.equal(controller.percent, 150);
  assert.deepEqual(state.factors, [1.5]);
  assert.deepEqual(state.minimums.at(-1), [1000, 600]);
  assert.deepEqual(state.broadcasts, []);
});

test('wheel zoom is reset to the effective setting, and zoom keys still reach the terminals', t => {
  const { state, contents } = fixture(t, 125);
  state.factor = 2;
  contents.emit('zoom-changed', {}, 'in');
  assert.equal(state.factor, 1.25);
  for (const key of ['=', '+', '-', '0']) {
    contents.emit('before-input-event', { preventDefault: () => assert.fail(`Ctrl+${key} must reach the page`) }, { type: 'keyDown', control: true, key });
  }
  assert.deepEqual(state.broadcasts, []);
});

test('closing a window releases its global display listener and pending debounce', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { state, window, screen, controller } = fixture(t);
  state.workArea = { width: 1920, height: 1032 };
  window.emit('moved');
  state.destroyed = true;
  window.emit('closed');
  assert.equal(screen.listenerCount('display-metrics-changed'), 0);
  t.mock.timers.tick(1000);
  assert.equal(controller.update(), false);
  assert.equal(controller.percent, 80);
  assert.deepEqual(state.broadcasts, []);
});

test('settings IPC applies sanitized zoom before its single workspace broadcast and exposes the effective percentage', t => {
  const { state, window, controller, broadcast } = fixture(t);
  const store = { projects: [], get settings() { return state.settings; }, updateSettings: patch => { state.settings = cleanSettings({ ...state.settings, ...patch }); } };
  const context = vm.createContext({ store, window, windowZoom: controller, desktopGlassActive: false, desktopGlassWindow: false, desktopGlassBackend: null,
    process: { platform: 'win32', env: {} }, app: { getVersion: () => '1.0.0' } });
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  vm.runInContext(main.slice(main.indexOf('function updateStoreSettings('), main.indexOf('const sessions =')), context);
  vm.runInContext(main.slice(main.indexOf('function publicState('), main.indexOf('function terminalIds(')), context);
  const handlers = new Map();
  registerWorkspaceIpc({ handle: (name, handler) => handlers.set(name, handler), publicState: context.publicState, getSettings: () => store.settings,
    updateStoreSettings: context.updateStoreSettings, broadcast, chooseVoiceModel: () => {} });
  const snapshot = () => handlers.get('workspace:state')();
  const updateSettings = handlers.get('workspace:settings');
  assert.equal(snapshot().settings.uiZoom, null);
  assert.equal(snapshot().uiZoom, 80);
  updateSettings({ uiZoom: 125 });
  assert.equal(state.factor, 1.25);
  assert.equal(snapshot().uiZoom, 125);
  assert.equal(snapshot().settings.uiZoom, 125);
  assert.deepEqual(state.broadcasts, [125]);
  updateSettings({ fontSize: 14 });
  assert.deepEqual(state.factors, [0.8, 1.25], 'unrelated settings do not reapply page zoom');
  updateSettings({ uiZoom: 95 });
  assert.equal(snapshot().settings.uiZoom, null);
  assert.equal(snapshot().uiZoom, 80);
  state.workArea = { width: 1920, height: 1032 };
  updateSettings({ uiZoom: 100 });
  updateSettings({ uiZoom: null });
  assert.equal(snapshot().settings.uiZoom, null);
  assert.equal(snapshot().uiZoom, 100);
  assert.deepEqual(state.broadcasts, [125, 125, 80, 100, 100]);
});
