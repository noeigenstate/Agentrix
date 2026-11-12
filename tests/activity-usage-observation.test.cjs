const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const ts = require('typescript');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('the activity usage card retains observations on remount, isolates projects and discards unmounted reads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const requests = [];
  let bridge = { usage: project => new Promise(resolve => requests.push({ project, resolve })) }, hooks;
  const filename = path.join(__dirname, '../src/features/agents/ApiUsage.tsx'), mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  mod.require = name => {
    if (name === 'react') return {
      useState(initial) {
        const current = hooks, index = current.values.length;
        current.values.push(typeof initial === 'function' ? initial() : initial);
        return [current.values[index], value => { current.values[index] = value; }];
      },
      useRef(initial) { const slot = { current: initial }; hooks.values.push(slot); return slot; },
      useEffect(effect) { hooks.effects.push(effect); },
    };
    if (name === '../native-session/native-bridge.ts') return { nativeBridge: () => bridge };
    if (name === '../native-session/native-store.ts') return { useUsageRevision: () => 0 };
    if (name === '../../shared/i18n') return { t: key => key };
    if (name.endsWith('.css') || name.startsWith('./') || name.startsWith('../native-session/')) return {};
    return original(name);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  const mount = projectId => {
    hooks = { values: [], effects: [] }; mod.exports.ApiUsage({ terminal: {}, projectId });
    const instance = hooks, cleanup = instance.effects.map(effect => effect());
    return { values: instance.values, close: () => cleanup.forEach(dispose => dispose?.()) };
  };
  const a = mount('a'); assert.equal(a.values[0], null); t.mock.timers.tick(0); await flush();
  const observed = { agents: { claude: { connection: { kind: 'subscription', observedAt: 1000 } } } };
  requests.shift().resolve({ ok: true, value: observed }); await flush(); assert.equal(a.values[0], observed);
  t.mock.timers.tick(60000); await flush(); const late = requests.shift(); a.close();
  const b = mount('b'); assert.equal(b.values[0], null, 'another project cannot borrow project a');
  late.resolve({ ok: true, value: { agents: {} } }); await flush(); b.close();
  const again = mount('a'); assert.equal(again.values[0], observed, 'cached data is available before the next read'); again.close();
  bridge = { usage: () => assert.fail('no read expected before the timer') };
  const otherBackend = mount('a'); assert.equal(otherBackend.values[0], null); otherBackend.close();
  // No project removal reaches the card, so it holds only the projects read most recently.
  bridge = { usage: async project => ({ ok: true, value: { agents: {}, project } }) };
  for (let other = 0; other < 40; other++) { const pane = mount(`other-${other}`); t.mock.timers.tick(0); await flush(); pane.close(); }
  const recent = mount('other-39'); assert.equal(recent.values[0].project, 'other-39'); recent.close();
  const dropped = mount('other-0'); assert.equal(dropped.values[0], null, 'a project not read for many others is no longer held'); dropped.close();
});
