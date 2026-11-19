const { agentDescription } = require('../agents/call-seat.cjs');
const AGENT_MODEL = /^(sonnet|opus|haiku|fable)$/;
const AGENT_EFFORT = /^(low|medium|high|xhigh|max)$/;

function agentSeat(input, seats) {
  if (!seats || !['Agent', 'Task'].includes(input?.tool_name)) return {};
  const tool = input.tool_input;
  const { labels } = agentDescription(tool?.description, () => Object.keys(seats));
  if (!labels) return {};
  const { seat } = labels;
  const { model, effort, agentModel: alias = model } = seats[seat] || {};
  if (typeof model !== 'string' || !model || model.length > 160) return {};
  if (!/^(opus|sonnet|haiku|fable|claude-)/.test(model)) return { note: `[${seat}] uses Codex. Launch this seat through the dispatch helper.` };
  if (typeof alias !== 'string' || !AGENT_MODEL.test(alias) || typeof effort !== 'string' || !AGENT_EFFORT.test(effort) || tool.subagent_type === 'fork') {
    return { note: `[${seat}] Claude Agent cannot apply this seat's model and effort.` };
  }
  return { model: alias, effort };
}

function seatHookOutput(input, seats) {
  if (input?.hook_event_name !== 'PreToolUse') return {};
  const { model, effort, note } = agentSeat(input, seats);
  if (note) return { systemMessage: note };
  const tool = input.tool_input;
  if (!model || tool.model === model && tool.effort === effort) return {};
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...tool, model, effort } } };
}

function observedAgentSeat(input, seats) {
  if (input?.hook_event_name !== 'PostToolUse' || typeof input.tool_use_id !== 'string' || !/^[\w-]{1,160}$/.test(input.tool_use_id)) return null;
  const { model, effort } = agentSeat(input, seats);
  if (!model || input.tool_input.model !== model || input.tool_input.effort !== effort) return null;
  return { toolUseId: input.tool_use_id, model, effort };
}

module.exports = { seatHookOutput, observedAgentSeat };
