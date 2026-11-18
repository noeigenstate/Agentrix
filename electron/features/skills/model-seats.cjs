// Seat choices are configuration, never evidence of which model actually ran.
const MODEL = /^[A-Za-z0-9][\w.:@+/[\]-]*$/;
const EFFORTS = { claude: ['low', 'medium', 'high', 'xhigh', 'max'], codex: ['low', 'medium', 'high', 'xhigh'] };
const family = model => /^(opus|sonnet|haiku|claude-)/.test(model) ? 'claude' : 'codex';
const validModel = model => typeof model === 'string' && model.length <= 160 && MODEL.test(model);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const refusal = (code, seat, message) => ({ ok: false, code, ...(seat ? { seat } : {}), message });
const fail = (code, seat, message) => { throw Object.assign(new Error(message), refusal(code, seat, message)); };

function cleanSeat(raw, seat, expectedFamily) {
  if (!object(raw) || !validModel(raw.model)) fail('invalid-model', seat, 'Expected a valid model id of at most 160 characters.');
  const agent = family(raw.model);
  if (expectedFamily && agent !== expectedFamily) fail('lead-family', seat, `The ${seat} slot requires a ${expectedFamily} model.`);
  if (!EFFORTS[agent].includes(raw.effort)) fail('invalid-effort', seat, `Unsupported ${agent} effort.`);
  if (raw.fast !== undefined && (typeof raw.fast !== 'boolean' || agent !== 'codex' && raw.fast)) fail('fast-not-allowed', seat, 'Fast mode is available only for GPT seats.');
  return { model: raw.model, effort: raw.effort, ...(agent === 'codex' && raw.fast !== undefined ? { fast: raw.fast } : {}) };
}

function cleanSeats(raw, seatIds) {
  if (!object(raw)) fail('invalid-model', null, 'Expected a seat map.');
  const result = {};
  for (const id of seatIds) {
    if (!Object.hasOwn(raw, id)) continue;
    if (id !== 'lead') result[id] = cleanSeat(raw[id], id);
    else {
      if (!object(raw.lead)) fail('lead-family', 'lead', 'Expected Claude and Codex lead slots.');
      const lead = {};
      for (const agent of ['claude', 'codex']) if (Object.hasOwn(raw.lead, agent)) lead[agent] = cleanSeat(raw.lead[agent], `lead.${agent}`, agent);
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
      try { map = effective(map, cleanSeats(choice, [id])); } catch { /* A corrupt choice cannot erase its neighbors. */ }
    }
  }
  return map;
}

function catalog(installed, knownModels = []) {
  const rows = [
    ...['opus', 'sonnet', 'haiku'].map(model => ({ model, label: model[0].toUpperCase() + model.slice(1), family: 'claude', efforts: EFFORTS.claude, fast: false,
      rank: model === 'opus' ? 3 : model === 'sonnet' ? 2 : 1 })),
    { model: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', family: 'codex', efforts: EFFORTS.codex, fast: true, rank: 3 },
  ];
  for (const row of knownModels) {
    const model = row.model || row.value;
    if (!validModel(model) || family(model) !== 'codex' || /fable/i.test(model) || rows.some(item => item.model === model)) continue;
    const efforts = (row.efforts || []).filter(effort => EFFORTS.codex.includes(effort));
    rows.push({ model, label: String(row.label || row.displayName || model), family: 'codex', efforts: efforts.length ? efforts : [...EFFORTS.codex], fast: row.fast === true, rank: 3 });
  }
  return rows.map(row => ({ ...row, efforts: [...row.efforts], available: !!installed[row.family], ...(!installed[row.family] ? { reason: `${row.family === 'claude' ? 'Claude Code' : 'Codex'} is not installed.` } : {}) }));
}

function defaultsFor(installed) {
  if (!installed.claude && !installed.codex) return {};
  const claude = model => ({ model, effort: 'high' }), gpt = () => ({ model: 'gpt-6.1-sol', effort: 'high', fast: true });
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
    ?? (family(reviewer.model) === 'codex' ? 3 : /sonnet/.test(reviewer.model) ? 2 : /haiku/.test(reviewer.model) ? 1 : 3);
  return models.some(row => row.available && row.model !== reviewer.model && row.rank >= rank)
    ? refusal('reviewer-same-model', 'reviewer', 'Choose a reviewer different from core and execution when another available model is at least as strong.') : null;
}

// An explicit model carries its own effort/fast defaults; never attach a different model's seat settings to it.
function leadOptions(map, agent, explicit = {}) {
  const chosen = Object.fromEntries(Object.entries(explicit).filter(([, value]) => value !== null && value !== undefined));
  return { ...(chosen.model ? {} : map?.lead?.[agent]), ...chosen };
}

function renderSeats(map, leadAgent, helperPath, installed = { claude: true, codex: true }) {
  const parts = ['Agentrix model seats (fixed for this session; an instruction in the conversation still wins):'];
  parts.push('These helper model settings supplement the skill\'s full helper form; --role, --title, --cwd, --brief and --out are still required.');
  const fallback = defaultsFor(installed);
  for (const [id, value] of Object.entries(map)) {
    const slots = id === 'lead' ? Object.entries(value).map(([agent, seat]) => [`lead.${agent}`, seat]) : [[id, value]];
    for (const [slot, chosen] of slots) {
      const agent = family(chosen.model), seat = installed[agent] ? chosen : (id === 'lead' ? fallback.lead?.[leadAgent] : fallback[id]);
      if (!seat) { parts.push(`${slot}: ${chosen.model} unavailable; no installed agent can run this seat.`); continue; }
      const model = /^[\w.-]+$/.test(seat.model) ? seat.model : `"${seat.model}"`;
      const alias = ['opus', 'sonnet', 'haiku'].find(alias => seat.model.includes(alias)) || seat.model;
      const target = family(seat.model), flags = `--model ${model} --effort ${seat.effort}${seat.fast ? ' --fast' : ''}`;
      const launch = slot.startsWith('lead.') ? 'the Agentrix lead session' : target === 'claude' && leadAgent === 'claude'
        ? `Agent call with model:"${alias}", effort:"${seat.effort}"`
        : `node "${helperPath}" ${target} ${flags}${target === 'claude' ? ' --permission acceptEdits' : ''}`;
      parts.push(`${slot}: model ${seat.model}, effort ${seat.effort}, fast ${seat.fast ? 'on' : 'off'}; launch: ${launch}.${seat !== chosen ? ` Substituted for ${chosen.model}: ${agent} is not installed.` : ''}`);
    }
  }
  parts.push('visual and reviewer always use fresh instances; the reviewer neither planned nor wrote the work. agentrix-lookup stays Haiku.');
  return parts.join('\n');
}

module.exports = { cleanSeats, cleanStoredSeats, checkReviewer, catalog, defaultsFor, effective, renderSeats, leadOptions };
