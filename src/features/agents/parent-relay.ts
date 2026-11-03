// A word for a sub-agent now reaches the worker itself (Claude by streaming input, Codex by steer), never the planner's input, so nothing is
// pasted into the planner's terminal any more. A relay request from a main process that still sends one is answered, once and by its id,
// with a refusal that says so — main waits for that answer and must not believe the word was passed on.
export const RELAY_REFUSED = 'Words for a sub-agent go to the worker directly; nothing is pasted into the planner’s input.';

export function startParentRelay() {
  return window.agentrix.onAgentRelay(({ id }) => { void window.agentrix.agentRelayResult(id, RELAY_REFUSED); });
}
