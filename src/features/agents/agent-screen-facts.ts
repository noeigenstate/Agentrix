import type { ScreenFacts } from '../../shared/types.ts';
import { parseAgentScreen } from './agent-screen.ts';
import { claudeWorking, cliDialogShown, cliInputDraft, hasCliInput, queueShown } from './agent-screen-input.ts';

export type { ScreenFacts };
type Frame = { rows: string[]; sessionId: string | null; revision: number; queued?: number; pending?: boolean };

// busy is Claude's working line alone: a running ! command is not a turn. The facts main wants from a Claude terminal's screen: booleans only, never text.
export function screenFacts(rows: string[], queued = 0): Omit<ScreenFacts, 'sessionId' | 'revision'> {
  const screen = { ...parseAgentScreen('claude', rows), queued };
  return { inputPresent: hasCliInput('claude', rows, screen), busy: claudeWorking(rows), dialog: cliDialogShown('claude', rows, screen),
    menu: screen.choice?.kind === 'menu', queueShown: queueShown(rows), draft: !!cliInputDraft('claude', rows, screen) };
}

// Sends the facts once per session at its first completed parse, then only when one changes. A change that comes with
// no new frame (the queue count) still needs a revision above the last one sent, which main requires.
export function createFactsPublisher(send: (facts: ScreenFacts) => void) {
  let key = '', session: string | null = null, last = 0;
  return (frame: Frame) => {
    if (!frame.sessionId || frame.pending) return;
    const facts = screenFacts(frame.rows, frame.queued ?? 0), next = frame.sessionId + JSON.stringify(facts);
    if (next === key) return;
    if (session !== frame.sessionId) { session = frame.sessionId; last = 0; }
    key = next; last = Math.max(frame.revision, last + 1);
    send({ sessionId: frame.sessionId, revision: last, ...facts });
  };
}
