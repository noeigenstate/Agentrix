import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { FileHtml, FileText, FilmStrip, Image as ImageIcon } from '@phosphor-icons/react';
import type { FileCard as Card } from '../../shared/types';
import { t } from '../../shared/i18n';
import { showPopup } from '../files/file-popup';
import './file-cards.css';
import { pathTooltip } from './reading-paths';

const PREVIEWED = /\.(?:md|markdown|mdx|html?|mp4|m4v|webm|ogv|ogg|mov|mkv|avi|png|jpe?g|gif|webp|bmp)$/i;
export const previewable = (file: string) => PREVIEWED.test(file);
const SHOWN = 4;
// Main has resolved the file against its local/remote cwd. Windows paths are
// case insensitive; POSIX paths (including SSH) retain their case.
const imagePathKey = (file: string, remote = false) => remote || /^\/(?!\/)/.test(file) ? file : file.replace(/\\/g, '/').toLowerCase();

// The documents, pages, videos and images a group of steps wrote (or a reply named), as small cards under it: a
// Markdown file laid out, a picture of an HTML page, a video that plays where it is, the image itself. Nothing is read
// until a card scrolls into view; a click shows the file in a popup over the conversation, never on the project's page.
// quiet: a file that cannot be shown leaves no card (a reply may name a picture that is not there).
export function FileCards({ projectId, files, renderMarkdown, onError, quiet = false, excludeImages = [] }: {
  projectId: string; files: string[]; renderMarkdown: (text: string) => ReactNode; onError: (message: string) => void; quiet?: boolean; excludeImages?: string[];
}) {
  const [all, setAll] = useState(false);
  const scope = JSON.stringify([projectId, files, excludeImages]), current = useRef(scope); current.current = scope;
  const [resolved, setResolved] = useState<{ scope: string; paths: Record<string, string> }>({ scope, paths: {} });
  const onResolved = useCallback((file: string, card: Card) => {
    if (card.kind !== 'image') return;
    const key = imagePathKey(card.path, card.remote);
    setResolved(previous => {
      if (current.current !== scope) return previous;
      const paths = previous.scope === scope ? previous.paths : {};
      return paths[file] === key ? previous : { scope, paths: { ...paths, [file]: key } };
    });
  }, [scope]);
  const paths = resolved.scope === scope ? resolved.paths : {}, used = new Set(excludeImages.map(file => imagePathKey(file)));
  const unique = files.filter(file => {
    const key = paths[file]; if (!key) return true;
    if (used.has(key)) return false;
    used.add(key); return true;
  });
  const shown = all ? unique : unique.slice(0, SHOWN);
  return <div className="file-cards">
    {shown.map(file => <FileCard key={file} projectId={projectId} file={file} renderMarkdown={renderMarkdown} onError={onError} quiet={quiet} onResolved={onResolved} />)}
    {unique.length > SHOWN && !all && <button type="button" className="text-button file-cards-more" onClick={() => setAll(true)}>{t('还有 {count} 个文件', { count: unique.length - SHOWN })}</button>}
  </div>;
}

function FileCard({ projectId, file, renderMarkdown, onError, quiet, onResolved }: { projectId: string; file: string; renderMarkdown: (text: string) => ReactNode; onError: (message: string) => void; quiet: boolean; onResolved: (file: string, card: Card) => void }) {
  const root = useRef<HTMLDivElement>(null), video = useRef<HTMLVideoElement>(null);
  // failed: why the card could not be made, shown again when it is clicked.
  const [card, setCard] = useState<Card | null>(null), [failed, setFailed] = useState<string | null>(null), [seen, setSeen] = useState(false);
  // Asked for once it is near the view; a video that leaves the view stops playing.
  useEffect(() => {
    const node = root.current; if (!node) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setSeen(true);
      else video.current?.pause();
    }, { rootMargin: '200px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!seen) return;
    let live = true;
    setCard(null); setFailed(null);
    void window.agentrix.fileCard(projectId, file).then(result => { if (!live) return; if (result.ok) { setCard(result.value); onResolved(file, result.value); } else setFailed(result.error); }).catch(() => { if (live) setFailed('无法预览此文件。'); });
    return () => { live = false; };
  }, [seen, projectId, file, onResolved]);
  const name = file.split(/[\\/]/).pop() || file;
  const kind = card?.kind ?? (/\.html?$/i.test(file) ? 'html' : /\.(?:md|markdown|mdx)$/i.test(file) ? 'markdown' : /\.(?:png|jpe?g|gif|webp|bmp)$/i.test(file) ? 'image' : 'video');
  const Icon = kind === 'html' ? FileHtml : kind === 'video' ? FilmStrip : kind === 'image' ? ImageIcon : FileText;
  // Standalone local images open by absolute path; images on a project share open through its file boundary.
  // A Markdown file outside the project is read as a document; pages and videos resolve their own preview folder.
  const show = (shown: Card) => {
    if (shown.kind === 'image' && !shown.remote && /^(?:[a-z]:[\\/]|\/(?!\/))/i.test(shown.path)) return showPopup({ kind: 'image', path: shown.path });
    if (shown.kind === 'markdown' && shown.outside) return showPopup({ kind: 'document', projectId, path: shown.path });
    showPopup({ kind: 'file', projectId, path: shown.path });
  };
  // A click before the card loaded still resolves through the main process, never the raw agent path.
  const open = async () => {
    if (card) { show(card); return; }
    if (failed) { onError(t(failed)); return; }
    try {
      const result = await window.agentrix.fileCard(projectId, file);
      if (result.ok) { setCard(result.value); onResolved(file, result.value); show(result.value); }
      else onError(t(result.error));
    } catch { onError(t('无法预览此文件。')); }
  };
  if (quiet && failed) return null;
  return <div ref={root} className={`file-card is-${kind}`}>
    {card?.kind === 'video'
      ? <video ref={video} src={card.url} preload="metadata" controls playsInline />
      : <button type="button" className="file-card-view" data-reading-path={file} title={`${t('打开 {name}', { name })}\n${pathTooltip(file)}`} aria-label={t('打开 {name}', { name })} onClick={open}>
        {card?.kind === 'markdown' ? <div className="file-card-doc" aria-hidden="true">{renderMarkdown(card.excerpt)}</div>
          : (card?.kind === 'html' || card?.kind === 'image') && card.picture ? <img src={card.picture} alt={card.kind === 'image' ? name : ''} />
          : <span className="file-card-empty"><Icon size={26} weight="light" />{failed ? t('无法预览') : card ? t('没有可显示的画面') : null}</span>}
      </button>}
    <button type="button" className="file-card-name" data-reading-path={file} title={`${file}\n${pathTooltip(file)}`} onClick={open}><Icon size={13} />{name}</button>
  </div>;
}
