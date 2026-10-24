const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { seedDevProfile } = require('../electron/dev-profile.cjs');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pg-dev-profile-'));

test('a new dev profile copies projects and settings but restores no terminal or agent session', () => {
  const installed = temp(), dev = path.join(temp(), 'Agentrix Dev');
  const restore = { terminal: true, codex: true, cwd: 'E:\\p', threadId: 'thread', agent: 'claude', interrupted: false };
  fs.writeFileSync(path.join(installed, 'workspace.json'), JSON.stringify({
    version: 2, settings: { restoreSessions: true }, history: ['a'],
    projects: [{ id: 'p', name: 'P', path: 'E:\\p', kind: 'local', restore, terminals: [{ id: 't', restore }] }],
  }));
  assert.equal(seedDevProfile(installed, dev), true);
  const seeded = JSON.parse(fs.readFileSync(path.join(dev, 'workspace.json'), 'utf8'));
  assert.deepEqual(seeded.settings, { restoreSessions: true });
  assert.deepEqual(seeded.history, ['a']);
  assert.deepEqual(seeded.projects[0].restore, { ...restore, terminal: false, codex: false });
  assert.deepEqual(seeded.projects[0].terminals[0].restore, { ...restore, terminal: false, codex: false });
});

test('an existing dev profile is never overwritten, and a missing installed profile seeds nothing', () => {
  const installed = temp(), dev = temp();
  fs.writeFileSync(path.join(installed, 'workspace.json'), JSON.stringify({ version: 2, projects: [{ id: 'new' }] }));
  fs.writeFileSync(path.join(dev, 'workspace.json'), '{"version":2,"projects":[{"id":"mine"}]}');
  assert.equal(seedDevProfile(installed, dev), false);
  assert.equal(fs.readFileSync(path.join(dev, 'workspace.json'), 'utf8'), '{"version":2,"projects":[{"id":"mine"}]}');
  const empty = path.join(temp(), 'fresh');
  assert.equal(seedDevProfile(path.join(temp(), 'missing'), empty), false);
  assert.equal(fs.existsSync(path.join(empty, 'workspace.json')), false);
});
