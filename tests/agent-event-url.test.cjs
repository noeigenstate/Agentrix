const { test } = require('node:test');
const assert = require('node:assert/strict');
const { claudeEvent } = require('../integration/agent-event.cjs');

test('local Unix hooks accept form and URL elicitation as attention, never a turn or completion', () => {
  for (const notification_type of ['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog']) {
    const event = claudeEvent(JSON.stringify({ session_id: 's', transcript_path: '/tmp/s.jsonl', notification_type, message: '长'.repeat(400), prompt: 'not a submission' }), 'terminal', 'key', 'notify');
    assert.equal(event.type, 'agent-activity');
    assert.equal(event.state, 'attention');
    assert.equal(event.sessionId, 's');
    assert.equal(event.projectId, 'terminal');
    assert.equal(event.sessionKey, 'key');
    assert.equal(event.message, '长'.repeat(300));
    assert.equal(event.prompt, null);
    assert.equal(event.turnId, undefined);
  }
  for (const notification_type of ['idle_prompt', 'auth_success', 'other', undefined]) {
    assert.equal(claudeEvent(JSON.stringify({ session_id: 's', notification_type }), 'terminal', 'key', 'notify'), null);
  }
  assert.equal(claudeEvent(JSON.stringify({ notification_type: 'elicitation_url_dialog' }), 'terminal', 'key', 'notify'), null);
});
