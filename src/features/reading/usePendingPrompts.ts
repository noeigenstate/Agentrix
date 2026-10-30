import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import type { ConversationEntry } from '../../shared/types';
import { addPendingPrompt, createPendingPrompts, PENDING_PROMPT_TIMEOUT, reconcilePendingPrompts, removePendingPrompt, type PendingPrompts } from './pending-prompts';

type Slot = { state: PendingPrompts; threadId?: string; listeners: Set<() => void>; timer?: ReturnType<typeof setTimeout> };
// Keep an unconfirmed message when the reader temporarily switches to the CLI.
const terminals = new Map<string, Slot>();

function slotFor(id: string, sessionId: string | null, threadId?: string): Slot {
  let slot = terminals.get(id);
  if (!slot || slot.state.sessionId !== sessionId || threadId && slot.threadId && slot.threadId !== threadId) {
    clearTimeout(slot?.timer);
    slot = { state: createPendingPrompts(sessionId), threadId, listeners: new Set() };
    terminals.set(id, slot);
  }
  if (threadId) slot.threadId = threadId;
  return slot;
}

function update(slot: Slot, state: PendingPrompts) {
  if (slot.state === state) return;
  slot.state = state;
  clearTimeout(slot.timer); slot.timer = undefined;
  const next = Math.min(...state.prompts.filter(prompt => prompt.sending).map(prompt => prompt.at + PENDING_PROMPT_TIMEOUT));
  if (Number.isFinite(next)) slot.timer = setTimeout(() => update(slot, reconcilePendingPrompts(slot.state, state.sessionId, [], Date.now())), Math.max(0, next - Date.now()));
  slot.listeners.forEach(listener => listener());
}

export function usePendingPrompts(id: string, sessionId: string | null, entries: readonly ConversationEntry[], threadId?: string) {
  const slot = slotFor(id, sessionId, threadId);
  const snapshot = useSyncExternalStore(listener => { slot.listeners.add(listener); return () => { slot.listeners.delete(listener); }; }, () => slot.state);
  // Derive before paint so an incoming record never renders alongside its echo.
  const state = useMemo(() => reconcilePendingPrompts(snapshot, sessionId, entries, Date.now()), [snapshot, sessionId, entries]);
  useLayoutEffect(() => { update(slot, state); }, [slot, state]);
  const echo = (text: string, images: string[] = []) => {
    const promptId = `pending:${crypto.randomUUID()}`;
    update(slot, addPendingPrompt(reconcilePendingPrompts(slot.state, sessionId, entries, Date.now()), promptId, text, Date.now(), images));
    return promptId;
  };
  return { pending: state.prompts, echo, cancelEcho: (promptId: string) => update(slot, removePendingPrompt(slot.state, promptId)) };
}
