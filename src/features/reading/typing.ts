// Whether someone is writing in a message box right now: it holds words, or a key went into it a moment ago. A card or
// popup that appears then never takes the keyboard from it, or the next Enter would answer that card (select a picker's
// option, approve a command) instead of sending the message being written.
const GRACE = 2000;
export function markTyping(node: HTMLElement) { node.dataset.typedAt = String(Date.now()); }
export function isTyping(node: Element | null) {
  return node instanceof HTMLTextAreaElement && (!!node.value.trim() || Date.now() - Number(node.dataset.typedAt || 0) < GRACE);
}

// Focus belongs to an editor even when it is empty and the typing grace has expired.
export function hasEditingFocus(view: Element | null) {
  const node = document.activeElement;
  return !!node && !!view?.contains(node) && (node.matches('input, textarea, select') || (node as HTMLElement).isContentEditable);
}
