const { outsideFences, region } = require('./builtin-format.cjs');
const { agentAlias, defaultsFor, resolveSeat } = require('./model-seats.cjs');
const { familyOf, BACKGROUND_MODEL_ENV } = require('./seat-rules.mjs');
const { levers } = require('./operation-slots.cjs');

const modelWords = seat => [seat.model, seat.effort, seat.fast && 'fast'].filter(Boolean).join(' · ');
const modelArgument = model => /^[\w.-]+$/.test(model) ? model : `"${model}"`;

function launchWords(id, lead, seat, leadAgent, catalog, pinnedHaiku) {
  if (id === lead) return 'this session';
  const family = familyOf(seat.model), alias = family === 'claude' && leadAgent === 'claude' && !seat.fast && agentAlias(seat.model, catalog);
  const specialties = id === 'developer' ? '; specialties: --seat developer/<frontend or backend or desktop or database or ai>' : '';
  if (alias && !(alias === 'haiku' && pinnedHaiku)) return `Agent call, model "${alias}", effort "${seat.effort}", description starts with [${id}]${specialties}`;
  const model = modelArgument(seat.model === 'haiku' && pinnedHaiku ? pinnedHaiku : seat.model);
  return `helper ${family} --seat ${id} --model ${model} --effort ${seat.effort}${seat.fast ? ' --fast' : ''} --detach, then wait${specialties}`;
}

function replaceCells(parts, table, width, columns) {
  let changed = false;
  for (let index = table.start + 1; index < table.end; index++) {
    const cells = parts[index * 2].split('|');
    if (cells.length !== width) continue;
    const values = columns(cells[1].trim());
    if (!values || values.every((value, offset) => cells[width - 3 + offset].trim() === value)) continue;
    for (const [offset, value] of values.entries()) cells[width - 3 + offset] = ` ${value} `;
    parts[index * 2] = cells.join('|');
    changed = true;
  }
  return changed;
}

function lookupWords(operation, catalog) {
  const lookup = operation.choices.lookup, family = familyOf(lookup.model);
  const { pinnedHaiku } = operation, model = lookup.model === 'haiku' && pinnedHaiku ? pinnedHaiku : lookup.model;
  const words = modelWords({ model, effort: lookup.effort });
  const permission = family === 'claude' ? '--permission plan' : '--read-only';
  const helper = `${words}; helper ${family} --seat researcher --model ${modelArgument(model)} --effort ${lookup.effort} ${permission} --detach, then wait`;
  const alias = family === 'claude' && agentAlias(model, catalog);
  return alias && !(alias === 'haiku' && pinnedHaiku)
    ? [`${words}; agentrix-lookup in native mode, else Agent call, model "${alias}", effort "${lookup.effort}"`, helper]
    : [helper, helper];
}

function operationColumns(id, operation, catalog) {
  const { choices, values, claude } = operation;
  const choice = Object.hasOwn(choices, id) ? choices[id] : null;
  switch (id) {
    case 'lookup': return lookupWords(operation, catalog);
    case 'background': return [claude.env[BACKGROUND_MODEL_ENV] || 'haiku', 'not controllable'];
    case 'subagent': return ['claude', 'codex'].map(agent => choice && familyOf(choice.model) === agent
      ? modelWords({ ...choice, model: agent === 'claude' && choice.model === 'haiku' ? operation.pinnedHaiku || choice.model : choice.model })
      : 'follows the conversation');
    case 'memory': return ['not controllable', choice?.model || 'Codex default'];
    case 'review': return ['not controllable (review is the Reviewer seat)',
      choice ? `${choice.model}${values.review === 'follow' ? ' (Reviewer seat)' : ''}` : 'Codex default'];
    default: return null;
  }
}

function renderRoutingSkill(text, { roles, map, leadAgent, installed, catalog, operations = levers(null, map, catalog, installed) }) {
  const parts = text.split(/(\r?\n)/), lines = parts.filter((_, index) => index % 2 === 0), { visible } = outsideFences(lines);
  const team = region(visible, 'team'), operationTable = region(visible, 'operations');
  if (!team && !operationTable) return text;
  const names = new Map(roles.map(({ id, name }) => [id, name]));
  const ids = names.size ? [...names.keys()] : Object.keys(map), lead = ids[0];
  const defaults = defaultsFor(installed, catalog, ids), summary = [];
  const teamChanged = team && replaceCells(parts, team, 8, id => {
    if (!ids.includes(id)) return null;
    const seat = resolveSeat(Object.hasOwn(map, id) ? map[id] : null, Object.hasOwn(defaults, id) ? defaults[id] : null, installed, catalog);
    if (!seat) return null;
    const model = modelWords(seat), launch = launchWords(id, lead, seat, leadAgent, catalog, operations.pinnedHaiku);
    summary.push(`${names.get(id) || id} ${model}`);
    return [model, launch];
  });
  const operationsChanged = operationTable && replaceCells(parts, operationTable, 7, id => operationColumns(id, operations, catalog));
  if (!teamChanged && !operationsChanged) return text;
  if (teamChanged) {
    const frontEnd = lines.findIndex((line, index) => index > 0 && line === '---');
    const summaryLine = lines.slice(1, frontEnd).findIndex(line => line.startsWith('summary: ')) + 1;
    if (summaryLine > 0) parts[2 * summaryLine] = `summary: ${summary.join('；')}`;
  }
  return parts.join('');
}

module.exports = { renderRoutingSkill };
