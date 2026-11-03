// The native sessions the window knows, one entry per terminal. Events are subscribed first and a snapshot asked for after (contract §1): the
// events that arrive meanwhile wait and are folded on top of it, repeats drop by sequence, and a gap or an unknown session or connection
// epoch asks for one new snapshot. Entries outlive the view, so a card collapsed or remounted loses nothing.
import { useSyncExternalStore } from 'react';
import type { AgentEvent } from '../../shared/agent-events';
import { nativeBridge } from './native-bridge.ts';
import { type NativeModel, applyEvents, emptyModel, fromSnapshot } from './native-model.ts';

export type NativeEntry = {
  model: NativeModel;
  // The session the owner closed the finished view of: a different session shows again.
  dismissed: string | null;
  // The notice of a switch to the terminal, dismissed by the owner.
  noteDismissed: boolean;
};

const RESYNC_DELAY = 250;
// Events that mean the account's numbers may have changed, so the usage panel reads them again.
const USAGE_EVENTS = new Set(['usage.updated', 'limits.updated', 'path.changed', 'turn.completed']);

let entries: ReadonlyMap<string, NativeEntry> = new Map(), usageRevision = 0, stopListening: (() => void) | null = null;
const listeners = new Set<() => void>(), waiting = new Map<string, AgentEvent[]>(), loading = new Set<string>(), resyncing = new Set<string>();

function publish(terminalId: string, entry: NativeEntry) {
  entries = new Map(entries).set(terminalId, entry);
  listeners.forEach(listener => listener());
}

function bump() { usageRevision += 1; listeners.forEach(listener => listener()); }

function resync(terminalId: string) {
  if (resyncing.has(terminalId)) return;
  resyncing.add(terminalId);
  setTimeout(() => { resyncing.delete(terminalId); void load(terminalId); }, RESYNC_DELAY);
}

async function load(terminalId: string) {
  const bridge = nativeBridge();
  if (!bridge || loading.has(terminalId)) return;
  loading.add(terminalId);
  const result = await bridge.snapshot(terminalId).catch(() => null);
  loading.delete(terminalId);
  const known = entries.get(terminalId), asked = waiting.get(terminalId) ?? [];
  waiting.delete(terminalId);
  const base = result?.ok && result.value ? fromSnapshot(result.value) : known?.model ?? emptyModel();
  const { model, resync: again } = applyEvents(base, asked);
  const same = !!known && known.model.identity?.runtimeSessionId === model.identity?.runtimeSessionId;
  publish(terminalId, { model, dismissed: known?.dismissed ?? null, noteDismissed: same && (known?.noteDismissed ?? false) });
  if (again) resync(terminalId);
}

function onEvent(event: AgentEvent) {
  const terminalId = event.terminalId, known = entries.get(terminalId);
  if (!event.replay && USAGE_EVENTS.has(event.type)) bump();
  if (!known || loading.has(terminalId)) {
    waiting.set(terminalId, [...waiting.get(terminalId) ?? [], event]);
    void load(terminalId);
    return;
  }
  const { model, resync: again } = applyEvents(known.model, [event]);
  publish(terminalId, { ...known, model });
  if (again) resync(terminalId);
}

function listen() {
  if (!stopListening) stopListening = nativeBridge()?.onEvent(onEvent) ?? null;
}

function subscribe(listener: () => void) {
  listeners.add(listener); listen();
  return () => { listeners.delete(listener); };
}

// Every terminal's entry; the map is replaced, never changed, so a component re-renders when it does.
export const useNativeEntries = () => useSyncExternalStore(subscribe, () => entries, () => entries);
export const useUsageRevision = () => useSyncExternalStore(subscribe, () => usageRevision, () => usageRevision);

// Asks once for a terminal's session, if the window has not heard of it: a window opened onto sessions that already run.
export function ensureNativeSession(terminalId: string) {
  listen();
  if (!entries.has(terminalId)) void load(terminalId);
}

// Asks again, for a session just started (its first events may have come before anyone listened).
export function refreshNativeSession(terminalId: string) {
  listen();
  void load(terminalId);
}

const keep = (terminalId: string, change: (entry: NativeEntry) => NativeEntry) => {
  const known = entries.get(terminalId);
  if (known) publish(terminalId, change(known));
};

// The owner is done with a finished session's view: the launcher comes back until a new session starts there.
export const dismissNative = (terminalId: string) => keep(terminalId, entry => ({ ...entry, dismissed: entry.model.identity?.runtimeSessionId ?? null }));
export const dismissNote = (terminalId: string) => keep(terminalId, entry => ({ ...entry, noteDismissed: true }));

// A switch to the terminal the window itself decided on (no key saved): the same notice as one the main process reports.
export function noteTerminalSwitch(terminalId: string, reason: string) {
  const model = { ...emptyModel(), path: { previous: 'api', selected: 'terminal', reason, at: Date.now() } };
  publish(terminalId, { model, dismissed: null, noteDismissed: false });
}

// Whether the terminal's card shows the native view: a session exists, the owner has not closed its finished view, and it was not moved to
// the terminal (then the terminal's own reading view takes the cell).
export const nativeShown = (entry: NativeEntry | undefined): entry is NativeEntry => !!entry?.model.identity && entry.model.identity.runtimeSessionId !== entry.dismissed && entry.model.path?.selected !== 'terminal';

// The reason a session was moved to the terminal, while the owner has not dismissed the notice.
export const terminalSwitch = (entry: NativeEntry | undefined) => (entry && !entry.noteDismissed && entry.model.path?.selected === 'terminal' ? entry.model.path : null);

// Tests: forget everything and stop listening.
export function disposeNativeStore() {
  stopListening?.(); stopListening = null;
  entries = new Map(); usageRevision = 0; waiting.clear(); loading.clear(); resyncing.clear(); listeners.clear();
}
