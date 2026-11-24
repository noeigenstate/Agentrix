const { processLocator } = require('./locator.cjs');

function stateOf({ file, version, via, fileShown, reason, scan }) {
  return file ? { installed: true, version, via, fileShown, ...(reason ? { reason } : {}) } : { installed: false, reason, ...(scan ? { scan } : {}) };
}

function installResult({ file, version, reason }) {
  return { installed: !!file, version, file, reason };
}

function createInstall(locator = processLocator) {
  return {
    locate: async env => installResult(await locator.locate({ env })),
    refresh: async env => installResult(await locator.refresh({ env })),
    stateOf,
  };
}

module.exports = { createInstall, transcript: require('./transcript.cjs') };
