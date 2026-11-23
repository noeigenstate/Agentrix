import { useEffect, useState } from 'react';
import type { IBuffer, IBufferCell, IBufferLine, Terminal } from '@xterm/xterm';
import type { ApprovalStamp } from '../../shared/types';
import type { ScreenAgent, ScreenChoice } from '../agents/agent-screen-types';
import { choiceIdentity, parseAgentScreen } from '../agents/agent-screen.ts';
import { claudeInputHint, claudePromptRange, cliDialogShown, cliInputAvailable, cliInputDraft, isAtPrompt, isCliWorking, withoutClaudeCursor }
  from '../agents/agent-screen-input.ts';
import { createFactsPublisher } from '../agents/agent-screen-facts.ts';
export { cliStateFor, nextCliState } from '../agents/agent-screen-state.ts';

// What a terminal shows right now, as text rows: the agent's own screen (its welcome lines, footer, mode and the
// choices it is asking about) for the reading view to present without switching to the terminal. Each
// UI updates coalesce over 100 ms. Delivery observes every completed parse, including the instant pending reaches zero.
// parsed describes the cached rows, not permission to write: pending must be false before any mutation.
export type Screen = {
  rows: string[]; sessionId: string | null; epoch?: number; revision: number; parse?: number; updatedAt: number;
  stateUpdatedAt?: Record<ScreenAgent, number>; parsed?: boolean; pending?: boolean; queued?: number; approval?: ApprovalStamp | null;
  instances?: Record<ScreenAgent, number>; inputFrames?: Record<ScreenAgent, number>; inputHint?: boolean;
};
type Entry = { id: string; terminal: Terminal; listeners: Set<(screen: Screen) => void>; parses: Set<(screen: Screen) => void>; timer: number; dispose: () => void; frame?: Screen; epoch: number;
  sessionId?: string; approval: ApprovalStamp | null; writes: number; pending: number; revision: number; parse: number; updatedAt: number;
  states: Partial<Record<ScreenAgent, string | null>>; stateUpdatedAt: Record<ScreenAgent, number>;
  inputShown: Record<ScreenAgent, boolean>; inputFrames: Record<ScreenAgent, number>;
  identities: Partial<Record<ScreenAgent, string | null>>; instances: Record<ScreenAgent, number>; rowsKey: string; facts: (frame: Screen) => void; factsTimer: number };
const entries = new Map<string, Entry>();
// What the terminal's owner knows about it (the agent running in it, the messages main holds queued), kept by id across a remount.
const agentKinds = new Map<string, ScreenAgent | null>();
const queueCounts = new Map<string, number>();
let incarnation = 0;
let frameRevision = 0;
const pending = new Map<string, Set<(screen: Screen) => void>>();
const pendingParses = new Map<string, Set<(screen: Screen) => void>>();
export type PasteReceipt = {
  sessionId: string; text: string; status: 'pending' | 'accepted' | 'refused'; emptyInput: boolean;
  canWrite?: () => boolean; waiting?: Promise<void>;
};
const pastes = new Map<string, PasteReceipt>();

// IPC acceptance is not terminal acceptance. The packet receiver can prove it refused this paste without writing it.
export function beginScreenPaste(id: string, sessionId: string, text: string, emptyInput = false, canWrite?: () => boolean): PasteReceipt {
  const receipt: PasteReceipt = { sessionId, text, status: 'pending', emptyInput, canWrite };
  pastes.set(id, receipt); return receipt;
}
export function recordScreenPaste(id: string, sessionId: string, text: string, accepted: boolean) {
  const receipt = pastes.get(id);
  if (receipt?.sessionId !== sessionId || receipt.text !== text) return;
  receipt.status = accepted ? 'accepted' : 'refused'; receipt.canWrite = undefined; pastes.delete(id);
}
export function canPasteScreen(agent: ScreenAgent, frame: Screen | null, emptyInput = false) {
  if (!frame) return false;
  const screen = { ...parseAgentScreen(agent, frame.rows), inputHint: frame.inputHint };
  return !cliDialogShown(agent, frame.rows, screen)
    && (!emptyInput || !frame.pending && cliInputAvailable(agent, frame.rows) && !cliInputDraft(agent, frame.rows, screen));
}
export const screenPaste = (id: string, sessionId: string, text: string) => {
  const receipt = pastes.get(id);
  return receipt?.sessionId === sessionId && receipt.text === text ? receipt : undefined;
};

function isPromptHint(cell: IBufferCell) {
  if (cell.isDim()) return true;
  const color = cell.getFgColor();
  // ANSI gray and its explicit gray equivalents. Normal input uses the terminal's foreground.
  if (cell.isFgPalette()) return color === 8 || color >= 244 && color <= 247;
  return cell.isFgRGB() && (color === 0x808080 || color === 0x999999 || color === 0x9d9d9d);
}

function promptRow(line: IBufferLine, prefix: number, scratch: IBufferCell) {
  let text = line.translateToString(false, 0, prefix), styled = false, cursor = -1;
  for (let column = prefix; column < line.length; column++) {
    const cell = line.getCell(column, scratch);
    if (!cell?.getWidth()) continue;
    const chars = cell.getChars() || ' ';
    if (isPromptHint(cell)) { styled ||= !!chars.trim(); continue; }
    if (chars.trim()) cursor = cell.isInverse() ? text.length : -1;
    text += chars;
  }
  return { text: text.trimEnd(), styled, cursor };
}

function omitClaudeHints(buffer: IBuffer, rows: string[]) {
  const lineAt = (row: number) => buffer.getLine(buffer.baseY + row);
  const range = claudePromptRange(rows, row => !!lineAt(row)?.isWrapped);
  if (!range) return false;
  const scratch = buffer.getNullCell?.();
  let styled = false, editable = false;
  for (let row = range.first; scratch && row < range.end; row++) {
    const line = lineAt(row);
    if (!line) continue;
    const prefix = row === range.first ? range.prefix : 0;
    // Keep the continuation shape even when xterm hard-wraps or all the padding was dim.
    const result = promptRow(line, prefix, scratch);
    styled ||= result.styled;
    rows[row] = !prefix && result.text && !/^ {2}\S/.test(result.text) ? '  ' + result.text.trimStart() : result.text;
    // A final inverse cell can be the CLI's cursor following a styled hint.
    editable ||= !!withoutClaudeCursor(result.text.slice(prefix, result.cursor >= 0 ? result.cursor : undefined)).trim();
  }
  if (!(styled && !editable) && !claudeInputHint(rows)) return false;
  rows[range.first] = rows[range.first].slice(0, range.prefix).trimEnd();
  rows.fill('', range.first + 1, range.end);
  return true;
}

// Claude labels the upper input border while Ultracode is on. Keep it a border for the shared input parser.
function claudeScreenRows(rows: string[]) {
  return rows.map((row, index) => /^\s*─{2,}\s+ultracode\s+─+\s*$/i.test(row) && /^\s*❯/.test(rows[index + 1] ?? '')
    ? row.replace(/ ultracode /i, '───────────') : row);
}

function read(terminal: Terminal, agent?: ScreenAgent | null): Pick<Screen, 'rows' | 'inputHint'> {
  const buffer = terminal.buffer.active, rows: string[] = [];
  // The live screen, from baseY: viewportY stays wherever the reader scrolled the terminal back to, and writes made from
  // the reading view never scroll it down again, so the questions and command output would be read from old rows.
  for (let index = 0; index < terminal.rows; index++) rows.push(buffer.getLine(buffer.baseY + index)?.translateToString(true) ?? '');
  if (agent !== 'claude') return { rows };
  const normalized = claudeScreenRows(rows), inputHint = omitClaudeHints(buffer, normalized);
  return inputHint ? { rows: normalized, inputHint } : { rows: normalized };
}

function capture(entry: Entry): Screen {
  const screen = read(entry.terminal, agentKinds.get(entry.id));
  // State timestamps advance only when the observed state changes, never for spinner or background output.
  const rowsKey = JSON.stringify(screen.rows);
  if (rowsKey !== entry.rowsKey) {
    entry.revision = ++frameRevision;
    entry.updatedAt = Date.now();
    entry.rowsKey = rowsKey;
    for (const agent of ['claude', 'codex'] as const) {
      const parsed = parseAgentScreen(agent, screen.rows), choice = parsed.choice;
      const waiting = cliDialogShown(agent, screen.rows, parsed);
      entry.inputShown[agent] = !waiting && cliInputAvailable(agent, screen.rows);
      const state = waiting ? 'waiting' : isCliWorking(agent, screen.rows, parsed) ? 'working' : isAtPrompt(agent, screen.rows, parsed) ? 'idle' : null;
      if (entry.states[agent] !== state) { entry.states[agent] = state; entry.stateUpdatedAt[agent] = entry.updatedAt; }
      const identity = choice ? choiceIdentity(choice) : null;
      if (entry.identities[agent] !== identity) { entry.identities[agent] = identity; entry.instances[agent] = ++incarnation; }
    }
  }
  // The terminal remains mounted in raw mode. Remember input observed on every parse, including while more output
  // is queued, so a later identical prompt cannot inherit a dismissed episode the reader never saw end.
  for (const agent of ['claude', 'codex'] as const) if (entry.inputShown[agent]) entry.inputFrames[agent]++;
  return entry.frame = { ...screen, sessionId: entry.sessionId ?? null, epoch: entry.epoch, revision: entry.revision, parse: ++entry.parse, updatedAt: entry.updatedAt, parsed: true,
    stateUpdatedAt: { ...entry.stateUpdatedAt }, approval: entry.pending ? null : entry.approval, instances: { ...entry.instances }, inputFrames: { ...entry.inputFrames } };
}

function snapshot(entry: Entry): Screen {
  return { ...entry.frame!, pending: entry.pending > 0, queued: queueCounts.get(entry.id) ?? 0, approval: entry.pending ? null : entry.approval };
}

// Screen facts are computed on the parsed subscribers' 100 ms coalescing: a burst of frames costs one computation, from the last frame.
function scheduleFacts(entry: Entry) {
  if (agentKinds.get(entry.id) !== 'claude' || entry.factsTimer) return;
  entry.factsTimer = window.setTimeout(() => {
    entry.factsTimer = 0;
    if (entries.get(entry.id) === entry && agentKinds.get(entry.id) === 'claude') entry.facts(snapshot(entry));
  }, 100);
}

function publish(entry: Entry) {
  capture(entry);
  const frame = snapshot(entry);
  entry.parses.forEach(listener => listener(frame));
  scheduleFacts(entry);
  if (entry.timer || !entry.listeners.size) return;
  entry.timer = window.setTimeout(() => {
    entry.timer = 0;
    if (entries.get(entry.id) !== entry) return;
    const current = snapshot(entry);
    entry.listeners.forEach(listener => listener(current));
  }, 100);
}

export function registerScreen(id: string, terminal: Terminal, sessionId?: string) {
  const previous = entries.get(id), listeners = previous?.listeners ?? pending.get(id) ?? new Set(); pending.delete(id);
  const parses = previous?.parses ?? pendingParses.get(id) ?? new Set(); pendingParses.delete(id);
  previous?.dispose();
  const entry: Entry = { id, terminal, listeners, parses, timer: 0, dispose: () => {}, epoch: ++incarnation, sessionId, approval: null, writes: 0, pending: 0, parse: 0,
    inputShown: { claude: false, codex: false }, inputFrames: { claude: 0, codex: 0 },
    revision: ++frameRevision, updatedAt: Date.now(), states: {}, stateUpdatedAt: { claude: 0, codex: 0 }, identities: {}, instances: { claude: ++incarnation, codex: ++incarnation }, rowsKey: '',
    facts: createFactsPublisher(facts => window.agentrix.screenFacts(id, facts)), factsTimer: 0 };
  const notify = () => {
    if (entries.get(id) === entry) publish(entry);
  };
  const written = terminal.onWriteParsed(notify), resized = terminal.onResize(notify);
  entry.dispose = () => { written.dispose(); resized.dispose(); clearTimeout(entry.timer); clearTimeout(entry.factsTimer); };
  capture(entry);
  entries.set(id, entry);
  listeners.forEach(listener => listener({ rows: [], sessionId: sessionId ?? null, revision: entry.revision, updatedAt: entry.updatedAt }));
  parses.forEach(listener => listener(snapshot(entry)));
  notify();
  return () => {
    if (entries.get(id) !== entry) return;
    entry.dispose(); entries.delete(id); pastes.delete(id);
    entry.listeners.forEach(listener => listener({ rows: [], sessionId: null, revision: ++frameRevision, updatedAt: Date.now() }));
    entry.parses.forEach(listener => listener({ rows: [], sessionId: null, revision: frameRevision, updatedAt: Date.now() }));
    if (entry.listeners.size) pending.set(id, entry.listeners);
    if (entry.parses.size) pendingParses.set(id, entry.parses);
  };
}

// Keep main's queue count available to snapshot readers without publishing a new parse.
export function setQueueCount(id: string, count: number) {
  if (count) queueCounts.set(id, count); else queueCounts.delete(id);
}

// The agent running in a terminal; only Claude's screen is read for facts.
export function setScreenAgent(id: string, agent: ScreenAgent | null) {
  if (agentKinds.get(id) === agent) return;
  agentKinds.set(id, agent);
  const entry = entries.get(id); if (entry) publish(entry);
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
export function subscribeScreen(id: string, listener: (screen: Screen) => void, parsed = false) {
  const waiting = parsed ? pendingParses : pending;
  const set = entries.get(id)?.[parsed ? 'parses' : 'listeners'] ?? waiting.get(id) ?? new Set();
  if (!entries.has(id)) waiting.set(id, set);
  set.add(listener);
  const current = readScreen(id); if (current) listener(current);
  return () => { set.delete(listener); if (!set.size && waiting.get(id) === set) waiting.delete(id); };
}

// Delivery callbacks do no UI work until a message can actually advance.
export const subscribeParsed = (id: string, listener: (screen: Screen) => void) => subscribeScreen(id, listener, true);

export function receiveScreenPaste(id: string, sessionId: string, text: string, agent: () => ScreenAgent | null, paste: () => void,
  read = readScreen, subscribe = subscribeParsed) {
  const receipt = screenPaste(id, sessionId, text);
  if (!receipt) { paste(); return; }
  const finish = (frame: Screen | null) => {
    // A delayed packet cannot consume a replacement receipt.
    if (screenPaste(id, sessionId, text) !== receipt) return;
    const kind = agent();
    const accepted = (kind ? canPasteScreen(kind, frame, receipt.emptyInput) : !receipt.emptyInput) && (receipt.canWrite?.() ?? true);
    recordScreenPaste(id, sessionId, text, accepted);
    if (accepted) paste();
  };
  const frame = read(id);
  if (!receipt.canWrite || !frame?.pending) { finish(frame); return; }

  // More PTY output can arrive during paste IPC. Use the next drained parse in the receiver so it
  // doesn't take another IPC round trip, and check that frame before touching xterm.
  receipt.waiting = new Promise<void>(resolve => {
    let off = () => {};
    let done = false;
    const complete = (current: Screen | null) => {
      if (done) return;
      done = true; clearTimeout(timer); off();
      finish(current); resolve();
    };
    const timer = setTimeout(() => complete(null), 2000);
    off = subscribe(id, current => { if (!current.pending) complete(current); });
    if (done) off();
  });
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
