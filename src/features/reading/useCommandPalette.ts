import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import type { AgentCommand } from '../../shared/types';

// A draft that is only the start of a command: "/" and its letters, no space yet.
export const isCommandDraft = (draft: string) => /^\/[^\s]*$/.test(draft);

// The commands whose name contains what follows the "/", the one named exactly first (a project's /doc before the built-in /doctor), then those it begins.
export function matchCommands(commands: readonly AgentCommand[], draft: string) {
  const query = draft.slice(1).toLowerCase(), name = (command: AgentCommand) => command.name.slice(1).toLowerCase();
  const rank = (command: AgentCommand) => name(command) === query ? 0 : name(command).startsWith(query) ? 1 : 2;
  return commands.filter(command => name(command).includes(query)).sort((a, b) => rank(a) - rank(b));
}

// The command list over the message box, shared by the reading view and the native session's box. `blocked`: the box takes nothing now;
// `recalled`: the draft was taken from the walk through sent messages (↑), which keeps the list shut so ↑ goes on through them; `showEmpty`: a list
// with no match is still drawn (the reading view does) or leaves the keys to the box. `complete` puts a command into the box, `send` sends the
// draft as it is.
export function useCommandPalette({ id, commands, draft, blocked, recalled, showEmpty, complete, send }: {
  id: string; commands: readonly AgentCommand[]; draft: string; blocked: boolean; recalled: () => boolean; showEmpty: boolean;
  complete: (command: AgentCommand) => void; send: () => void;
}) {
  const [dismissed, setDismissed] = useState(false), [selection, setSelection] = useState(0);
  const matches = useMemo(() => matchCommands(commands, draft), [commands, draft]);
  const open = !blocked && !dismissed && !recalled() && isCommandDraft(draft) && (showEmpty || matches.length > 0), selected = matches[selection];
  const listId = `reading-commands-${id}`, optionId = (index: number) => `${listId}-${index}`;
  useEffect(() => { setSelection(0); }, [draft, commands]);
  useEffect(() => { if (open) document.getElementById(optionId(selection))?.scrollIntoView({ block: 'nearest' }); }, [open, selection]);
  // Esc closes it, ↑↓ walk it round, Tab completes, Enter completes (or sends a command already written in full). True when the key was the list's.
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return false;
    if (event.key === 'Escape') { event.preventDefault(); setDismissed(true); return true; }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      if (matches.length) setSelection(index => (index + (event.key === 'ArrowUp' ? -1 : 1) + matches.length) % matches.length);
      return true;
    }
    if (selected && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))) {
      event.preventDefault(); if (event.key === 'Enter' && draft === selected.name) send(); else complete(selected);
      return true;
    }
    return false;
  };
  return { open, matches, selected, selection, listId, optionId, complete, keys, dismiss: setDismissed };
}
