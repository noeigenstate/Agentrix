import { useSyncExternalStore } from 'react';

// The split of a project its reader last picked: the terminal the header actions, the activity pane and the title bar's mode switch follow.
// Until one is picked, the first visible terminal is in use (terminalInUse).
const picked = new Map<string, string>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function setActiveTerminal(projectId: string, terminalId: string) {
  if (picked.get(projectId) === terminalId) return;
  picked.set(projectId, terminalId);
  listeners.forEach(listener => listener());
}
export const useActiveTerminal = (projectId: string) => useSyncExternalStore(subscribe, () => picked.get(projectId) ?? null);
