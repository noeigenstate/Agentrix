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
    const leaf = mod.exports.ApiUsage({ terminal: {}, projectId });
    hooks = { values: [], effects: [] }; leaf.type(leaf.props);
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
});
