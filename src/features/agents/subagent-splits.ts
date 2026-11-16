// The sub-agent views the owner has opened beside a terminal's conversation: which ones are open, and how a view follows its
// agent. Transient (nothing is saved) and read-only: opening a view only reads the sub-agent's record through window.agentrix.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AgentCall, ProjectTerminal, Result, SubagentFeed, SubagentFeedEvent } from '../../shared/types';

export type SubagentSplit = { terminalId: string; callId: string };

// The feed each view last read, so a view opened again shows it at once; dropped when the view closes or its terminal goes.
const lastFeeds = new Map<string, SubagentFeed>();
const feedKey = (terminalId: string, callId: string) => JSON.stringify([terminalId, callId]);
let splits: readonly SubagentSplit[] = [];
const listeners = new Set<() => void>();
const publish = (next: readonly SubagentSplit[]) => { splits = next; listeners.forEach(listener => listener()); };
const same = (a: SubagentSplit, terminalId: string, callId: string) => a.terminalId === terminalId && a.callId === callId;

export const isSplitOpen = (open: readonly SubagentSplit[], terminalId: string, callId: string) => open.some(item => same(item, terminalId, callId));
export const splitsOf = (open: readonly SubagentSplit[], terminalId: string) => open.filter(item => item.terminalId === terminalId);

// The calls the owner's lists show (the Agent tab, and the narrow window's chip with its count): a call main has hidden (it ended and no process keeps it)
// is left out unless its view is open beside the conversation, and a model whose calls are all hidden has no entry; one that never had a call keeps its head.
export const listedCalls = (calls: readonly AgentCall[], open: readonly SubagentSplit[], terminalId: string) =>
  calls.map(call => ({ call, items: call.items.filter(item => !item.hidden || isSplitOpen(open, terminalId, item.id)) })).filter(group => group.items.length || !group.call.items.length);

// ---- the project's Agent tab ------------------------------------------------------------------------------------------------
// What the other lanes add to the records, read here as optional fields so this compiles before their types merge (D1: state 'starting' and notice;
// the dispatcher: source 'intercepted' for a worker a script started by itself, and resumed / awaiting for a continued worker and one waiting for the owner;
// the background lane: agentUsage.background). A record without them reads as before.
export type RowState = AgentCall['items'][number]['state'] | 'starting';
export type RowItem = Omit<AgentCall['items'][number], 'state'> & { state: RowState; notice?: 'unconfirmed'; source?: string; resumed?: boolean; awaiting?: 'owner' };
export type BackgroundTask = { id: string; command: string; terminalId: string; startedAt: number; lastOutputAt?: number; endedAt?: number; state: 'running' | 'done'; exitCode?: number | null; tail?: string[] | string };
// The last lines of a task's output. The contract is string[]; one string (what 1.5.1's main sent) is split, and anything else reads as no output, so a bad payload never throws in a render.
export function backgroundTail(task: BackgroundTask | undefined): string[] {
  const tail: unknown = task?.tail;
  if (typeof tail === 'string') return tail ? tail.split('\n') : [];
  return Array.isArray(tail) ? tail.filter((line): line is string => typeof line === 'string') : [];
}
export const backgroundOf = (terminal: ProjectTerminal): readonly BackgroundTask[] => (terminal.agentUsage as { background?: BackgroundTask[] } | null | undefined)?.background ?? [];

// A background task opens in the same split slot as a call, under a call id of its own.
const BACKGROUND_PREFIX = 'background:';
export const backgroundCallId = (id: string) => BACKGROUND_PREFIX + id;
export const isBackgroundCall = (callId: string) => callId.startsWith(BACKGROUND_PREFIX);
export const backgroundTaskOf = (terminal: ProjectTerminal | undefined, callId: string) => terminal ? backgroundOf(terminal).find(task => backgroundCallId(task.id) === callId) : undefined;

// A terminal of the project, named by its own title (终端 1, 终端 2…, as the decision inbox and the split labels say), else by its place there.
export type CallSource = { id: string; number: number; title?: string; calls: readonly AgentCall[]; background: readonly BackgroundTask[] };
export const callSources = (terminals: readonly ProjectTerminal[]): CallSource[] => terminals.map((terminal, index) => ({ id: terminal.id, number: index + 1, title: terminal.title, calls: terminal.agentUsage?.calls ?? [], background: backgroundOf(terminal) }));

export type CallRow = { item: RowItem; terminalId: string; number: number; title?: string; call: AgentCall };
export type BackgroundRow = { task: BackgroundTask; terminalId: string; number: number; title?: string };
export type RecentEntry = { at: number; call?: CallRow; background?: BackgroundRow };
export type ProjectGroup = { call: AgentCall; rate: AgentCall['rate']; rows: CallRow[] };
export const RECENT_KEEP = 10, RECENT_MAX_AGE_MS = 30 * 60 * 1000;
export const modelKey = (call: AgentCall) => JSON.stringify([call.agent, call.provider, call.model, call.modelUnconfirmed, call.effort, call.fast]);
export const backgroundEnd = (task: BackgroundTask) => task.endedAt ?? task.lastOutputAt ?? task.startedAt;

// Every terminal's calls of the project, grouped by model (the first record's head, the first known rate), the running background tasks, and the last finished ones.
// A hidden live call is left out unless its view is open (as in listedCalls); a finished call is listed under 最近完成 hidden or not (main hides a call as soon as it ends). With separateDone off (a single terminal's card) a finished call stays in its group.
export function projectCalls(sources: readonly CallSource[], open: readonly SubagentSplit[], now: number, separateDone = true) {
  const groups = new Map<string, ProjectGroup>(), recent: RecentEntry[] = [];
  for (const source of sources) for (const call of source.calls) {
    const key = modelKey(call);
    let group = groups.get(key);
    if (!group) groups.set(key, group = { call, rate: call.rate, rows: [] });
    else if (group.rate == null && call.rate != null) group.rate = call.rate;
    for (const item of call.items as RowItem[]) {
      const row = { item, terminalId: source.id, number: source.number, title: source.title, call };
      if (separateDone && item.state === 'done') { recent.push({ at: item.endedAt ?? now, call: row }); continue; }
      if (item.hidden && !isSplitOpen(open, source.id, item.id)) continue;
      group.rows.push(row);
    }
  }
  const background: BackgroundRow[] = [];
  for (const source of sources) for (const task of source.background) {
    if (task.state === 'running') background.push({ task, terminalId: source.id, number: source.number, title: source.title });
    else recent.push({ at: backgroundEnd(task), background: { task, terminalId: source.id, number: source.number, title: source.title } });
  }
  // A model whose calls are all listed under 最近完成 (or hidden) has no head here; one that never had a call keeps its head.
  const listed = [...groups.values()].filter(group => group.rows.length || !group.call.items.length);
  const kept = recent.filter(entry => now - entry.at <= RECENT_MAX_AGE_MS).sort((a, b) => b.at - a.at).slice(0, RECENT_KEEP);
  return { groups: listed, background, recent: kept };
}
export const countRunning = (sources: readonly CallSource[]) => sources.reduce((sum, source) => sum + source.calls.reduce((inner, call) => inner + call.items.filter(item => item.state === 'running' || (item.state as RowState) === 'starting').length, 0), 0);
export const countBackground = (terminals: readonly ProjectTerminal[]) => terminals.reduce((sum, terminal) => sum + backgroundOf(terminal).filter(task => task.state === 'running').length, 0);

// One clock for every card, read by the second and ticking while a card is on screen (the elapsed times and "last output N s ago" move with it).
let clock = 0, clockTimer: ReturnType<typeof setInterval> | undefined;
const clockListeners = new Set<() => void>();
const thisSecond = () => Math.floor(Date.now() / 1000) * 1000;
export function subscribeClock(listener: () => void) {
  if (!clockListeners.size) { clock = thisSecond(); clockTimer = setInterval(() => { clock = thisSecond(); clockListeners.forEach(notify => notify()); }, 1000); }
  clockListeners.add(listener);
  return () => { clockListeners.delete(listener); if (!clockListeners.size) { clearInterval(clockTimer); clockTimer = undefined; } };
}
export const getClock = () => clockTimer ? clock : thisSecond();
const noSubscription = () => () => {};
// `live` is whether anything on screen moves with the second (a running background row, a 再等等 timer); without it the card only re-reads the clock when it re-renders.
export const useClock = (live = true) => useSyncExternalStore(live ? subscribeClock : noSubscription, getClock, getClock);
export const hasWaitTimer = (now: number) => [...waited.values()].some(until => until > now);

// Small UI state of the cards, one version number so a change redraws them: whether 「最近完成」 is unfolded (per project, keyed by its first terminal; the Agent tab and the narrow window's popover share it)
// and where a 停止 stands (sent and not answered, or refused with the reason).
let uiVersion = 0;
const finished = new Set<string>(), stopping = new Map<string, { pending: boolean; refusal?: string }>();
const uiListeners = new Set<() => void>();
const touch = () => { uiVersion++; uiListeners.forEach(listener => listener()); };
export const useUiVersion = () => useSyncExternalStore(listener => { uiListeners.add(listener); return () => { uiListeners.delete(listener); }; }, () => uiVersion, () => uiVersion);
export const isFinishedOpen = (projectKey: string) => finished.has(projectKey);
export const toggleFinished = (projectKey: string) => { if (!finished.delete(projectKey)) finished.add(projectKey); touch(); };
export const stopState = (terminalId: string, callId: string) => stopping.get(feedKey(terminalId, callId));
export const setStopState = (terminalId: string, callId: string, state: { pending: boolean; refusal?: string } | null) => { if (state) stopping.set(feedKey(terminalId, callId), state); else stopping.delete(feedKey(terminalId, callId)); touch(); };

// 再等等 hides a starting worker's notice until another 15 s have passed (the card re-reads the clock every second).
const WAIT_MORE_MS = 15000;
const waited = new Map<string, number>();
export const noticeKey = (terminalId: string, callId: string) => feedKey(terminalId, callId);
export const waitMore = (terminalId: string, callId: string, now = Date.now()) => { waited.set(noticeKey(terminalId, callId), now + WAIT_MORE_MS); };
export const noticeShown = (terminalId: string, item: RowItem, now: number) => item.state === 'starting' && item.notice === 'unconfirmed' && now >= (waited.get(noticeKey(terminalId, item.id)) ?? 0);

// A terminal has one view beside its conversation, at any width: opening another sub-agent replaces it (and drops the feed kept for it).
export function openSplit(terminalId: string, callId: string) {
  if (isSplitOpen(splits, terminalId, callId)) return;
  for (const replaced of splitsOf(splits, terminalId)) lastFeeds.delete(feedKey(terminalId, replaced.callId));
  publish([...splits.filter(item => item.terminalId !== terminalId), { terminalId, callId }]);
}
export function closeSplit(terminalId: string, callId: string) {
  lastFeeds.delete(feedKey(terminalId, callId));
  publish(splits.filter(item => !same(item, terminalId, callId)));
}
// Terminals the workspace no longer has: their views close and the feeds kept for reopening are dropped.
export function pruneSplits(live: ReadonlySet<string>) {
  for (const key of lastFeeds.keys()) if (!live.has(JSON.parse(key)[0])) lastFeeds.delete(key);
  for (const key of [...waited.keys(), ...stopping.keys()]) if (!live.has(JSON.parse(key)[0])) { waited.delete(key); stopping.delete(key); }
  for (const key of [...finished]) if (!live.has(key)) finished.delete(key);
  if (splits.some(item => !live.has(item.terminalId))) publish(splits.filter(item => live.has(item.terminalId)));
}
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
// A word sent to a dispatched worker is delivered once its resumed transcript opens with 「业主插话：」 and the word; the same word sent twice
// needs two such lines. A word relayed through the parent session leaves no trace in the worker's record, so it is never reported delivered.
export function deliveredIds(entries: readonly { role: string; clientMessageId?: string; sender?: { kind: string } }[], sent: readonly { id: string; text: string; route: string }[]) {
  const received = new Set(entries.filter(entry => entry.role === 'user' && entry.sender?.kind === 'owner').map(entry => entry.clientMessageId));
  return new Set(sent.filter(item => item.route === 'dispatch' && received.has(item.id)).map(item => item.id));
}

export function unreadAfter(entries: readonly { id: string }[], lastSeenId: string | null) {
  const index = lastSeenId === null ? -1 : entries.findIndex(entry => entry.id === lastSeenId);
  return entries.length - 1 - index;
}

export function useSubagentFeed(terminalId: string, callId: string) {
  const [state, setState] = useState<FeedState>(FEED_LOADING);
  useEffect(() => followFeed(window.agentrix, terminalId, callId, setState), [terminalId, callId]);
  return state;
}
