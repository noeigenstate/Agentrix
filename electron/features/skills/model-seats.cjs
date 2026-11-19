// Seat choices are configuration, never evidence of which model actually ran.
const { modelRow } = require('./model-catalog.cjs');
const { BASE_EFFORTS, EFFORT, familyOf: family, validModel, rankByName: rankOf, unsupportedEffort } = require('./seat-rules.mjs');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ALIASES = ['opus', 'sonnet', 'haiku'];
const TEAM = { orchestrator: 'opus', product: 'opus', architect: 'opus', designer: 'sonnet', developer: 'opus',
  reviewer: 'opus', qa: 'sonnet', researcher: 'sonnet', devops: 'sonnet', security: 'opus' };
const CODEX_ROLES = new Set(['developer', 'devops']);
const refusal = (code, seat, message) => ({ ok: false, code, ...(seat ? { seat } : {}), message });
const fail = (code, seat, message) => { throw Object.assign(new Error(message), refusal(code, seat, message)); };

function cleanSeat(raw, seat, models, stored = false) {
  if (!object(raw) || !validModel(raw.model)) fail('invalid-model', seat, 'Expected a valid model id of at most 160 characters.');
  const agent = family(raw.model);
  const row = models?.find(row => row.model === raw.model);
  if (typeof raw.effort !== 'string' || !EFFORT.test(raw.effort) || !stored && !(row?.efforts || BASE_EFFORTS[agent]).includes(raw.effort)) {
    fail('invalid-effort', seat, unsupportedEffort(agent));
  }
  if (raw.fast !== undefined && (typeof raw.fast !== 'boolean' || !stored && raw.fast && (row ? !row.fast : agent === 'claude'))) fail('fast-not-allowed', seat, 'Fast mode is unavailable for this model.');
  return { model: raw.model, effort: raw.effort, ...(raw.fast !== undefined ? { fast: raw.fast } : {}) };
}

function cleanSeats(raw, seatIds, models, stored = false) {
  if (!object(raw)) fail('invalid-model', null, 'Expected a seat map.');
  return Object.fromEntries(seatIds.filter(id => Object.hasOwn(raw, id)).map(id => [id, cleanSeat(raw[id], id, models, stored)]));
}

// A corrupt stored choice must not erase another seat.
function cleanStoredSeats(raw, seatIds) {
  if (!object(raw)) return {};
  return Object.fromEntries(seatIds.flatMap(id => {
    if (!Object.hasOwn(raw, id)) return [];
    try { return [[id, cleanSeat(raw[id], id, null, true)]]; } catch { return []; }
  }));
}

function oldRoleValues(raw, claude, codex) {
  return Object.fromEntries(Object.entries({ orchestrator: claude ?? codex, architect: raw.architect, designer: raw.visual,
    developer: raw.core ?? raw.execution, reviewer: raw.reviewer, qa: raw.visual, researcher: raw.lookup }).filter(([, value]) => value != null));
}

function migrateSeats(raw) {
  const source = cleanStoredSeats(raw, ['architect', 'core', 'execution', 'visual', 'lookup', 'reviewer']);
  const lead = cleanStoredSeats(raw?.lead, ['claude', 'codex']);
  const claude = lead.claude && family(lead.claude.model) === 'claude' ? lead.claude : undefined;
  const codex = lead.codex && family(lead.codex.model) === 'codex' ? lead.codex : undefined;
  const kept = claude ?? codex;
  const notice = kept ? `总指挥沿用原领队 ${claude ? 'Claude' : 'Codex'} 槽 ${kept.model}·${kept.effort}${kept.fast ? '·fast' : ''}${claude && codex ? `；原 Codex 槽 ${codex.model} 未保留` : ''}` : null;
  return { map: oldRoleValues(source, claude, codex), notice };
}

function migrateDefaultModels(raw, seatIds) {
  const old = raw || {};
  const remapped = oldRoleValues(old, old['lead.claude'], old['lead.codex']);
  // Lookup choices migrate, but the Haiku lookup default never belonged to the researcher seat.
  delete remapped.researcher;
  return Object.fromEntries(seatIds.flatMap(id => typeof (old[id] ?? remapped[id]) === 'string' ? [[id, old[id] ?? remapped[id]]] : []));
}

function catalog(installed, knownModels = []) {
  const rows = [
    ...ALIASES.map(model => ({ ...modelRow({ model, displayName: `${model[0].toUpperCase() + model.slice(1)} (follows latest)` }, 'alias') })),
    ...(!knownModels.some(row => family(row.model || row.value || '') === 'codex') ? [modelRow({ model: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', fast: true }, 'cached')] : []),
  ];
  for (const row of knownModels) {
    const normalized = modelRow(row, row.source || 'live');
    if (!normalized) continue;
    const index = rows.findIndex(item => item.model === normalized.model);
    if (index < 0) rows.push(normalized); else rows[index] = normalized;
    if (ALIASES.includes(row.alias)) {
      const aliasIndex = rows.findIndex(item => item.model === row.alias);
      rows[aliasIndex] = { ...normalized, model: row.alias, label: rows[aliasIndex].label, source: 'alias', listed: true };
    }
  }
  return rows.map(row => ({ ...row, efforts: [...row.efforts], available: !!installed[row.family], ...(!installed[row.family] ? { reason: `${row.family === 'claude' ? 'Claude Code' : 'Codex'} is not installed.` } : {}) }));
}

const versionOrder = (left, right) => Number(left[0]) - Number(right[0]) || Number(left[1] || 0) - Number(right[1] || 0);
const high = model => ({ model, effort: 'high' });

function codexDefault(models) {
  const candidates = models.flatMap(row => {
    const version = /^gpt-(\d+)(?:\.(\d+))?-sol$/.exec(row.model);
    return version && row.available !== false && row.listed !== false ? [{ model: row.model, version: version.slice(1) }] : [];
  });
  const newest = candidates.sort((a, b) => versionOrder(b.version, a.version))[0];
  return { ...high(newest?.model || 'gpt-6.1-sol'), fast: true };
}

function defaultsFor(installed, models = [], seatIds = Object.keys(TEAM)) {
  if (!installed.claude && !installed.codex) return {};
  const codex = codexDefault(models);
  return Object.fromEntries(seatIds.map((id, index) => [id, !installed.claude || installed.codex && index > 0 && CODEX_ROLES.has(id)
    ? { ...codex } : high(index === 0 || !Object.hasOwn(TEAM, id) ? 'opus' : TEAM[id])]));
}

function effective(defaults, global = {}, project = {}) {
  return structuredClone({ ...defaults, ...global, ...project });
}

// Date and context variants have the same reviewer identity. Explicit provider aliases take precedence for launch.
const releaseOf = model => /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?$/.exec(model.replace(/\[1m\]$/, '').replace(/-\d{8}$/, ''));
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
  if (ALIASES.includes(model)) return model;
  const alias = releaseOf(model)?.[1];
  return alias && aliasTargets(models).get(alias)?.model === model ? alias : null;
}

function checkReviewer(map, models) {
  const { reviewer, developer } = map;
  if (!reviewer || !developer) return null;
  const latest = aliasTargets(models);
  const identity = model => {
    const release = releaseOf(latest.get(model)?.model || model);
    return release ? `${release[1]}-${Number(release[2])}-${Number(release[3] || 0)}` : model;
  };
  const reviewerId = identity(reviewer.model);
  if (identity(developer.model) !== reviewerId) return null;
  const rank = models.find(row => row.model === reviewer.model)?.rank
    ?? rankOf(reviewer.model);
  return models.some(row => row.available && identity(row.model) !== reviewerId && row.rank >= rank)
    ? refusal('reviewer-same-model', 'reviewer', 'Choose a reviewer different from developer when another available model is at least as strong.') : null;
}

function resolveSeat(choice, fallback, installed, models) {
  const selected = choice && installed[family(choice.model)] ? choice : fallback;
  if (!selected) return null;
  const row = models.find(row => row.model === selected.model);
  const seat = { ...selected };
  if (row && !row.efforts.includes(seat.effort)) seat.effort = row.defaultEffort || row.efforts[0];
  if (row && seat.fast && !row.fast) seat.fast = false;
  return seat;
}

function leadOptions(map, agent, installed, models = [], lead = 'orchestrator') {
  if (!installed[agent]) return null;
  const fallback = agent === 'claude' ? high('opus') : codexDefault(models);
  const selected = Object.hasOwn(map, lead) && family(map[lead].model) === agent ? map[lead] : fallback;
  return resolveSeat(selected, fallback, installed, models);
}

function leadConfiguration(map, lead, installed, models) {
  const leads = { claude: leadOptions(map, 'claude', installed, models, lead), codex: leadOptions(map, 'codex', installed, models, lead) };
  const preferred = Object.hasOwn(map, lead) ? family(map[lead].model) : null;
  return { leads, leadAgent: preferred && leads[preferred] ? preferred : leads.claude ? 'claude' : leads.codex ? 'codex' : null };
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

module.exports = { cleanSeats, cleanStoredSeats, migrateSeats, migrateDefaultModels, checkReviewer, catalog, defaultsFor, effective,
  leadOptions, leadConfiguration, resolveSeat, agentAlias, seatIssues, rankOf };
