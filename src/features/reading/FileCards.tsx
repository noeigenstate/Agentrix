import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FileHtml, FileText, FilmStrip, Image as ImageIcon } from '@phosphor-icons/react';
import type { FileCard as Card } from '../../shared/types';
import { t } from '../../shared/i18n';
import { showPopup } from '../files/file-popup';
import './file-cards.css';
import { pathTooltip } from './reading-paths';

const PREVIEWED = /\.(?:md|markdown|mdx|html?|mp4|m4v|webm|ogv|ogg|mov|mkv|avi|png|jpe?g|gif|webp|bmp)$/i;
export const previewable = (file: string) => PREVIEWED.test(file);
const SHOWN = 4;

// The documents, pages, videos and images a group of steps wrote (or a reply named), as small cards under it: a
// Markdown file laid out, a picture of an HTML page, a video that plays where it is, the image itself. Nothing is read
// until a card scrolls into view; a click shows the file in a popup over the conversation, never on the project's page.
// quiet: a file that cannot be shown leaves no card (a reply may name a picture that is not there).
export function FileCards({ projectId, files, renderMarkdown, onError, quiet = false }: {
  projectId: string; files: string[]; renderMarkdown: (text: string) => ReactNode; onError: (message: string) => void; quiet?: boolean;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? files : files.slice(0, SHOWN);
  return <div className="file-cards">
    {shown.map(file => <FileCard key={file} projectId={projectId} file={file} renderMarkdown={renderMarkdown} onError={onError} quiet={quiet} />)}
    {files.length > SHOWN && !all && <button type="button" className="text-button file-cards-more" onClick={() => setAll(true)}>{t('还有 {count} 个文件', { count: files.length - SHOWN })}</button>}
  </div>;
}

function FileCard({ projectId, file, renderMarkdown, onError, quiet }: { projectId: string; file: string; renderMarkdown: (text: string) => ReactNode; onError: (message: string) => void; quiet: boolean }) {
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
    void window.agentrix.fileCard(projectId, file).then(result => { if (!live) return; if (result.ok) setCard(result.value); else setFailed(result.error); }).catch(() => { if (live) setFailed('无法预览此文件。'); });
    return () => { live = false; };
  }, [seen, projectId, file]);
  const name = file.split(/[\\/]/).pop() || file;
  const kind = card?.kind ?? (/\.html?$/i.test(file) ? 'html' : /\.(?:md|markdown|mdx)$/i.test(file) ? 'markdown' : /\.(?:png|jpe?g|gif|webp|bmp)$/i.test(file) ? 'image' : 'video');
  const Icon = kind === 'html' ? FileHtml : kind === 'video' ? FilmStrip : kind === 'image' ? ImageIcon : FileText;
  // An image on this computer is read by its own path; one in a remote project, like any file there, through the project.
  // A Markdown file outside the project is read as a document; pages and videos resolve their own preview folder.
  const show = (shown: Card) => showPopup(shown.kind === 'image' && !shown.remote ? { kind: 'image', path: shown.path }
    : shown.kind === 'markdown' && shown.outside ? { kind: 'document', projectId, path: shown.path } : { kind: 'file', projectId, path: shown.path });
  // A click before the card loaded still resolves through the main process, never the raw agent path.
  const open = async () => {
    if (card) { show(card); return; }
    if (failed) { onError(t(failed)); return; }
    try {
      const result = await window.agentrix.fileCard(projectId, file);
      if (result.ok) { setCard(result.value); show(result.value); }
      else onError(t(result.error));
    } catch { onError(t('无法预览此文件。')); }
  };
  if (quiet && failed) return null;
  return <div ref={root} className={`file-card is-${kind}`}>
    {card?.kind === 'video'
      ? <video ref={video} src={card.url} preload="metadata" controls playsInline />
      : <button type="button" className="file-card-view" data-reading-path={file} title={`${t('打开 {name}', { name })}\n${pathTooltip()}`} aria-label={t('打开 {name}', { name })} onClick={open}>
        {card?.kind === 'markdown' ? <div className="file-card-doc" aria-hidden="true">{renderMarkdown(card.excerpt)}</div>
          : (card?.kind === 'html' || card?.kind === 'image') && card.picture ? <img src={card.picture} alt={card.kind === 'image' ? name : ''} />
          : <span className="file-card-empty"><Icon size={26} weight="light" />{failed ? t('无法预览') : card ? t('没有可显示的画面') : null}</span>}
      </button>}
    <button type="button" className="file-card-name" data-reading-path={file} title={`${file}\n${pathTooltip()}`} onClick={open}><Icon size={13} />{name}</button>
  </div>;
}
