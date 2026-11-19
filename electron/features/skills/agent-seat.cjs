const { agentDescription, CLAUDE_ALIAS, CLAUDE_EFFORT, familyOf } = require('../agents/call-seat.cjs');

function agentSeat(input, seats) {
  if (!seats || !['Agent', 'Task'].includes(input?.tool_name)) return {};
  const tool = input.tool_input;
  const { labels } = agentDescription(tool?.description, () => Object.keys(seats));
  if (!labels) return {};
  const { seat } = labels;
  const { model, effort, agentModel: alias = model } = seats[seat] || {};
  if (typeof model !== 'string' || !model || model.length > 160) return {};
  if (familyOf(model) !== 'claude') return { note: `[${seat}] uses Codex. Launch this seat through the dispatch helper.` };
  if (typeof alias !== 'string' || !CLAUDE_ALIAS.test(alias) || typeof effort !== 'string' || !CLAUDE_EFFORT.test(effort) || tool.subagent_type === 'fork') {
    return { note: `[${seat}] Claude Agent cannot apply this seat's model and effort.` };
  }
  return { model: alias, effort };
}

function seatHookOutput(input, seats, report = () => {}) {
  if (input?.hook_event_name !== 'PreToolUse') return {};
  const { model, effort, note } = agentSeat(input, seats);
  if (note) return { systemMessage: note };
  if (!model) return {};
  const tool = input.tool_input;
  // updatedInput replaces the whole tool input.
  const output = tool.model === model && tool.effort === effort ? {}
    : { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...tool, model, effort } } };
  const observed = seatObservation(input, model, effort, 'pre');
  if (observed) report(observed);
  return output;
}

function observedAgentSeat(input, seats) {
  if (input?.hook_event_name !== 'PostToolUse' || !agentSeat(input, seats).model) return null;
  const { model, effort } = input.tool_input;
  return seatObservation(input, model, effort, 'post');
}

function seatObservation(input, model, effort, phase) {
  const toolUseId = input.tool_use_id;
  if (typeof toolUseId !== 'string' || !/^[\w-]{1,160}$/.test(toolUseId)) return null;
  const supported = typeof model === 'string' && CLAUDE_ALIAS.test(model) && typeof effort === 'string' && CLAUDE_EFFORT.test(effort);
  return { toolUseId, model: supported ? model : null, effort: supported ? effort : null, phase };
}

module.exports = { seatHookOutput, observedAgentSeat };
