const fs = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { SESSION_ID, config, initialize, openSession, setConfig, modelKey, errorWithCode } = require('./session.cjs');
const activeCatalogs = new Set();

// ACP lists orchestration modes as model options with only a value and name, so identify them by their ID family.
const isCatalogModel = model => typeof model === 'string' && !/^(?:agy:)?gemini-pro-orchestrator(?:-|$)/i.test(model);

function transcriptFile(profile, sessionId) {
  if (!profile || !SESSION_ID.test(sessionId)) return null;
  return path.join(profile, 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs', 'transcript_full.jsonl');
}

async function transcriptOffset(profile, sessionId) {
  const file = transcriptFile(profile, sessionId);
  return file ? fs.promises.stat(file).then(stat => stat.size, () => 0) : 0;
}

async function readActualModel(profile, sessionId, offset = 0) {
  const file = transcriptFile(profile, sessionId);
  if (!file) return null;
  let model = null;
  const source = fs.createReadStream(file, { start: offset });
  const lines = createInterface({ input: source, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row?.type === 'PLANNER_RESPONSE' && typeof row.model === 'string' && /^[\w.-]{1,128}$/.test(row.model)) model = row.model;
      } catch {}
    }
  } catch { return null; }
  finally { lines.close(); source.destroy(); }
  return model;
}

function observedModel(actual, effective) {
  if (!actual) return { model: null, effort: null, fast: null };
  const effort = /-(low|medium|high|xhigh)$/.exec(actual)?.[1];
  const base = effort && modelKey(actual.slice(0, -effort.length - 1));
  if (base && base === effective.model) return { model: base, effort, fast: null };
  return { model: modelKey(actual), effort: null, fast: null };
}

function removeCatalog(folder, report) {
  return fs.promises.rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(error => {
    report?.(Object.assign(new Error('Could not remove an Antigravity model probe profile.'), { code: error.code }));
  });
}

async function catalogProfileAt(profile, report) {
  const parent = path.dirname(profile);
  await fs.promises.mkdir(parent, { recursive: true });
  const folders = await fs.promises.readdir(parent, { withFileTypes: true });
  await Promise.all(folders.filter(folder => folder.isDirectory() && folder.name.startsWith('catalog-'))
    .map(folder => path.join(parent, folder.name)).filter(folder => !activeCatalogs.has(folder)).map(folder => removeCatalog(folder, report)));
  const catalogProfile = fs.mkdtempSync(path.join(parent, 'catalog-'));
  activeCatalogs.add(catalogProfile);
  return catalogProfile;
}

async function probeModels(connect, { cwd, env, profile, spec, signal, clientVersion, rpcTimeoutMs, report }) {
  const catalogProfile = profile && await catalogProfileAt(profile, report);
  let connection, sessionId, initialized;
  const abort = () => { void connection?.close().catch(() => {}); };
  const checkOpen = () => { if (signal?.aborted) throw errorWithCode('session_closed'); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    checkOpen();
    connection = await connect({ spec, purpose: 'catalog', signal, cwd, env, profile: catalogProfile, rpcTimeoutMs });
    checkOpen();
    const { rpc } = connection;
    initialized = await initialize(rpc, clientVersion);
    const session = await openSession(rpc, { cwd: connection.cwd });
    sessionId = session.sessionId;
    const model = config(session.configOptions, 'model');
    if (!model?.options?.length) throw errorWithCode('agy_config_mismatch');
    const rows = [];
    for (const { value, name } of model.options) {
      if (!isCatalogModel(value)) continue;
      const options = value === model.currentValue ? session.configOptions : await setConfig(rpc, sessionId, 'model', value);
      const thinking = config(options, 'thought_level');
      const efforts = thinking?.options?.map(option => option.value) || [];
      rows.push({ model: modelKey(value), label: name, efforts: efforts.length ? efforts : ['default'],
        defaultEffort: efforts.includes(thinking?.currentValue) ? thinking.currentValue : efforts[0] ?? 'default', fast: false, isDefault: value === model.currentValue });
    }
    return rows;
  } finally {
    signal?.removeEventListener('abort', abort);
    try {
      if (sessionId && initialized.agentCapabilities?.sessionCapabilities?.close)
        await connection.rpc.request('session/close', { sessionId }, 1000).catch(() => {});
      await connection?.close();
    } finally {
      if (catalogProfile) {
        try { await removeCatalog(catalogProfile, report); }
        finally { activeCatalogs.delete(catalogProfile); }
      }
    }
  }
}

module.exports = { isCatalogModel, observedModel, probeModels, readActualModel, transcriptOffset };
