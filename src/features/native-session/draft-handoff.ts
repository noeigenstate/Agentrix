// The owner's draft across a run-mode switch (contract addendum). The view the session leaves offers its draft (words, pictures, messages main
// has not delivered); once the switch is preparing it goes to main in one answer, and only main's "accepted" shuts the old input — until then
// that input is untouched. The view that takes over finds the draft in its snapshot and puts it in the box. A draft is never sent by this
// file: the words go back to a box, undelivered messages come back as unsent for the owner to take, and a delivered message is not in it at all.
import { useCallback, useEffect, useRef, useState } from 'react';
import { nativeBridge, type NativeDraft, type NativeHandoffReceipt, type NativePendingInput, type SwitchState } from './native-bridge.ts';
import { resolveSwitch, takeHandoff, useNativeEntries } from './native-store.ts';

export type DraftOffer = { text: string; images: string[]; undelivered: NativePendingInput[] };
// A card nobody offers a draft for (the raw terminal has no message box) hands over this one, so its switch is never left waiting for a draft.
const NO_DRAFT: DraftOffer = { text: '', images: [], undelivered: [] };
// Main takes only these pictures; one it would refuse stays in its box, so it cannot stop the whole draft.
const TRANSFERABLE = /^data:image\/(png|jpeg|webp);base64,/;
const carriable = (draft: DraftOffer): DraftOffer => ({ ...draft, images: draft.images.filter(image => TRANSFERABLE.test(image)), undelivered: draft.undelivered.map(message => message.images ? { ...message, images: message.images.filter(image => TRANSFERABLE.test(image)) } : message) });

// What a view reads and calls. `offer` states the draft as it is now (call it when it changes); `incoming` is a draft waiting for this view,
// `take` hands it over once; `locked` is true while main has the draft and the switch is still going.
export type Handoff = { locked: boolean; offer(draft: DraftOffer): void; incoming: NativeDraft | null; take(): NativeDraft | null };

const receiptOf = (value: unknown): NativeHandoffReceipt | null => {
  const found = value as Partial<NativeHandoffReceipt> | null;
  return typeof found?.changeId === 'number' && typeof found.version === 'number' && typeof found.accepted === 'boolean' ? found as NativeHandoffReceipt : null;
};

export function useHandoff(terminalId: string, sessionId: string | null, switchState: SwitchState | null | undefined, surface?: SwitchState['current'] | null): Handoff {
  const entry = useNativeEntries().get(terminalId), state = resolveSwitch(switchState, entry);
  const changeId = state?.phase === 'preparing' ? state.changeId : null;
  // Events can arrive before the workspace broadcast changes its runtime id. Use the binding of this change,
  // and retry when that binding catches up rather than waiting for another switch-state event.
  const runtimeId = (entry?.model.switchState?.changeId === state?.changeId ? entry?.model.identity?.runtimeSessionId : null)
    ?? sessionId ?? entry?.model.identity?.runtimeSessionId ?? terminalId;
  // The offered draft is kept in a ref, so typing does not render the parent; each change of it is a new version (main says which it accepted),
  // and only while preparing does a change wake the sender below.
  const offered = useRef<{ draft: DraftOffer; version: number }>({ draft: NO_DRAFT, version: 0 }), preparing = useRef(false), sent = useRef('');
  const [accepted, setAccepted] = useState<number | null>(null), [edits, edited] = useState(0);
  preparing.current = changeId !== null;
  const offer = useCallback((draft: DraftOffer) => {
    const known = offered.current, next = carriable(draft);
    if (JSON.stringify(known.draft) === JSON.stringify(next)) return;
    offered.current = { draft: next, version: known.version + 1 };
    if (preparing.current) edited(count => count + 1);
  }, []);
  // Sent once per version while preparing; one main did not accept is offered again with the next update of the switch.
  useEffect(() => {
    const bridge = nativeBridge(), current = offered.current;
    if (changeId === null || accepted === changeId || !bridge) return;
    const key = `${runtimeId}/${changeId}/${current.version}`;
    if (sent.current === key) return;
    sent.current = key;
    void bridge.answer(terminalId, runtimeId, `handoff-${changeId}`, { handoff: { changeId, draft: { version: current.version, ...current.draft } } })
      .then(result => {
        if (sent.current !== key) return;
        const receipt = result.ok ? receiptOf(result.value) : null;
        if (receipt?.accepted && receipt.changeId === changeId && receipt.version === offered.current.version) setAccepted(changeId);
        else if (!receipt?.accepted) sent.current = '';
      }).catch(() => { if (sent.current === key) sent.current = ''; });
  }, [changeId, runtimeId, accepted, state, edits]);
  const locked = !!state && (state.phase === 'preparing' || state.phase === 'switching') && accepted === state.changeId;
  // A snapshot can already contain the outgoing draft while its source is still mounted. Only the committed
  // destination (or the original surface after failure) may take it. An older handoff can arrive during the next change.
  const incoming = entry?.handoff && (!state || (surface == null || surface === state.current)
    && (state.phase === 'stable' || entry.handoff.changeId < state.changeId)) ? entry.handoff.draft : null;
  return { locked, offer, incoming, take: () => incoming ? takeHandoff(terminalId) : null };
}
