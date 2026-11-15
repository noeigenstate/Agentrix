// The modules carved out of electron/main.cjs, for tests that run main's own text in a vm context. Each module is
// evaluated inside that context, so its globals (Date, setTimeout, process) are the context's, as main's text was,
// and each factory takes the context itself as its deps. defineMain(context, ...names) defines the named functions
// as context globals, the way running main's text once defined them.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '../..');
const modules = [
  ['electron/features/terminal-events/claude-activity.cjs', 'createClaudeActivity'],
  ['electron/features/terminal/switch-host.cjs', 'createSwitchHost'],
  ['electron/features/native-session/host-inputs.cjs', 'createHostInputs'],
  ['electron/features/agents/dispatch-intake.cjs', 'createDispatchIntake'],
  ['electron/features/terminal-events/bootstrap-file.cjs', null],
];
// Every name main defines from the modules, and the module that defines it.
const owners = new Map(modules.flatMap(([file, factory]) => {
  const exports = require(path.join(root, file));
  return Object.keys(factory ? exports[factory]({}) : exports).map(name => [name, file]);
}));

function load(context, file) {
  const filename = path.join(root, file), module = { exports: {} };
  const wrapper = vm.runInContext(`(function (exports, require, module, __filename, __dirname) {${fs.readFileSync(filename, 'utf8')}\n})`, context, { filename });
  wrapper(module.exports, createRequire(filename), module, filename, path.dirname(filename));
  return module.exports;
}

const instances = new WeakMap();
function defineMain(context, ...names) {
  if (!vm.isContext(context)) vm.createContext(context);
  const loaded = instances.get(context) || new Map();
  instances.set(context, loaded);
  for (const name of names) {
    const file = owners.get(name);
    if (!file) throw new Error(`main defines no ${name} from its modules`);
    if (!loaded.has(file)) {
      const exports = load(context, file), factory = modules.find(([item]) => item === file)[1];
      loaded.set(file, factory ? exports[factory](context) : exports);
    }
    context[name] = loaded.get(file)[name];
  }
  return context;
}

module.exports = { defineMain };
