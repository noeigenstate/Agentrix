import { useSyncExternalStore } from 'react';
import type { ProjectTerminal } from '../../shared/types';
import { readScreen, subscribeScreen } from '../terminal/terminal-screen.ts';
import { parseAgentScreen } from '../agents/agent-screen.ts';
import { readingState, nextCliState, type CliState } from './reading-state.ts';

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
const monitors = new Map<string, { terminal: ProjectTerminal; signal: CliState | null; dispose: () => void }>();
let unsubscribeState: (() => void) | undefined;

function releaseMonitor(id: string) {
  monitors.get(id)?.dispose(); monitors.delete(id); cancelHandoff(id);
  if (!monitors.size) { unsubscribeState?.(); unsubscribeState = undefined; }
}

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
  if (!terminal.codexActive || !terminal.sessionId) releaseMonitor(terminal.id);
  if (terminal.codexActive || terminal.readingHistory) return;
  cancelHandoff(terminal.id); choices.delete(terminal.id); inputSeen.delete(terminal.id); automatic.delete(terminal.id);
  if (terminals.has(terminal.id)) setReading(terminal.id, true);
}
// One handoff per permission notice; a manual toggle cancels its return trip.
export function syncReading(terminal: ProjectTerminal) {
  agentExited(terminal);
  // Keep watching the terminal after an automatic handoff unmounts ReadingView; no new host output is needed to return.
  if (terminal.codexActive && terminal.sessionId && terminal.agent) {
    const current = monitors.get(terminal.id);
    if (current) current.terminal = terminal;
    else {
      const monitor = { terminal, signal: null, dispose: () => {} };
      monitors.set(terminal.id, monitor);
      monitor.dispose = subscribeScreen(terminal.id, frame => {
        if (frame?.sessionId === null) { releaseMonitor(terminal.id); return; }
        syncReading(monitor.terminal);
      });
      if (monitors.get(terminal.id) !== monitor) { monitor.dispose(); return; }
      // Removed terminals get no final exit update. Use the complete host inventory
      // to retire their listeners, including a monitor created before xterm mounted.
      if (!unsubscribeState && typeof window !== 'undefined') unsubscribeState = window.agentrix?.onState?.(state => {
        const live = new Map(state.projects.flatMap(project => project.terminals || []).map(value => [value.id, value]));
        for (const [id, watched] of monitors) {
          const value = live.get(id);
          if (value) syncReading(value);
          else agentExited({ ...watched.terminal, sessionId: null, codexActive: false, readingHistory: undefined });
        }
      });
    }
  }
  const monitor = monitors.get(terminal.id), signal = nextCliState(monitor?.signal ?? null, terminal), screen = readScreen(terminal.id);
  if (monitor) monitor.signal = signal;
  const waiting = screen && terminal.agent ? readingState(terminal.agent, screen.rows, parseAgentScreen(terminal.agent, screen.rows), terminal, signal, screen).waiting
    : signal ? signal.state === 'waiting' : terminal.needsInput != null;
  if (!waiting || !terminal.codexActive) {
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
