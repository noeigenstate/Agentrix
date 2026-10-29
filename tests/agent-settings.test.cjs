const { test } = require('node:test');
const assert = require('node:assert/strict');
const { agentSettings } = require('../electron/features/agents/agent-settings.cjs');
const { modelName } = require('../src/shared/model-name.ts');

const replay = (agent, records) => records.reduce((current, record) => agentSettings(current, agent, record), null);
const reply = (model, effort, speed) => ({ type: 'assistant', effort, message: { model, usage: { speed } } });
const said = text => ({ type: 'user', message: { content: `<local-command-stdout>${text}</local-command-stdout>` } });

test("Claude Code's model, effort and speed come from its replies, and its own commands change them at once", () => {
  assert.deepEqual(replay('claude', [reply('claude-opus-5-5', 'max', 'standard')]), { model: 'claude-opus-5-5', effort: 'max', fast: false });
  assert.deepEqual(replay('claude', [reply('claude-opus-5-5', 'max', 'standard'), reply('claude-opus-5-5', 'max', 'fast')]).fast, true);
  // /model, /effort and /fast answer before the next reply.
  const changed = replay('claude', [reply('claude-opus-5-5', 'xhigh', 'standard'), said('Set model to `Sonnet 5.5` and saved as your default for new sessions'),
    said('Set effort level to max (this session only): Maximum capability with deepest reasoning.'), said('Fast mode ON')]);
  assert.deepEqual(changed, { model: 'Sonnet 5.5', effort: 'max', fast: true });
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
  assert.deepEqual(replay('claude', [effective]), { model: 'claude-opus-5-5', effort: 'xhigh', fast: true });
  assert.deepEqual(replay('claude', [reply('claude-opus-5-5', undefined, undefined)]), { model: 'claude-opus-5-5', effort: null, fast: null });
  assert.equal(replay('claude', [reply('claude-opus-5-5', 'high', 'unrecognized')]).fast, null);
  assert.equal(replay('claude', [effective, reply('claude-opus-5-5', undefined, 'unrecognized')]).fast, true);
});

test("Codex's model and effort come from each turn, and fast mode from the settings it applies", () => {
  const settings = replay('codex', [
    { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6.1-sol', service_tier: 'priority', reasoning_effort: 'high' } } },
    { type: 'turn_context', payload: { cwd: '/srv/app', model: 'gpt-6.1-sol', effort: 'high' } },
  ]);
  assert.deepEqual(settings, { model: 'gpt-6.1-sol', effort: 'high', fast: true });
  // /model then /fast: the next turn and the settings applied after it.
  assert.deepEqual(replay('codex', [
    { type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'high' } },
    { type: 'turn_context', payload: { model: 'gpt-6-luna', collaboration_mode: { settings: { reasoning_effort: 'medium' } } } },
    { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-luna', service_tier: 'default' } } },
  ]), { model: 'gpt-6-luna', effort: 'medium', fast: false });
  assert.equal(replay('codex', [{ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6.1-sol', service_tier: null } } }]).fast, false, 'no tier is the standard one');
  // As the SSH worker sends them, compacted.
  assert.deepEqual(replay('codex', [{ type: 'turn_context', payload: { cwd: '/srv', model: 'gpt-6.1-sol', effort: 'xhigh' } }]), { model: 'gpt-6.1-sol', effort: 'xhigh', fast: null });
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
