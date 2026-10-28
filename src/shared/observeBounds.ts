export type Bounds = { left: number; top: number; width: number; height: number };

// ResizeObserver misses transformed positions. Sample those only during a focus flight or drag;
// at rest, layout/scroll notifications are enough. Report changes before writing any overlay styles.
export function observeBounds(target: () => Element | null | undefined, change: (box: Bounds | null) => void) {
  let element: Element | null | undefined, previous: Bounds | null | undefined, frame = 0;
  let viewportWidth = 0, viewportHeight = 0;
  const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
  const resize = new ResizeObserver(schedule);
  const measure = () => {
    frame = 0;
    const next = target();
    if (next !== element) { resize.disconnect(); element = next; if (element) resize.observe(element); }
    const rect = element?.getBoundingClientRect();
    const box = rect?.width && rect.height ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null;
    const moving = element?.closest('[data-focus-motion], .is-reordering');
    if (viewportWidth !== window.innerWidth || viewportHeight !== window.innerHeight
      || previous === undefined || previous?.left !== box?.left || previous?.top !== box?.top
      || previous?.width !== box?.width || previous?.height !== box?.height) {
      viewportWidth = window.innerWidth; viewportHeight = window.innerHeight;
      previous = box; change(box);
    }
    if (moving) schedule();
  };
  const mutations = new MutationObserver(schedule);
  mutations.observe(document.querySelector('.app-shell') || document.body, {
    subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'data-focus-motion', 'open'],
  });
  window.addEventListener('resize', schedule);
  document.addEventListener('scroll', schedule, true);
  measure();
  return () => {
    cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect();
    window.removeEventListener('resize', schedule); document.removeEventListener('scroll', schedule, true);
  };
}
