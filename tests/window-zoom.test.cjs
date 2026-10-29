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

function fixture(t, { zoom = null, workArea = { width: 1280, height: 680 }, loaded = true } = {}) {
  const state = { settings: cleanSettings({ uiZoom: zoom }), workArea, loaded, factor: 1.35, pageFactor: loaded ? 1.35 : 1, factors: [], minimums: [], broadcasts: [], bounds: { x: 0, y: 0, width: 1500, height: 940 } };
  const contents = Object.assign(new EventEmitter(), {
    getZoomFactor: () => state.factor,
    setZoomFactor: value => {
      state.factor = value; state.factors.push(value);
      if (state.loaded && state.mode !== 'manual') state.pageFactor = value;
    },
    setZoomMode: mode => { state.mode = mode; },
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
  const load = () => { state.loaded = true; state.pageFactor = 1; contents.emit('did-finish-load'); };
  return { state, contents, window, screen, controller, broadcast, load };
}

test('registration applies auto or explicit page zoom immediately without multiplying the display scale', t => {
  for (const [setting, expected] of [[null, 80], [80, 80], [90, 90], [100, 100], [110, 110], [125, 125], [150, 150]]) {
    const { state, controller } = fixture(t, { zoom: setting });
    assert.equal(controller.percent, expected);
    assert.deepEqual(state.factors, [expected / 100]);
    assert.equal(state.pageFactor, expected / 100, 'the page must rescale, not just remember the requested factor');
    assert.deepEqual(state.minimums, [zoomMinimumSize(expected, state.workArea)]);
    assert.deepEqual(state.matchedBounds, state.bounds);
    assert.equal(state.mode, 'isolated');
    assert.deepEqual(state.broadcasts, [], 'initial zoom is available in the first workspace snapshot');
  }
});

test('initial load and later reloads reapply zoom even when the reported factor already matches', t => {
  for (const [zoom, expected] of [[null, 0.8], [125, 1.25]]) {
    const { state, load } = fixture(t, { zoom, loaded: false });
    assert.equal(state.factor, expected, 'a pre-load zoom request is remembered');
    assert.equal(state.pageFactor, 1, 'a pre-load zoom request cannot rescale the missing renderer');
    load();
    assert.equal(state.pageFactor, expected);
    load();
    assert.equal(state.pageFactor, expected, 'crash reloads also restore page zoom');
    assert.deepEqual(state.factors, [expected, expected, expected]);
    assert.equal(state.mode, 'isolated', 'per-webContents mode survives navigation');
    assert.deepEqual(state.broadcasts, []);
  }
});

test('finishing a load recomputes automatic zoom and broadcasts only an effective percentage change', t => {
  const { state, controller, load } = fixture(t, { loaded: false });
  state.workArea = { width: 1920, height: 1032 };
  load();
  assert.equal(controller.percent, 100);
  assert.equal(state.pageFactor, 1);
  assert.deepEqual(state.minimums.at(-1), [820, 560]);
  assert.deepEqual(state.broadcasts, [100]);
  load();
  assert.deepEqual(state.broadcasts, [100]);
});

test('display moves, resizes and metric changes debounce auto zoom and broadcast only effective changes', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { state, window, screen, controller } = fixture(t);
  state.workArea = { width: 1920, height: 1032 };
  state.bounds.x = 1920;
  window.emit('move');
  t.mock.timers.tick(100);
  window.emit('resize');
  screen.emit('display-metrics-changed', {}, {}, ['scaleFactor', 'workArea']);
  t.mock.timers.tick(149);
  assert.equal(controller.percent, 80);
  t.mock.timers.tick(1);
  assert.equal(controller.percent, 100);
  assert.equal(state.matchedBounds.x, 1920);
  assert.deepEqual(state.minimums.at(-1), [820, 560]);
  assert.deepEqual(state.broadcasts, [100]);
  window.emit('resize');
  t.mock.timers.tick(150);
  assert.deepEqual(state.broadcasts, [100]);
  assert.equal(state.minimums.length, 2, 'unchanged constraints do not cause resize loops');
  state.workArea = { width: 1366, height: 728 };
  screen.emit('display-metrics-changed');
  t.mock.timers.tick(150);
  assert.deepEqual(state.broadcasts, [100, 80]);
});

test('move, resize, display-added, display-removed and metric events each recompute automatic zoom', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { state, window, screen, controller } = fixture(t);
  const events = [[window, 'move'], [window, 'resize'], [screen, 'display-added'], [screen, 'display-removed'], [screen, 'display-metrics-changed']];
  for (const [target, event] of events) {
    const previous = controller.percent, next = previous === 80 ? 100 : 80;
    state.workArea = next === 100 ? { width: 1920, height: 1032 } : { width: 1280, height: 680 };
    target.emit(event);
    t.mock.timers.tick(149);
    assert.equal(controller.percent, previous, `${event} is debounced`);
    t.mock.timers.tick(1);
    assert.equal(controller.percent, next, event);
    assert.equal(state.pageFactor, next / 100, event);
    assert.equal(state.broadcasts.at(-1), next, event);
  }
  assert.deepEqual(state.broadcasts, [100, 80, 100, 80, 100]);
});

test('explicit zoom survives display changes while minimum size follows the current work area cap', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { state, window, screen, controller } = fixture(t, { zoom: 150 });
  assert.deepEqual(state.minimums.at(-1), [1230, 680]);
  state.workArea = { width: 1000, height: 600 };
  window.emit('move');
  screen.emit('display-removed');
  t.mock.timers.tick(150);
  assert.equal(controller.percent, 150);
  assert.deepEqual(state.factors, [1.5]);
  assert.deepEqual(state.minimums.at(-1), [1000, 600]);
  assert.deepEqual(state.broadcasts, []);
});

test('wheel and pinch zoom are reset to the effective setting, and zoom keys still reach the terminals', t => {
  const { state, contents } = fixture(t, { zoom: 125 });
  for (const [factor, direction] of [[2, 'in'], [0.5, 'out']]) {
    state.factor = state.pageFactor = factor;
    contents.emit('zoom-changed', {}, direction);
    assert.equal(state.factor, 1.25);
    assert.equal(state.pageFactor, 1.25);
  }
  for (const key of ['=', '+', '-', '0']) {
    contents.emit('before-input-event', { preventDefault: () => assert.fail(`Ctrl+${key} must reach the page`) }, { type: 'keyDown', control: true, key });
  }
  assert.deepEqual(state.broadcasts, []);
});

test('zoom comparisons tolerate rounding noise but correct a larger drift', t => {
  const { state, controller } = fixture(t, { zoom: 125 });
  for (const factor of [1.2505, 1.2495]) {
    state.factor = factor;
    assert.equal(controller.update(), false);
    assert.deepEqual(state.factors, [1.25]);
  }
  state.factor = 1.252;
  assert.equal(controller.update(), false);
  assert.deepEqual(state.factors, [1.25, 1.25]);
  assert.equal(state.pageFactor, 1.25);
  assert.deepEqual(state.broadcasts, []);
});

test('closing a window releases all global display listeners and the pending debounce', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { state, window, screen, controller } = fixture(t);
  state.workArea = { width: 1920, height: 1032 };
  window.emit('move');
  screen.emit('display-added');
  state.destroyed = true;
  window.emit('closed');
  for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) assert.equal(screen.listenerCount(event), 0, event);
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
