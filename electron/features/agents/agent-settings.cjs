// What an agent runs with, as its own records tell it: the model, how hard it thinks (its effort) and whether fast mode
// is on. Codex writes them when a turn starts (turn_context) and whenever its settings are applied (at start, after
// /model or /fast: thread_settings_applied, whose service tier "priority" is fast mode). Claude Code writes them with
// every reply (message.model, effort/perTurnEffort, usage.speed) and answers /model, /effort and /fast at once in its own output.
// The reading view shows them above its message box.
const EMPTY = { model: null, effort: null, fast: null };
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;

function changed(current, patch) {
  const base = current || EMPTY;
  const next = { model: patch.model ?? base.model, effort: patch.effort ?? base.effort, fast: patch.fast ?? base.fast };
  return next.model === base.model && next.effort === base.effort && next.fast === base.fast ? current : next;
}

// What Claude Code printed for one of its own commands: "Set model to `Opus 5.5` …", "Set effort level to max (…)",
// and fast mode turned on or off.
function claudeCommandOutput(record) {
  const content = record.message?.content;
  const words = typeof content === 'string' ? content : Array.isArray(content) ? content.map(block => typeof block?.text === 'string' ? block.text : '').join('\n') : '';
  const output = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(words)?.[1].replace(/\x1b\[[0-9;]*m/g, '');
  if (!output) return null;
  const model = /^\s*Set model to\s+`?([^`\n(]+?)`?(?:\s+\(|\s+and\b|\s*$)/im.exec(output)?.[1];
  const effort = /^\s*Set effort level to\s+([a-z]+)\b/im.exec(output)?.[1];
  const fast = /\bfast mode\b[^\n.]*?\b(on|enabled|off|disabled)\b/i.exec(output)?.[1];
  if (!model && !effort && !fast) return null;
  return { model: text(model), effort: text(effort)?.toLowerCase() ?? null, fast: fast ? /^(?:on|enabled)$/i.test(fast) : null };
}

// The settings after this record; the same object when it changes nothing.
function agentSettings(current, agent, record) {
  if (!record || typeof record !== 'object') return current;
  if (agent === 'claude') {
    // A subagent's replies carry its own model, not the session's.
    if (record.isSidechain) return current;
    if (record.type === 'assistant') {
      const model = text(record.message?.model), speed = record.message?.usage?.speed;
      return changed(current, { model: model && model !== '<synthetic>' ? model : null, effort: text(record.perTurnEffort) ?? text(record.effort),
        fast: speed === 'fast' ? true : speed === 'standard' ? false : null });
    }
    if (record.type === 'user') { const said = claudeCommandOutput(record); return said ? changed(current, said) : current; }
    return current;
  }
  const payload = record.payload || {};
  if (record.type === 'turn_context') return changed(current, { model: text(payload.model), effort: text(payload.effort) ?? text(payload.collaboration_mode?.settings?.reasoning_effort) });
  if (record.type === 'event_msg' && payload.type === 'thread_settings_applied') {
    const settings = payload.thread_settings || {}, tier = settings.service_tier;
    return changed(current, { model: text(settings.model), effort: text(settings.reasoning_effort),
      fast: tier === undefined ? null : tier === 'priority' || tier === 'fast' });
  }
  return current;
}

module.exports = { agentSettings };
