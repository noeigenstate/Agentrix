// What an agent runs with, as its own records tell it: the model, how hard it thinks (its effort) and whether fast mode
// is on. Codex writes them when a turn starts (turn_context) and whenever its settings are applied (at start, after
// /model or /fast: thread_settings_applied, whose service tier "priority" is fast mode). Claude Code writes them with
// every reply (message.model, effort/perTurnEffort, usage.speed) and answers /model, /effort and /fast at once in its own output.
// The reading view shows them above its message box.
const EMPTY = { model: null, effort: null, fast: null, ultracode: null };
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;

function changed(current, patch) {
  const base = current || EMPTY;
  const next = {
    model: patch.model ?? base.model, effort: patch.effort ?? base.effort, fast: patch.fast ?? base.fast,
    ultracode: patch.ultracode ?? base.ultracode ?? null,
  };
  return Object.keys(next).every(key => next[key] === base[key]) ? current : next;
}

// What Claude Code printed for one of its own commands: "Set model to `Opus 5.5` …", "Set effort level to max (…)",
// and fast mode turned on or off.
function claudeStdout(record) {
  const content = record.message?.content;
  const words = typeof content === 'string' ? content : Array.isArray(content) ? content.map(block => typeof block?.text === 'string' ? block.text : '').join('\n') : '';
  return /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(words)?.[1].replace(/\x1b\[[0-9;]*m/g, '');
}

const fastEcho = /^[ \t]*(?:↯\s*|Kept\s+)?Fast mode\s+(?:is (?:now )?)?(on|enabled|off|disabled)\b/i;
const fastEnabled = /^(?:on|enabled)$/i;

function claudeFastModeEcho(record) {
  if (record?.type !== 'user' || record.isSidechain || record.isMeta || record.isCompactSummary) return null;
  const output = claudeStdout(record);
  if (!output) return null;
  const reason = /^[ \t]*(?:↯\s*)?Fast mode unavailable:\s*(.+)/i.exec(output)?.[1].trim();
  if (!reason && !fastEnabled.test(fastEcho.exec(output)?.[1] ?? '')) return null;
  const at = Date.parse(record.timestamp);
  return Number.isFinite(at) ? { at, reason: reason || null } : null;
}

function claudeCommandOutput(record) {
  const output = claudeStdout(record);
  if (!output) return null;
  const model = /^\s*Set model to\s+`?([^`\n(]+?)`?(?:\s+\(|\s+and\b|\s+for this session only\b|\s*$)/im.exec(output)?.[1];
  const effort = /^\s*Set effort level to\s+([a-z]+)\b/im.exec(output)?.[1];
  const fast = fastEcho.exec(output)?.[1];
  const fastModel = fast && /\bmodel set to\s+`?([^`·\n]+?)`?(?:\s*·|\s*$)/i.exec(output)?.[1];
  const standaloneUltra = /^\s*Ultracode (?:on|off) \(|^\s*Ultracode off\. Effort stays \w+\./i;
  const ultracode = (effort || standaloneUltra.test(output)) && /\bUltracode\s+(on|off)\b/i.exec(output)?.[1];
  if (!model && !effort && !fast && !ultracode) return null;
  return { model: text(model || fastModel), effort: text(effort)?.toLowerCase() ?? null,
    fast: fast ? fastEnabled.test(fast) : null, ultracode: ultracode ? ultracode.toLowerCase() === 'on' : null };
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
    if (record.type === 'attachment') {
      const kind = record.attachment?.type;
      if (kind === 'ultra_effort_enter' || kind === 'ultra_effort_exit') return changed(current, { ultracode: kind === 'ultra_effort_enter' });
    }
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

module.exports = { agentSettings, claudeFastModeEcho };
