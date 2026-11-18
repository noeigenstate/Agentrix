const { skillName } = require('./files.cjs');
const { frontMatter } = require('./front-matter.cjs');

const KEYS = ['name', 'description', 'trigger', 'when', 'requires', 'title', 'summary'];
const SECTIONS = ['When this applies', 'What to do', 'Rules', 'Done when'];
const TRIGGERS = ['always', 'auto'];
const REQUIRES = ['none', 'any-agent', 'codex', 'claude', 'both'];
const SEAT_ID = /^[a-z][a-z0-9-]{0,31}$/;
const chinese = value => /\p{Script=Han}/u.test(value);
const sentences = value => value.split(/[。！？!?]+/u).filter(part => part.trim()).length;
const needsQuotes = value => /^[>|[\]{}&*!#'"%@`,]|^[-?:](?:\s|$)|:\s|\s#/.test(value);

// Keep the line numbers so the renderer can replace the real table while leaving fenced examples alone.
function outsideFences(lines) {
  let fence = null;
  const visible = lines.map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return '';
    }
    return fence ? '' : line;
  });
  return { visible, fence };
}

function teamRegion(lines) {
  const starts = [], ends = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '<!-- agentrix:team -->') starts.push(index);
    if (line.trim() === '<!-- /agentrix:team -->') ends.push(index);
  }
  return starts.length === 1 && ends.length === 1 && starts[0] < ends[0] ? { start: starts[0], end: ends[0] } : null;
}

function seatRoles(value, seats, fail) {
  const roles = new Map();
  for (const entry of value.split(/;\s*/)) {
    const [id, ...parts] = entry.split('='), fields = parts.join('=').split('|').map(field => field.trim());
    const [name, duty, detail, outputs = ''] = fields;
    if (!seats?.includes(id) || roles.has(id) || fields.length < 3 || fields.length > 4
        || !/^\p{Script=Han}{2,6}$/u.test(name) || fields.some(field => !field || [...field].length > 40)) fail('invalid duties');
    roles.set(id, { id, name, duty, detail, outputs });
  }
  if (roles.size !== seats?.length) fail('duties must describe every seat');
  return seats.map(id => roles.get(id));
}

function builtinMetadata(text, folder) {
  const fail = reason => { throw new Error(`Invalid built-in skill ${folder}: ${reason}`); };
  let front;
  try { front = frontMatter(text); if (front) skillName(front.fields.name); } catch (error) { fail(error.message); }
  if (!front) fail('expected front matter followed by a body');
  const lines = front.raw.split(/\r?\n/), fields = {};
  const keys = [...KEYS, ...['seats', 'fresh', 'duties'].filter(key => Object.hasOwn(front.fields, key))];
  if (lines.length !== keys.length) fail('expected seven required front matter keys and optional seats/fresh/duties');
  for (const [index, key] of keys.entries()) {
    const match = new RegExp(`^${key}: (\\S(?:.*\\S)?)$`).exec(lines[index]);
    if (!match) fail(`expected a single-line ${key} at position ${index + 1}`);
    const raw = match[1], value = front.fields[key];
    const quoted = raw.startsWith('"') || raw.startsWith("'");
    if (raw.startsWith("'") && !/^'(?:[^']|'')*'$/.test(raw)) fail(`invalid quoted ${key}`);
    if (!quoted && needsQuotes(raw)) fail(`invalid plain scalar ${key}`);
    if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f\u0085\u2028\u2029]/.test(value)) fail(`invalid ${key}`);
    if (quoted && !needsQuotes(value)) fail(`unnecessary quotes around ${key}`);
    fields[key] = value;
  }
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(fields.name) || fields.name !== folder) fail('name must be kebab-case and match its folder');
  if (!/^[\p{Script=Han}]{2,8}$/u.test(fields.title)) fail('title must be 2-8 Chinese characters');
  if (!chinese(fields.summary) || [...fields.summary].length > 90 || sentences(fields.summary) > 2) fail('summary must be Chinese, at most two sentences and 90 characters');
  if (fields.description.length > 2000 || chinese(fields.description) || !/^Use (when|before|on|at|whenever)\b\s+\S/.test(fields.description)) fail('description must be English, start with a Use trigger and be at most 2000 characters');
  if (!TRIGGERS.includes(fields.trigger)) fail('invalid trigger');
  if (!chinese(fields.when) || sentences(fields.when) !== 1) fail('when must be one Chinese sentence');
  if (!REQUIRES.includes(fields.requires)) fail('invalid requires');
  for (const key of ['seats', 'fresh']) if (Object.hasOwn(fields, key)) {
    const ids = fields[key].split(',').map(id => id.trim());
    if (ids.some(id => !SEAT_ID.test(id) || key === 'fresh' && !fields.seats?.includes(id)) || new Set(ids).size !== ids.length) fail(`invalid ${key}`);
    fields[key] = ids;
  }
  if (fields.duties) {
    fields.roles = seatRoles(fields.duties, fields.seats, fail);
    delete fields.duties;
  }

  // Fenced examples may contain headings; only actual document headings define the format.
  const { visible, fence } = outsideFences(front.body.split(/\r?\n/));
  if (fields.seats && !teamRegion(visible)) fail('expected one agentrix:team region outside fences');
  const body = visible.join('\n');
  const headings = [...body.matchAll(/^ {0,3}(#{1,2})(?:[ \t]+(.*)|$)/gm)];
  if (fence || !/^# [A-Za-z][^\n]*\n/.test(body.trimStart()) || chinese(front.body) || headings.length !== 5
    || !/^# [A-Za-z]/.test(headings[0][0]) || headings.slice(1).some((heading, index) => heading[0] !== `## ${SECTIONS[index]}`)) fail('expected an English title and the four required sections in order');
  for (let index = 1; index < headings.length; index++) {
    const section = body.slice(headings[index].index + headings[index][0].length, headings[index + 1]?.index).trim();
    if (!section) fail(`empty ${SECTIONS[index - 1]} section`);
    if (index === 2 && !/^\d+\. \S/m.test(section)) fail('What to do must contain numbered steps');
    if (index === 3 && !/^[-*+] \S/m.test(section)) fail('Rules must contain bullets');
  }
  return fields;
}

module.exports = { builtinMetadata, TRIGGERS, outsideFences, teamRegion };
