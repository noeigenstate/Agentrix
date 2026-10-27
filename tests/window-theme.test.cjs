const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { WorkspaceStore } = require('../electron/state.cjs');
const { desktopGlassOptions } = require('../electron/desktop-glass.cjs');

const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const windowStart = main.indexOf('    window = new BrowserWindow({');
const glassStart = main.indexOf('    if (desktopGlassWindow) {', windowStart);

function fixture(t, theme, glass = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-window-theme-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'workspace.json'), store = new WorkspaceStore(file);
  store.updateSettings({ theme });
  const context = vm.createContext({ store: new WorkspaceStore(file), desktopGlassActive: glass, desktopGlassWindow: glass,
    desktopGlassBackend: 'windows', desktopGlassOptions, path, root: directory, __dirname: directory, t: text => text,
    process: { platform: 'win32' },
    BrowserWindow: class {
      constructor(options) { this.options = options; this.backgrounds = []; }
      isDestroyed() { return !!this.destroyed; }
      setBackgroundColor(color) { this.backgrounds.push(color); }
    } });
  vm.runInContext(main.slice(main.indexOf('function windowBackgroundColor('), main.indexOf('const sessions =')), context);
  vm.runInContext(main.slice(windowStart, glassStart), context);
  return context;
}

test('window construction uses the saved theme and live updates use sanitized settings', t => {
  for (const [theme, background] of [['mono', '#181818'], ['light', '#f8f9fb']]) {
    const context = fixture(t, theme);
    assert.equal(context.window.options.backgroundColor, background);
    context.updateStoreSettings({ theme: 'light' });
    assert.deepEqual(context.window.backgrounds, theme === 'light' ? [] : ['#f8f9fb']);
    context.updateStoreSettings({ fontSize: 14 });
    context.updateStoreSettings({ theme: 'mono' });
    assert.equal(context.window.backgrounds.at(-1), '#181818');
    context.updateStoreSettings({ theme: 'retired' });
    assert.equal(context.store.settings.theme, 'mono');
    assert.equal(context.window.backgrounds.length, theme === 'light' ? 1 : 2);
    context.window.destroyed = true;
    context.updateStoreSettings({ theme: 'light' });
    assert.equal(context.window.backgrounds.at(-1), '#181818');
  }
});

test('active desktop glass keeps transparency and failed glass uses the saved theme background', async t => {
  const context = fixture(t, 'mono', true);
  assert.equal(context.window.options.backgroundColor, '#00000000');
  context.updateStoreSettings({ theme: 'light' });
  assert.deepEqual(context.window.backgrounds, []);
  context.desktopGlassActive = false;
  context.runtimeDir = '';
  context.applyDesktopGlass = async () => { throw new Error('Backdrop unavailable'); };
  const glassEnd = main.indexOf("    if (process.platform === 'win32') window.setAppDetails", glassStart);
  await vm.runInContext(`(async () => { ${main.slice(glassStart, glassEnd)} })()`, context);
  assert.deepEqual(context.window.backgrounds, ['#f8f9fb']);
});
