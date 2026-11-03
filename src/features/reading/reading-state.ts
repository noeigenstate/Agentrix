import type { ProjectTerminal } from '../../shared/types.ts';
import type { AgentScreen, ScreenAgent } from '../agents/agent-screen-types.ts';
import { cliDialogShown, hasCliInput, isAtPrompt, isCliWorking } from './cli-panel.ts';

// Host contract: sessionId is the PTY incarnation, revision increases for every transition, including attention cleared.
// Kept local until the host publishes it; legacy hosts retain the conservative screen fallback.
export type CliState = { sessionId: string; revision: number; updatedAt: number; state: 'idle' | 'working' | 'waiting'; message?: string };
export function validCliState(terminal: ProjectTerminal): CliState | null {
  const state = (terminal as ProjectTerminal & { cliState?: CliState }).cliState;
  return state && state.sessionId === terminal.sessionId && Number.isSafeInteger(state.revision) && state.revision >= 0
    && Number.isFinite(state.updatedAt) && ['idle', 'working', 'waiting'].includes(state.state) ? state : null;
}
export function nextCliState(previous: CliState | null, terminal: ProjectTerminal): CliState | null {
  const kept = previous?.sessionId === terminal.sessionId ? previous : null;
  const next = validCliState(terminal);
  return next && next.revision > (kept?.revision ?? -1) ? next : kept;
}

export function readingState(agent: ScreenAgent, rows: string[], screen: AgentScreen, terminal: ProjectTerminal, signal = validCliState(terminal)) {
  const input = hasCliInput(agent, rows, screen), idle = isAtPrompt(agent, rows, screen);
  const dialog = cliDialogShown(agent, rows, screen);
  const activity = terminal.mainTurn?.state ?? terminal.codexActivity;
  // Old hosts provide no age for needsInput. A current input is the only evidence that can retire that stale notice.
  const waiting = signal ? signal.state === 'waiting' : dialog || terminal.needsInput != null && !idle;
  const working = !waiting && (signal ? signal.state === 'working' : isCliWorking(agent, rows, screen)
    || !idle && activity === 'working');
  return { input, idle, waiting, working, message: signal?.state === 'waiting' ? signal.message : waiting ? terminal.needsInput : null,
    // Even a host completion can arrive before xterm finishes parsing a closing dialog. Never send Enter into those rows.
    canDeliver: input && !dialog && !waiting };
}
