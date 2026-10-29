import { useEffect, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { ApprovalStamp } from '../../shared/types';
import type { ScreenAgent, ScreenChoice } from '../agents/agent-screen-types';
import { choiceIdentity, parseAgentScreen } from '../agents/agent-screen.ts';

// What a terminal shows right now, as text rows: the agent's own screen (its welcome lines, footer, mode and the
// choices it is asking about) for the reading view to present without switching to the terminal. Each
// TerminalPane registers its xterm; readers subscribe and are told at most every 100 ms after output.
export type Screen = { rows: string[]; approval?: ApprovalStamp | null; instances?: Record<ScreenAgent, number> };
type Entry = { terminal: Terminal; listeners: Set<(screen: Screen) => void>; timer: number; dispose: () => void;
  sessionId?: string; approval: ApprovalStamp | null; writes: number; pending: number;
  identities: Partial<Record<ScreenAgent, string | null>>; instances: Record<ScreenAgent, number>; rowsKey: string };
const entries = new Map<string, Entry>();
let incarnation = 0;
const pending = new Map<string, Set<(screen: Screen) => void>>();

function read(terminal: Terminal): Screen {
  const buffer = terminal.buffer.active, rows: string[] = [];
  // The live screen, from baseY: viewportY stays wherever the reader scrolled the terminal back to, and writes made from
  // the reading view never scroll it down again, so the questions and command output would be read from old rows.
  for (let index = 0; index < terminal.rows; index++) rows.push(buffer.getLine(buffer.baseY + index)?.translateToString(true) ?? '');
  return { rows };
}

function snapshot(entry: Entry): Screen {
  const screen = read(entry.terminal);
  // Observe every parsed screen, before the 100 ms UI publisher. Otherwise A/B/A inside one UI frame reuses A.
  const rowsKey = JSON.stringify(screen.rows);
  if (rowsKey !== entry.rowsKey) {
    entry.rowsKey = rowsKey;
    for (const agent of ['claude', 'codex'] as const) {
      const choice = parseAgentScreen(agent, screen.rows).choice;
      const identity = choice ? choiceIdentity(choice) : null;
      if (entry.identities[agent] !== identity) { entry.identities[agent] = identity; entry.instances[agent] = ++incarnation; }
    }
  }
  return { ...screen, approval: entry.pending ? null : entry.approval, instances: { ...entry.instances } };
}

export function registerScreen(id: string, terminal: Terminal, sessionId?: string) {
  const listeners = pending.get(id) ?? new Set(); pending.delete(id);
  const entry: Entry = { terminal, listeners, timer: 0, dispose: () => {}, sessionId, approval: null, writes: 0, pending: 0,
    identities: {}, instances: { claude: ++incarnation, codex: ++incarnation }, rowsKey: '' };
  const notify = () => {
    snapshot(entry);
    if (entry.timer || !entry.listeners.size) return;
    entry.timer = window.setTimeout(() => { entry.timer = 0; if (!entry.listeners.size) return; const screen = snapshot(entry); entry.listeners.forEach(listener => listener(screen)); }, 100);
  };
  const written = terminal.onWriteParsed(notify), resized = terminal.onResize(notify);
  entry.dispose = () => { written.dispose(); resized.dispose(); clearTimeout(entry.timer); };
  entries.set(id, entry); notify();
  return () => {
    if (entries.get(id) !== entry) return;
    entry.dispose(); entries.delete(id);
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
    snapshot(entry);
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

export function useScreen(id: string) {
  const [screen, setScreen] = useState<Screen | null>(() => readScreen(id));
  useEffect(() => subscribeScreen(id, setScreen), [id]);
  return screen;
}

// A permission choice carries the screen's approval stamp and the agent's instance, so a stale card cannot answer a newer prompt.
export function bindApproval(choice: ScreenChoice | null, agent: ScreenAgent, screen: Screen | null): ScreenChoice | null {
  if (choice?.kind !== 'permission') return choice;
  return { ...choice, approval: { instance: screen?.instances?.[agent] ?? 0, stamp: screen?.approval ?? null } };
}
