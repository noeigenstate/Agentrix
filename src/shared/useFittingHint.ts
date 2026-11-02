// A textarea's placeholder is clipped without an ellipsis (Chromium ignores text-overflow there), so a hint that does not fit gives way to a
// shorter one instead of being cut mid-word. hints run from the longest to the shortest; the first that fits on the box's one line is shown,
// and none when even the shortest does not (an empty placeholder, never a cut-off one). The first hint is the full one: whenever the shown
// hint is not it, the box carries the full hint as its tooltip and accessible description, so no shortcut is lost to a narrow box.
import { type CSSProperties, type RefObject, useLayoutEffect, useState } from 'react';

// -1 when no hint fits.
export const fittingIndex = (hints: string[], room: number, width: (text: string) => number) => hints.findIndex(hint => width(hint) <= room);

// The visually hidden element a shortened box points to with aria-describedby.
export const HIDDEN_NOTE: CSSProperties = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' };

// What a box needs besides its placeholder: the full hint as title and description when the shown one is a shortened form (or none).
export const fullHintProps = (hints: string[], shown: string, noteId: string) =>
  shown === hints[0] ? {} : { title: hints[0], 'aria-describedby': noteId };

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
  return hints[index] ?? '';
}
