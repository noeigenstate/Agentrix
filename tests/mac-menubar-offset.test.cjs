const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { registerTitlebarOffset } = require('../electron/app/titlebar-offset.cjs');

const display = (id, y, height) => ({ id, bounds: { y }, workArea: { y: y + height } });
const displayEvents = ['display-metrics-changed', 'display-added', 'display-removed'];

function fixture({ platform = 'darwin', initialDisplay = display(1, 0, 24), fullScreen = false, windowTop = initialDisplay?.bounds?.y ?? 0 } = {}) {
  const state = { display: initialDisplay, fullScreen, destroyed: false, reads: 0, broadcasts: [] };
  const bounds = { x: 40, y: windowTop, width: 1000, height: 800 };
  const window = Object.assign(new EventEmitter(), {
    getBounds: () => bounds, isFullScreen: () => state.fullScreen, isDestroyed: () => state.destroyed,
  });
  const screen = Object.assign(new EventEmitter(), {
    getDisplayMatching: rect => { assert.equal(rect, bounds); state.reads++; return state.display; },
  });
  const controller = registerTitlebarOffset({ window, screen, platform,
    broadcast: () => state.broadcasts.push(controller.offset),
  });
  return { state, bounds, window, screen, controller };
}

test('startup measures windowed displays relative to their origins, including a valid zero height', () => {
  for (const y of [0, 1080, -1080]) for (const height of [0, 24, 37]) {
    const { state, controller } = fixture({ initialDisplay: display(1, y, height) });
    assert.equal(controller.offset, height);
    assert.deepEqual(state.broadcasts, [], 'the initial offset is available in the first workspace snapshot');
  }
});

test("invalid measurements keep that display's cached height or default to 24", () => {
  assert.equal(fixture({ initialDisplay: null }).controller.offset, 24);
  for (const height of [-1, NaN, Infinity]) {
    assert.equal(fixture({ initialDisplay: display(1, 0, height) }).controller.offset, 24);
    const { state, window, controller } = fixture({ initialDisplay: display(1, 0, 37) });
    state.display = display(1, 0, height);
    window.emit('move');
    assert.equal(controller.offset, 37);
    state.display = display(2, 0, height);
    window.emit('move');
    assert.equal(controller.offset, 24, "another display never inherits the previous display's cache");
  }
});

test('entering full screen subtracts the window top relative to its display and clamps to zero', () => {
  for (const y of [0, 1080, -1080]) {
    for (const [height, inset, expected] of [[24, 0, 24], [37, 37, 0], [37, 12, 25], [37, 50, 0]]) {
      const { state, bounds, window, controller } = fixture({ initialDisplay: display(1, y, height) });
      state.fullScreen = true;
      state.display = display(1, y, 0);
      bounds.y = y + inset;
      window.emit('enter-full-screen');
      assert.equal(controller.offset, expected);
    }
  }
});

test('a never-measured full-screen display uses 24 without caching full-screen work-area metrics', () => {
  for (const [windowTop, expected] of [[1080, 24], [1117, 0]]) {
    const { controller } = fixture({ initialDisplay: display(2, 1080, 37), fullScreen: true, windowTop });
    assert.equal(controller.offset, expected);
  }
});

test("full-screen moves restore each display's cached height, including zero", () => {
  const { state, bounds, window, screen, controller } = fixture();
  for (const [id, y, height] of [[2, -1080, 37], [3, 1080, 0]]) {
    state.display = display(id, y, height);
    bounds.y = y;
    window.emit('move');
    assert.equal(controller.offset, height);
  }
  state.fullScreen = true;
  for (const [id, y, expected] of [[1, 0, 24], [2, -1080, 37], [3, 1080, 0]]) {
    state.display = display(id, y, 0);
    bounds.y = y;
    screen.emit('display-removed');
    assert.equal(controller.offset, expected);
  }
  assert.deepEqual(state.broadcasts, [37, 0, 24, 37, 0]);
});

test('window moves and every display event recompute the full-screen offset on the matching display', () => {
  for (const event of ['move', ...displayEvents]) {
    const { state, bounds, window, screen, controller } = fixture({ initialDisplay: display(1, 0, 37) });
    const target = event === 'move' ? window : screen;
    state.fullScreen = true;
    state.display = display(1, 0, 0);
    bounds.y = 37;
    window.emit('enter-full-screen');
    state.display = display(2, -1080, 0);
    bounds.y = -1080;
    target.emit(event);
    assert.equal(controller.offset, 24, event);
    state.display = display(1, 0, 0);
    bounds.y = 10;
    target.emit(event);
    assert.equal(controller.offset, 27, event);
    assert.deepEqual(state.broadcasts, [0, 24, 27], event);
  }
});

test('leaving full screen refreshes the windowed height and broadcasts only effective changes', () => {
  const { state, bounds, window, screen, controller } = fixture({ initialDisplay: display(1, 0, 37) });
  state.fullScreen = true;
  bounds.y = 37;
  window.emit('enter-full-screen');
  screen.emit('display-metrics-changed');
  assert.deepEqual(state.broadcasts, [0]);
  state.fullScreen = false;
  state.display = display(1, 0, 24);
  window.emit('leave-full-screen');
  assert.equal(controller.offset, 24);
  for (const event of displayEvents) screen.emit(event);
  window.emit('move');
  assert.deepEqual(state.broadcasts, [0, 24]);
});

test('closing releases global display listeners and destroyed windows are never measured', () => {
  const { state, window, screen } = fixture();
  state.destroyed = true;
  window.emit('move');
  window.emit('enter-full-screen');
  assert.equal(state.reads, 1);
  window.emit('closed');
  for (const event of displayEvents) assert.equal(screen.listenerCount(event), 0);
  screen.emit('display-removed');
  assert.equal(state.reads, 1);
  assert.deepEqual(state.broadcasts, []);
});

test('Windows and Linux expose zero without reading displays or installing listeners', () => {
  for (const platform of ['win32', 'linux']) {
    const { state, window, screen, controller } = fixture({ platform });
    assert.equal(controller.offset, 0);
    assert.equal(state.reads, 0);
    assert.deepEqual(state.broadcasts, []);
    assert.deepEqual(window.eventNames(), []);
    assert.deepEqual(screen.eventNames(), []);
  }
});
