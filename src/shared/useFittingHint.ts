// A textarea's placeholder is clipped without an ellipsis (Chromium ignores text-overflow there), so a hint that does not fit gives way to a
// shorter one instead of being cut mid-word. hints run from the longest to the shortest; the first that fits on the box's one line is shown,
// the shortest when none does.
import { type RefObject, useLayoutEffect, useState } from 'react';

export const fittingIndex = (hints: string[], room: number, width: (text: string) => number) => {
  const index = hints.findIndex(hint => width(hint) <= room);
  return index < 0 ? hints.length - 1 : index;
};

export function useFittingHint(box: RefObject<HTMLTextAreaElement | null>, hints: string[]) {
  const [index, setIndex] = useState(0), key = hints.join('\n');
  useLayoutEffect(() => {
    const node = box.current, canvas = document.createElement('canvas').getContext('2d');
    if (!node || !canvas) return;
    const fit = () => {
      const style = getComputedStyle(node);
      canvas.font = style.font;
      setIndex(fittingIndex(hints, node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), text => canvas.measureText(text).width));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => observer.disconnect();
  }, [box, key]);
  return hints[Math.min(index, hints.length - 1)];
}
