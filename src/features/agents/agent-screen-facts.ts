import type { ScreenFacts } from '../../shared/types.ts';
import { cliDialogShown, cliInputAvailable, cliInputDraft, parseAgentScreen, screenOf, type ScreenAgent } from '../cli-screens/index.ts';

export type { ScreenFacts };
type Frame = { agentVersion?: string; rows: string[]; sessionId: string | null; revision: number; pending?: boolean };

// busy is Claude's working line alone: a running ! command is not a turn. The facts main wants from a Claude terminal's screen: booleans only, never text.
function screenFacts(agent: ScreenAgent, rows: string[], version?: string): Omit<ScreenFacts, 'sessionId' | 'revision'> | null {
  const facts = screenOf(agent)?.facts;
  if (!facts) return null;
  const screen = parseAgentScreen(agent, rows, version);
  if (screen.unsupported) return null;
  return { inputPresent: cliInputAvailable(agent, rows), busy: facts.busy(rows), dialog: cliDialogShown(agent, rows, screen),
    menu: screen.choice?.kind === 'menu', queueShown: facts.queue(rows), draft: !!cliInputDraft(agent, rows, screen) };
}

// Sends the facts once per session at its first completed parse, then only when one changes.
export function createFactsPublisher(send: (facts: ScreenFacts) => void) {
  let key = '', session: string | null = null, last = 0, seen = '';
  return (frame: Frame, agent: ScreenAgent) => {
    if (!frame.sessionId || frame.pending) return;
    const stamp = frame.sessionId + '|' + frame.revision;
    if (stamp === seen) return;
    seen = stamp;
    const facts = screenFacts(agent, frame.rows, frame.agentVersion);
    if (!facts) return;
    const next = frame.sessionId + JSON.stringify(facts);
    if (next === key) return;
    if (session !== frame.sessionId) { session = frame.sessionId; last = 0; }
    key = next; last = Math.max(frame.revision, last + 1);
    send({ sessionId: frame.sessionId, revision: last, ...facts });
  };
}
