import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';

type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };
type FollowState = { stuck: boolean; unseen: number };
const bottomDistance = (node: ScrollMetrics) => Math.max(0, node.scrollHeight - node.clientHeight - node.scrollTop);
const metrics = (node: HTMLElement): ScrollMetrics => ({ scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight });

// Layout changes and our own writes must not look like the reader scrolling up.
export function shouldStickToBottom(stuck: boolean, current: ScrollMetrics, previous: ScrollMetrics, ours: boolean, userInitiated: boolean): boolean {
  if (ours) return stuck;
  if (bottomDistance(current) <= 40) return true;
  const resized = current.scrollHeight !== previous.scrollHeight || current.clientHeight !== previous.clientHeight;
  return userInitiated && !resized && current.scrollTop < previous.scrollTop ? false : stuck;
}

// Count only the suffix after retained entries: a loaded history page is not a new message.
export function countNewEntries(previous: ReadonlySet<string>, entries: readonly { id: string }[]): number {
  for (let index = entries.length - 1; index >= 0; index--) {
    if (previous.has(entries[index].id)) return entries.length - index - 1;
  }
  return entries.length;
}

// Explicit 'instant' also overrides a stylesheet's scroll-behavior: smooth.
export function scrollToLatest(node: HTMLElement, behavior: ScrollBehavior = 'instant') {
  node.scrollTo({ top: node.scrollHeight, behavior });
}

export function useStickToBottom(container: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>, entries: readonly { id: string }[], conversation: unknown) {
  const [state, setState] = useState<FollowState>({ stuck: true, unseen: 0 });
  const [readyFor, setReadyFor] = useState<unknown>(null);
  const owner = useRef(conversation);
  const current = useRef(state), seen = useRef(new Set<string>());
  const motion = useRef({ frame: 0, smooth: false, userUntil: 0, dragging: false, touchY: null as number | null, previous: null as ScrollMetrics | null });
  const update = useCallback((next: FollowState) => {
    if (next.stuck === current.current.stuck && next.unseen === current.current.unseen) return;
    current.current = next; setState(next);
  }, []);
  const pin = useCallback((behavior: ScrollBehavior = 'instant') => {
    const node = container.current;
    if (!node || !current.current.stuck) return;
    const scroll = motion.current;
    if (bottomDistance(node) <= 1) { scroll.smooth = false; scroll.previous = metrics(node); return; }
    if (scroll.frame) cancelAnimationFrame(scroll.frame);
    scroll.frame = requestAnimationFrame(() => { scroll.frame = 0; });
    // Keep smooth jumps protected for their whole animation, including intermediate scroll events.
    scroll.smooth = behavior === 'smooth';
    scrollToLatest(node, behavior);
    scroll.previous = metrics(node);
  }, [container]);
  const toBottom = useCallback((behavior: ScrollBehavior = 'instant') => { update({ stuck: true, unseen: 0 }); pin(behavior); }, [pin, update]);
  const holdPosition = useCallback(() => {
    const scroll = motion.current, node = container.current;
    if (scroll.smooth && node) node.scrollTo({ top: node.scrollTop, behavior: 'instant' });
    scroll.smooth = false;
    if (scroll.frame) cancelAnimationFrame(scroll.frame);
    scroll.frame = requestAnimationFrame(() => { scroll.frame = 0; });
    update({ stuck: false, unseen: current.current.unseen });
  }, [container, update]);

  useLayoutEffect(() => {
    const node = container.current, body = content.current;
    if (!node || !body) return;
    const scroll = motion.current;
    owner.current = conversation; seen.current = new Set(); setReadyFor(null);
    update({ stuck: true, unseen: 0 });
    scroll.previous = metrics(node);
    pin();
    const observer = new ResizeObserver(() => pin());
    observer.observe(body); observer.observe(node);

    const userInput = (interrupt: boolean) => {
      scroll.userUntil = performance.now() + 1000;
      if (!interrupt) return;
      if (scroll.frame) { cancelAnimationFrame(scroll.frame); scroll.frame = 0; }
      if (scroll.smooth) {
        scroll.smooth = false;
        // A reader can interrupt a smooth jump with an upward gesture or a scrollbar drag.
        node.scrollTo({ top: node.scrollTop, behavior: 'instant' });
        scroll.previous = metrics(node);
      }
    };
    const onScroll = () => {
      const next = metrics(node), previous = scroll.previous || next;
      const user = scroll.dragging || scroll.touchY !== null || performance.now() < scroll.userUntil;
      const stuck = shouldStickToBottom(current.current.stuck, next, previous, !!scroll.frame || scroll.smooth, user);
      if (stuck !== current.current.stuck) update({ stuck, unseen: stuck ? 0 : current.current.unseen });
      if (scroll.smooth && bottomDistance(next) <= 1) scroll.smooth = false;
      if (user) scroll.userUntil = performance.now() + 1000; // Touchpad/touch inertia is still user scrolling.
      scroll.previous = next;
    };
    const onWheel = (event: WheelEvent) => { if (event.deltaY) userInput(event.deltaY < 0); };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if ((event.target as Element).closest('input, textarea, select, button, a, [contenteditable="true"]')) return;
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
        userInput(['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey);
      }
    };
    const onPointer = (event: PointerEvent) => {
      // Native scrollbar events target the scroll container; text selection and tool buttons don't.
      const bounds = node.getBoundingClientRect();
      if (event.target !== node || event.clientX < bounds.right - Math.max(16, node.offsetWidth - node.clientWidth)) return;
      scroll.dragging = true; userInput(true);
    };
    const endPointer = () => { if (scroll.dragging) userInput(false); scroll.dragging = false; };
    const onTouchStart = (event: TouchEvent) => { scroll.touchY = event.touches[0]?.clientY ?? null; };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (y !== undefined && scroll.touchY !== null) userInput(y > scroll.touchY);
      scroll.touchY = y ?? null;
    };
    const endTouch = () => { userInput(false); scroll.touchY = null; };
    const onScrollEnd = () => { scroll.smooth = false; if (current.current.stuck) pin(); };
    node.addEventListener('scroll', onScroll, { passive: true });
    node.addEventListener('scrollend', onScrollEnd);
    node.addEventListener('wheel', onWheel, { passive: true });
    node.addEventListener('keydown', onKey);
    node.addEventListener('pointerdown', onPointer);
    node.addEventListener('touchstart', onTouchStart, { passive: true });
    node.addEventListener('touchmove', onTouchMove, { passive: true });
    node.addEventListener('touchend', endTouch);
    node.addEventListener('touchcancel', endTouch);
    window.addEventListener('pointerup', endPointer);
    window.addEventListener('pointercancel', endPointer);
    return () => {
      observer.disconnect();
      if (scroll.frame) cancelAnimationFrame(scroll.frame);
      scroll.frame = 0; scroll.smooth = false; scroll.userUntil = 0; scroll.dragging = false; scroll.touchY = null;
      node.removeEventListener('scroll', onScroll);
      node.removeEventListener('scrollend', onScrollEnd);
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('keydown', onKey);
      node.removeEventListener('pointerdown', onPointer);
      node.removeEventListener('touchstart', onTouchStart);
      node.removeEventListener('touchmove', onTouchMove);
      node.removeEventListener('touchend', endTouch);
      node.removeEventListener('touchcancel', endTouch);
      window.removeEventListener('pointerup', endPointer);
      window.removeEventListener('pointercancel', endPointer);
    };
  }, [container, content, conversation, pin, update]);

  useLayoutEffect(() => {
    const arrived = countNewEntries(seen.current, entries);
    seen.current = new Set(entries.map(entry => entry.id));
    if (!current.current.stuck && arrived) update({ stuck: false, unseen: current.current.unseen + arrived });
    pin();
    if (entries.length) setReadyFor(() => conversation);
    else setReadyFor(null);
  }, [entries, conversation, pin, update]);

  return { ...(owner.current === conversation ? state : { stuck: true, unseen: 0 }), ready: readyFor === conversation, toBottom, holdPosition };
}
