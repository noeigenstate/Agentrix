import { actionFor, editingKeyInField, type ShortcutAction } from './features/shortcuts/shortcuts';
import type { MenuCommand, TitlebarView } from './shared/types';

// Terminal popups are modeless: only their own keys belong to the CLI, even while other projects are hidden.
const dialogOpen = (document: Document, target: EventTarget | null = document.activeElement) => !!document.querySelector('dialog:modal, .tour-layer') || !!(target as Element | null)?.closest?.('.reading-terminal-popup');

export function handleAppShortcut(document: Document, event: KeyboardEvent, runAction: (action: ShortcutAction) => void) {
  const action = actionFor(event);
  if (!action || editingKeyInField(event) || dialogOpen(document, event.target)) return;
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat) runAction(action);
}

export function handleMenuCommand(document: Document, command: MenuCommand, runAction: (action: ShortcutAction) => void, installUpdate: () => void) {
  if (command === 'installUpdate') return installUpdate();
  if (!dialogOpen(document)) runAction(command);
}

export function handleTitlebarNavigate(document: Document, target: TitlebarView, setView: (target: TitlebarView) => void) {
  if (!dialogOpen(document)) setView(target);
}
