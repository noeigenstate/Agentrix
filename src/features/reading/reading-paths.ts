import { findPathCandidates } from '../terminal/terminal-links.ts';
import { isMac, isWindows } from '../../shared/platform';
import { t } from '../../shared/i18n';
import { showPopup } from '../files/file-popup.ts';
import { isGeneratedPicture, isPicture } from './reply-links.ts';

// A picture's path previews it here with the modifier; any other path is shown in the system's file manager.
const previews = (path: string) => isPicture(path) || isGeneratedPicture(path);
export const pathTooltip = (path = '') => previews(path) ? t(isMac ? '⌘+点击 预览图片' : 'Ctrl+点击 预览图片')
  : t(isMac ? '⌘+点击 在访达中显示' : isWindows ? 'Ctrl+点击 在文件资源管理器中显示' : 'Ctrl+点击 在文件管理器中显示');

export function markReadingPaths(root: HTMLElement) {
  for (const link of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    let href = link.getAttribute('href')!;
    // marked URL-encodes link destinations. Keep the original href for plain click; only reveal uses its path text.
    if (!/^file:\/\//i.test(href)) { try { href = decodeURIComponent(href); } catch { /* keep literal percent signs */ } }
    if (/^(?:https?:\/\/|www\.|#)/i.test(href) || /^[a-z][\w+.-]*:/i.test(href) && !/^(?:file:\/\/|[a-z]:[\\/])/i.test(href)) continue;
    link.dataset.readingPath = href;
    link.title = `${href}\n${pathTooltip(href)}`;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.parentElement?.closest('a, button, [data-reading-path]')) nodes.push(node);
  }
  for (const node of nodes) {
    const text = node.data, links = findPathCandidates(text, node.parentElement?.tagName === 'CODE' && !node.parentElement.closest('pre'));
    if (!links.length) continue;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const link of links) {
      fragment.append(text.slice(offset, link.start));
      const span = document.createElement('span');
      span.dataset.readingPath = link.target; span.title = pathTooltip(link.target); span.textContent = text.slice(link.start, link.end);
      fragment.append(span); offset = link.end;
    }
    fragment.append(text.slice(offset)); node.replaceWith(fragment);
  }
}

type PathClick = Pick<MouseEvent, 'button' | 'ctrlKey' | 'metaKey' | 'target' | 'preventDefault' | 'stopPropagation'>;
// Capture only modifier clicks, before a card or Markdown link performs its ordinary preview action. A picture opens in
// the picture popup, read where the project is (an SSH project's over its connection).
export function revealPathClick(event: PathClick, projectId: string, onError: (message: string) => void) {
  if (event.button !== 0 || !(isMac ? event.metaKey : event.ctrlKey)) return;
  const path = (event.target as Element | null)?.closest<HTMLElement>('[data-reading-path]')?.dataset.readingPath;
  if (!path) return;
  event.preventDefault(); event.stopPropagation();
  if (previews(path)) return showPopup({ kind: 'image', projectId, path });
  void window.agentrix.revealPath(projectId, path).then(result => { if (!result.ok) onError(t(result.error)); })
    .catch(() => onError(t('无法在文件管理器中显示此路径。')));
}
