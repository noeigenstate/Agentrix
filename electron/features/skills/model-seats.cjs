// Seat choices are configuration, never evidence of which model actually ran.
const { BASE: EFFORTS, EFFORT, familyOf: family, validModel, rankOf, modelRow } = require('./model-catalog.cjs');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const refusal = (code, seat, message) => ({ ok: false, code, ...(seat ? { seat } : {}), message });
const fail = (code, seat, message) => { throw Object.assign(new Error(message), refusal(code, seat, message)); };

function cleanSeat(raw, seat, expectedFamily, models, stored = false) {
  if (!object(raw) || !validModel(raw.model)) fail('invalid-model', seat, 'Expected a valid model id of at most 160 characters.');
  const agent = family(raw.model);
  if (expectedFamily && agent !== expectedFamily) fail('lead-family', seat, `The ${seat} slot requires a ${expectedFamily} model.`);
  const row = models?.find(row => row.model === raw.model);
  if (typeof raw.effort !== 'string' || !EFFORT.test(raw.effort) || !stored && !(row?.efforts || EFFORTS[agent]).includes(raw.effort)) fail('invalid-effort', seat, `Unsupported ${agent} effort.`);
  if (raw.fast !== undefined && (typeof raw.fast !== 'boolean' || !stored && raw.fast && (row ? !row.fast : agent === 'claude'))) fail('fast-not-allowed', seat, 'Fast mode is unavailable for this model.');
  return { model: raw.model, effort: raw.effort, ...(raw.fast !== undefined ? { fast: raw.fast } : {}) };
}

function cleanSeats(raw, seatIds, models, stored = false) {
  if (!object(raw)) fail('invalid-model', null, 'Expected a seat map.');
  const result = {};
  for (const id of seatIds) {
    if (!Object.hasOwn(raw, id)) continue;
    if (id !== 'lead') result[id] = cleanSeat(raw[id], id, null, models, stored);
    else {
      if (!object(raw.lead)) fail('lead-family', 'lead', 'Expected Claude and Codex lead slots.');
      const lead = {};
      for (const agent of ['claude', 'codex']) if (Object.hasOwn(raw.lead, agent)) lead[agent] = cleanSeat(raw.lead[agent], `lead.${agent}`, agent, models, stored);
      if (Object.keys(lead).length) result.lead = lead;
    }
  }
  return result;
}

// Stored scopes may outlive older validation rules. Keep each valid seat and each independent lead slot.
function cleanStoredSeats(raw, seatIds) {
  let map = {};
  if (!object(raw)) return map;
  for (const id of seatIds) {
    if (!Object.hasOwn(raw, id)) continue;
    const choices = id === 'lead' && object(raw.lead)
      ? ['claude', 'codex'].filter(agent => Object.hasOwn(raw.lead, agent)).map(agent => ({ lead: { [agent]: raw.lead[agent] } })) : [{ [id]: raw[id] }];
    for (const choice of choices) {
      try { map = effective(map, cleanSeats(choice, [id], null, true)); } catch { /* A corrupt choice cannot erase its neighbors. */ }
    }
  }
  return map;
}

function catalog(installed, knownModels = []) {
  const rows = [
    ...['opus', 'sonnet', 'haiku'].map(model => ({ ...modelRow({ model, displayName: `${model[0].toUpperCase() + model.slice(1)} (follows latest)` }, 'alias') })),
    ...(!knownModels.some(row => family(row.model || row.value || '') === 'codex') ? [modelRow({ model: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', fast: true }, 'cached')] : []),
  ];
  for (const row of knownModels) {
    const normalized = modelRow(row, row.source || 'live');
    if (!normalized) continue;
    const index = rows.findIndex(item => item.model === normalized.model);
    if (index < 0) rows.push(normalized); else rows[index] = normalized;
    if (['opus', 'sonnet', 'haiku'].includes(row.alias)) {
      const aliasIndex = rows.findIndex(item => item.model === row.alias);
      rows[aliasIndex] = { ...normalized, model: row.alias, label: rows[aliasIndex].label, source: 'alias', listed: true };
    }
  }
  return rows.map(row => ({ ...row, efforts: [...row.efforts], available: !!installed[row.family], ...(!installed[row.family] ? { reason: `${row.family === 'claude' ? 'Claude Code' : 'Codex'} is not installed.` } : {}) }));
}

function defaultsFor(installed, models = []) {
  if (!installed.claude && !installed.codex) return {};
  const newest = models.filter(row => row.available !== false && row.listed !== false && /^gpt-\d+\.\d+-sol$/.test(row.model))
    .sort((a, b) => { const av = a.model.match(/\d+/g).map(Number), bv = b.model.match(/\d+/g).map(Number); return bv[0] - av[0] || bv[1] - av[1]; })[0];
  const claude = model => ({ model, effort: 'high' }), gpt = () => ({ model: newest?.model || 'gpt-6.1-sol', effort: newest?.defaultEffort || 'high', fast: newest ? newest.fast : true });
  return { lead: { ...(installed.claude ? { claude: claude('opus') } : {}), ...(installed.codex ? { codex: gpt() } : {}) },
    architect: installed.claude ? claude('opus') : gpt(), core: installed.codex ? gpt() : claude('opus'),
    execution: installed.claude ? claude('sonnet') : gpt(), visual: installed.claude ? claude('sonnet') : gpt(),
    lookup: installed.claude ? claude('haiku') : gpt(), reviewer: installed.claude ? claude('opus') : gpt() };
}

function effective(defaults, global = {}, project = {}) {
  const map = { ...defaults, ...global, ...project };
  if (defaults.lead || global.lead || project.lead) map.lead = { ...defaults.lead, ...global.lead, ...project.lead };
  return structuredClone(map);
}

function checkReviewer(map, models) {
  const reviewer = map.reviewer;
  if (!reviewer || !['core', 'execution'].some(id => map[id]?.model === reviewer.model)) return null;
  const rank = models.find(row => row.model === reviewer.model)?.rank
    ?? rankOf(reviewer.model);
  return models.some(row => row.available && row.model !== reviewer.model && row.rank >= rank)
    ? refusal('reviewer-same-model', 'reviewer', 'Choose a reviewer different from core and execution when another available model is at least as strong.') : null;
}

// An explicit model carries its own effort/fast defaults; never attach a different model's seat settings to it.
function leadOptions(map, agent, explicit = {}) {
  const chosen = Object.fromEntries(Object.entries(explicit).filter(([, value]) => value !== null && value !== undefined));
  return { ...(chosen.model ? {} : map?.lead?.[agent]), ...chosen };
}

function seatIssues(map, models) {
  const issues = [];
  for (const [id, value] of Object.entries(map)) for (const [slot, seat] of id === 'lead' ? Object.entries(value).map(([agent, seat]) => [`lead.${agent}`, seat]) : [[id, value]]) {
    const row = models.find(row => row.model === seat.model);
    if (!row || row.listed === false) issues.push({ slot, code: 'model-unlisted', substitute: seat.model });
    if (row && !row.efforts.includes(seat.effort)) issues.push({ slot, code: 'effort-unsupported', substitute: row.defaultEffort || row.efforts[0] });
    if (row && seat.fast && !row.fast) issues.push({ slot, code: 'fast-unsupported', substitute: false });
  }
  return issues;
}

function renderSeats(map, leadAgent, helperPath, installed = { claude: true, codex: true }, models = []) {
  const parts = ['Agentrix model seats (fixed for this session; an instruction in the conversation still wins):'];
  parts.push('These helper model settings supplement the skill\'s full helper form; --role, --title, --cwd, --brief and --out are still required.');
  const fallback = defaultsFor(installed, models);
  for (const [id, value] of Object.entries(map)) {
    const slots = id === 'lead' ? Object.entries(value).map(([agent, seat]) => [`lead.${agent}`, seat]) : [[id, value]];
    for (const [slot, chosen] of slots) {
      const agent = family(chosen.model), original = installed[agent] ? chosen : (id === 'lead' ? fallback.lead?.[leadAgent] : fallback[id]);
      const row = models.find(row => row.model === original?.model), notes = [];
      const seat = original && { ...original };
      if (row && !row.efforts.includes(seat.effort)) { notes.push(`Adjusted effort ${seat.effort} to ${row.defaultEffort}`); seat.effort = row.defaultEffort; }
      if (row && seat.fast && !row.fast) { notes.push('Adjusted fast on to off'); seat.fast = false; }
      if (!seat) { parts.push(`${slot}: ${chosen.model} unavailable; no installed agent can run this seat.`); continue; }
      const model = /^[\w.-]+$/.test(seat.model) ? seat.model : `"${seat.model}"`;
      const alias = ['opus', 'sonnet', 'haiku'].find(alias => seat.model.includes(alias)) || seat.model;
      const target = family(seat.model), flags = `--model ${model} --effort ${seat.effort}${seat.fast ? ' --fast' : ''}`;
      const launch = slot.startsWith('lead.') ? 'the Agentrix lead session' : target === 'claude' && leadAgent === 'claude' && !seat.fast
        ? `Agent call with model:"${alias}", effort:"${seat.effort}"`
        : `node "${helperPath}" ${target} ${flags}${target === 'claude' ? ' --permission acceptEdits' : ''} --detach; then node "${helperPath}" wait <run-id> --cwd <dir> (keep waiting in this turn; Bash timeout 600000)`;
      parts.push(`${slot}: model ${seat.model}, effort ${seat.effort}, fast ${seat.fast ? 'on' : 'off'}; launch: ${launch}.${original !== chosen ? ` Substituted for ${chosen.model}: ${agent} is not installed.` : ''}${notes.map(note => ` ${note}.`).join('')}`);
    }
  }
  parts.push('visual and reviewer always use fresh instances; the reviewer neither planned nor wrote the work. agentrix-lookup stays Haiku.');
  return parts.join('\n');
}

module.exports = { cleanSeats, cleanStoredSeats, checkReviewer, catalog, defaultsFor, effective, renderSeats, leadOptions, seatIssues, rankOf };
