const { metadata } = require('./files.cjs');

const KEYS = ['name', 'description', 'trigger', 'when', 'requires', 'title', 'summary'];
const SECTIONS = ['When this applies', 'What to do', 'Rules', 'Done when'];
const TRIGGERS = ['always', 'auto', 'first-open'];
const REQUIRES = ['none', 'any-agent', 'codex', 'claude', 'both'];
const chinese = value => /\p{Script=Han}/u.test(value);
const sentences = value => value.split(/[。！？!?]+/u).filter(part => part.trim()).length;
const needsQuotes = value => /^[>|[\]{}&*!#'"%@`,]|^[-?:](?:\s|$)|:\s|\s#/.test(value);

function builtinMetadata(text, folder) {
  const fail = reason => { throw new Error(`Invalid built-in skill ${folder}: ${reason}`); };
  try { metadata(text); } catch (error) { fail(error.message); }
  const front = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!front) fail('expected front matter followed by a body');
  const lines = front[1].split(/\r?\n/), fields = {};
  if (lines.length !== KEYS.length) fail('expected exactly seven front matter keys');
  for (const [index, key] of KEYS.entries()) {
    const match = new RegExp(`^${key}: (\\S(?:.*\\S)?)$`).exec(lines[index]);
    if (!match) fail(`expected a single-line ${key} at position ${index + 1}`);
    let value = match[1];
    const quoted = value.startsWith('"') || value.startsWith("'");
    if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { fail(`invalid quoted ${key}`); }
    } else if (value.startsWith("'")) {
      if (!/^'(?:[^']|'')*'$/.test(value)) fail(`invalid quoted ${key}`);
      value = value.slice(1, -1).replace(/''/g, "'");
    } else if (needsQuotes(value)) fail(`invalid plain scalar ${key}`);
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

  // Fenced examples may contain headings; only actual document headings define the format.
  let fence = null;
  const body = front[2].split(/\r?\n/).filter(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return false;
    }
    return !fence;
  }).join('\n');
  const headings = [...body.matchAll(/^ {0,3}(#{1,2})(?:[ \t]+(.*)|$)/gm)];
  if (fence || !/^# [A-Za-z][^\n]*\n/.test(body.trimStart()) || chinese(body) || headings.length !== 5
    || !/^# [A-Za-z]/.test(headings[0][0]) || headings.slice(1).some((heading, index) => heading[0] !== `## ${SECTIONS[index]}`)) fail('expected an English title and the four required sections in order');
  for (let index = 1; index < headings.length; index++) {
    const section = body.slice(headings[index].index + headings[index][0].length, headings[index + 1]?.index).trim();
    if (!section) fail(`empty ${SECTIONS[index - 1]} section`);
    if (index === 2 && !/^\d+\. \S/m.test(section)) fail('What to do must contain numbered steps');
    if (index === 3 && !/^[-*+] \S/m.test(section)) fail('Rules must contain bullets');
  }
  return fields;
}

module.exports = { builtinMetadata, TRIGGERS };
