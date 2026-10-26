const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const filename = path.join(__dirname, '../src/shared/Select.tsx'), mod = new Module(filename, module);
mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
const originalRequire = mod.require.bind(mod);
mod.require = name => name.endsWith('.css') ? {} : name === '@phosphor-icons/react' ? {} : originalRequire(name);
mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText, filename);
const { selectMenuWidths, selectMenuLeft } = mod.exports;

// The browser resolves max-content within these bounds before its measured width is used for placement.
const menuWidth = (triggerWidth, contentWidth, windowWidth) => {
  const { minWidth, maxWidth } = selectMenuWidths(triggerWidth, windowWidth);
  return Math.min(maxWidth, Math.max(minWidth, contentWidth));
};

test('a narrow project trigger lets the longest option grow the menu while keeping left alignment', () => {
  const width = menuWidth(70, 112, 1000);
  assert.equal(width, 112, 'codepulse fits instead of being clipped to the 70px trigger');
  assert.deepEqual(selectMenuWidths(70, 1000), { minWidth: 70, maxWidth: 360 });
  assert.equal(selectMenuLeft(100, width, 1000), 100);
});

test('a menu near the right edge shifts using its measured width instead of the trigger width', () => {
  const width = menuWidth(70, 180, 1000);
  assert.equal(selectMenuLeft(900, width, 1000), 812);
  assert.equal(selectMenuLeft(812, width, 1000), 812, 'an exact fit does not shift');
  assert.equal(selectMenuLeft(4, width, 1000), 8, 'the left edge margin is preserved');
});

test('very long options hit the content cap or the available window width', () => {
  assert.equal(menuWidth(70, 2000, 1000), 360);
  assert.equal(menuWidth(70, 2000, 320), 304);
  assert.equal(selectMenuLeft(200, 304, 320), 8);
});

test('wide settings triggers remain the minimum without adding unnecessary menu width', () => {
  for (const width of [200, 250, 300, 420]) {
    assert.equal(menuWidth(width, 120, 1000), width);
  }
  assert.deepEqual(selectMenuWidths(420, 1000), { minWidth: 420, maxWidth: 420 });
});

test('the window bounds override a trigger wider than the available menu space', () => {
  assert.deepEqual(selectMenuWidths(420, 320), { minWidth: 304, maxWidth: 304 });
  assert.equal(menuWidth(420, 2000, 320), 304);
  assert.equal(selectMenuLeft(8, 304, 320), 8);
});
