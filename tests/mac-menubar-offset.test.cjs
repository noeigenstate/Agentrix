const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Run the real measurement and window listeners without starting Electron.
const filename = path.join(__dirname, '../electron/main.cjs');
const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map(source.statements.filter(ts.isFunctionDeclaration).map(node => [node.name.text, node.getText(source)]));
const menuBarHeight = vm.runInNewContext(`(${functions.get('menuBarHeight')})`);
const display = (y, height) => ({ bounds: { y }, workArea: { y: y + height } });

test('menu-bar height uses the display origin, including displays above the primary screen', () => {
  for (const y of [0, 1080, -1080]) {
    assert.equal(menuBarHeight(display(y, 24)), 24);
    assert.equal(menuBarHeight(display(y, 37), 24), 37);
  }
});

test('zero, unknown and invalid measurements keep the last good height or default to 24', () => {
  for (const value of [undefined, null, {}, { bounds: {} }, { workArea: {} },
    display(0, 0), display(-1080, 0), display(0, -1), display(0, NaN), display(0, Infinity)]) {
    assert.equal(menuBarHeight(value), 24);
    assert.equal(menuBarHeight(value, 37), 37);
  }
});

function fixture(platform = 'darwin', initialDisplay = display(0, 24)) {
  const state = { display: initialDisplay, fullscreen: false, destroyed: false, reads: 0, broadcasts: [] };
  const bounds = { x: 40, y: 50, width: 1000, height: 800 };
  const window = Object.assign(new EventEmitter(), {
    getBounds: () => bounds, isFullScreen: () => state.fullscreen, isDestroyed: () => state.destroyed,
  });
  const screen = Object.assign(new EventEmitter(), {
    getDisplayMatching: rect => { assert.equal(rect, bounds); state.reads++; return state.display; },
  });
  const context = vm.createContext({ window, screen, process: { platform, env: {} },
    store: { projects: [], settings: {} }, app: { getVersion: () => 'test' }, windowZoom: null, localShell: () => ({ kind: 'bash', zsh: false }),
    desktopGlassBackend: null, desktopGlassActive: false, desktopGlassWindow: false,
    broadcast: () => state.broadcasts.push(context.publicState().titlebarOffset),
  });
  const offset = source.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(declaration => declaration.name.getText(source) === 'titlebarOffset'));
  assert.ok(offset);
  vm.runInContext([offset.getText(source), ...['menuBarHeight', 'registerTitlebarOffset', 'publicState'].map(name => functions.get(name))].join('\n'), context);
  context.registerTitlebarOffset();
  return { state, window, screen, offset: () => context.publicState().titlebarOffset };
}

test('startup measures the current display and publishes the height in workspace state', () => {
  const { state, offset } = fixture('darwin', display(-1080, 37));
  assert.equal(offset(), 37);
  assert.deepEqual(state.broadcasts, [37]);
  assert.equal(fixture('darwin', null).offset(), 24);
  assert.equal(fixture('darwin', display(0, 0)).offset(), 24);
});

test('moving and display changes refresh the offset and broadcast only changed heights', () => {
  const { state, window, screen, offset } = fixture();
  window.emit('move');
  assert.deepEqual(state.broadcasts, []);
  state.display = display(-1080, 37);
  window.emit('move');
  assert.equal(offset(), 37);
  for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) {
    state.display = display(1080, offset() + 1);
    screen.emit(event);
  }
  assert.deepEqual(state.broadcasts, [37, 38, 39, 40]);
  state.display = undefined;
  screen.emit('display-removed');
  assert.equal(offset(), 40);
  assert.deepEqual(state.broadcasts, [37, 38, 39, 40]);
});

test('full screen preserves the cache without measuring and leaving full screen refreshes it', () => {
  const { state, window, screen, offset } = fixture('darwin', display(0, 37));
  state.fullscreen = true;
  state.display = display(0, 0);
  window.emit('move');
  screen.emit('display-metrics-changed');
  assert.equal(offset(), 37);
  assert.equal(state.reads, 1);
  state.display = display(1080, 24);
  state.fullscreen = false;
  window.emit('leave-full-screen');
  assert.equal(offset(), 24);
  assert.deepEqual(state.broadcasts, [37, 24]);
});

test('closing releases global display listeners and destroyed windows are never measured', () => {
  const { state, window, screen } = fixture();
  state.destroyed = true;
  window.emit('move');
  assert.equal(state.reads, 1);
  window.emit('closed');
  for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) assert.equal(screen.listenerCount(event), 0);
});

test('Windows and Linux expose zero without reading displays or installing listeners', () => {
  for (const platform of ['win32', 'linux']) {
    const { state, window, screen, offset } = fixture(platform);
    assert.equal(offset(), 0);
    assert.equal(state.reads, 0);
    assert.deepEqual(state.broadcasts, []);
    assert.equal(window.eventNames().length, 0);
    assert.equal(screen.eventNames().length, 0);
  }
});
