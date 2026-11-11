import { useEffect, useRef } from 'react';

// A request to show a file or folder in an open project's file tree, by its path from the project's folder. Only the
// tree of the project open in the workbench listens: revealInTree says whether one took the request.
const trees = new Map<string, (path: string) => void>();

export const treeShown = (projectId: string) => trees.has(projectId);
export function revealInTree(projectId: string, path: string) {
  const reveal = trees.get(projectId);
  reveal?.(path);
  return !!reveal;
}

export function useTreeReveal(projectId: string, reveal: (path: string) => void) {
  const latest = useRef(reveal);
  latest.current = reveal;
  useEffect(() => {
    const listener = (path: string) => latest.current(path);
    trees.set(projectId, listener);
    return () => { if (trees.get(projectId) === listener) trees.delete(projectId); };
  }, [projectId]);
}
