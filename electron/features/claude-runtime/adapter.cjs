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

async function modelProbe(host, cwd, installed) {
  const { app, probeClaude, createSdkLoader, resolveClaudeExecutable, claudeLocator, apiEnvironment,
    listModels, netRequest, electronNet, process = globalThis.process } = host;
  const key = host.claudeRuntime?.credentials.read();
  let rows = [];
  try {
    if (installed()) rows = await probeClaude({
      loadSdk: createSdkLoader({ packaged: app.isPackaged }),
      options: { cwd, pathToClaudeCodeExecutable: await resolveClaudeExecutable({ locator: claudeLocator }),
        ...(key ? { env: apiEnvironment(process.env, key) } : {}) },
    });
  } catch { /* The keyed model list is independent of the SDK probe. */ }
  if (key) {
    const listed = await listModels(key, { request: netRequest(electronNet) });
    if (Array.isArray(listed.models)) for (const model of listed.models) {
      if (!rows.some(row => (row.resolvedModel || row.value) === model)) rows.push({ model });
    }
  }
  return rows;
}

module.exports = { createInstall, modelProbe, transcript: require('./transcript.cjs'), events: { hooks: require('./hooks.cjs') } };
