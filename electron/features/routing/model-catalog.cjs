const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('../../atomic-write.cjs');
const { adapters, agentIds, canonicalModelId } = require('../cli-adapters/registry.mjs');
const { adapterOfModel, EFFORT, validModel, rankByName: rankOf } = require('./seat-rules.mjs');

const RETAIN = 30 * 24 * 60 * 60 * 1000;
const FAILED_RETRY = 60_000;
const PROBE_ERRORS = new Set(['auth_required', 'cli_required', 'cli_outdated']);

function trackModelRuntime(runtime, { local = true, runtimes, observe }) {
  if (!local) return runtime;
  const models = runtime.models.bind(runtime), close = runtime.close.bind(runtime);
  runtimes.add(runtime);
  runtime.models = async () => {
    const rows = await models();
    if (runtimes.has(runtime)) observe(rows);
    return rows;
  };
  runtime.close = async () => { runtimes.delete(runtime); await close(); };
  return runtime;
}

function modelRow(raw, source = 'live') {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.resolvedModel || raw.model || raw.value;
  if (!validModel(id) || id === 'default' || raw.value === 'default') return null;
  const model = canonicalModelId(id);
  const { id: family, models: { efforts: baseEfforts } } = adapterOfModel(model).manifest;
  const supplied = raw.efforts ?? raw.supportedEffortLevels ?? raw.supportedReasoningEfforts?.map(item => item.reasoningEffort);
  const efforts = Array.isArray(supplied) ? [...new Set(supplied.filter(value => typeof value === 'string' && EFFORT.test(value)))].slice(0, 32) : [];
  const levels = efforts.length ? efforts : [...baseEfforts];
  const advertised = raw.fast ?? raw.supportsFastMode;
  const tiers = raw.additionalSpeedTiers || raw.serviceTiers;
  const fast = advertised === true || Array.isArray(tiers) && tiers.some(tier => ['fast', 'priority'].includes(typeof tier === 'string' ? tier : tier?.id));
  const defaultEffort = raw.defaultEffort ?? raw.defaultReasoningEffort;
  const alias = raw.alias || raw.value;
  return { model, label: String(raw.label || raw.displayName || model).replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 80), family,
    efforts: levels, defaultEffort: levels.includes(defaultEffort) ? defaultEffort : levels.includes('high') ? 'high' : levels[0],
    fast, ...(!fast ? { fastReason: ['unsupported', 'unknown', 'agent-tool'].includes(raw.fastReason) ? raw.fastReason : advertised === false || Array.isArray(tiers) ? 'unsupported' : 'unknown' } : {}),
    rank: [1, 2, 3].includes(raw.rank) ? raw.rank : rankOf(model), available: true, source,
    listed: raw.listed !== false, ...(typeof alias === 'string' && adapterOfModel(alias).manifest.models.aliases.includes(alias) && { alias }),
    ...(typeof raw.isDefault === 'boolean' ? { isDefault: raw.isDefault } : {}) };
}

class ModelCatalog {
  constructor({ dataDir, probes = {}, now = Date.now, changed = () => {}, report = () => {} }) {
    Object.assign(this, { probes, now, changed, report });
    this.file = path.join(dataDir, 'seat-models.json'); this.pending = new Map(); this.failures = new Map();
    this.data = { version: 1, ...Object.fromEntries(agentIds().map(id => [id, { at: null, rows: [] }])) };
    try {
      const stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (stored.version === 1) for (const family of agentIds()) {
        const at = Number.isFinite(stored[family]?.at) ? stored[family].at : null;
        this.data[family] = { at, rows: this.normalize(stored[family]?.rows, family, 'cached').map(row => ({ ...row,
          lastSeen: Number.isFinite(row.lastSeen) ? Math.min(row.lastSeen, this.now()) : at ?? this.now() })) };
      }
    } catch (error) { if (error.code !== 'ENOENT') report(error); }
  }
  normalize(rows, family, source) {
    const result = [], seen = new Set();
    for (const raw of Array.isArray(rows) ? rows : []) {
      const row = modelRow(raw, source);
      if (!row || row.family !== family || seen.has(row.model)) continue;
      seen.add(row.model); result.push({ ...row, ...(Number.isFinite(raw.lastSeen) ? { lastSeen: raw.lastSeen } : {}) });
      if (result.length === 300) break;
    }
    return result;
  }
  rows() { return agentIds().flatMap(id => this.data[id].rows.filter(row => row.listed || this.now() - row.lastSeen < RETAIN)); }
  timestamps() { return Object.fromEntries(agentIds().map(id => [id, this.data[id].at])); }
  errors() { return Object.fromEntries([...this.failures].map(([family, { code }]) => [family, code])); }
  fail(family, code) {
    const previous = this.failures.get(family)?.code;
    this.failures.set(family, { at: this.now(), code });
    if (code !== previous) this.changed();
  }
  accept(family, rows, background = false) {
    const prior = this.data[family];
    if (!Array.isArray(rows) || !prior?.rows) return;
    const at = this.now(), fresh = this.normalize(rows, family, 'live').map(row => ({ ...row, listed: true, lastSeen: at }));
    if (background && !fresh.length) return this.fail(family, 'no_models');
    const recovered = this.failures.delete(family);
    const ids = new Set(fresh.map(row => row.model));
    const retained = prior.rows.filter(row => !ids.has(row.model) && at - row.lastSeen < RETAIN)
      .map(row => ({ ...row, listed: false, source: 'cached' }));
    const next = { at, rows: [...fresh, ...retained].slice(0, 300) };
    const content = rows => JSON.stringify(rows.map(({ lastSeen, source, ...row }) => row));
    const changed = content(next.rows) !== content(prior.rows);
    this.data[family] = next;
    try { writeFileAtomic(this.file, JSON.stringify(this.data)); } catch (error) { this.report(error); }
    if (changed || recovered || background && at !== prior.at) this.changed();
  }
  async refresh(reason = 'dialog', { waitForBackground = true } = {}) {
    await Promise.all(adapters().map(({ manifest: { id: family, models: { catalogAge, catalogBackground } } }) => {
      const age = Object.hasOwn(catalogAge, reason) ? catalogAge[reason] : catalogAge.dialog;
      if (age === null || !this.probes[family]) return;
      const at = this.data[family].at;
      const failed = this.failures.get(family);
      if (reason !== 'manual' && (failed ? this.now() - failed.at < FAILED_RETRY : at !== null && this.now() - at < age)) return;
      if (!this.pending.has(family)) {
        const task = Promise.resolve().then(() => this.probes[family]()).then(rows => this.accept(family, rows, catalogBackground))
          .catch(error => this.fail(family, PROBE_ERRORS.has(error?.catalogCode) ? error.catalogCode : 'probe_failed')).finally(() => this.pending.delete(family));
        this.pending.set(family, task);
      }
      if (!catalogBackground || waitForBackground) return this.pending.get(family);
    }));
  }
}

module.exports = { EFFORT, validModel, rankOf, modelRow, ModelCatalog, trackModelRuntime };
