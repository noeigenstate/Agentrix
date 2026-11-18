const { outsideFences, teamRegion } = require('./builtin-format.cjs');
const { agentAlias, defaultsFor, resolveSeat } = require('./model-seats.cjs');
const { familyOf } = require('./model-catalog.cjs');

const modelWords = seat => [seat.model, seat.effort, ...(seat.fast ? ['fast'] : [])].join(' · ');

function launchWords(id, lead, seat, leadAgent, catalog) {
  if (id === lead) return 'this session';
  const family = familyOf(seat.model), alias = family === 'claude' && leadAgent === 'claude' && !seat.fast && agentAlias(seat.model, catalog);
  const specialties = id === 'developer' ? '; specialties: --seat developer/<frontend or backend or desktop or database or ai>' : '';
  if (alias) return `Agent call, model "${alias}", effort "${seat.effort}", description starts with [${id}]${specialties}`;
  const model = /^[\w.-]+$/.test(seat.model) ? seat.model : `"${seat.model}"`;
  return `helper ${family} --seat ${id} --model ${model} --effort ${seat.effort}${seat.fast ? ' --fast' : ''} --detach, then wait${specialties}`;
}

function renderRoutingSkill(text, { roles, map, leadAgent, installed, catalog }) {
  const parts = text.split(/(\r?\n)/), lines = parts.filter((_, index) => index % 2 === 0);
  const region = teamRegion(outsideFences(lines).visible);
  if (!region) return text;
  const names = new Map(roles.map(({ id, name }) => [id, name]));
  const ids = names.size ? [...names.keys()] : Object.keys(map), lead = ids[0];
  const defaults = defaultsFor(installed, catalog, ids), summary = [];
  let changed = false;
  for (let index = region.start + 1; index < region.end; index++) {
    const cells = lines[index].split('|'), id = cells[1]?.trim();
    if (cells.length !== 8 || !ids.includes(id)) continue;
    const seat = resolveSeat(Object.hasOwn(map, id) ? map[id] : null, Object.hasOwn(defaults, id) ? defaults[id] : null, installed, catalog);
    if (!seat) continue;
    const model = modelWords(seat), launch = launchWords(id, lead, seat, leadAgent, catalog);
    summary.push(`${names.get(id) || id} ${model}`);
    if (cells[5].trim() === model && cells[6].trim() === launch) continue;
    cells[5] = ` ${model} `; cells[6] = ` ${launch} `;
    parts[index * 2] = cells.join('|');
    changed = true;
  }
  if (!changed) return text;
  const frontEnd = lines.findIndex((line, index) => index > 0 && line === '---');
  const summaryLine = lines.slice(1, frontEnd).findIndex(line => line.startsWith('summary: ')) + 1;
  if (summaryLine > 0) parts[2 * summaryLine] = `summary: ${summary.join('；')}`;
  return parts.join('');
}

module.exports = { renderRoutingSkill };
