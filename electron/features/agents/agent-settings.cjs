// What an agent runs with, as its own records tell it: the model, how hard it thinks (its effort) and whether fast mode
// is on. Codex writes them when a turn starts (turn_context) and whenever its settings are applied (at start, after
// /model or /fast: thread_settings_applied, whose service tier "priority" is fast mode). Claude Code writes them with
// every reply (message.model, effort/perTurnEffort, usage.speed) and answers /model, /effort and /fast at once in its own output.
// The reading view shows them above its message box.
const EMPTY = { model: null, effort: null, fast: null, ultracode: null };
const { workerOf, claudeFastModeEcho, claudeSettings, codexSettings } = require('../cli-adapters/workers.cjs');

function changed(current, patch) {
  const base = current || EMPTY;
  const next = {
    model: patch.model ?? base.model, effort: patch.effort ?? base.effort, fast: patch.fast ?? base.fast,
    ultracode: patch.ultracode ?? base.ultracode ?? null,
  };
  return Object.keys(next).every(key => next[key] === base[key]) ? current : next;
}

// The standalone SSH helper also reads settings and has no main-process registry.
function agentSettings(current, agent, record) {
  if (!record || typeof record !== 'object') return current;
  const patch = workerOf(agent)?.parseSettings(record);
  return patch ? changed(current, patch) : current;
}

module.exports = { agentSettings, claudeFastModeEcho, claudeSettings, codexSettings };
