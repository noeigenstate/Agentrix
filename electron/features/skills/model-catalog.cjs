const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('../../atomic-write.cjs');

const MODEL = /^[A-Za-z0-9][\w.:@+/[\]-]*$/;
const EFFORT = /^[a-z][a-z0-9-]{0,31}$/;
const BASE = { claude: ['low', 'medium', 'high', 'xhigh', 'max'], codex: ['low', 'medium', 'high', 'xhigh'] };
const familyOf = model => /^(opus|sonnet|haiku|claude-)/.test(model) ? 'claude' : 'codex';
const validModel = model => typeof model === 'string' && model.length <= 160 && MODEL.test(model);
const rankOf = model => /(^|[-_.])(haiku|mini|nano|lite)([-_.]|$)/.test(model) ? 1 : /(^|[-_.])sonnet([-_.]|$)/.test(model) ? 2 : 3;
const RETAIN = 30 * 24 * 60 * 60 * 1000;

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
  const model = raw.resolvedModel || raw.model || raw.value;
  if (!validModel(model) || model === 'default' || raw.value === 'default') return null;
  const family = familyOf(model);
  const supplied = raw.efforts ?? raw.supportedEffortLevels ?? raw.supportedReasoningEfforts?.map(item => item.reasoningEffort);
  const efforts = Array.isArray(supplied) ? [...new Set(supplied.filter(value => typeof value === 'string' && EFFORT.test(value)))].slice(0, 32) : [...BASE[family]];
  const levels = efforts.length ? efforts : [...BASE[family]];
  const advertised = raw.fast ?? raw.supportsFastMode;
  const tiers = raw.additionalSpeedTiers || raw.serviceTiers;
  const fast = advertised === true || Array.isArray(tiers) && tiers.some(tier => ['fast', 'priority'].includes(typeof tier === 'string' ? tier : tier?.id));
  const defaultEffort = raw.defaultEffort ?? raw.defaultReasoningEffort;
  return { model, label: String(raw.label || raw.displayName || model).replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 80), family,
    efforts: levels, defaultEffort: levels.includes(defaultEffort) ? defaultEffort : levels.includes('high') ? 'high' : levels[0],
    fast, ...(!fast ? { fastReason: ['unsupported', 'unknown', 'agent-tool'].includes(raw.fastReason) ? raw.fastReason : advertised === false || Array.isArray(tiers) ? 'unsupported' : 'unknown' } : {}),
    rank: [1, 2, 3].includes(raw.rank) ? raw.rank : rankOf(model), available: true, source,
    listed: raw.listed !== false, ...(['opus', 'sonnet', 'haiku'].includes(raw.alias || raw.value) ? { alias: raw.alias || raw.value } : {}),
    ...(typeof raw.isDefault === 'boolean' ? { isDefault: raw.isDefault } : {}) };
}

class ModelCatalog {
  constructor({ dataDir, probes = {}, now = Date.now, changed = () => {}, report = () => {} }) {
    Object.assign(this, { probes, now, changed, report });
    this.file = path.join(dataDir, 'seat-models.json'); this.pending = new Map();
    this.data = { version: 1, codex: { at: null, rows: [] }, claude: { at: null, rows: [] } };
    try {
      const stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (stored.version === 1) for (const family of ['codex', 'claude']) {
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
  rows() { return ['claude', 'codex'].flatMap(family => this.data[family].rows.filter(row => row.listed || this.now() - row.lastSeen < RETAIN)); }
  timestamps() { return { claude: this.data.claude.at, codex: this.data.codex.at }; }
  accept(family, rows) {
    if (!Array.isArray(rows)) return;
    const at = this.now(), fresh = this.normalize(rows, family, 'live').map(row => ({ ...row, listed: true, lastSeen: at }));
    const ids = new Set(fresh.map(row => row.model));
    const retained = this.data[family].rows.filter(row => !ids.has(row.model) && at - row.lastSeen < RETAIN)
      .map(row => ({ ...row, listed: false, source: 'cached' }));
    this.data[family] = { at, rows: [...fresh, ...retained].slice(0, 300) };
    try { writeFileAtomic(this.file, JSON.stringify(this.data)); } catch (error) { this.report(error); }
    this.changed();
  }
  async refresh(reason = 'dialog') {
    await Promise.all(['codex', 'claude'].map(async family => {
      const age = reason === 'manual' ? 0 : family === 'claude' ? 24 * 3600000 : reason === 'startup' ? 6 * 3600000 : 3600000;
      if (reason === 'startup' && family === 'claude' || !this.probes[family]) return;
      const at = this.data[family].at;
      if (reason !== 'manual' && at !== null && this.now() - at < age) return;
      if (!this.pending.has(family)) {
        const task = Promise.resolve().then(() => this.probes[family]()).then(rows => this.accept(family, rows))
          .catch(() => {}).finally(() => this.pending.delete(family));
        this.pending.set(family, task);
      }
      await this.pending.get(family);
    }));
  }
}

module.exports = { BASE, EFFORT, familyOf, validModel, rankOf, modelRow, ModelCatalog, trackModelRuntime };
