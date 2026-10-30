import { useSyncExternalStore } from 'react';
import type { ProjectTerminal } from '../../shared/types';

// While Codex or Claude Code runs in a terminal, its conversation shows in the reading view by default. The toggle
// in the card header shows the raw terminal instead; that choice lasts until the agent exits, and the next agent
// started there opens in the reading view again.
let terminals = new Set<string>();
const listeners = new Set<() => void>();
let snapshot: string[] = [];
const inputSeen = new Set<string>(), automatic = new Set<string>();
const choices = new Set<string>();
const handoffs = new Map<string, ReturnType<typeof setTimeout>>();
const READING_HANDOFF_DELAY = 1500;

function cancelHandoff(id: string) {
  const timer = handoffs.get(id);
  if (timer !== undefined) clearTimeout(timer);
  handoffs.delete(id);
}

// Screen state comes from ReadingView; the handoff logic does not need a React screen hook.
export function setChoiceVisible(id: string, visible: boolean) {
  if (visible) { choices.add(id); cancelHandoff(id); }
  else choices.delete(id);
}

export function setReading(id: string, on: boolean, auto = false) {
  if (!auto) { automatic.delete(id); cancelHandoff(id); }
  if (terminals.has(id) === !on) return;
  terminals = new Set(terminals);
  if (on) terminals.delete(id); else terminals.add(id);
  snapshot = [...terminals];
  listeners.forEach(listener => listener());
}
// The terminals switched to the raw terminal while their agent runs.
export function useTerminalChoice() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot);
}
export const readingShown = (terminal: ProjectTerminal, raw: string[]) => (!!terminal.sessionId && terminal.codexActive || !!terminal.readingHistory) && !raw.includes(terminal.id);
// Forget a terminal's choice once its agent has exited.
export function agentExited(terminal: ProjectTerminal) {
  if (terminal.codexActive || terminal.readingHistory) return;
  cancelHandoff(terminal.id); choices.delete(terminal.id); inputSeen.delete(terminal.id); automatic.delete(terminal.id);
  if (terminals.has(terminal.id)) setReading(terminal.id, true);
}
// One handoff per permission notice; a manual toggle cancels its return trip.
export function syncReading(terminal: ProjectTerminal) {
  agentExited(terminal);
  if (terminal.needsInput === null || !terminal.codexActive) {
    cancelHandoff(terminal.id);
    inputSeen.delete(terminal.id);
    if (automatic.delete(terminal.id) && terminals.has(terminal.id)) setReading(terminal.id, true, true);
    return;
  }
  if (inputSeen.has(terminal.id)) return;
  inputSeen.add(terminal.id);
  if (choices.has(terminal.id) || !readingShown(terminal, snapshot)) return;
  handoffs.set(terminal.id, setTimeout(() => {
    handoffs.delete(terminal.id);
    if (!inputSeen.has(terminal.id) || choices.has(terminal.id) || !readingShown(terminal, snapshot)) return;
    automatic.add(terminal.id); setReading(terminal.id, false, true);
  }, READING_HANDOFF_DELAY));
}
