// Compose imported application modules over a test host. Each host keeps one instance of each factory.
const path = require('node:path');

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

const instances = new WeakMap();
function defineMain(context, ...names) {
  const loaded = instances.get(context) || new Map();
  instances.set(context, loaded);
  for (const name of names) {
    const file = owners.get(name);
    if (!file) throw new Error(`main defines no ${name} from its modules`);
    if (!loaded.has(file)) {
      const exports = require(path.join(root, file)), factory = modules.find(([item]) => item === file)[1];
      loaded.set(file, factory ? exports[factory](context) : exports);
    }
    context[name] = loaded.get(file)[name];
  }
  return context;
}

module.exports = { defineMain };
