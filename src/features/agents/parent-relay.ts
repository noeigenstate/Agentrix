// A word the owner gave a sub-agent that cannot take it directly is relayed by the main process to the planner's own agent terminal.
// The terminal's screen lives here: send only through an available input, preserve the owner's draft, and report to main.
import { sendToAgent } from '../home/send-to-agent';

export function startParentRelay() {
  return window.agentrix.onAgentRelay(async ({ id, terminalId, sessionId, agent, text, deadline }) => {
    const error = await sendToAgent(terminalId, sessionId, agent, text, { preserveDraft: true, deadline }).catch(failure => failure instanceof Error ? failure.message : String(failure));
    void window.agentrix.agentRelayResult(id, error);
  });
}
