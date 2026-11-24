const { createLocator } = require('./locator.cjs');

const found = candidate => ({ version: candidate.version, via: candidate.via, fileShown: candidate.fileShown });

function stateOf({ terminal, native, reason, version, failure, incomplete }) {
  const state = { installed: !!terminal || !!failure?.found || reason === 'too_old' || !!incomplete, ...(terminal ? found(terminal) : {}) };
  if (reason === 'too_old') Object.assign(state, { reason, version: state.version ?? version ?? null });
  if (failure) state.reason = failure.reason;
  if (incomplete) state.incomplete = true;
  if (reason === 'cli_split_versions') Object.assign(state, { notice: reason, native: found(native) });
  return state;
}

function installResult(located) {
  const { installed, version, reason } = stateOf(located);
  return { installed, version: version ?? null, file: located.terminal?.file ?? located.failure?.found ?? null, reason: reason ?? located.reason ?? null };
}

function createInstall(locator = createLocator()) {
  return {
    locate: async env => installResult(await locator.locate({ env })),
    refresh: async env => installResult(await locator.refresh({ env })),
    stateOf,
  };
}

module.exports = { createInstall };
