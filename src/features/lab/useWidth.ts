import { useEffect, useRef, useState } from 'react';

// The width of an element, followed as the window changes. A chart drawn in a viewBox of exactly this width is never scaled, so its text stays the
// app's own 12px; `initial` is what the first render (and a render without a window) draws with.
export function useWidth<T extends HTMLElement>(initial: number) {
  const ref = useRef<T>(null), [width, setWidth] = useState(initial);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => { const next = Math.round(element.clientWidth); if (next > 0) setWidth(next); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}
