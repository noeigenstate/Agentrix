const { adapters: declarations, agentOfModel } = require('./registry.mjs');
const { createPathInstall, onPath } = require('./path-install.cjs');
const claude = require('../claude-runtime/adapter.cjs');
const codex = require('../codex-runtime/adapter.cjs');
const claudeSdk = require('../claude-sdk/adapter.cjs');
const codexAppServer = require('../codex-app-server/adapter.cjs');
const { support } = require('./capabilities.mjs');
const { workerOf } = require('./workers.cjs');
const { terminalAdapters } = require('./terminal.cjs');
const usage = require('./usage.cjs');

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
  ['claude', { ...runtimeInstall(claude.createInstall, ({ claude: peek, refreshClaude: refresh }) => ({ peek, refresh })), transcript: claude.transcript, events: claude.events, ...claudeSdk }],
  ['codex', { ...runtimeInstall(codex.createInstall, ({ codex: peek, refreshCodex: refresh }) => ({ peek, refresh })), transcript: codex.transcript, ...codexAppServer }],
]);

function createAdapter(manifest, runtime = {}, pathOptions) {
  const defaultInstall = () => createPathInstall(manifest, pathOptions);
  const install = runtime.install ? {} : { install: defaultInstall(), settingsInstall: defaultInstall };
  const worker = workerOf(manifest.id);
  return Object.freeze({ manifest, ...install, ...runtime, ...(worker && { worker }) });
}

const terminalFacets = terminalAdapters(Object.fromEntries(declarations().map(({ manifest }) => [manifest.id, manifest.words])));
const registered = Object.freeze(declarations().map(({ manifest }) => {
  const runtime = runtimes.get(manifest.id);
  return createAdapter(manifest, { ...runtime, ...terminalFacets[manifest.id], usage: usage[manifest.id] });
}));
const adapters = () => registered;
const adapterOf = id => registered.find(({ manifest }) => manifest.id === id);
const adapterOfModel = model => adapterOf(agentOfModel(model));

// These defaults are part of the existing native and saved-session wire formats.
const defaultNativeAgent = 'claude';
const legacyRestoreAgent = 'codex';
const supportsNative = (id, kind) => {
  const adapter = adapterOf(id);
  return !!adapter && support(adapter.manifest, kind === 'ssh' ? 'ssh.native' : 'native').ok;
};

// Runtimes belong to one host. The bound native facet exposes create(spec, emit).
function bindNativeAdapters(providers) {
  const bound = new Map(registered.filter(adapter => adapter.native).map(adapter => {
    const { id } = adapter.manifest;
    return [id, { ...adapter, native: providers[id] }];
  }));
  return id => bound.get(id);
}

module.exports = { adapters, adapterOf, adapterOfModel, agentOfModel, createAdapter, onPath,
  bindNativeAdapters, defaultNativeAgent, legacyRestoreAgent, support, supportsNative };
