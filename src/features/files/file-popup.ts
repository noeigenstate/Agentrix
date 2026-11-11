import { useSyncExternalStore } from 'react';

// A file shown over whatever is on screen: a page, a document, a picture or a video an agent wrote or named. Opening
// one never moves to the project's page; only its header or a shortcut goes there.
// file and folder: a path inside the project, read as its preview and file list do. image: a picture anywhere on this
// computer, or, with its project, one a reply names (from the project's folder) or one an SSH project's agent generated,
// read back over the connection. document: a Markdown file outside the project (an agent's memory or notes), read where the project is.
// picture: one already in the window (a picture sent in a message), shown larger.
export type PopupTarget = { kind: 'file' | 'folder' | 'document'; projectId: string; path: string } | { kind: 'image'; path: string; projectId?: string } | { kind: 'picture'; src: string; path: string };

let current: PopupTarget | null = null;
const listeners = new Set<() => void>();
const publish = (target: PopupTarget | null) => { current = target; listeners.forEach(listener => listener()); };

export const showPopup = (target: PopupTarget) => publish(target);
export const closePopup = () => publish(null);
export const usePopup = () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => current);

export const openLinkInPopup = (projectId: string, link: string, onError: (message: string) => void) =>
  window.agentrix.openLink(projectId, link).then(result => {
    if (!result.ok) onError(result.error);
    else if (result.value.kind !== 'external') showPopup({ kind: result.value.kind === 'file' ? 'file' : 'folder', projectId, path: result.value.path });
  }).catch(error => onError(String(error)));
