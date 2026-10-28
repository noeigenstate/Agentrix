import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import { isMac } from '../../shared/platform';
import { revealPathClick } from './reading-paths';

export function useReadingPaths(projectId: string, onError: (message: string) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const down = useRef<{ x: number; y: number } | null>(null);
  const held = (event: { metaKey: boolean; ctrlKey: boolean }) => isMac ? event.metaKey : event.ctrlKey;
  useEffect(() => {
    const update = (event: KeyboardEvent) => ref.current?.toggleAttribute('data-reveal-modifier', held(event));
    const clear = () => ref.current?.removeAttribute('data-reveal-modifier');
    addEventListener('keydown', update); addEventListener('keyup', update); addEventListener('blur', clear);
    return () => { removeEventListener('keydown', update); removeEventListener('keyup', update); removeEventListener('blur', clear); };
  }, []);
  return {
    ref,
    onMouseDownCapture: (event: ReactMouseEvent<HTMLDivElement>) => { down.current = { x: event.clientX, y: event.clientY }; },
    onMouseMoveCapture: (event: ReactMouseEvent<HTMLDivElement>) => event.currentTarget.toggleAttribute('data-reveal-modifier', held(event)),
    onClickCapture: (event: ReactMouseEvent<HTMLDivElement>) => {
      const start = down.current; down.current = null;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
      revealPathClick(event, projectId, onError);
    },
  };
}
