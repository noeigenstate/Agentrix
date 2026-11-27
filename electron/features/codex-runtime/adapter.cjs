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

async function modelProbe(host, cwd, installed) {
  if (!installed()) return null;
  const { loadCodexProbe, probeCodex, spawn, codexExecutable, process = globalThis.process } = host;
  const { createRpc, stopProcess, workerEnvironment } = await loadCodexProbe();
  return probeCodex({ rpcFactory: createRpc, stop: stopProcess, workerEnvironment, spawn, executable: codexExecutable, cwd, env: process.env });
}

module.exports = { createInstall, modelProbe, transcript: require('./transcript.cjs') };
