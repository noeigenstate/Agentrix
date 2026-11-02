// The sub-agent views the owner has opened beside a terminal's conversation: which ones are open, and how a view follows its
// agent. Transient (nothing is saved) and read-only: opening a view only reads the sub-agent's record through window.agentrix.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Result, SubagentFeed, SubagentFeedEvent } from '../../shared/types';

export type SubagentSplit = { terminalId: string; callId: string };
// At most two views per terminal: a third click replaces the oldest, so the conversation always keeps the larger share.
export const MAX_SPLITS = 2;
// A centre narrower than this has room for one view only.
export const NARROW_CENTRE = 600;
export const splitLimit = (centre: number) => centre < NARROW_CENTRE ? 1 : MAX_SPLITS;

let splits: readonly SubagentSplit[] = [];
const listeners = new Set<() => void>();
const publish = (next: readonly SubagentSplit[]) => { splits = next; listeners.forEach(listener => listener()); };
const same = (a: SubagentSplit, terminalId: string, callId: string) => a.terminalId === terminalId && a.callId === callId;

export const isSplitOpen = (open: readonly SubagentSplit[], terminalId: string, callId: string) => open.some(item => same(item, terminalId, callId));
export const splitsOf = (open: readonly SubagentSplit[], terminalId: string) => open.filter(item => item.terminalId === terminalId);

// Keeps the newest `limit` views of a terminal; the rest close.
export function limitSplits(terminalId: string, limit: number) {
  const mine = splitsOf(splits, terminalId), keep = mine.slice(mine.length - limit);
  if (mine.length > limit) publish(splits.filter(item => item.terminalId !== terminalId || keep.includes(item)));
}
export function openSplit(terminalId: string, callId: string, limit = MAX_SPLITS) {
  if (isSplitOpen(splits, terminalId, callId)) return;
  publish([...splits, { terminalId, callId }]);
  limitSplits(terminalId, limit);
}
export const closeSplit = (terminalId: string, callId: string) => publish(splits.filter(item => !same(item, terminalId, callId)));
export const toggleSplit = (terminalId: string, callId: string) => isSplitOpen(splits, terminalId, callId) ? closeSplit(terminalId, callId) : openSplit(terminalId, callId);

export const getSplits = () => splits;
export function subscribeSplits(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export const useSplits = () => useSyncExternalStore(subscribeSplits, getSplits, getSplits);

// ---- following one agent ------------------------------------------------------------------------------------------------------
// ok: the agent's record as last read. gone: the main process no longer keeps it (the view keeps what it has and says so).
// error: a read failed; the view keeps what it has and tries again at the next change.
export type FeedState = { feed: SubagentFeed | null; status: 'loading' | 'ok' | 'gone' | 'error'; error: string | null };
export const FEED_LOADING: FeedState = { feed: null, status: 'loading', error: null };

type FeedBridge = { subagentFeed(terminalId: string, callId: string): Promise<Result<SubagentFeed>>; onSubagentFeed(listener: (event: SubagentFeedEvent) => void): () => void };
const lastFeeds = new Map<string, SubagentFeed>();
const feedKey = (terminalId: string, callId: string) => `${terminalId}\n${callId}`;

// Reads the feed now and again whenever the main process says it moved to a newer revision. Only one read is in flight; a change that
// arrives meanwhile is read once it returns. A feed older than the one shown is ignored, and a gone feed ends the following.
export function followFeed(bridge: FeedBridge, terminalId: string, callId: string, onState: (state: FeedState) => void) {
  const key = feedKey(terminalId, callId), cached = lastFeeds.get(key) ?? null;
  let state: FeedState = cached ? { feed: cached, status: 'ok', error: null } : FEED_LOADING;
  let seen = cached?.revision ?? -1, wanted = seen, reading = false, stopped = false;
  const show = (next: FeedState) => { state = next; if (!stopped) onState(next); };
  const gone = () => state.status === 'gone';

  async function read() {
    if (reading || stopped || gone()) return;
    reading = true;
    try {
      do {
        const before = seen, result = await bridge.subagentFeed(terminalId, callId).catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
        if (result.ok) {
          if (result.value.revision >= seen) { seen = result.value.revision; lastFeeds.set(key, result.value); show({ feed: result.value, status: 'ok', error: null }); }
        } else show({ feed: state.feed, status: result.error === 'gone' ? 'gone' : 'error', error: result.error === 'gone' ? null : result.error });
        // Nothing newer came back: wait for the next change instead of asking again.
        if (seen === before) wanted = seen;
      } while (!stopped && !gone() && wanted > seen);
    } finally { reading = false; }
  }
  const stopListening = bridge.onSubagentFeed((event: SubagentFeedEvent) => {
    if (event.terminalId !== terminalId || event.callId !== callId || event.revision <= seen) return;
    wanted = Math.max(wanted, event.revision);
    void read();
  });
  onState(state);
  void read();
  return () => { stopped = true; stopListening(); };
}

// How many entries came after the last one the owner saw (the whole feed when that entry has scrolled out of it).
export function unreadAfter(entries: readonly { id: string }[], lastSeenId: string | null) {
  const index = lastSeenId === null ? -1 : entries.findIndex(entry => entry.id === lastSeenId);
  return entries.length - 1 - index;
}

export function useSubagentFeed(terminalId: string, callId: string) {
  const [state, setState] = useState<FeedState>(FEED_LOADING);
  useEffect(() => followFeed(window.agentrix, terminalId, callId, setState), [terminalId, callId]);
  return state;
}
