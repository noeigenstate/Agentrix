const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

// Exercise real hook effects and event handlers without starting Electron or a native GUI.
function hookHarness(filename, overrides = {}) {
  const slots = []; let cursor = 0, dirty = false, effects = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory, deps) => {
    const index = cursor++, slot = slots[index];
    if (!slot || !same(deps, slot.deps)) slots[index] = { value: factory(), deps };
    return slots[index].value;
  };
  const effect = (run, deps) => {
    const index = cursor++, slot = slots[index];
    if (!slot || !same(deps, slot.deps)) effects.push(() => {
      slot?.cleanup?.(); slots[index] = { deps, cleanup: run() };
    });
  };
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, value => {
        const next = typeof value === 'function' ? value(slots[index].value) : value;
        if (!Object.is(next, slots[index].value)) { slots[index].value = next; dirty = true; }
      }];
    },
    useRef: initial => memo(() => ({ current: initial }), []),
    useMemo: memo,
    useCallback: (callback, deps) => memo(() => callback, deps),
    useLayoutEffect: effect,
    useEffect: effect,
  };
  const full = path.resolve(__dirname, '..', '..', filename), mod = new Module(full, module);
  mod.filename = full; mod.paths = Module._nodeModulePaths(path.dirname(full));
  const original = mod.require.bind(mod);
  const key = name => name.startsWith('.') ? './' + path.basename(name) : name;
  mod.require = name => name === 'react' ? hooks : Object.hasOwn(overrides, key(name)) ? overrides[key(name)] : original(name);
  mod._compile(ts.transpileModule(fs.readFileSync(full, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, full);
  return {
    render(name, ...args) {
      const renders = [];
      do {
        if (renders.length > 20) throw new Error('Hook did not settle before paint');
        cursor = 0; effects = []; dirty = false;
        renders.push(mod.exports[name](...args));
        for (const run of effects) run();
      } while (dirty);
      return { result: renders.at(-1), renders };
    },
    dispose() { for (const slot of slots) slot?.cleanup?.(); },
  };
}
module.exports = { hookHarness };
