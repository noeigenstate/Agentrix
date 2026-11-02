const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { popupHarness } = require('./reading-popup-coverage.test.cjs');

test('question and form cards and managed Claude UI are removed', () => {
  for (const file of ['ReadingChoice.tsx', 'ReadingQuestion.tsx', 'NativeApprovalCard.tsx', 'NativeQuestionCard.tsx', 'ManagedSession.tsx', 'native-question.css'])
    assert.equal(fs.existsSync(path.join(__dirname, '../src/features/reading', file)), false, file);
});
for (const agent of ['codex', 'claude']) test(agent + ': a question cannot receive keys from the disabled composer', t => {
  const rows = fs.readFileSync(path.join(__dirname, 'fixtures/questions', agent + '-question.txt'), 'utf8').split(/\r?\n/);
  const h = popupHarness(t, agent); h.view.rows = rows; h.render(); h.tick(3001); assert.ok(h.popup());
  for (const key of ['Enter', 'Escape', 'Tab', 'ArrowDown', '1', '2']) h.keys(key);
  assert.deepEqual(h.writes, []); assert.deepEqual(h.pastes, []);
});
