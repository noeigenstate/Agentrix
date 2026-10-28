import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { flushSync } from 'react-dom';
import { motionReduced, observeMotion } from '../../shared/motion';

type Drag = { id: string; targetId: string | null };
type Rect = { left: number; top: number };

// What is dragged where: the slots (children of the container that keep their place in the layout), the item a
// pointer down on a handle picks up, and the element that scrolls while dragging near its edge.
export type ReorderTarget = {
  slots: string; slotId: (slot: HTMLElement) => string;
  item: (target: Element) => { element: HTMLElement; id: string } | null;
  area: (container: HTMLElement) => HTMLElement;
};
// Project cards on the grid, picked up by their header.
const PROJECTS: ReorderTarget = {
  slots: ':scope > [data-project-slot]', slotId: slot => slot.dataset.projectSlot!,
  item: target => {
    const header = target.closest<HTMLElement>('.panel-header'), panel = header?.closest<HTMLElement>('[data-project-id]');
    return header && panel && !target.closest('button:not(.panel-name), [role="menu"]') ? { element: panel, id: panel.dataset.projectId! } : null;
  },
  area: container => container.closest<HTMLElement>('.grid-area')!,
};
// A project's terminal splits, picked up by their title bar; they scroll in their own area.
export const TERMINAL_SPLITS: ReorderTarget = {
  slots: ':scope > [data-terminal-slot]', slotId: slot => slot.dataset.terminalSlot!,
  item: target => {
    const header = target.closest<HTMLElement>('.terminal-split-header'), split = header?.closest<HTMLElement>('[data-terminal-id]');
    return header && split && !target.closest('button') ? { element: split, id: split.dataset.terminalId! } : null;
  },
  area: container => container,
};

export function useProjectReorder(enabled: boolean, context: string, ids: string[], onReorder: (ids: string[]) => Promise<unknown>) {
  return useReorder(enabled, context, ids, onReorder, PROJECTS);
}

export function useReorder(enabled: boolean, context: string, ids: string[], onReorder: (ids: string[]) => Promise<unknown>, target: ReorderTarget) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  const commit = useRef(onReorder); commit.current = onReorder;
  const gridRef = useRef<HTMLElement | null>(null);
  const before = useRef(new Map<string, Rect>());
  const animations = useRef<Animation[]>([]);
  const idsKey = [...ids].sort().join('\0');
  useEffect(() => { cancel.current?.(); }, [enabled, context, idsKey]);
  useEffect(() => () => { cancel.current?.(); animations.current.forEach(animation => animation.cancel()); }, []);
  useEffect(() => observeMotion(() => {
    if (motionReduced()) animations.current.forEach(animation => { if (animation.playState !== 'idle') animation.finish(); });
  }), []);

  // Animate the existing slots to their new layout. Terminals keep their nodes,
  // buffers and dimensions; only the surrounding slots move.
  useLayoutEffect(() => {
    animations.current.forEach(animation => animation.cancel()); animations.current = [];
    const grid = gridRef.current;
    if (!grid || motionReduced()) { before.current.clear(); return; }
    const moves: { slot: HTMLElement; dx: number; dy: number }[] = [];
    for (const slot of grid.querySelectorAll<HTMLElement>(target.slots)) {
      const previous = before.current.get(target.slotId(slot));
      if (!previous || target.slotId(slot) === drag?.id || !slot.getClientRects().length) continue;
      const next = slot.getBoundingClientRect();
      const dx = previous.left - next.left, dy = previous.top - next.top;
      if (Math.abs(dx) + Math.abs(dy) < 1) continue;
      moves.push({ slot, dx, dy });
    }
    for (const { slot, dx, dy } of moves) animations.current.push(slot.animate([
      { transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' },
    ], { duration: 250, easing: 'cubic-bezier(.2,.85,.25,1)' }));
    before.current.clear();
  }, [order]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (cancel.current) return;
    suppressClick.current = false;
    if (!enabled || event.button !== 0 || !event.isPrimary || event.ctrlKey || event.altKey || event.metaKey) return;
    const picked = target.item(event.target as Element);
    if (!picked) return;
    const panel = picked.element, sourceId = picked.id;
    const grid = event.currentTarget; gridRef.current = grid;
    const area = target.area(grid);
    const pointerId = event.pointerId;
    const origin = panel.getBoundingClientRect();
    const startX = event.clientX, startY = event.clientY;
    let x = startX, y = startY, active = false, ended = false, settling = false, dirty = false, frame = 0;
    let lastFrame: number | null = null;
    let draft = [...ids]; let landing: Animation | undefined; let lastIndex = ids.indexOf(sourceId);
    const slots = () => [...grid.querySelectorAll<HTMLElement>(target.slots)];
    const snapshot = () => { before.current = new Map(slots().filter(slot => slot.getClientRects().length).map(slot => [target.slotId(slot), slot.getBoundingClientRect()])); };
    const hit = () => {
      const viewport = area.getBoundingClientRect();
      if (x < viewport.left || x > viewport.right || y < viewport.top || y > viewport.bottom) return null;
      // Offset coordinates ignore in-flight FLIP transforms, avoiding reorder
      // oscillation when a neighboring card animates underneath the pointer. A container that scrolls itself moves its
      // slots under a still box.
      const bounds = grid.getBoundingClientRect(), left = bounds.left - (area === grid ? grid.scrollLeft : 0), top = bounds.top - (area === grid ? grid.scrollTop : 0);
      const found = slots().find(slot => slot.getClientRects().length && x >= left + slot.offsetLeft && x <= left + slot.offsetLeft + slot.offsetWidth && y >= top + slot.offsetTop && y <= top + slot.offsetTop + slot.offsetHeight);
      return found ? target.slotId(found) : null;
    };
    const update = () => {
      const targetId = hit();
      const index = targetId ? slots().findIndex(slot => target.slotId(slot) === targetId) : -1;
      let next: string[] | null = null;
      if (index !== lastIndex && targetId && targetId !== sourceId) {
        const from = draft.indexOf(sourceId), to = draft.indexOf(targetId);
        if (from >= 0 && to >= 0 && from !== to) {
          next = [...draft]; next.splice(from, 1); next.splice(to, 0, sourceId); snapshot();
        }
      }
      lastIndex = index;
      // Finish all hit-testing and FLIP reads before invalidating styles or React's layout.
      panel.style.setProperty('--drag-x', `${x - startX}px`);
      panel.style.setProperty('--drag-y', `${y - startY}px`);
      if (next) { draft = next; setOrder(next); setDrag({ id: sourceId, targetId }); }
      return targetId;
    };
    const scroll = (now: number) => {
      if (ended || !active || settling) return;
      const box = area.getBoundingClientRect();
      const elapsed = lastFrame === null ? 1000 / 60 : Math.min(50, Math.max(0, now - lastFrame)); lastFrame = now;
      const old = area.scrollTop;
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) {
        const direction = y < box.top + 42 ? -1 : y > box.bottom - 42 ? 1 : 0;
        if (direction) area.scrollTop += direction * .72 * elapsed;
      }
      if (dirty || old !== area.scrollTop) { update(); dirty = false; }
      frame = requestAnimationFrame(scroll);
    };
    const activate = () => {
      if (ended || active) return;
      active = true; suppressClick.current = true;
      // Capture on the stable grid: moving a card's DOM node must not cancel
      // the pointer gesture or leave its terminal in a selection operation.
      grid.setPointerCapture(pointerId);
      for (const [name, value] of Object.entries({ left: origin.left, top: origin.top, width: origin.width, height: origin.height })) panel.style.setProperty(`--drag-${name}`, `${value}px`);
      panel.style.setProperty('--drag-x', '0px'); panel.style.setProperty('--drag-y', '0px');
      flushSync(() => { setOrder(draft); setDrag({ id: sourceId, targetId: null }); });
      // A fixed element is placed against its nearest ancestor with a transform or filter (a project card's glass, for
      // a terminal split), not the window: measured once lifted, the difference keeps it where it was picked up.
      const placed = panel.getBoundingClientRect();
      panel.style.setProperty('--drag-left', `${origin.left * 2 - placed.left - (placed.width - origin.width) / 2}px`);
      panel.style.setProperty('--drag-top', `${origin.top * 2 - placed.top - (placed.height - origin.height) / 2}px`);
      panel.style.setProperty('--drag-x', `${x - startX}px`); panel.style.setProperty('--drag-y', `${y - startY}px`);
      window.getSelection()?.removeAllRanges(); frame = requestAnimationFrame(scroll);
    };
    const timer = window.setTimeout(activate, 260);
    const move = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== pointerId || settling) return;
      x = event.clientX; y = event.clientY;
      if (!active && Math.hypot(x - startX, y - startY) >= 6) activate();
      if (active) { event.preventDefault(); dirty = true; }
    };
    const detach = () => {
      window.clearTimeout(timer); cancelAnimationFrame(frame);
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', canceled);
      document.removeEventListener('keydown', key, true); window.removeEventListener('blur', abort); grid.removeEventListener('lostpointercapture', abort);
      if (grid.hasPointerCapture(pointerId)) grid.releasePointerCapture(pointerId);
    };
    // The card must leave its floating position (drag state) in the same frame its landing transform is
    // dropped; cancelling first would paint one frame back at the origin, a visible jump after release.
    const clear = () => {
      ended = true; cancel.current = null;
      animations.current = animations.current.filter(animation => animation !== landing);
      flushSync(() => { setDrag(null); setOrder(null); }); landing?.cancel();
    };
    const finish = (save: boolean) => {
      if (ended || settling) return;
      detach();
      if (!active) { clear(); return; }
      settling = true;
      const changed = draft.some((id, index) => id !== ids[index]);
      const persist = save && changed;
      if (!persist) { snapshot(); draft = [...ids]; setOrder(draft); }
      requestAnimationFrame(() => {
        if (ended) return;
        const slot = slots().find(slot => target.slotId(slot) === sourceId);
        if (!slot) { clear(); return; }
        const home = slot.getBoundingClientRect();
        const reduced = motionReduced();
        landing = panel.animate([{ transform: getComputedStyle(panel).transform }, { transform: `translate3d(${home.left - origin.left}px, ${home.top - origin.top}px, 0) scale(1)` }], { duration: reduced ? 0 : 170, easing: 'cubic-bezier(.2,.85,.25,1)', fill: 'forwards' });
        animations.current.push(landing);
        Promise.all([landing.finished.catch(() => {}), persist ? commit.current(draft) : Promise.resolve()]).finally(() => { if (!ended) clear(); });
      });
    };
    const up = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== pointerId || ended || settling) return;
      x = event.clientX; y = event.clientY;
      // The release can arrive at a new cell without a final pointermove (for example, coalesced input).
      const over = active ? update() : null;
      finish(!!over);
    };
    const canceled = (event: globalThis.PointerEvent) => { if (event.pointerId === pointerId) finish(false); };
    const abort = () => { detach(); clear(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); } };
    cancel.current = abort;
    document.addEventListener('pointermove', move, { passive: false }); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', canceled);
    document.addEventListener('keydown', key, true); window.addEventListener('blur', abort); grid.addEventListener('lostpointercapture', abort);
  };
  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); }
  };
  return { drag, order, onPointerDown, onClickCapture };
}
