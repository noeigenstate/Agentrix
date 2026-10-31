const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

// Only the parts of the style builder that need no browser (colour conversion, assembling the payload) run here; the probe, the canvas and the focus rule need a page.
function load() {
  const filename = path.join(__dirname, '../src/features/titlebar/native-style.tsx');
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  mod.require = name => {
    if (name === '@phosphor-icons/react') return { Stamp: () => null, CirclesFour: () => null };
    if (name === '../../shared/themes') return { subscribeTheme: () => () => {} };
    return original(name);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
  return mod.exports;
}
const { colorHex, styleFrom } = load();

test('computed colours become CSS hex, with alpha only when not opaque', () => {
  assert.equal(colorHex('rgb(242, 242, 242)'), '#f2f2f2');
  assert.equal(colorHex('rgba(36, 39, 45, 1)'), '#24272d');
  assert.equal(colorHex('rgba(255, 255, 255, 0.5)'), '#ffffff80');
  assert.equal(colorHex('color(srgb 1 0.5 0 / 0.25)'), '#ff800040');
  assert.throws(() => colorHex('transparent'), /Unreadable colour/);
});

test('the style carries the nav rules as numbers, the colours and the icons untouched', () => {
  const button = { height: '28px', paddingLeft: '12px', columnGap: '6px', borderTopLeftRadius: '8px', fontSize: '13px', fontWeight: '600' };
  const colors = { text: '#b5b5b5', textSelected: '#f2f2f2', hover: '#343434', selected: '#383838', badge: '#e5e5e5', badgeText: '#181818', focus: '#d0d0d0' };
  const icons = { decisions: 'data:image/png;base64,AA', workspace: 'data:image/png;base64,BB' };
  const style = styleFrom({
    scale: 0.9, nav: { columnGap: '4px' }, button, colors, icons, focus: { width: 2, offset: 2 },
    badge: { minWidth: '18px', paddingLeft: '5px', lineHeight: '17px', fontSize: '11px' },
  });
  assert.deepEqual(style, {
    scale: 0.9, font: { size: 13, weight: 600 },
    metrics: { height: 28, paddingX: 12, gap: 6, itemGap: 4, radius: 8, iconSize: 16, focusWidth: 2, focusOffset: 2, badge: { minWidth: 18, paddingX: 5, height: 17, fontSize: 11 } },
    colors, icons,
  });
});
