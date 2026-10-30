import type { ConversationEntry } from '../../shared/types';

type Identity = { id: string; at: number; user?: string };
type EntryIdentity = { turn: Identity; tools?: Identity };
// Retained objects carry page-boundary identity; the WeakMap reconciles overlaps without a growing ID registry.
const identities = new WeakMap<ConversationEntry, EntryIdentity>();
export const timelineIdentity = (entry: ConversationEntry) => identities.get(entry) ?? entry.timeline;

// Reconcile before trimming the buffer. Overlapping IDs preserve both append and full-snapshot identities;
// a prepended part of the same turn inherits its already visible parent instead of remounting it.
export function retainTimelineIdentity(previous: readonly ConversationEntry[], incoming: readonly ConversationEntry[]): ConversationEntry[] {
  const known = new Map(previous.map(entry => [entry.id, timelineIdentity(entry)]));
  for (const entry of incoming) if (!known.has(entry.id) && entry.timeline) known.set(entry.id, entry.timeline);
  // Also support an unannotated initial caller, without changing its objects.
  if (previous.length && !previous.some(entry => identities.has(entry))) {
    for (const entry of retainTimelineIdentity([], previous)) known.set(entry.id, identities.get(entry));
  }
  const result = [...incoming], claimed = new Set<string>();
  let user: string | undefined;
  for (let start = 0; start < incoming.length;) {
    const first = incoming[start];
    if (first.queued || first.role === 'user') { if (!first.queued) user = first.id; start++; continue; }
    let end = start + 1;
    while (end < incoming.length && (incoming[end].queued || incoming[end].role !== 'user')) end++;
    const run = incoming.slice(start, end).filter(entry => !entry.queued);
    const existing = run.map(entry => known.get(entry.id)?.turn).find(turn => turn && !claimed.has(turn.id) && (!user || !turn.user || turn.user === user));
    const oldFirst = known.get(first.id)?.turn;
    const freshId = oldFirst?.id === first.id ? JSON.stringify(['turn', user, first.id]) : first.id;
    const turn = existing ? (user && !existing.user ? { ...existing, user } : existing) : { id: freshId, at: first.at, user };
    claimed.add(turn.id);
    let tools: Identity | undefined;
    const claimedTools = new Set<string>();
    for (let index = start; index < end; index++) {
      const entry = incoming[index];
      if (entry.queued) continue;
      if (entry.role === 'tool' && !tools) {
        let stop = index + 1;
        while (stop < end && (incoming[stop].queued || incoming[stop].role === 'tool')) stop++;
        const old = incoming.slice(index, stop).map(item => known.get(item.id)).find(item => item?.turn.id === turn.id && item.tools && !claimedTools.has(item.tools.id));
        tools = old?.tools ?? { id: entry.id, at: entry.at };
        claimedTools.add(tools.id);
      } else if (entry.role !== 'tool') tools = undefined;
      const old = identities.get(entry);
      if (old?.turn === turn && old.tools === tools) continue;
      const copy = { ...entry };
      identities.set(copy, { turn, tools }); result[index] = copy;
    }
    start = end;
  }
  return result;
}
