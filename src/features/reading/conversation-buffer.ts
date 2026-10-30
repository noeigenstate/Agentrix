import type { ConversationEntry, ConversationPacket } from '../../shared/types';
import { retainTimelineIdentity } from './reading-timeline-identity.ts';

export function applyConversationPacket(entries: readonly ConversationEntry[], packet: Pick<ConversationPacket, 'list' | 'changes'>, paged = false): ConversationEntry[] {
  if (packet.list && !paged) return retainTimelineIdentity(entries, packet.list).slice(-400);
  const next = [...entries];
  const indices = new Map(next.map((entry, index) => [entry.id, index]));
  const list = packet.list;
  // A live resync may contain older entries outside our page. Only overlapping updates and its new suffix belong here.
  let overlap = -1;
  list?.forEach((entry, index) => { if (indices.has(entry.id)) overlap = index; });
  const incoming = list ? list.filter((entry, index) => indices.has(entry.id) || index > overlap) : packet.changes ?? [];
  for (const entry of incoming) {
    const at = indices.get(entry.id);
    if (at === undefined) { indices.set(entry.id, next.length); next.push(entry); }
    else next[at] = entry;
  }
  const result = retainTimelineIdentity(entries, next);
  return paged ? result : result.slice(-400);
}

// The initial IPC snapshot is the base; events received while it is in flight follow it.
// A fixed window bounds latency even when packets keep arriving during a working turn.
const DELAY = 50;
export function createConversationBuffer(apply: (entries: ConversationEntry[]) => void, paged = false) {
  let entries: ConversationEntry[] = [], waiting = true, disposed = false;
  let queued: Pick<ConversationPacket, 'list' | 'changes'>[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (waiting || disposed || timer !== null) return;
    timer = setTimeout(() => { timer = null; apply(entries); }, DELAY);
  };
  return {
    snapshot(initial: ConversationEntry[]) {
      if (disposed) return;
      entries = retainTimelineIdentity([], initial);
      if (!paged) entries = entries.slice(-400);
      for (const packet of queued) entries = applyConversationPacket(entries, packet, paged);
      queued = []; waiting = false; schedule();
    },
    push(packet: Pick<ConversationPacket, 'list' | 'changes'>) {
      if (disposed) return;
      if (waiting) queued.push(packet);
      else { entries = applyConversationPacket(entries, packet, paged); schedule(); }
    },
    prepend(older: ConversationEntry[]) {
      if (disposed || waiting) return;
      const ids = new Set(entries.map(entry => entry.id));
      entries = retainTimelineIdentity(entries, [...older.filter(entry => !ids.has(entry.id)), ...entries]);
      apply(entries);
    },
    refresh(initial: ConversationEntry[]) {
      if (disposed || waiting) return;
      entries = applyConversationPacket(initial, { list: entries }, true);
      apply(entries);
    },
    dispose() { disposed = true; queued = []; if (timer !== null) clearTimeout(timer); timer = null; },
  };
}
