import { useEffect, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { ApprovalStamp } from '../../shared/types';
import type { ScreenAgent, ScreenChoice } from '../agents/agent-screen-types';
import { choiceIdentity, parseAgentScreen } from '../agents/agent-screen.ts';
import { cliDialogShown, isAtPrompt, isCliWorking } from '../agents/agent-screen-input.ts';
export { cliStateFor, nextCliState } from '../agents/agent-screen-state.ts';

// What a terminal shows right now, as text rows: the agent's own screen (its welcome lines, footer, mode and the
// choices it is asking about) for the reading view to present without switching to the terminal. Each
// TerminalPane registers its xterm; each completed parse publishes a stable frame, even for an unchanged spinner.
export type Screen = { rows: string[]; sessionId: string | null; epoch?: number; revision: number; updatedAt: number; stateUpdatedAt?: Record<ScreenAgent, number>; parsed?: boolean; pending?: boolean; approval?: ApprovalStamp | null; instances?: Record<ScreenAgent, number> };
type Entry = { terminal: Terminal; listeners: Set<(screen: Screen) => void>; dispose: () => void; frame?: Screen; epoch: number;
  sessionId?: string; approval: ApprovalStamp | null; writes: number; pending: number; revision: number; updatedAt: number;
  states: Partial<Record<ScreenAgent, string | null>>; stateUpdatedAt: Record<ScreenAgent, number>;
  identities: Partial<Record<ScreenAgent, string | null>>; instances: Record<ScreenAgent, number>; rowsKey: string };
const entries = new Map<string, Entry>();
let incarnation = 0;
let frameRevision = 0;
const pending = new Map<string, Set<(screen: Screen) => void>>();

function read(terminal: Terminal): Pick<Screen, 'rows'> {
  const buffer = terminal.buffer.active, rows: string[] = [];
  // The live screen, from baseY: viewportY stays wherever the reader scrolled the terminal back to, and writes made from
  // the reading view never scroll it down again, so the questions and command output would be read from old rows.
  for (let index = 0; index < terminal.rows; index++) rows.push(buffer.getLine(buffer.baseY + index)?.translateToString(true) ?? '');
  return { rows };
}

function capture(entry: Entry): Screen {
  const screen = read(entry.terminal);
  entry.revision = ++frameRevision;
  // State timestamps advance only when the observed state changes, never for spinner or background output.
  const rowsKey = JSON.stringify(screen.rows);
  if (rowsKey !== entry.rowsKey) {
    entry.updatedAt = Date.now();
    entry.rowsKey = rowsKey;
    for (const agent of ['claude', 'codex'] as const) {
      const parsed = parseAgentScreen(agent, screen.rows), choice = parsed.choice;
      const state = cliDialogShown(agent, screen.rows, parsed) ? 'waiting' : isCliWorking(agent, screen.rows, parsed) ? 'working' : isAtPrompt(agent, screen.rows, parsed) ? 'idle' : null;
      if (entry.states[agent] !== state) { entry.states[agent] = state; entry.stateUpdatedAt[agent] = entry.updatedAt; }
      const identity = choice ? choiceIdentity(choice) : null;
      if (entry.identities[agent] !== identity) { entry.identities[agent] = identity; entry.instances[agent] = ++incarnation; }
    }
  }
  return entry.frame = { ...screen, sessionId: entry.sessionId ?? null, epoch: entry.epoch, revision: entry.revision, updatedAt: entry.updatedAt, parsed: true,
    stateUpdatedAt: { ...entry.stateUpdatedAt }, approval: entry.pending ? null : entry.approval, instances: { ...entry.instances } };
}

function snapshot(entry: Entry): Screen {
  return { ...entry.frame!, pending: entry.pending > 0, approval: entry.pending ? null : entry.approval };
}

function publish(entry: Entry) {
  capture(entry);
  const frame = snapshot(entry);
  entry.listeners.forEach(listener => listener(frame));
}

export function registerScreen(id: string, terminal: Terminal, sessionId?: string) {
  const previous = entries.get(id), listeners = previous?.listeners ?? pending.get(id) ?? new Set(); pending.delete(id);
  previous?.dispose();
  const entry: Entry = { terminal, listeners, dispose: () => {}, epoch: ++incarnation, sessionId, approval: null, writes: 0, pending: 0,
    revision: ++frameRevision, updatedAt: Date.now(), states: {}, stateUpdatedAt: { claude: 0, codex: 0 }, identities: {}, instances: { claude: ++incarnation, codex: ++incarnation }, rowsKey: '' };
  const notify = () => {
    if (entries.get(id) === entry) publish(entry);
  };
  const written = terminal.onWriteParsed(notify), resized = terminal.onResize(notify);
  entry.dispose = () => { written.dispose(); resized.dispose(); };
  capture(entry);
  entries.set(id, entry);
  listeners.forEach(listener => listener({ rows: [], sessionId: sessionId ?? null, revision: entry.revision, updatedAt: entry.updatedAt }));
  notify();
  return () => {
    if (entries.get(id) !== entry) return;
    entry.dispose(); entries.delete(id);
    entry.listeners.forEach(listener => listener({ rows: [], sessionId: null, revision: ++frameRevision, updatedAt: Date.now() }));
    if (entry.listeners.size) pending.set(id, entry.listeners);
  };
}

export function readScreen(id: string): Screen | null {
  const entry = entries.get(id);
  return entry ? snapshot(entry) : null;
}

// Invalidate on receipt, before xterm parses its async write queue. Only the last queued write's callback may
// associate a backend stamp with these rows. An old parse callback cannot rearm a newer screen.
export function writeScreen(id: string, data: string, approval?: ApprovalStamp) {
  const entry = entries.get(id);
  if (!entry) return;
  const serial = ++entry.writes;
  entry.pending++; entry.approval = null;
  entry.terminal.write(data, () => {
    if (entries.get(id) !== entry) return;
    entry.pending--;
    if (serial === entry.writes && approval && approval.sessionId === entry.sessionId) entry.approval = { ...approval };
    publish(entry);
  });
}

export function screenChoice(agent: ScreenAgent, screen: Screen | null): ScreenChoice | null {
  const choice = parseAgentScreen(agent, screen?.rows ?? []).choice;
  return bindApproval(choice, agent, screen);
}

// Subscribers stay attached across a terminal being remounted (its pane re-creates the xterm).
export function subscribeScreen(id: string, listener: (screen: Screen) => void) {
  const set = entries.get(id)?.listeners ?? pending.get(id) ?? new Set();
  if (!entries.has(id)) pending.set(id, set);
  set.add(listener);
  const current = readScreen(id); if (current) listener(current);
  return () => { set.delete(listener); if (!set.size && pending.get(id) === set) pending.delete(id); };
}

export function useScreen(id: string, sessionId?: string | null) {
  const [value, setValue] = useState(() => ({ id, screen: readScreen(id) }));
  useEffect(() => {
    setValue({ id, screen: readScreen(id) });
    return subscribeScreen(id, screen => setValue({ id, screen }));
  }, [id, sessionId]);
  return value.id === id && (sessionId === undefined || value.screen?.sessionId === sessionId) ? value.screen : null;
}

// A permission choice carries the screen's approval stamp and the agent's instance, so a stale card cannot answer a newer prompt.
export function bindApproval(choice: ScreenChoice | null, agent: ScreenAgent, screen: Screen | null): ScreenChoice | null {
  if (choice?.kind !== 'permission') return choice;
  return { ...choice, approval: { instance: screen?.instances?.[agent] ?? 0, stamp: screen?.approval ?? null } };
}
