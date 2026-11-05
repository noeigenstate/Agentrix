import { useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

// The message box's memory of what was sent: ↑ with the caret at the very start takes the message sent before, ↓ at the very end the one after,
// and past the newest the draft that was not sent. Only a bare arrow with nothing selected; typing, or any other change of the box (forget),
// leaves the walk. `messages` is read at the key, so a message sent meanwhile is in it; `setDraft` must not call forget.
export function useComposerHistory({ messages, draft, setDraft, input, onRecall }: {
  messages: () => readonly string[]; draft: string; setDraft: (value: string) => void;
  input: RefObject<HTMLTextAreaElement | null>; onRecall?: () => void;
}) {
  const at = useRef<number | null>(null), unsent = useRef(''), caret = useRef<number | null>(null);
  useLayoutEffect(() => { if (caret.current !== null) { input.current?.setSelectionRange(caret.current, caret.current); caret.current = null; } });
  // Whether the box holds a message taken from the walk: a command recalled this way is sent as it is, so no command list opens over it.
  const recalled = () => at.current !== null;
  const forget = () => { at.current = null; };
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.key !== 'ArrowUp' && event.key !== 'ArrowDown') || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false;
    const node = event.currentTarget, sent = messages();
    if (node.selectionStart !== node.selectionEnd || !(event.key === 'ArrowUp' ? node.selectionStart === 0 : node.selectionEnd === draft.length)) return false;
    if (event.key === 'ArrowUp' && sent.length) {
      event.preventDefault(); onRecall?.();
      if (at.current === null) { unsent.current = draft; at.current = sent.length; }
      at.current = Math.max(0, at.current - 1); caret.current = 0; setDraft(sent[at.current]);
    } else if (event.key === 'ArrowDown' && at.current !== null) {
      event.preventDefault(); onRecall?.(); at.current++;
      const next = at.current >= sent.length ? unsent.current : sent[at.current];
      if (at.current >= sent.length) at.current = null;
      caret.current = next.length; setDraft(next);
    } else return false;
    node.setSelectionRange(caret.current!, caret.current!);
    return true;
  };
  return { keys, recalled, forget };
}
