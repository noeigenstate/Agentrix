import type { ConversationEntry } from '../../shared/types';
import { showPopup } from '../files/file-popup.ts';
import { revealInTree, treeShown } from '../files/tree-reveal.ts';

// A picture Codex generated, by the rule of electron/generated-image-path.cjs: an absolute path of either system, never a
// network or file: one, under a generated_images folder (tests/generated-images.test.cjs holds both to the same
// answers). A picture a reply names, as a card shows one (file-kind.cjs), a line number after it left out.
const GENERATED = /[\\/]generated_images[\\/][^\\/]+[\\/][^\\/]+\.(?:png|jpe?g|webp)$/i;
const PICTURE = /\.(?:png|jpe?g|gif|webp|bmp)$/i;
export const isGeneratedPicture = (path: string) => !/^(?:[\\/]{2}|file:)/i.test(path) && /^(?:[a-z]:[\\/]|[\\/])/i.test(path) && GENERATED.test(path);
export const isPicture = (path: string) => PICTURE.test(path.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)$/, ''));

const WEB = /^(?:https?:\/\/|www\.|#)/i;
// A file: link as the path it names.
function filePath(path: string) {
  if (!/^file:\/\//i.test(path)) return path;
  try { return decodeURIComponent(new URL(path).pathname).replace(/^\/(?=[a-z]:)/i, ''); } catch { return path; }
}
// Where each generated picture of a conversation was copied in its project, by the picture's saved path.
const key = (path: string) => filePath(path).replace(/\\/g, '/').toLowerCase();
export const generatedCopies = (entries: ConversationEntry[]) =>
  new Map(entries.flatMap(entry => entry.generated?.copied ? [[key(entry.generated.path), entry.generated.copied] as const] : []));

// The full path of the file a plain click on a reply link shows: a generated picture's copy in the project when it has
// one, else the picture itself; any other file or folder of the project where it is (an SSH project's on that computer).
// Null for a web address and for a link the click refuses (outside the project, or not found).
export async function replyLinkPath(projectId: string, path: string, copies: Map<string, string>) {
  if (WEB.test(path)) return null;
  const local = filePath(path);
  if (isGeneratedPicture(local) && !copies.has(key(local))) return local;
  const found = await window.agentrix.linkPath(projectId, isGeneratedPicture(local) ? copies.get(key(local))! : path).catch(() => null);
  return found?.ok ? found.value : null;
}

// A plain click on a path a reply names (a link's path, decoded). With the project open in the workbench, the file or
// folder is shown in its file tree; a generated picture is shown by its copy in the project, and opens in the picture
// popup while it has none. On a project's small card nothing expands it: a picture opens in the popup, anything else
// as before (onOpenLink), and so does a web address anywhere.
export async function openReplyLink(projectId: string, path: string, copies: Map<string, string>, onOpenLink: ((target: string) => void) | undefined, onError: (message: string) => void) {
  if (WEB.test(path)) return onOpenLink?.(path);
  const local = filePath(path);
  if (isGeneratedPicture(local)) {
    const copy = copies.get(key(local));
    if (!copy || !revealInTree(projectId, copy)) showPopup({ kind: 'image', projectId, path: local });
    return;
  }
  if (!treeShown(projectId)) return isPicture(path) ? showPopup({ kind: 'image', projectId, path }) : onOpenLink?.(path);
  const result = await window.agentrix.openLink(projectId, path);
  if (!result.ok) onError(result.error);
  else if (result.value.kind !== 'external') revealInTree(projectId, result.value.path);
}
