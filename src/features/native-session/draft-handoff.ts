// The owner's draft across a run-mode switch (contract addendum). The view the session leaves offers its draft (words, pictures, messages main
// has not delivered); once the switch is preparing it goes to main in one answer, and only main's "accepted" shuts the old input — until then
// that input is untouched. The view that takes over finds the draft in its snapshot and puts it in the box. A draft is never sent by this
// file: the words go back to a box, undelivered messages come back as unsent for the owner to take, and a delivered message is not in it at all.
import { useCallback, useEffect, useRef, useState } from 'react';
import { nativeBridge, type NativeDraft, type NativeHandoffReceipt, type NativePendingInput, type SwitchState } from './native-bridge.ts';
import { resolveSwitch, takeHandoff, useNativeEntries } from './native-store.ts';

export type DraftOffer = { text: string; images: string[]; undelivered: NativePendingInput[] };

// What a view reads and calls. `offer` states the draft as it is now (call it when it changes); `incoming` is a draft waiting for this view,
// `take` hands it over once; `locked` is true while main has the draft and the switch is still going.
export type Handoff = { locked: boolean; offer(draft: DraftOffer): void; incoming: NativeDraft | null; take(): NativeDraft | null };

const receiptOf = (value: unknown): NativeHandoffReceipt | null => {
  const found = value as Partial<NativeHandoffReceipt> | null;
  return typeof found?.changeId === 'number' && typeof found.version === 'number' && typeof found.accepted === 'boolean' ? found as NativeHandoffReceipt : null;
};

export function useHandoff(terminalId: string, sessionId: string | null, switchState: SwitchState | null | undefined): Handoff {
  const entry = useNativeEntries().get(terminalId), state = resolveSwitch(switchState, entry);
  const changeId = state?.phase === 'preparing' ? state.changeId : null;
  // The offered draft is kept in a ref, so typing does not render the parent; each change of it is a new version (main says which it accepted),
  // and only while preparing does a change wake the sender below.
  const offered = useRef<{ draft: DraftOffer; version: number } | null>(null), preparing = useRef(false), sent = useRef('');
  const [accepted, setAccepted] = useState<number | null>(null), [edits, edited] = useState(0);
  preparing.current = changeId !== null;
  const offer = useCallback((draft: DraftOffer) => {
    const known = offered.current;
    if (known && JSON.stringify(known.draft) === JSON.stringify(draft)) return;
    offered.current = { draft, version: (known?.version ?? 0) + 1 };
    if (preparing.current) edited(count => count + 1);
  }, []);
  // Sent once per version while preparing; one main did not accept is offered again with the next update of the switch.
  useEffect(() => {
    const bridge = nativeBridge(), current = offered.current;
    if (changeId === null || !current || accepted === changeId || !bridge) return;
    const key = `${changeId}/${current.version}`;
    if (sent.current === key) return;
    sent.current = key;
    void bridge.answer(terminalId, sessionId ?? terminalId, `handoff-${changeId}`, { handoff: { changeId, draft: { version: current.version, ...current.draft } } })
      .then(result => {
        const receipt = result.ok ? receiptOf(result.value) : null;
        if (receipt?.accepted && receipt.changeId === changeId && receipt.version === offered.current?.version) setAccepted(changeId);
        else if (!receipt?.accepted) sent.current = '';
      }).catch(() => { sent.current = ''; });
  }, [changeId, accepted, state, edits]);
  const locked = !!state && (state.phase === 'preparing' || state.phase === 'switching') && accepted === state.changeId;
  return { locked, offer, incoming: entry?.handoff?.draft ?? null, take: () => takeHandoff(terminalId) };
}
