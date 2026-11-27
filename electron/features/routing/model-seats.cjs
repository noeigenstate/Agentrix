// Seat choices are configuration, never evidence of which model actually ran.
const { modelRow } = require('./model-catalog.cjs');
const { canLead } = require('../cli-adapters/capabilities.mjs');
const { adapters, adapterOf, localModel, canonicalModelId } = require('../cli-adapters/registry.mjs');
const { adapterOfModel, agentOfModel, EFFORT, allowsUltracode, validModel, rankByName: rankOf, unsupportedEffort } = require('./seat-rules.mjs');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const TEAM_ROLES = ['orchestrator', 'product', 'architect', 'designer', 'developer', 'reviewer', 'qa', 'researcher', 'devops', 'security'];
const SONNET_ROLES = new Set(['designer', 'qa', 'researcher', 'devops']);
const refusal = (code, seat, message) => ({ ok: false, code, ...(seat ? { seat } : {}), message });
const fail = (code, seat, message) => { throw Object.assign(new Error(message), refusal(code, seat, message)); };

function cleanSeat(raw, seat, models, stored = false, isLead = seat === 'orchestrator') {
  if (!object(raw) || !validModel(raw.model)) fail('invalid-model', seat, 'Expected a valid model id of at most 160 characters.');
  const { manifest } = adapterOfModel(raw.model);
  if (isLead && !canLead(manifest)) fail('invalid-model', seat, 'This CLI is available only for dispatched roles.');
  const { id: agent, models: { efforts, fastDefault } } = manifest;
  const model = canonicalModelId(raw.model);
  const row = models?.find(row => row.model === model);
  if (typeof raw.effort !== 'string' || !EFFORT.test(raw.effort) || !stored && !(row?.efforts || efforts).includes(raw.effort)) {
    fail('invalid-effort', seat, unsupportedEffort(agent));
  }
  if (raw.fast !== undefined && (typeof raw.fast !== 'boolean' || !stored && raw.fast && !(row ? row.fast : fastDefault))) {
    fail('fast-not-allowed', seat, 'Fast mode is unavailable for this model.');
  }
  const ultracode = allowsUltracode(model, isLead);
  if (Object.hasOwn(raw, 'ultracode') && (typeof raw.ultracode !== 'boolean' || !stored && raw.ultracode && isLead && !ultracode)) {
    fail('ultracode-not-allowed', seat, 'Ultracode requires a Claude orchestrator and a boolean setting.');
  }
  return { model, effort: raw.effort, ...(raw.fast !== undefined ? { fast: raw.fast } : {}), ...(ultracode && raw.ultracode && { ultracode: true }) };
}

// A corrupt stored choice must not erase another seat.
function cleanStoredSeats(raw, seatIds) {
  if (!object(raw)) return {};
  return Object.fromEntries(seatIds.flatMap(id => {
    if (!Object.hasOwn(raw, id)) return [];
    try { return [[id, cleanSeat(raw[id], id, null, true)]]; } catch { return []; }
  }));
}

function catalog(installed, knownModels = []) {
  const rows = adapters().flatMap(({ manifest }) => catalogDefaults(manifest, knownModels));
  for (const row of knownModels) {
    const normalized = modelRow(row, row.source || 'live');
    if (!normalized) continue;
    const index = rows.findIndex(item => item.model === normalized.model);
    if (index < 0) rows.push(normalized); else rows[index] = normalized;
    const aliasIndex = row.alias && aliasesOf(row.alias).includes(row.alias) ? rows.findIndex(item => item.model === row.alias) : -1;
    if (aliasIndex >= 0) {
      rows[aliasIndex] = { ...normalized, model: row.alias, label: rows[aliasIndex].label, source: 'alias', listed: true };
    }
  }
  return rows.map(row => {
    const available = !!installed[row.family];
    return { ...row, efforts: [...row.efforts], available, ...(!available && { reason: `${adapterOf(row.family).manifest.label} is not installed.` }) };
  });
}

const titleCase = word => word.charAt(0).toUpperCase() + word.slice(1);

function catalogDefaults({ id, models: { aliases, fallback, fastDefault } }, knownModels) {
  if (aliases.length) return aliases.map(model => modelRow({ model, displayName: `${titleCase(localModel(model))} (follows latest)` }, 'alias'));
  if (!fallback || knownModels.some(row => agentOfModel(row.model || row.value || '') === id)) return [];
  const label = localModel(fallback).split('-').map((word, index) => index ? titleCase(word) : word.toUpperCase()).join('-');
  return [modelRow({ model: fallback, label, fast: fastDefault }, 'cached')];
}

const versionOrder = (left, right) => Number(left[0]) - Number(right[0]) || Number(left[1] || 0) - Number(right[1] || 0);
const high = model => ({ model, effort: 'high' });

function providerDefault({ id, models: { fallback, preferred, fastDefault } }, rows) {
  const choices = rows.filter(row => row.available !== false && row.listed !== false && agentOfModel(row.model) === id);
  if (!fallback) {
    const row = choices.find(row => row.isDefault) ?? choices[0];
    return row ? { model: row.model, effort: row.defaultEffort ?? row.efforts?.[0] ?? 'high' } : null;
  }
  let model = fallback, bestVersion;
  if (preferred) for (const row of choices) {
    const match = preferred.exec(localModel(row.model));
    if (!match) continue;
    const version = match.slice(1);
    if (!bestVersion || versionOrder(version, bestVersion) > 0) {
      model = row.model;
      bestVersion = version;
    }
  }
  return { ...high(model), ...(fastDefault && { fast: true }) };
}

function defaultsFor(installed, models = [], seatIds = TEAM_ROLES) {
  const defaults = new Map(), roleProviders = new Map();
  let lead, catalogLead;
  for (const { manifest } of adapters()) {
    if (!installed[manifest.id]) continue;
    const seat = providerDefault(manifest, models);
    if (!seat) continue;
    defaults.set(manifest.id, seat);
    for (const role of manifest.models.defaultRoles ?? []) roleProviders.set(role, manifest.id);
    if (canLead(manifest)) {
      if (manifest.models.fallback) lead ??= manifest.id;
      else catalogLead ??= manifest.id;
    }
  }
  // A provider whose models arrive in the background must not displace an existing default lead.
  lead ??= catalogLead;
  const primary = lead ?? defaults.keys().next().value;
  return Object.fromEntries(seatIds.flatMap((id, index) => {
    const provider = index === 0 ? lead : roleProviders.get(id) ?? primary;
    if (!provider) return [];
    const useSonnet = index > 0 && SONNET_ROLES.has(id) && agentOfModel('sonnet') === provider;
    return [[id, useSonnet ? high('sonnet') : { ...defaults.get(provider) }]];
  }));
}

function effective(defaults, global = {}, project = {}) {
  return structuredClone({ ...defaults, ...global, ...project });
}

// Date and context variants have the same reviewer identity. Explicit provider aliases take precedence for launch.
const aliasesOf = model => adapterOfModel(model).manifest.models.aliases;
function releaseOf(model) {
  const release = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(model.replace(/\[1m\]$/, '').replace(/-\d{8}$/, ''));
  return release && aliasesOf(model).includes(release[1]) ? release : null;
}
function aliasTargets(models) {
  const latest = new Map();
  for (const row of models) {
    const release = releaseOf(row.model);
    if (!release || row.listed === false) continue;
    const alias = release[1], version = release.slice(2), explicit = row.alias === alias;
    const prior = latest.get(alias), order = prior ? versionOrder(version, prior.version) : 0;
    if (!prior || explicit && !prior.explicit || explicit === prior.explicit && (order > 0 || !order && row.model === release[0])) {
      latest.set(alias, { model: row.model, version, explicit });
    }
  }
  return latest;
}

function agentAlias(model, models) {
  if (aliasesOf(model).includes(model)) return model;
  const alias = releaseOf(model)?.[1];
  return alias && aliasTargets(models).get(alias)?.model === model ? alias : null;
}

const concreteAlias = (alias, models) => aliasTargets(models).get(alias)?.model;

function modelIdentity(models) {
  const latest = aliasTargets(models);
  return model => {
    const release = releaseOf(latest.get(model)?.model || model);
    return release ? `${release[1]}-${Number(release[2])}-${Number(release[3] || 0)}` : model;
  };
}

function resolveSeat(choice, fallback, installed, models, isLead = false) {
  const selected = choice && installed[agentOfModel(choice.model)] ? choice : fallback;
  if (!selected) return null;
  const seat = { ...selected, model: canonicalModelId(selected.model) };
  const row = models.find(row => row.model === seat.model);
  if (row && !row.efforts.includes(seat.effort)) seat.effort = row.defaultEffort || row.efforts[0];
  if (row && seat.fast && !row.fast) seat.fast = false;
  if (seat.ultracode !== true || !allowsUltracode(seat.model, isLead)) delete seat.ultracode;
  return seat;
}

function leadOptions(map, agent, installed, models = [], lead = 'orchestrator') {
  const adapter = adapterOf(agent);
  if (!adapter || !installed[agent] || !canLead(adapter.manifest)) return null;
  const fallback = providerDefault(adapter.manifest, models);
  const selected = Object.hasOwn(map, lead) && agentOfModel(map[lead].model) === agent ? map[lead] : fallback;
  return resolveSeat(selected, fallback, installed, models, true);
}

function leadConfiguration(map, lead, installed, models) {
  const ids = adapters().filter(({ manifest }) => canLead(manifest)).map(({ manifest }) => manifest.id);
  const leads = Object.fromEntries(ids.map(id => [id, leadOptions(map, id, installed, models, lead)]));
  const preferred = Object.hasOwn(map, lead) ? agentOfModel(map[lead].model) : null;
  return { leads, leadAgent: preferred && leads[preferred] ? preferred : ids.find(id => leads[id]) ?? null };
}

function seatIssues(map, models) {
  const issues = [];
  for (const [slot, seat] of Object.entries(map)) {
    const row = models.find(row => row.model === seat.model);
    if (!row || row.listed === false) issues.push({ slot, code: 'model-unlisted', substitute: seat.model });
    if (row && !row.efforts.includes(seat.effort)) issues.push({ slot, code: 'effort-unsupported', substitute: row.defaultEffort || row.efforts[0] });
    if (row && seat.fast && !row.fast) issues.push({ slot, code: 'fast-unsupported', substitute: false });
  }
  return issues;
}

module.exports = { cleanSeat, cleanStoredSeats, modelIdentity, catalog, defaultsFor, effective,
  leadOptions, leadConfiguration, resolveSeat, agentAlias, concreteAlias, seatIssues, rankOf };
