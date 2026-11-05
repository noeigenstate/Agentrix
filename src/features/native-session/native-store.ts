// The native sessions the window knows, one entry per terminal. Events are subscribed first and a snapshot asked for after (contract §1): the
// events that arrive meanwhile wait and are folded on top of it, repeats drop by sequence, and a gap or an unknown session or connection
// epoch asks for one new snapshot. Entries outlive the view, so a card collapsed or remounted loses nothing.
import { useSyncExternalStore } from 'react';
import type { AgentEvent, NativeDraft, NativeHandoff, SwitchState } from '../../shared/agent-events';
import { nativeBridge } from './native-bridge.ts';
import { type NativeModel, applyEvents, emptyModel, fromSnapshot, isOver } from './native-model.ts';

export type NativeEntry = {
  model: NativeModel;
  // The session the owner closed the finished view of: a different session shows again.
  dismissed: string | null;
  // The notice of a switch to the terminal, dismissed by the owner.
  noteDismissed: boolean;
  // The draft the session this one replaced left for it (snapshot.handoff); taken once per change by `takeHandoff`.
  handoff: NativeHandoff | null;
};

const RESYNC_DELAY = 250;
// Events that mean the account's numbers may have changed, so the usage panel reads them again.
// A switch moving changes how many sessions Settings says are waiting.
const USAGE_EVENTS = new Set(['usage.updated', 'limits.updated', 'path.changed', 'turn.completed', 'switch.updated']);

let entries: ReadonlyMap<string, NativeEntry> = new Map(), usageRevision = 0, stopListening: (() => void) | null = null, dismissedSwitches: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>(), waiting = new Map<string, AgentEvent[]>(), loading = new Set<string>(), resyncing = new Set<string>(), takenHandoffs = new Map<string, number>();

function publish(terminalId: string, entry: NativeEntry) {
  entries = new Map(entries).set(terminalId, entry);
  listeners.forEach(listener => listener());
}

function bump() { usageRevision += 1; listeners.forEach(listener => listener()); }
// A change the main process already knows about (a key, a path, a budget): the usage card reads again without waiting for its timer.
export const usageChanged = bump;

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
  publish(terminalId, { model, dismissed: known?.dismissed ?? null, noteDismissed: same && (known?.noteDismissed ?? false), handoff: newHandoff(terminalId, result?.ok ? result.value?.handoff : undefined) ?? known?.handoff ?? null });
  if (again) resync(terminalId);
}

// A snapshot's handoff, unless this terminal already took that change's.
const newHandoff = (terminalId: string, handoff: NativeHandoff | undefined) => (handoff && takenHandoffs.get(terminalId) !== handoff.changeId ? handoff : null);

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
  // A change that has settled may have left a draft in the snapshot for this session to take.
  if (again || (!event.replay && event.type === 'switch.updated' && event.payload.phase === 'stable')) resync(terminalId);
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
  publish(terminalId, { model, dismissed: null, noteDismissed: false, handoff: null });
}

// Whether the terminal's card shows the native view: a session exists, the owner has not closed its finished view, and it was not moved to
// the terminal (then the terminal's own reading view takes the cell).
export const nativeShown = (entry: NativeEntry | undefined): entry is NativeEntry => !!entry?.model.identity && entry.model.identity.runtimeSessionId !== entry.dismissed && entry.model.path?.selected !== 'terminal';

// An item of the terminal's session as the window knows it right now (not as the last render saw it); undefined when there is none.
export const nativeItem = (terminalId: string, itemId: string) => entries.get(terminalId)?.model.items[itemId];

// Whether the terminal's native view already tells this sentence (the reason its session ended with, or its error), so a bar elsewhere need not say it again.
export const nativeTells = (entry: NativeEntry | undefined, text: string) => nativeShown(entry) && [entry.model.session?.reason, entry.model.error?.message].some(told => told === text);

// The reason a session was moved to the terminal, while the owner has not dismissed the notice.
export const terminalSwitch = (entry: NativeEntry | undefined) => (entry && !entry.noteDismissed && entry.model.path?.selected === 'terminal' ? entry.model.path : null);

// ── The run-mode switch ──
// Phases in the order a change goes through them: when two copies of one change differ, the later phase is the newer copy.
const PHASES: SwitchState['phase'][] = ['waiting-turn', 'awaiting-choice', 'waiting-background', 'preparing', 'switching', 'rolling-back', 'stable'];

// The one state a terminal's card shows. ProjectTerminal.switchState and the event stream's (switch.updated, snapshot.switchState) are the same
// state from main, seen at different moments: the newer change wins and, inside one change, the later phase. A finished session has none.
export function resolveSwitch(terminal: SwitchState | null | undefined, entry: NativeEntry | undefined): SwitchState | null {
  const events = entry && !isOver(entry.model) ? entry.model.switchState : null;
  if (!terminal || !events) return terminal ?? events;
  if (terminal.changeId !== events.changeId) return terminal.changeId > events.changeId ? terminal : events;
  return PHASES.indexOf(terminal.phase) > PHASES.indexOf(events.phase) ? terminal : events;
}

// A failed switch's note, closed by the owner for that change only: the next change's failure shows again.
const noteKey = (terminalId: string, state: SwitchState) => `${terminalId}/${state.changeId}`;
export const useSwitchNoteShown = (terminalId: string, state: SwitchState | null) => !useSyncExternalStore(subscribe, () => dismissedSwitches, () => dismissedSwitches).has(state ? noteKey(terminalId, state) : '');
export function dismissSwitchNote(terminalId: string, state: SwitchState) {
  dismissedSwitches = new Set(dismissedSwitches).add(noteKey(terminalId, state));
  listeners.forEach(listener => listener());
}

// The draft the previous session left for this terminal's new one, once per change: it is gone from the entry when taken and a later snapshot
// of the same change does not bring it back, so a remounted view never puts the same words back.
export function takeHandoff(terminalId: string): NativeDraft | null {
  const known = entries.get(terminalId), handoff = known?.handoff;
  if (!known || !handoff) return null;
  takenHandoffs.set(terminalId, handoff.changeId);
  publish(terminalId, { ...known, handoff: null });
  return handoff.draft;
}

// Tests: forget everything and stop listening.
export function disposeNativeStore() {
  stopListening?.(); stopListening = null;
  entries = new Map(); usageRevision = 0; dismissedSwitches = new Set(); waiting.clear(); loading.clear(); resyncing.clear(); takenHandoffs.clear(); listeners.clear();
}
