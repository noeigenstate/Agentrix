import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motionReduced, observeMotion } from '../../shared/motion';

type Bounds = { left: number; top: number; width: number; height: number };
type Flight = { id: string; from: Bounds; opening: boolean };

// Move the real panel between layouts. Keeping the terminal mounted preserves
// its PTY, input, selection and live output throughout the transition.
export function useProjectFocusMotion(mode: 'smooth' | 'system' | 'off') {
  const root = useRef<HTMLDivElement>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const currentId = useRef<string | null>(null);
  const pending = useRef<Flight | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const overviewScroll = useRef({ top: 0, left: 0 });

  const focus = useCallback((nextId: string | null) => {
    if (currentId.current === nextId) return;
    const shell = root.current;
    const id = nextId || currentId.current;
    const panel = id ? shell?.querySelector<HTMLElement>(`[data-project-id="${CSS.escape(id)}"]`) : null;
    const preview = !nextId ? shell?.querySelector<HTMLElement>('.file-preview') : null;
    const from = (preview || panel)?.getBoundingClientRect();
    const area = shell?.querySelector('.grid-area');
    if (!currentId.current && area) overviewScroll.current = { top: area.scrollTop, left: area.scrollLeft };
    // A quick return starts at the current animated bounds, without snapping.
    stop.current?.();
    const animate = mode === 'smooth' || mode === 'system' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    pending.current = id && from && from.width > 0 && from.height > 0 && animate
      ? { id, from, opening: !!nextId } : null;
    currentId.current = nextId;
    setFocusedId(nextId);
  }, [mode]);

  useLayoutEffect(() => {
    const shell = root.current;
    const area = shell?.querySelector('.grid-area');
    if (!focusedId && area) { area.scrollTop = overviewScroll.current.top; area.scrollLeft = overviewScroll.current.left; }
    const flight = pending.current; pending.current = null;
    if (!shell || !flight) return;
    const panel = shell.querySelector<HTMLElement>(`[data-project-id="${CSS.escape(flight.id)}"]`);
    const slot = panel?.parentElement;
    if (!panel || !slot || !slot.getClientRects().length || getComputedStyle(panel).visibility === 'hidden') return;

    const duration = flight.opening ? 720 : 560;
    const deadline = performance.now() + duration;
    let animation: Animation | null = null;
    let target: Bounds;
    let finished = false;
    const supporting: Animation[] = [];
    shell.dataset.focusMotion = flight.opening ? 'opening' : 'closing';
    panel.classList.add('focus-motion-panel');

    const clear = () => {
      if (finished) return;
      finished = true;
      observer.disconnect();
      window.removeEventListener('resize', retarget);
      stopMotion();
      animation?.cancel();
      supporting.forEach(item => item.cancel());
      panel.classList.remove('focus-motion-panel');
      panel.style.removeProperty('--focus-width');
      panel.style.removeProperty('--focus-height');
      delete shell.dataset.focusMotion;
      if (stop.current === clear) stop.current = null;
    };
    const animate = (from: Bounds, remaining: number) => {
      target = slot.getBoundingClientRect();
      if (!target.width || !target.height) { clear(); return; }
      animation?.cancel();
      // Leaving native fullscreen can immediately make the viewport smaller.
      // Keep the whole moving card inside that viewport while it shrinks.
      const top = shell.querySelector('.titlebar')?.getBoundingClientRect().bottom || 0;
      const bottom = window.innerHeight;
      const scale = Math.min(1, window.innerWidth / from.width, Math.max(1, bottom - top) / from.height);
      const width = from.width * scale, height = from.height * scale;
      const left = Math.max(0, Math.min(from.left, window.innerWidth - width));
      const y = Math.max(top, Math.min(from.top, bottom - height));
      // Freeze the surface size while the compositor moves it. Resizing the
      // native window can then retarget the flight without resizing PTYs on
      // every animation frame or clipping the card inside the destination slot.
      panel.style.setProperty('--focus-width', `${target.width}px`);
      panel.style.setProperty('--focus-height', `${target.height}px`);
      const next = panel.animate([
        { transform: `translate3d(${left}px, ${y}px, 0) scale(${width / target.width}, ${height / target.height})` },
        { transform: `translate3d(${target.left}px, ${target.top}px, 0) scale(1, 1)` },
      ], { duration: remaining, easing: 'cubic-bezier(.32,.08,.24,1)', fill: 'both' });
      animation = next;
      next.finished.then(() => { if (animation === next) clear(); }).catch(() => {});
    };
    const retarget = () => {
      if (finished) return;
      const next = slot.getBoundingClientRect();
      if (Math.abs(next.left - target.left) + Math.abs(next.top - target.top) + Math.abs(next.width - target.width) + Math.abs(next.height - target.height) < 1) return;
      // A slower native fullscreen resize must not consume nearly all of the
      // visible zoom and turn the remaining motion into an abrupt snap.
      animate(panel.getBoundingClientRect(), Math.max(flight.opening ? 380 : 280, deadline - performance.now()));
    };
    const observer = new ResizeObserver(retarget);
    const stopMotion = observeMotion(() => { if (motionReduced()) clear(); });
    stop.current = clear;
    animate(flight.from, duration);
    if (finished) return;
    observer.observe(slot);
    window.addEventListener('resize', retarget);
    if (flight.opening) {
      const sidebar = shell.querySelector('.focus-sidebar');
      if (sidebar) supporting.push(sidebar.animate([
        { opacity: 0, transform: 'translateX(-14px)' }, { opacity: 1, transform: 'translateX(0)' },
      ], { duration: 360, delay: 120, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' }));
    } else {
      for (const sibling of shell.querySelectorAll<HTMLElement>('.project-slot')) {
        if (sibling !== slot && sibling.getClientRects().length) supporting.push(sibling.animate([
          { opacity: 0 }, { opacity: 1 },
        ], { duration: 240, delay: 60, fill: 'both' }));
      }
    }
    return clear;
  }, [focusedId, mode]);

  useEffect(() => () => stop.current?.(), []);
  return { root, focusedId, focus };
}
