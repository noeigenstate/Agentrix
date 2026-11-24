const { test } = require('node:test');
const assert = require('node:assert/strict');
const { agentSettings, claudeFastModeEcho } = require('../electron/features/agents/agent-settings.cjs');
const { modelName } = require('../src/shared/model-name.ts');

const replay = (agent, records) => records.reduce((current, record) => agentSettings(current, agent, record), null);
const reply = (model, effort, speed) => ({ type: 'assistant', effort, message: { model, usage: { speed } } });
const said = text => ({ type: 'user', message: { content: `<local-command-stdout>${text}</local-command-stdout>` } });

test("Claude Code's model, effort and speed come from its replies, and its own commands change them at once", () => {
  assert.deepEqual(replay('claude', [reply('claude-opus-5-5', 'max', 'standard')]), { model: 'claude-opus-5-5', effort: 'max', fast: false, ultracode: null });
  assert.deepEqual(replay('claude', [reply('claude-opus-5-5', 'max', 'standard'), reply('claude-opus-5-5', 'max', 'fast')]).fast, true);
  // /model, /effort and /fast answer before the next reply.
  const changed = replay('claude', [reply('claude-opus-5-5', 'xhigh', 'standard'), said('Set model to `Sonnet 5.5` and saved as your default for new sessions'),
    said('Set effort level to max (this session only): Maximum capability with deepest reasoning.'), said('Fast mode ON')]);
  assert.deepEqual(changed, { model: 'Sonnet 5.5', effort: 'max', fast: true, ultracode: null });
  assert.equal(replay('claude', [reply('claude-opus-5-5', 'max', 'fast'), said('Fast mode is now off')]).fast, false);
  // A subagent's reply, Claude's synthetic messages and what the person typed change nothing.
  const kept = replay('claude', [reply('claude-opus-5-5', 'max', 'standard')]);
  assert.equal(agentSettings(kept, 'claude', { ...reply('claude-haiku-5-5', 'low', 'standard'), isSidechain: true }), kept);
  assert.equal(agentSettings(kept, 'claude', reply('<synthetic>', undefined, null)), kept);
  assert.equal(agentSettings(kept, 'claude', { type: 'user', message: { content: 'Set effort level to low please' } }), kept);
  assert.equal(agentSettings(null, 'claude', { type: 'system' }), null);
});

test('Claude reports effective per-turn effort and recognizes only recorded fast or standard speed', () => {
  const effective = { ...reply('claude-opus-5-5', 'high', 'fast'), perTurnEffort: 'xhigh' };
  assert.deepEqual(replay('claude', [effective]), { model: 'claude-opus-5-5', effort: 'xhigh', fast: true, ultracode: null });
  assert.deepEqual(replay('claude', [reply('claude-opus-5-5', undefined, undefined)]), { model: 'claude-opus-5-5', effort: null, fast: null, ultracode: null });
  assert.equal(replay('claude', [reply('claude-opus-5-5', 'high', 'unrecognized')]).fast, null);
  assert.equal(replay('claude', [effective, reply('claude-opus-5-5', undefined, 'unrecognized')]).fast, true);
});

test('Claude fast mode echoes update the current speed and unavailable replies leave it alone', () => {
  const normal = replay('claude', [reply('claude-fable-5-2', 'max', 'standard')]);
  const on = { type: 'user', message: { content: [
    { type: 'text', text: '<local-command-stdout>\x1b[38;2;255;120;20m↯\x1b[39m Fast mode ON · $16/$80 per Mtok</local-command-stdout>' },
  ] } };
  const fast = agentSettings(normal, 'claude', on);
  assert.equal(fast.fast, true);
  assert.equal(agentSettings(fast, 'claude', said('Fast mode OFF')).fast, false);
  assert.equal(agentSettings(normal, 'claude', said('↯ Fast mode ON · model set to Opus 5.5 · $16/$80 per Mtok')).model, 'Opus 5.5');
  assert.equal(agentSettings(normal, 'claude', said('Kept Fast mode OFF')), normal);
  for (const reason of ['Fast mode is currently unavailable', 'Fast mode has been disabled by your organization']) {
    assert.equal(agentSettings(fast, 'claude', said(`Fast mode unavailable: ${reason}`)), fast);
  }
});

test('Claude Ultracode follows its root attachments and effort feedback', () => {
  const attachment = type => ({ type: 'attachment', attachment: { type } });
  const enabled = replay('claude', [attachment('ultra_effort_enter'), reply('claude-fable-5-2', 'high', 'standard')]);
  assert.equal(enabled.ultracode, true);
  assert.equal(agentSettings(enabled, 'claude', { ...attachment('ultra_effort_exit'), isSidechain: true }), enabled);
  const disabled = agentSettings(enabled, 'claude', attachment('ultra_effort_exit'));
  assert.equal(disabled.ultracode, false);
  const on = agentSettings(disabled, 'claude', said('Ultracode on (this session only): dynamic workflows on every task. Effort stays high.'));
  assert.deepEqual(on, { ...enabled });
  const off = agentSettings(on, 'claude', said('Set effort level to xhigh (this session only): Deeper reasoning ·\nUltracode off'));
  assert.deepEqual(off, { ...disabled, effort: 'xhigh' });
  assert.equal(agentSettings(off, 'claude', said('Set effort level to max (this session only): Maximum capability')).ultracode, false);
  assert.equal(agentSettings(on, 'claude', said('Ultracode off. Effort stays max.')).ultracode, false);
});

test('only dated root Claude command echoes report a fast-mode refusal or clear it', () => {
  const reason = 'Fast mode requires usage credits · /usage-credits to turn them on';
  const record = { ...said('Fast mode unavailable: ' + reason), timestamp: new Date(1000).toISOString() };
  assert.deepEqual(claudeFastModeEcho(record), { at: 1000, reason });
  assert.deepEqual(claudeFastModeEcho({ ...record, ...said('\x1b[33m↯\x1b[39m Fast mode ON · $16/$80 per Mtok') }), { at: 1000, reason: null });
  assert.equal(claudeFastModeEcho({ ...record, ...said('Fast mode OFF') }), null);
  assert.equal(claudeFastModeEcho({ ...record, isSidechain: true }), null);
  assert.equal(claudeFastModeEcho({ ...record, message: { content: 'Fast mode unavailable: ' + reason } }), null);
  assert.equal(claudeFastModeEcho({ ...record, timestamp: undefined }), null);
});

test("Codex's model and effort come from each turn, and fast mode from the settings it applies", () => {
  const settings = replay('codex', [
    { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6.1-sol', service_tier: 'priority', reasoning_effort: 'high' } } },
    { type: 'turn_context', payload: { cwd: '/srv/app', model: 'gpt-6.1-sol', effort: 'high' } },
  ]);
  assert.deepEqual(settings, { model: 'gpt-6.1-sol', effort: 'high', fast: true, ultracode: null });
  // /model then /fast: the next turn and the settings applied after it.
  assert.deepEqual(replay('codex', [
    { type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'high' } },
    { type: 'turn_context', payload: { model: 'gpt-6-luna', collaboration_mode: { settings: { reasoning_effort: 'medium' } } } },
    { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-luna', service_tier: 'default' } } },
  ]), { model: 'gpt-6-luna', effort: 'medium', fast: false, ultracode: null });
  assert.equal(replay('codex', [{ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6.1-sol', service_tier: null } } }]).fast, false, 'no tier is the standard one');
  // As the SSH worker sends them, compacted.
  assert.deepEqual(replay('codex', [{ type: 'turn_context', payload: { cwd: '/srv', model: 'gpt-6.1-sol', effort: 'xhigh' } }]),
    { model: 'gpt-6.1-sol', effort: 'xhigh', fast: null, ultracode: null });
  const same = replay('codex', [{ type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'high' } }]);
  assert.equal(agentSettings(same, 'codex', { type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'high' } }), same, 'unchanged settings are the same object');
  assert.equal(agentSettings(same, 'codex', { type: 'event_msg', payload: { type: 'agent_message', message: 'hi' } }), same);
});

test('models are named the way their CLIs print them', () => {
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelName('claude-fable-5-1'), 'Fable 5.1');
  assert.equal(modelName('claude-opus-4-1-20250805'), 'Opus 4.1');
  assert.equal(modelName('claude-sonnet-5-5[1m]'), 'Sonnet 5.5');
  assert.equal(modelName('gpt-6.1-sol'), 'GPT-6.1-Sol');
  assert.equal(modelName('gpt-5.6-terra'), 'GPT-5.6-Terra');
  assert.equal(modelName('Sonnet 5.5'), 'Sonnet 5.5', "a name Claude Code printed after /model");
  assert.equal(modelName('o3'), 'o3');
});
