// Whose Esc it is, among the result windows that are open. Each window listens on `window` and every one of them hears every key, so the rule is asked
// here, with all of them in view: at most one takes a press, and one that does not take it leaves the key untouched for whatever it was meant for.
type Shown = { readonly current: HTMLElement | null };

// Oldest first.
const shown: Shown[] = [];
export function showPanel(panel: Shown) {
  shown.push(panel);
  return () => { shown.splice(shown.indexOf(panel), 1); };
}

// A window is on top when what is drawn at its centre is its own: one that is hidden, or lies under a dialog, a menu, the guide or a file preview, is not.
const onTop = (node: HTMLElement | null) => {
  if (!node) return false;
  const box = node.getBoundingClientRect();
  return node.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
};

// Where the Esc this window takes was pressed, or null when the key is not its. A key pressed in the window's own session view (the window, its message
// box or its conversation) is that window's. With nothing focused (a press on a window's text leaves the page itself as the target) it belongs to the
// newest window the owner can see, if nothing lies over it.
export function escapeFrom(panel: Shown, target: EventTarget | null): 'view' | 'page' | null {
  if (target !== document.body && target !== document.documentElement && target !== document) return panel.current?.closest('[data-native-session]')?.contains(target as Node | null) ? 'view' : null;
  return shown.filter(other => onTop(other.current)).at(-1) === panel ? 'page' : null;
}
