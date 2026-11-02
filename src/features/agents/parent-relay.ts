// A word the owner gave a sub-agent that cannot take it directly is relayed by the main process to the planner's own agent terminal.
// The terminal's screen lives in this window, so the send happens here, the normal way (sendToAgent), and main is told how it went.
import { sendToAgent } from '../home/send-to-agent';

export function startParentRelay() {
  return window.agentrix.onAgentRelay(async ({ id, terminalId, sessionId, agent, text }) => {
    const error = await sendToAgent(terminalId, sessionId, agent, text).catch(failure => failure instanceof Error ? failure.message : String(failure));
    void window.agentrix.agentRelayResult(id, error);
  });
}
