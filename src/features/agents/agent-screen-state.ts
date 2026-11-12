import type { CliState, ProjectTerminal } from '../../shared/types.ts';
import type { AgentScreen, ScreenAgent } from './agent-screen-types.ts';
import { parseAgentScreen } from './agent-screen.ts';
import { cliDialogShown, hasCliInput, isAtPrompt, isCliWorking } from './agent-screen-input.ts';

export type CliFrame = { rows: string[]; sessionId?: string | null; revision?: number; updatedAt?: number; stateUpdatedAt?: Partial<Record<ScreenAgent, number>>; pending?: boolean };
export function validCliState(terminal: ProjectTerminal): CliState | null {
  const state = terminal.cliState;
  return state && typeof state.sessionId === 'string' && !!state.sessionId && state.sessionId === terminal.sessionId && Number.isSafeInteger(state.revision) && state.revision >= 0
    && Number.isFinite(state.updatedAt) && state.updatedAt >= (terminal.agentStartedAt ?? 0)
    && ['idle', 'working', 'waiting'].includes(state.state) ? state : null;
}
export function nextCliState(previous: CliState | null, terminal: ProjectTerminal): CliState | null {
  const kept = previous && previous.sessionId === terminal.sessionId && previous.updatedAt >= (terminal.agentStartedAt ?? 0) ? previous : null, next = validCliState(terminal);
  return next && next.revision > (kept?.revision ?? -1) ? next : kept;
}

// Only a changed frame from this PTY can supersede host evidence. Reading a cached screen never makes it newer.
export function cliStateFor(agent: ScreenAgent, frame: CliFrame | null, terminal: ProjectTerminal, signal = validCliState(terminal), parsed?: AgentScreen) {
  const current = frame && (frame.sessionId === undefined || frame.sessionId === terminal.sessionId) ? frame : null;
  const rows = current?.rows ?? [], screen = current && parsed || parseAgentScreen(agent, rows);
  const input = hasCliInput(agent, rows, screen), idle = isAtPrompt(agent, rows, screen);
  const dialog = cliDialogShown(agent, rows, screen), busy = isCliWorking(agent, rows, screen);
  const observed = current?.pending ? null : dialog ? 'waiting' : busy ? 'working' : idle ? 'idle' : null;
  const newer = !!observed && current?.sessionId === terminal.sessionId && (current?.revision ?? 0) > 0
    && (current?.stateUpdatedAt?.[agent] ?? current?.updatedAt ?? 0) > (signal?.updatedAt ?? Infinity);
  const authority = signal && !newer ? signal : null;
  const waiting = dialog || (authority ? authority.state === 'waiting' : !signal && terminal.needsInput != null && !idle);
  const working = !waiting && (authority ? authority.state === 'working' : busy || !idle && (terminal.mainTurn?.state ?? terminal.codexActivity) === 'working');
  // A busy CLI takes messages as its terminal does. accepting ignores a frame xterm is still parsing (Claude Code's busy
  // output keeps one parsing most of the time): a send waits for the parsed frame before it writes.
  const accepting = input && !dialog && !waiting;
  return { input, idle, waiting, working, message: authority?.state === 'waiting' ? authority.message : waiting ? terminal.needsInput : null,
    accepting, canDeliver: accepting && !current?.pending };
}
