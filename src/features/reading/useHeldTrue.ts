import { useEffect, useState } from 'react';

// How long a frame-read signal must stay lost before the message box's look lets go of it. The screen is sampled at most
// every 100 ms and a redraw of Claude Code's busy screen (spinner and timer row, input box) leaves a half-drawn frame for
// one or two samples; 500 ms is five samples, past any redraw, and still a blink for a change that is real.
export const COMPOSER_HOLD_MS = 500;

// A signal for display only: true at once, false only after it has been false for `ms`, and false at once while `off` is set
// (a dialog, a menu or the popup: those must show, and block, in the very render they are seen). Nothing that writes to the terminal
// reads this; the delivery gates keep the frame's own verdict.
export function useHeldTrue(value: boolean, off: boolean, ms = COMPOSER_HOLD_MS) {
  const [held, setHeld] = useState(value);
  useEffect(() => {
    if (value) { setHeld(true); return; }
    if (off) { setHeld(false); return; }
    const timer = setTimeout(() => setHeld(false), ms);
    return () => clearTimeout(timer);
  }, [value, off, ms]);
  return !off && (value || held);
}
