const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { updateBootstrapMode } = require('../electron/features/terminal-events/bootstrap-file.cjs');
const { modeNote, skillInstructions } = require('../electron/features/skills/delivery.cjs');

test('writing a session mode reports a switch only when it replaces the other mode', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-mode-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'session.json'), mode = () => fs.readFileSync(file + '.mode', 'utf8');
  assert.equal(updateBootstrapMode(file, false), false, 'the first write is the launch, not a switch');
  assert.equal(mode(), 'native\n');
  assert.equal(updateBootstrapMode(file, false), false);
  assert.equal(updateBootstrapMode(file, true), true);
  assert.equal(mode(), 'conductor\n');
  assert.equal(updateBootstrapMode(file, true), false);
  assert.equal(updateBootstrapMode(file, undefined), true, 'a project without the flag is native');
  assert.equal(mode(), 'native\n');
});

test('the mode note names the new mode, and a conductor is sent to its instructions and tools', () => {
  const conductor = modeNote(true, 'C:\\skills\\model-routing\\SKILL.md'), native = modeNote(false, 'C:/skills/model-routing/SKILL.md');
  assert.match(conductor, /owner has just switched this conversation's mode/);
  assert.match(conductor, /in conductor mode/);
  assert.match(conductor, /read and follow C:\/skills\/model-routing\/SKILL\.md; start roles with the start_role tool\./);
  assert.match(native, /in native mode/);
  assert.doesNotMatch(native, /model-routing|start_role/);
  assert.doesNotMatch(modeNote(true, undefined), /read and follow/);
});

test('conductor startup and mode switching both give the lead the role escalation rules', () => {
  const startup = conductor => skillInstructions({ conductor, skills: [], globalFolder: '<home>/skills' });
  for (const text of [startup(true), modeNote(true)]) {
    assert.match(text, /## Needs decision, decide and continue or restart the role with your decision/);
    assert.match(text, /Ask the owner only about irreversible or outward-facing actions.+or product decisions they have not delegated/);
    assert.match(text, /Ask once with options and a recommendation/);
    assert.match(text, /Read-only Claude roles cannot run commands or tests.*Codex seat or run the tests yourself/);
    assert.match(text, /## Needs approval, do the refused action yourself if allowed, or ask the owner once and restart the role with a wider allowance if approved/);
  }
  for (const text of [startup(false), modeNote(false)]) assert.doesNotMatch(text, /## Needs (decision|approval)/);
});
