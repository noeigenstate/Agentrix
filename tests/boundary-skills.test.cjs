// Guards for the Skills boundary (electron/features/skills/BOUNDARY.md) that no behaviour test covers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sourceFiles } = require('../scripts/module-boundaries.cjs');

const ROOT = path.join(__dirname, '..');

test('no code outside the skills backend names a built-in skill id or a shipped built-in name', () => {
  const shipped = fs.readdirSync(path.join(ROOT, 'resources/skills'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  assert.ok(shipped.length, 'resources/skills ships built-in skills');
  const escaped = shipped.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  // A quoted "builtin:<name>" id, or a shipped folder name as a whole string literal.
  const named = new RegExp(`['"\`]builtin:|['"\`](?:${escaped})['"\`]`);
  const offenders = sourceFiles(ROOT)
    .filter(file => /^(?:src|electron|integration)\//.test(file) && !file.startsWith('electron/features/skills/'))
    .filter(file => fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/).some(line => !/^\s*(?:\/\/|\*)/.test(line) && named.test(line.replace(/\/\/.*$/, ''))));
  assert.deepEqual(offenders, [], 'built-in ids and names come from the skills backend (SkillInfo.id, .source), never from literals elsewhere');
});
