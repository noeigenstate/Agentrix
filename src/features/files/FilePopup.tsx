import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { ArrowUp, CaretLeft, CaretRight, File, FileText, FilmStrip, Folder, Globe, Image as ImageIcon, SpinnerGap, X } from '@phosphor-icons/react';
import type { DirectoryListing, FilePreview as Preview } from '../../shared/types';
import { TextContent } from './FilePreview';
import { closePopup, showPopup, type PopupTarget } from './file-popup';
import { t } from '../../shared/i18n';
import './file-popup.css';
const MarkdownPreview = lazy(() => import('./MarkdownPreview').then(module => ({ default: module.MarkdownPreview })));

type Shown = { kind: 'preview'; preview: Preview } | { kind: 'picture'; url: string } | { kind: 'folder'; listing: DirectoryListing } | { kind: 'document'; content: string } | { kind: 'error'; message: string };

// A page, document, picture, video or folder shown over the current view, read only: Escape, the close button or a
// click beside it puts it away. A link inside a document, or an entry of a folder, opens the same way; a web address
// opens outside.
export function FilePopup({ target, onError }: { target: PopupTarget; onError: (message: string) => void }) {
  const [loaded, setLoaded] = useState<{ target: PopupTarget; page: number; value: Shown } | null>(null);
  const [selected, setSelected] = useState<{ target: PopupTarget; page: number } | null>(null);
  const [pageInput, setPageInput] = useState('1');
  const pageIndex = selected?.target === target ? selected.page : 0;
  const shown = loaded?.target === target && loaded.page === pageIndex ? loaded.value : null;
  // Keep the controls in place while the selected page loads, but never show the previous page as it.
  const previous = loaded?.target === target && loaded.value.kind === 'preview' ? loaded.value.preview : null;
  const textPage = previous?.kind === 'text' || previous?.kind === 'markdown' ? previous.page : null;
  const loading = !shown;
  const card = useRef<HTMLDivElement>(null);
  const fileName = target.path.split(/[\\/]/).filter(Boolean).at(-1) || target.path;
  const name = target.kind === 'folder' && !target.path ? t('项目根目录') : fileName;
  useEffect(() => {
    let live = true, previewId: string | null = null;
    const release = () => { const id = previewId; previewId = null; if (id) void window.agentrix.closePreview(id).catch(() => {}); };
    let read: Promise<Shown>;
    switch (target.kind) {
      case 'picture':
        read = Promise.resolve({ kind: 'picture', url: target.src });
        break;
      case 'image':
        read = window.agentrix.agentImage(target.path).then(result => result.ok ? { kind: 'picture', url: result.value.url } : { kind: 'error', message: result.error });
        break;
      case 'folder':
        read = window.agentrix.listDirectory(target.projectId, target.path).then(result => result.ok ? { kind: 'folder', listing: result.value } : { kind: 'error', message: result.error });
        break;
      case 'document':
        read = window.agentrix.agentDocument(target.projectId, target.path).then(result => result.ok ? { kind: 'document', content: result.value.truncated ? `${result.value.content}\n\n…` : result.value.content } : { kind: 'error', message: result.error });
        break;
      case 'file':
        read = window.agentrix.readFile(target.projectId, target.path, pageIndex).then(result => {
          if (!result.ok) return { kind: 'error', message: result.error };
          if ('previewId' in result.value) previewId = result.value.previewId;
          return { kind: 'preview', preview: result.value };
        });
        break;
    }
    void read.catch(() => ({ kind: 'error' as const, message: '无法预览此文件。' })).then(value => {
      if (live) setLoaded({ target, page: pageIndex, value }); else release();
    });
    return () => { live = false; release(); };
  }, [target, pageIndex]);
  useEffect(() => { setPageInput(String(pageIndex + 1)); }, [target, pageIndex]);
  const selectPage = (index: number) => {
    if (textPage) setSelected({ target, page: Math.max(0, Math.min(textPage.count - 1, index)) });
  };
  // Escape here never reaches the conversation behind it (where it would interrupt the agent).
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    card.current?.focus({ preventScroll: true });
    const keys = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePopup(); } };
    window.addEventListener('keydown', keys, true);
    return () => { window.removeEventListener('keydown', keys, true); if (before?.isConnected) before.focus({ preventScroll: true }); };
  }, []);
  const openLink = (link: string) => {
    if (target.kind === 'image' || target.kind === 'picture') return;
    const projectId = target.projectId;
    void window.agentrix.openLink(projectId, link).then(result => {
      if (!result.ok) onError(result.error);
      else if (result.value.kind !== 'external') showPopup({ kind: result.value.kind === 'file' ? 'file' : 'folder', projectId, path: result.value.path });
    });
  };
  const parent = target.kind === 'folder' && target.path ? target.path.split('/').slice(0, -1).join('/') : null;
  const preview = shown?.kind === 'preview' ? shown.preview : null;
  const Icon = target.kind === 'folder' ? Folder : target.kind === 'image' || target.kind === 'picture' || preview?.kind === 'image' ? ImageIcon : preview?.kind === 'video' ? FilmStrip : preview?.kind === 'html' ? Globe : FileText;
  let body: ReactNode;
  if (!shown) body = <div className="file-popup-message"><SpinnerGap size={22} className="loading-spinner" />{t('正在读取文件…')}</div>;
  else if (shown.kind === 'error') body = <div className="file-popup-message" role="status"><Icon size={28} /><p>{t(shown.message)}</p></div>;
  else if (shown.kind === 'folder' && target.kind === 'folder') body = <div className="file-popup-folder" role="list">
    {parent !== null && <button type="button" role="listitem" onClick={() => showPopup({ ...target, path: parent })}><ArrowUp size={15} />{t('上一级')}</button>}
    {shown.listing.entries.map(entry => <button type="button" role="listitem" key={entry.path} title={entry.path}
      onClick={() => entry.kind === 'link' ? openLink(entry.path) : showPopup({ kind: entry.kind === 'directory' ? 'folder' : 'file', projectId: target.projectId, path: entry.path })}>
      {entry.kind === 'directory' ? <Folder size={15} weight="fill" /> : <File size={15} />}{entry.name}</button>)}
    {!shown.listing.entries.length && <p className="file-popup-message">{t('这个文件夹是空的。')}</p>}
  </div>;
  // Only its web links work: it has no folder of its own here for relative links and pictures to come from.
  else if (shown.kind === 'document') body = <div className="file-popup-document"><Suspense fallback={<div className="file-popup-message">{t('正在渲染 Markdown…')}</div>}><MarkdownPreview content={shown.content} baseUrl="about:blank" onOpenLink={openLink} /></Suspense></div>;
  else if (shown.kind === 'picture') body = <Picture url={shown.url} name={fileName} />;
  else if (preview?.kind === 'image') body = <Picture url={preview.url} name={fileName} />;
  else if (preview?.kind === 'html') body = <iframe className="html-preview-frame" title={t('HTML 页面预览')} src={preview.url} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />;
  else if (preview?.kind === 'markdown') body = <div className="file-popup-document"><Suspense fallback={<div className="file-popup-message">{t('正在渲染 Markdown…')}</div>}><MarkdownPreview content={preview.content} baseUrl={preview.url} onOpenLink={openLink} /></Suspense></div>;
  else if (preview?.kind === 'video') body = <div className="file-popup-video"><video src={preview.url} controls autoPlay preload="metadata" playsInline aria-label={t('视频预览')} /></div>;
  else if (preview?.kind === 'text') body = <TextContent key={pageIndex} content={preview.content} />;
  else body = <div className="file-popup-message"><FileText size={28} /><p>{preview?.kind === 'unsupported' ? t(preview.reason) : t('无法预览此文件。')}</p></div>;
  const wide = preview?.kind === 'html' || preview?.kind === 'text' || preview?.kind === 'markdown' || shown?.kind === 'document' || !!textPage;
  const picture = shown?.kind === 'picture' || preview?.kind === 'image';
  return <div className="file-popup-overlay" onMouseDown={event => { if (event.target === event.currentTarget) closePopup(); }}>
    <div ref={card} className={`file-popup${wide ? ' is-wide' : ''}${picture ? ' is-picture' : ''}`} role="dialog" aria-modal="true" aria-label={name} tabIndex={-1}>
      <div className="file-popup-head"><Icon size={15} /><strong title={target.path}>{name}</strong><small>{t('Esc 关闭')}</small>
        <button type="button" className="icon-button" title={t('关闭')} aria-label={t('关闭')} onClick={closePopup}><X size={15} /></button></div>
      <div className="file-popup-body">{body}</div>
      {textPage && textPage.count > 1 && <form className="text-pagination file-popup-pagination" onSubmit={event => { event.preventDefault(); const value = Number(pageInput); if (Number.isSafeInteger(value)) selectPage(value - 1); }}>
        <button type="button" className="preview-option" disabled={!pageIndex || loading} onClick={() => selectPage(0)}>{t('首页')}</button>
        <button type="button" className="icon-button" aria-label={t('上一页')} disabled={!pageIndex || loading} onClick={() => selectPage(pageIndex - 1)}><CaretLeft size={15} /></button>
        <label>{t('第')} <input aria-label={t('文件页码')} type="number" min={1} max={textPage.count} value={pageInput} onChange={event => setPageInput(event.target.value)} /> {t('/ {count} 页', { count: textPage.count })}</label>
        <button type="submit" className="preview-option" disabled={loading}>{t('跳转')}</button>
        <button type="button" className="icon-button" aria-label={t('下一页')} disabled={pageIndex >= textPage.count - 1 || loading} onClick={() => selectPage(pageIndex + 1)}><CaretRight size={15} /></button>
        <button type="button" className="preview-option" disabled={pageIndex >= textPage.count - 1 || loading} onClick={() => selectPage(textPage.count - 1)}>{t('末页')}</button>
      </form>}
    </div>
  </div>;
}

// A picture fits the window whole. One larger than that shows at its own size on a click, at the spot clicked; there
// the mouse drags it about, and another click fits it again.
function Picture({ url, name }: { url: string; name: string }) {
  const [full, setFull] = useState(false), [larger, setLarger] = useState(false);
  const box = useRef<HTMLDivElement>(null), image = useRef<HTMLImageElement>(null);
  const focus = useRef<{ x: number; y: number; at: { x: number; y: number } } | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  // Whether the window shows it smaller than it is, measured while it fits.
  const measure = () => { const img = image.current; if (img && !full) setLarger(img.naturalWidth > img.clientWidth + 1 || img.naturalHeight > img.clientHeight + 1); };
  useEffect(() => { if (full) return; measure(); window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure); }, [full]);
  // At its own size, the point clicked stays under the pointer.
  useLayoutEffect(() => {
    const spot = focus.current, view = box.current, img = image.current; focus.current = null;
    if (!full || !spot || !view || !img) return;
    const frame = view.getBoundingClientRect();
    view.scrollLeft = spot.x * img.naturalWidth - (spot.at.x - frame.left);
    view.scrollTop = spot.y * img.naturalHeight - (spot.at.y - frame.top);
  }, [full]);
  const press = (event: ReactMouseEvent) => {
    if (event.button !== 0 || !box.current) return;
    event.preventDefault();
    drag.current = { x: event.clientX, y: event.clientY, left: box.current.scrollLeft, top: box.current.scrollTop, moved: false };
    const move = (moving: MouseEvent) => {
      const start = drag.current, view = box.current; if (!start || !view) return;
      if (Math.abs(moving.clientX - start.x) + Math.abs(moving.clientY - start.y) > 4) start.moved = true;
      if (full && start.moved) { view.scrollLeft = start.left - (moving.clientX - start.x); view.scrollTop = start.top - (moving.clientY - start.y); }
    };
    const release = (released: MouseEvent) => {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', release);
      const start = drag.current; drag.current = null;
      if (!start || start.moved || !(full || larger)) return;
      const img = image.current?.getBoundingClientRect();
      if (!full && img) focus.current = { x: (released.clientX - img.left) / img.width, y: (released.clientY - img.top) / img.height, at: { x: released.clientX, y: released.clientY } };
      setFull(!full);
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', release);
  };
  const hint = full ? t('拖动查看，单击缩小到窗口大小') : larger ? t('单击查看原始大小') : undefined;
  return <div ref={box} className={`file-popup-picture${full ? ' is-full' : larger ? ' is-larger' : ''}`} title={hint} onMouseDown={press}>
    <img ref={image} src={url} alt={name} draggable={false} onLoad={measure} />
  </div>;
}
