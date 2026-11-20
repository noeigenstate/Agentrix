import type { ScreenFacts } from '../../shared/types.ts';
import { parseAgentScreen } from './agent-screen.ts';
import { claudeWorking, cliDialogShown, cliInputAvailable, cliInputDraft, queueShown } from './agent-screen-input.ts';

export type { ScreenFacts };
type Frame = { rows: string[]; sessionId: string | null; revision: number; pending?: boolean };

// busy is Claude's working line alone: a running ! command is not a turn. The facts main wants from a Claude terminal's screen: booleans only, never text.
export function screenFacts(rows: string[]): Omit<ScreenFacts, 'sessionId' | 'revision'> {
  const screen = parseAgentScreen('claude', rows);
  return { inputPresent: cliInputAvailable('claude', rows), busy: claudeWorking(rows), dialog: cliDialogShown('claude', rows, screen),
    menu: screen.choice?.kind === 'menu', queueShown: queueShown(rows), draft: !!cliInputDraft('claude', rows, screen) };
}

// Sends the facts once per session at its first completed parse, then only when one changes.
export function createFactsPublisher(send: (facts: ScreenFacts) => void) {
  let key = '', session: string | null = null, last = 0, seen = '';
  return (frame: Frame) => {
    if (!frame.sessionId || frame.pending) return;
    const stamp = frame.sessionId + '|' + frame.revision;
    if (stamp === seen) return;
    seen = stamp;
    const facts = screenFacts(frame.rows), next = frame.sessionId + JSON.stringify(facts);
    if (next === key) return;
    if (session !== frame.sessionId) { session = frame.sessionId; last = 0; }
    key = next; last = Math.max(frame.revision, last + 1);
    send({ sessionId: frame.sessionId, revision: last, ...facts });
  };
}
