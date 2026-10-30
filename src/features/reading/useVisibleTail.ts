import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ConversationEntry } from '../../shared/types';
import { timelineIdentity } from './reading-timeline-identity.ts';
import { conversationBlocks } from '../../shared/conversation-blocks.mjs';

type ConversationBlock = { kind: 'message'; entry: ConversationEntry } | { kind: 'tools'; id: string; entries: ConversationEntry[] };
type AgentTurn = { kind: 'agent'; id: string; at: number; blocks: ConversationBlock[] };
type ConversationTurn = { kind: 'user'; entry: ConversationEntry } | AgentTurn;
export const VISIBLE_TAIL_PAGE = 40;
export const blockId = (block: ConversationBlock) => block.kind === 'message' ? block.entry.id : block.id;

// Slice after grouping: consecutive tools count as one reading block.
export function blocks(entries: readonly ConversationEntry[]): ConversationBlock[] {
  return conversationBlocks(entries).map(group => group[0].role === 'tool'
    ? { kind: 'tools', id: timelineIdentity(group[0])?.tools?.id ?? group[0].id, entries: group }
    : { kind: 'message', entry: group[0] });
}

// Page by content blocks, then nest the visible ones in turns. Read the prefix only for parent identity/time:
// revealing earlier content in the same turn must not remount its tools or change the agent's timestamp.
export function conversationTurns(grouped: readonly ConversationBlock[], start = 0): ConversationTurn[] {
  const result: ConversationTurn[] = [];
  let agent: AgentTurn | undefined;
  grouped.forEach((block, index) => {
    if (block.kind === 'message' && block.entry.role === 'user') {
      agent = undefined;
      if (index >= start) result.push({ kind: 'user', entry: block.entry });
    } else {
      if (!agent) {
        const entry = block.kind === 'tools' ? block.entries[0] : block.entry;
        const identity = timelineIdentity(entry)?.turn;
        agent = { kind: 'agent', id: identity?.id ?? blockId(block), at: identity?.at ?? entry.at, blocks: [] };
      }
      if (index >= start) {
        if (!agent.blocks.length) result.push(agent);
        agent.blocks.push(block);
      }
    }
  });
  return result;
}

export function visibleTail<T>(items: readonly T[], count = VISIBLE_TAIL_PAGE, anchor?: (item: T) => boolean) {
  const anchored = anchor ? items.findIndex(anchor) : -1;
  const start = anchored >= 0 ? anchored : Math.max(0, items.length - count);
  return { visible: items.slice(start), earlier: start };
}

export function prependScrollTop(top: number, beforeHeight: number, afterHeight: number) { return top + afterHeight - beforeHeight; }

export function useVisibleTail(grouped: readonly ConversationBlock[], conversation: string, container: RefObject<HTMLElement | null>, stuck: boolean, holdPosition: () => void,
  remote?: { paged: boolean; hasEarlier: boolean; loading: boolean; loadEarlier: () => Promise<boolean | void> }) {
  const [page, setPage] = useState({ conversation, count: VISIBLE_TAIL_PAGE });
  const previous = useRef<{ conversation: string; first: string | undefined }>({ conversation, first: undefined });
  const prepend = useRef<{ conversation: string; top: number; height: number; grouped: readonly ConversationBlock[]; anchor?: HTMLElement; y?: number } | null>(null);
  const release = useRef<(() => void) | null>(null);
  const count = page.conversation === conversation ? page.count : VISIBLE_TAIL_PAGE;
  const first = !stuck && previous.current.conversation === conversation ? previous.current.first : undefined;
  const tail = remote?.paged ? { visible: grouped, earlier: 0 } : visibleTail(grouped, count, first === undefined ? undefined : block => blockId(block) === first);
  useLayoutEffect(() => {
    prepend.current = null; release.current?.(); release.current = null;
    return () => { prepend.current = null; release.current?.(); release.current = null; };
  }, [conversation]);
  useLayoutEffect(() => {
    if (stuck) { prepend.current = null; release.current?.(); release.current = null; }
    const node = container.current, pending = prepend.current;
    if (pending && node && pending.conversation === conversation && (!remote?.paged || pending.grouped !== grouped)) {
      const adjust = () => {
        const top = pending.anchor?.isConnected && pending.y !== undefined
          ? node.scrollTop + pending.anchor.getBoundingClientRect().top - pending.y
          : prependScrollTop(pending.top, pending.height, node.scrollHeight);
        node.scrollTo({ top, behavior: 'instant' });
      };
      adjust();
      release.current?.();
      if (pending.anchor && typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(adjust);
        if (node.firstElementChild) observer.observe(node.firstElementChild);
        const cancel = () => { observer.disconnect(); for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) node.removeEventListener(event, cancel); };
        for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) node.addEventListener(event, cancel, { passive: true });
        release.current = cancel;
      }
      prepend.current = null;
    }
    previous.current = { conversation, first: tail.visible[0] ? blockId(tail.visible[0]) : undefined };
  });
  const showEarlier = () => {
    const node = container.current;
    if (!node || remote?.loading || !tail.earlier && !remote?.hasEarlier) return Promise.resolve();
    release.current?.(); release.current = null;
    const y = node.getBoundingClientRect?.().top;
    const anchor = y === undefined ? undefined : Array.from(node.querySelectorAll<HTMLElement>('[data-reading-entry]')).find(element => element.getBoundingClientRect().bottom > y);
    prepend.current = { conversation, top: node.scrollTop, height: node.scrollHeight, grouped, anchor, y: anchor?.getBoundingClientRect().top };
    holdPosition();
    // Release the streaming anchor for this prepend, then save the newly revealed first block.
    previous.current = { conversation, first: undefined };
    if (remote?.paged) return remote.loadEarlier().then(loaded => { if (loaded === false) prepend.current = null; });
    setPage({ conversation, count: tail.visible.length + VISIBLE_TAIL_PAGE });
    return Promise.resolve();
  };
  return { ...tail, hasEarlier: tail.earlier > 0 || !!remote?.hasEarlier, showEarlier };
}
