const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function rendererLoader(overrides = {}, shared, esModuleInterop = true) {
  const modules = new Map();
  const resolve = (from, name) => ['', '.ts', '.tsx'].map(ext => path.resolve(path.dirname(from), name + ext))
    .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  const compile = full => {
    if (modules.has(full)) return modules.get(full).exports;
    const mod = new Module(full, module);
    modules.set(full, mod);
    mod.filename = full; mod.paths = Module._nodeModulePaths(path.dirname(full));
    const original = mod.require.bind(mod);
    const key = name => name.startsWith('.') ? './' + path.basename(name) : name;
    mod.require = name => Object.hasOwn(overrides, key(name)) ? overrides[key(name)] : shared?.test(name) ? compile(resolve(full, name)) : name.endsWith('.css') ? {} : original(name);
    const compilerOptions = { module: ts.ModuleKind.CommonJS, esModuleInterop, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX };
    const { outputText } = ts.transpileModule(fs.readFileSync(full, 'utf8'), { compilerOptions });
    mod._compile(outputText, full);
    return mod.exports;
  };
  return file => compile(path.resolve(__dirname, '..', '..', file));
}

// Exercise real hook effects and event handlers without starting Electron or a native GUI.
function hookHarness(filename, overrides = {}, hookOverrides = {}) {
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
    ...require('react'),
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, value => {
        const next = typeof value === 'function' ? value(slots[index].value) : value;
        if (!Object.is(next, slots[index].value)) { slots[index].value = next; dirty = true; }
      }];
    },
    useRef: initial => memo(() => ({ current: initial }), []),
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useMemo: memo,
    useCallback: (callback, deps) => memo(() => callback, deps),
    useLayoutEffect: effect,
    useEffect: effect,
    useId: () => memo(() => `id-${slots.length}`, []),
    ...hookOverrides,
  };
  // Compile renderer dependencies on the same hooks and overrides as the rendered component.
  const load = rendererLoader({ ...overrides, react: hooks },
    /\/(useComposerHistory|useCommandPalette|useMentions|useNativeCommands|useHeldTrue|CommandList|composer-hints|NativeToast|IconButton)(\.tsx?)?$/, false);
  const exported = load(filename);
  return {
    render(name, ...args) {
      const renders = [];
      do {
        if (renders.length > 20) throw new Error('Hook did not settle before paint');
        cursor = 0; effects = []; dirty = false;
        renders.push(exported[name](...args));
        for (const run of effects) run();
      } while (dirty);
      return { result: renders.at(-1), renders };
    },
    // A source file of the module under test, compiled on the same hooks and overrides (for a stand-in that must run the real hook).
    load,
    dispose() { for (const slot of slots) slot?.cleanup?.(); },
  };
}
module.exports = { hookHarness, rendererLoader };
