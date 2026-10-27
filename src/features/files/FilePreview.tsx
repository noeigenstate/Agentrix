import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowClockwise, CaretLeft, CaretRight, Copy, FileText, FilmStrip, Globe, Image as ImageIcon, MagnifyingGlassMinus, MagnifyingGlassPlus, PencilSimple, SpinnerGap, Terminal, X } from '@phosphor-icons/react';
import type { FilePreview as Preview, GitDiff, Result } from '../../shared/types';
import { CodeEditor, findConflicts, resolveConflict, type Conflict } from './CodeEditor';
import { runEditorKey } from './editor-commands';
import { t } from '../../shared/i18n';
const MarkdownPreview = lazy(() => import('./MarkdownPreview').then(module => ({ default: module.MarkdownPreview })));

export function TextContent({ content }: { content: string }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 700 });
  const lines = useMemo(() => content.split('\n'), [content]);
  const width = useMemo(() => lines.reduce((max, line) => Math.max(max, Math.min(line.length, 2000)), 0), [lines]);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const resize = new ResizeObserver(() => setScroll(value => ({ ...value, height: node.clientHeight })));
    resize.observe(node);
    return () => resize.disconnect();
  }, []);
  const first = Math.max(0, Math.floor((scroll.top - 16) / 22) - 8);
  const last = Math.min(lines.length, first + Math.ceil(scroll.height / 22) + 20);
  const visible = lines.slice(first, last);
  return <div className="file-code-scroll" ref={viewport} onScroll={event => { const top = event.currentTarget.scrollTop; setScroll(value => ({ ...value, top })); }}>
    <div className="file-code-page" style={{ height: lines.length * 22 + 44, minWidth: width * 7.3 + 90 }}>
      <div className="file-code" style={{ top: first * 22 }}><div className="line-numbers" aria-hidden="true">{visible.map((_, index) => <span key={first + index}>{first + index + 1}</span>)}</div><pre tabIndex={0} aria-label={t('文件文本内容')}><code>{visible.join('\n') || ' '}</code></pre></div>
    </div>
  </div>;
}

function fileSize(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log2(Math.max(1, bytes)) / 10)));
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

export function FilePreview({ projectId, filePath, autoSave, onClose, onError, registerGuard, onOpenLink }: {
  // autoSave: edits are written after a short pause in typing, and before leaving the file.
  projectId: string; filePath: string; autoSave: boolean; onClose: () => void; onError: (message: string) => void;
  registerGuard: (guard: (() => Promise<boolean>) | null) => void;
  onOpenLink: (target: string) => void;
}) {
  const [loaded, setLoaded] = useState<{ key: string; result: Result<Preview> } | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'preview' | 'source'>(/\.html?$/i.test(filePath) ? 'preview' : 'source');
  const modeRef = useRef(mode); modeRef.current = mode;
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [imageError, setImageError] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageInput, setPageInput] = useState('1');
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(''), [saving, setSaving] = useState(false);
  const [writing, setWriting] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const guard = useRef<() => Promise<boolean>>(async () => true);
  const dirtyRef = useRef(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const key = `${projectId}:${filePath}:${pageIndex}`;
  // A save owns its file/page and revision until it finishes, independently of React rendering.
  const session = useMemo(() => ({ live: true, preview: null as Preview | null, draft: '',
    task: null as Promise<boolean> | null, flush: false, resources: new Set<string>() }), [key, revision]);
  const sessionRef = useRef(session); sessionRef.current = session;
  const autoSaveRef = useRef(autoSave); autoSaveRef.current = autoSave;
  const currentSession = () => session.live && sessionRef.current === session;
  const preview = loaded?.key === key && loaded.result.ok ? loaded.result.value : null;
  const error = loaded?.key === key && !loaded.result.ok ? loaded.result.error : null;
  const previewId = preview && 'previewId' in preview ? preview.previewId : null;
  const previewUrl = preview && 'url' in preview ? preview.url : null;
  const text = preview?.kind === 'text' || preview?.kind === 'html' || preview?.kind === 'markdown' ? preview.content : null;
  const textPage = preview?.kind === 'text' || preview?.kind === 'html' || preview?.kind === 'markdown' ? preview.page : null;
  const markdown = preview?.kind === 'markdown';
  const showingText = preview?.kind === 'text' || markdown || (preview?.kind === 'html' && (mode === 'source' || editing));
  const savedText = useMemo(() => (text || '').replace(/\r\n/g, '\n'), [text]);
  const dirty = editing && draft !== savedText;
  // Git: lines changed in the working tree but not staged, as the Git sidebar lists them (read again after
  // each save), and conflicts left in the text.
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const conflictCount = useMemo(() => editing ? findConflicts(draft).length : 0, [editing, draft]);
  dirtyRef.current = dirty;

  // quiet: an automatic save. The editor stays enabled and keeps its focus, and whatever was typed
  // while the file was being written stays in the editor and follows it in the next serial write.
  session.draft = draft;
  const save = (quiet = false): Promise<boolean> => {
    if (!currentSession()) return Promise.resolve(false);
    if (!quiet && (session.task || dirtyRef.current)) { session.flush = true; setSaving(true); }
    if (session.task) return session.task;
    if (!session.preview || !('content' in session.preview) || !editing || !dirtyRef.current) return Promise.resolve(true);
    setSaveMessage(''); setWriting(true);
    const task = (async () => {
      while (currentSession() && session.preview && 'content' in session.preview) {
        const base = session.preview, sent = session.draft;
        const result = await window.agentrix.saveFile(projectId, filePath, base.page.index, base.revision, sent);
        if (!currentSession()) {
          if (result.ok && 'previewId' in result.value) void window.agentrix.closePreview(result.value.previewId).catch(() => {});
          return false;
        }
        if (!result.ok) { setSaveMessage(result.error); return false; }
        session.preview = result.value;
        if ('previewId' in result.value) session.resources.add(result.value.previewId);
        setLoaded({ key, result });
        const saved = 'content' in result.value ? result.value.content.replace(/\r\n/g, '\n') : null;
        if (saved !== null && session.draft === sent) {
          session.draft = saved;
          setDraft(session.draft);
        }
        dirtyRef.current = saved !== null && session.draft !== saved;
        if (!dirtyRef.current) {
          window.agentrix.editorDirty(false);
          setSaveMessage(session.flush ? t('已保存') : t('已自动保存')); return true;
        }
        // The next write uses the returned revision, even if a debounce fired during this write.
        // Disabling auto save leaves newer edits dirty unless an explicit save requested a flush.
        if (!session.flush && !autoSaveRef.current) return true;
      }
      return false;
    })().catch(error => { if (currentSession()) setSaveMessage(String(error.message || error)); return false; })
      .finally(() => { session.task = null; session.flush = false; if (currentSession()) { setSaving(false); setWriting(false); } });
    session.task = task; return task;
  };
  const saveRef = useRef(save); saveRef.current = save;
  // Auto save: one second after the last keystroke, and at once when the window loses focus. A save
  // that fails (the file changed on disk) shows its message and waits for the next edit.
  useEffect(() => {
    if (!autoSave || !dirty) return;
    const timer = setTimeout(() => void saveRef.current(true), 1000);
    const blur = () => void saveRef.current(true);
    window.addEventListener('blur', blur);
    return () => { clearTimeout(timer); window.removeEventListener('blur', blur); };
  }, [autoSave, dirty, draft]);
  guard.current = async () => {
    if (session.task && !await session.task) return false;
    if (!currentSession()) return false;
    if (!dirtyRef.current) return true;
    // With auto save, leaving the file saves it; the question is asked only when that fails.
    if (autoSaveRef.current) {
      const saved = await saveRef.current(true);
      if (!currentSession()) return false;
      if (saved && !dirtyRef.current) return true;
    }
    const result = await window.agentrix.confirmEditorClose(filePath);
    if (!currentSession()) return false;
    if (!result.ok || result.value === 'cancel') return false;
    if (result.value === 'save') return saveRef.current();
    dirtyRef.current = false; window.agentrix.editorDirty(false);
    session.draft = session.preview && 'content' in session.preview ? session.preview.content.replace(/\r\n/g, '\n') : '';
    setDraft(session.draft); return true;
  };
  useEffect(() => {
    registerGuard(() => guard.current());
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirtyRef.current || sessionRef.current.task) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { registerGuard(null); window.agentrix.editorDirty(false); window.removeEventListener('beforeunload', beforeUnload); };
  }, [registerGuard]);
  useEffect(() => { window.agentrix.editorDirty(dirty || saving || writing, projectId, filePath); }, [dirty, saving, writing, projectId, filePath]);
  const navigate = async (action: () => void) => { if (await guard.current() && currentSession()) { setEditing(false); setSaveMessage(''); action(); } };
  const beginEditing = () => { if (text === null) return; if (!editing) setDraft(savedText); setEditing(true); setMode('source'); setSaveMessage(''); requestAnimationFrame(() => editor.current?.focus()); };

  useEffect(() => { setImageError(false); setVideoError(false); }, [previewUrl]);
  useEffect(() => {
    let active = true; setDiff(null);
    // Paged large files number each page from 1, which Git's line numbers would not match.
    if (!editing || !textPage || textPage.count > 1) return;
    // An untracked file is compared with nothing, so all of it is new; a file with unresolved conflicts shows
    // its conflict regions instead.
    (async () => {
      const status = await window.agentrix.gitStatus(projectId);
      if (!active || !status.ok || !status.value.repository) return;
      const file = status.value.files.find(item => item.path === filePath);
      if (file?.conflict) return;
      const result = await window.agentrix.gitDiff(projectId, filePath, { untracked: file?.untracked === true });
      if (active && result.ok && result.value.repository && !result.value.binary) setDiff(result.value);
    })().catch(() => {});
    return () => { active = false; };
  }, [projectId, filePath, editing, textPage?.count, preview?.revision]);
  useEffect(() => { if (textPage) setPageInput(String(textPage.index + 1)); }, [textPage?.index]);
  useEffect(() => {
    session.live = true;
    return () => { session.live = false; for (const id of session.resources) void window.agentrix.closePreview(id).catch(() => {}); session.resources.clear(); };
  }, [session]);
  useEffect(() => {
    for (const id of session.resources) if (id !== previewId) { session.resources.delete(id); void window.agentrix.closePreview(id).catch(() => {}); }
  }, [session, previewId]);
  useEffect(() => {
    let active = true;
    setLoading(true); setSaving(false); setWriting(false); setEditing(false);
    window.agentrix.readFile(projectId, filePath, pageIndex).then(result => {
      if (!active) {
        if (result.ok && 'previewId' in result.value) void window.agentrix.closePreview(result.value.previewId).catch(() => {});
        return;
      }
      session.preview = result.ok ? result.value : null;
      if (result.ok && 'previewId' in result.value) session.resources.add(result.value.previewId);
      setLoaded({ key, result }); setSaveMessage('');
      if (result.ok && 'content' in result.value) {
        session.draft = result.value.content.replace(/\r\n/g, '\n'); setDraft(session.draft);
        const editable = result.value.kind !== 'html' || modeRef.current === 'source';
        setEditing(editable);
        if (editable && result.value.kind !== 'markdown') setMode('source');
      } else setEditing(false);
    }).catch(err => { if (active) setLoaded({ key, result: { ok: false, error: String(err.message || err) } }); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId, filePath, key, pageIndex, revision]);
  const openVideo = async () => { const result = await window.agentrix.openVideo(projectId, filePath); if (!result.ok) onError(result.error); };
  const changeZoom = (step: number) => setZoom(value => Math.max(.1, Math.min(4, (value === 'fit' ? 1 : value) + step)));
  const Icon = preview?.kind === 'image' ? ImageIcon : preview?.kind === 'video' ? FilmStrip : preview?.kind === 'html' ? Globe : FileText;

  // A conflict is resolved only when the user picks a side; it is an ordinary edit (Ctrl+Z undoes it) saved with Ctrl+S.
  const resolve = (conflict: Conflict, choice: 'current' | 'incoming' | 'both') => {
    const node = editor.current; if (!node) return;
    const { from, to, replacement } = resolveConflict(node.value, conflict, choice);
    node.focus(); node.setSelectionRange(from, to);
    if (!document.execCommand(replacement ? 'insertText' : 'delete', false, replacement)) setDraft(node.value.slice(0, from) + replacement + node.value.slice(to));
  };
  const editorField = <CodeEditor editor={editor} text={draft} diff={diff} onResolve={resolve}><textarea ref={editor} className="file-text-editor" aria-label={t('文件编辑器')} value={draft} spellCheck={false} wrap="off" disabled={saving}
    onChange={event => { session.draft = event.target.value; dirtyRef.current = session.draft !== savedText; setDraft(session.draft); setSaveMessage(''); }} onFocus={() => { window.agentrix.terminalFocus(projectId, false); window.agentrix.fileTreeFocus(projectId, false); }}
    onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); void save(); }
      else runEditorKey(event.nativeEvent, event.currentTarget, filePath);
    }} /></CodeEditor>;
  const markdownBody = markdown && previewUrl ? <Suspense fallback={<div className="file-preview-message">{t('正在渲染 Markdown…')}</div>}><MarkdownPreview content={editing ? draft : text || ''} baseUrl={previewUrl} onOpenLink={onOpenLink} /></Suspense> : null;
  let body;
  if (editing && text !== null) body = markdown ? <div className="markdown-editor-surface"><div className="markdown-source-pane" hidden={mode === 'preview'}>{editorField}</div>{mode === 'preview' && markdownBody}</div> : editorField;
  else if (loading && !preview) body = <div className="file-preview-message"><SpinnerGap size={22} className="loading-spinner" />{t('正在读取文件…')}</div>;
  else if (error) body = <div className="file-preview-message" role="status"><FileText size={28} /><p>{error}</p><button className="button secondary small" onClick={() => setRevision(r => r + 1)}>{t('重试')}</button></div>;
  else if (preview?.kind === 'image') body = imageError
    ? <div className="file-preview-message" role="status"><ImageIcon size={28} /><p>{t('图片无法显示，请确认文件完整后刷新。')}</p><button className="button secondary small" onClick={() => setRevision(r => r + 1)}>{t('重新加载图片')}</button></div>
    : <div className="image-viewport"><div className={`image-canvas ${zoom === 'fit' ? 'image-fit' : 'image-zoomed'}`}>
      <img key={preview.url} className="preview-image" src={preview.url} alt={preview.name} draggable={false}
        style={zoom !== 'fit' && dimensions.width ? { width: dimensions.width * zoom, height: dimensions.height * zoom } : undefined}
        onLoad={event => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        onError={() => setImageError(true)} />
    </div></div>;
  else if (preview?.kind === 'html' && mode === 'preview') body = <iframe key={preview.url} className="html-preview-frame" title={t('HTML 页面预览')} src={preview.url} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />;
  else if (markdown && mode === 'preview') body = markdownBody;
  else if (preview?.kind === 'video') body = videoError
    ? <div className="file-preview-message" role="status"><FilmStrip size={28} /><p>{t('当前视频编码无法在应用中播放，或文件尚未生成完整。')}</p><button className="button secondary small" onClick={openVideo}>{t('用系统播放器打开')}</button><button className="text-button" onClick={() => setRevision(r => r + 1)}>{t('重新加载视频')}</button></div>
    : <div className="video-viewport"><video key={preview.url} className="preview-video" src={preview.url} controls preload="metadata" playsInline aria-label={t('视频预览')} onError={() => setVideoError(true)} /></div>;
  else if (text !== null) body = <TextContent key={`${key}:${revision}`} content={text} />;
  else body = <div className="file-preview-message"><FileText size={28} /><p>{preview?.kind === 'unsupported' ? t(preview.reason) : t('无法预览此文件。')}</p></div>;

  return <section className="file-preview" aria-label={t('文件预览')} onKeyDown={event => { if (editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); void save(); } }}>
    <div className="file-tabs"><button className="terminal-tab" onClick={onClose}><Terminal size={15} />{t('返回终端')}</button><div className="selected-file-tab"><Icon size={15} /><span>{filePath.split('/').at(-1)}{dirty ? ' •' : ''}</span><button className="icon-button" title={t('关闭文件预览')} aria-label={t('关闭文件预览')} onClick={onClose}><X size={14} /></button></div><span className={`preview-readonly ${editing && (dirty || conflictCount) ? 'is-dirty' : ''}`} role="status">{t(markdown && mode === 'preview' ? dirty ? '预览 · 未保存' : 'Markdown 预览' : editing ? saving ? '编辑模式 · 保存中…' : autoSave ? '编辑模式 · 自动保存' : dirty ? '编辑模式 · 未保存，Ctrl+S 保存' : '编辑模式' : preview?.kind === 'image' ? '图片预览' : preview?.kind === 'video' ? '视频预览' : preview?.kind === 'html' ? '网页预览' : '文本预览')}{editing && conflictCount ? t(' · {count} 处冲突', { count: conflictCount }) : ''}</span></div>
    <div className="file-preview-toolbar"><span title={filePath}>{filePath.split('/').join('  /  ')}</span><div>
      {preview?.kind === 'image' && <div className="image-controls">
        <button className="preview-option" aria-pressed={zoom === 'fit'} onClick={() => setZoom('fit')}>{t('适应窗口')}</button>
        <button className="preview-option" aria-pressed={zoom === 1} onClick={() => setZoom(1)}>{t('原始尺寸')}</button>
        <button className="icon-button" title={t('缩小图片')} aria-label={t('缩小图片')} onClick={() => changeZoom(-.25)}><MagnifyingGlassMinus size={16} /></button>
        <span className="zoom-label">{zoom === 'fit' ? t('自动') : `${Math.round(zoom * 100)}%`}</span>
        <button className="icon-button" title={t('放大图片')} aria-label={t('放大图片')} onClick={() => changeZoom(.25)}><MagnifyingGlassPlus size={16} /></button>
      </div>}
      {preview?.kind === 'html' && <div className="preview-mode"><button className="preview-option" aria-pressed={mode === 'preview' && !editing} onClick={() => void navigate(() => setMode('preview'))}>{t('页面')}</button><button className="preview-option" aria-pressed={mode === 'source' || editing} onClick={beginEditing}>{t('源码')}</button></div>}
      {markdown && <div className="preview-mode"><button className="preview-option" aria-pressed={mode === 'source'} onClick={beginEditing}>{t('编辑')}</button><button className="preview-option" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>{t('预览')}</button></div>}
      {text !== null && !editing && !markdown && preview?.kind !== 'html' && <button className="preview-option editor-action" disabled={loading} onClick={beginEditing}><PencilSimple size={15} />{textPage && textPage.count > 1 ? t('编辑当前段') : t('编辑')}</button>}
      {!editing && <button className="icon-button" disabled={saving} title={t('刷新文件')} aria-label={t('刷新文件')} onClick={() => void navigate(() => setRevision(r => r + 1))}><ArrowClockwise size={16} /></button>}
      {text !== null && !editing && <button className="icon-button" title={textPage && textPage.count > 1 ? t('复制当前页内容') : t('复制文件内容')} aria-label={textPage && textPage.count > 1 ? t('复制当前页内容') : t('复制文件内容')} onClick={async () => { const result = await window.agentrix.copy(text); if (!result.ok) onError(result.error); }}><Copy size={16} /></button>}
    </div></div>
    {body}
    {saveMessage && <div className={`editor-message ${saveMessage === t('已保存') || saveMessage === t('已自动保存') ? '' : 'editor-error'}`} role="status">{saveMessage}</div>}
    {showingText && textPage && textPage.count > 1 && <form className="text-pagination" onSubmit={event => { event.preventDefault(); const value = Number(pageInput); if (Number.isSafeInteger(value)) void navigate(() => setPageIndex(Math.max(0, Math.min(textPage.count - 1, value - 1)))); }}>
      <span>{t('分段读取 · 编辑仅影响当前段')}</span><button type="button" className="preview-option" disabled={!textPage.index || loading || saving} onClick={() => void navigate(() => setPageIndex(0))}>{t('首页')}</button>
      <button type="button" className="icon-button" aria-label={t('上一页')} disabled={!textPage.index || loading || saving} onClick={() => void navigate(() => setPageIndex(textPage.index - 1))}><CaretLeft size={15} /></button>
      <label>{t('第')} <input aria-label={t('文件页码')} type="number" min={1} max={textPage.count} value={pageInput} onChange={event => setPageInput(event.target.value)} /> {t('/ {count} 页', { count: textPage.count })}</label><button type="submit" className="preview-option" disabled={loading}>{t('跳转')}</button>
      <button type="button" className="icon-button" aria-label={t('下一页')} disabled={textPage.index === textPage.count - 1 || loading || saving} onClick={() => void navigate(() => setPageIndex(textPage.index + 1))}><CaretRight size={15} /></button>
      <button type="button" className="preview-option" disabled={textPage.index === textPage.count - 1 || loading || saving} onClick={() => void navigate(() => setPageIndex(textPage.count - 1))}>{t('末页')}</button>
    </form>}
    <div className="file-preview-footer"><span>{preview ? fileSize(preview.size) : ''}{preview?.kind === 'image' && dimensions.width > 0 ? ` · ${dimensions.width} × ${dimensions.height}` : ''}{showingText && textPage ? ` · ${textPage.encoding.toUpperCase()}` : ''}{markdown ? ' · Markdown' : ''}</span><span>{markdown && mode === 'preview' && dirty ? t('正在预览未保存的修改') : t('查看与编辑文件时，终端任务继续运行')}</span></div>
  </section>;
}
