const { adapters: declarations, agentOfModel } = require('./registry.mjs');
const { createPathInstall, onPath } = require('./path-install.cjs');
const claude = require('../claude-runtime/adapter.cjs');
const codex = require('../codex-runtime/adapter.cjs');

// Bind the locators main already owns for its terminal and native sessions.
function runtimeInstall(createInstall, callbacks) {
  const install = createInstall();
  return {
    install,
    settingsInstall: options => {
      const { peek, refresh } = callbacks(options);
      return { peek: () => { const snapshot = peek?.(); return snapshot ? install.stateOf(snapshot) : null; }, refresh };
    },
  };
}

const runtimes = new Map([
  ['claude', { ...runtimeInstall(claude.createInstall, ({ claude: peek, refreshClaude: refresh }) => ({ peek, refresh })), transcript: claude.transcript, events: claude.events }],
  ['codex', { ...runtimeInstall(codex.createInstall, ({ codex: peek, refreshCodex: refresh }) => ({ peek, refresh })), transcript: codex.transcript }],
]);

function createAdapter(manifest, runtime, pathOptions) {
  const defaultInstall = () => createPathInstall(manifest, pathOptions);
  return Object.freeze({ manifest, ...(runtime ?? { install: defaultInstall(), settingsInstall: defaultInstall }) });
}

const registered = Object.freeze(declarations().map(({ manifest }) => createAdapter(manifest, runtimes.get(manifest.id))));
const adapters = () => registered;
const adapterOf = id => registered.find(({ manifest }) => manifest.id === id);
const adapterOfModel = model => adapterOf(agentOfModel(model));

module.exports = { adapters, adapterOf, adapterOfModel, agentOfModel, createAdapter, onPath };
