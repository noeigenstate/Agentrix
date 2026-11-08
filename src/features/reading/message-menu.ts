// The right-click menu of a message (引用 / 复制): what it acts on and where it opens. Pure, so the rules are testable
// without a window.

// Where the browser, not the message menu, keeps the right click: links, pictures, media, code blocks and any control.
const OWN_MENU = 'a, img, video, audio, iframe, button, input, textarea, select, pre, [contenteditable="true"], .reading-code';
export const keepsOwnMenu = (target: EventTarget | null) => !!(target as Element | null)?.closest?.(OWN_MENU);

// The words selected inside this message, trimmed; nothing when the selection is empty or reaches outside the message.
export function selectedWithin(element: { contains(node: Node): boolean }, selection: Pick<Selection, 'isCollapsed' | 'anchorNode' | 'focusNode' | 'toString'> | null): string {
  if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return '';
  if (!element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) return '';
  return selection.toString().trim();
}

// What 引用 and 复制 act on: the selected part when there is one, otherwise the whole message.
export const menuText = (message: string, selected: string) => selected || message;

export const MENU_WIDTH = 182, MENU_HEIGHT = 88, MENU_EDGE = 8;
// The menu's corner, kept inside the window.
export const menuPlace = (x: number, y: number, view: { width: number; height: number }) => ({
  x: Math.max(MENU_EDGE, Math.min(x, view.width - MENU_WIDTH - MENU_EDGE)),
  y: Math.max(MENU_EDGE, Math.min(y, view.height - MENU_HEIGHT - MENU_EDGE)),
});

// The menu key and Shift+F10 open it from the keyboard, as they open any context menu.
export const opensMenu = (event: { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }) =>
  event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey);
