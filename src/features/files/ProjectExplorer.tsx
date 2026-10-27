import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import {
  ArrowsInLineVertical, CaretLeft, ArrowClockwise,
  CaretDown, CaretRight, Folder,
  DotsThree, Eye, EyeSlash, GitBranch, LinkSimple, SidebarSimple, SpinnerGap, FilePlus, FolderPlus, Clipboard,
} from '@phosphor-icons/react';
import type { DirectoryListing, FileEntry, Project } from '../../shared/types';
import { fileIcon, folderIcon } from './file-icons';
import { isCache, isQuiet } from './entry-noise';
import { useExplorerFileActions } from './ExplorerFileActions';
import { GitBadge, GitPanel, type GitOpenMode } from '../git/GitPanel';
import { gitDecorations, gitMark, type GitDecoration } from '../git/git-status';
import { useGitStatus } from '../git/useGitStatus';
import { t } from '../../shared/i18n';
import { shortcut } from '../shortcuts/shortcuts';

// Git titles come from git-status.ts in Chinese, joined with " · " (status · staged · rename); each part is translated.
const gitTitle = (title: string) => title.split(' · ').map(part => t(part)).join(' · ');

function FileIcon({ entry, open = false }: { entry: FileEntry; open?: boolean }) {
  if (entry.kind === 'directory') return folderIcon(open);
  if (entry.kind === 'link') return <LinkSimple className="file-icon" size={15} />;
  return fileIcon(entry.name);
}

function navigateTree(event: KeyboardEvent<HTMLButtonElement>, open: boolean, directory: boolean, toggle: () => void) {
  const tree = event.currentTarget.closest('[role="tree"]');
  const rows = [...(tree?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]') || [])];
  const index = rows.indexOf(event.currentTarget);
  const level = Number(event.currentTarget.getAttribute('aria-level'));
  let target: HTMLButtonElement | undefined;
  if (event.key === 'ArrowDown') target = rows[index + 1];
  else if (event.key === 'ArrowUp') target = rows[index - 1];
  else if (event.key === 'Home') target = rows[0];
  else if (event.key === 'End') target = rows.at(-1);
  else if (event.key === 'ArrowRight') {
    if (directory && !open) toggle();
    else if (open && Number(rows[index + 1]?.getAttribute('aria-level')) > level) target = rows[index + 1];
  } else if (event.key === 'ArrowLeft') {
    if (directory && open) toggle();
    else target = rows.slice(0, index).reverse().find(row => Number(row.getAttribute('aria-level')) < level);
  } else return;
  event.preventDefault();
  event.stopPropagation();
  target?.focus();
}

const indent = (depth: number) => 8 + depth * 14;

// Long paths keep their informative end: "…\projects\界面开发".
const shortPath = (value: string) => value.length > 34 ? `…${value.slice(-33)}` : value;

type NodeProps = {
  projectId: string; entry: FileEntry; depth: number; expanded: Set<string>;
  revision: number; enabled: boolean; selectedFile: string | null; hideNoise: boolean;
  onToggle: (path: string) => void; onSelect: (path: string) => void;
  selected: Set<string>; choose: (entry: FileEntry, event: MouseEvent) => boolean; contextMenu: (entry: FileEntry, event: MouseEvent) => void;
  decorations: Map<string, GitDecoration>;
};

function TreeNode(props: NodeProps) {
  const { projectId, entry, depth, expanded, revision, enabled, selectedFile, hideNoise, onToggle, onSelect, selected, choose, contextMenu } = props;
  const isDirectory = entry.kind === 'directory';
  const root = depth < 0;
  const open = isDirectory && (depth < 0 || expanded.has(entry.path));
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [pages, setPages] = useState(1);
  const decoration = props.decorations.get(entry.path);
  const requestRefresh = useRef<(() => void) | null>(null);
  const lastRevision = useRef(revision);

  useEffect(() => {
    if (!open || !enabled) return;
    let active = true, running = false, queued = false;
    const refresh = async () => {
      if (!active) return;
      if (running) { queued = true; return; }
      running = true; setLoading(true);
      try {
        const entries: FileEntry[] = [];
        let offset: number | null = 0;
        let result: DirectoryListing | null = null;
        for (let page = 0; page < pages && offset !== null; page++) {
          const response = await window.agentrix.listDirectory(projectId, entry.path, offset);
          if (!active) return;
          if (!response.ok) throw new Error(response.error);
          result = response.value;
          entries.push(...result.entries);
          if (result.nextOffset !== null && result.nextOffset <= offset) throw new Error(t('目录分页未前进，请刷新重试。'));
          offset = result.nextOffset;
        }
        if (active && result) { setListing({ ...result, entries }); setError(''); }
      } catch (err) { if (active) setError(String(err instanceof Error ? err.message : err)); }
      finally {
        running = false;
        if (active) { setLoading(false); if (queued) { queued = false; void refresh(); } }
      }
    };
    requestRefresh.current = () => { void refresh(); };
    void refresh();
    return () => { active = false; requestRefresh.current = null; };
  }, [projectId, entry.path, open, enabled, pages]);
  // Hiding leaves out caches only: never one that holds a Git change or the open file, so nothing in use disappears.
  const hidden = (child: FileEntry) => hideNoise && isCache(child) && !props.decorations.has(child.path) && !(selectedFile === child.path || selectedFile?.startsWith(`${child.path}/`));
  useEffect(() => { if (lastRevision.current !== revision) { lastRevision.current = revision; requestRefresh.current?.(); } }, [revision]);

  return <div className="tree-node" data-directory-path={isDirectory ? entry.path : undefined}>
    {!root && <button className={`tree-row ${selected.has(entry.path) || !selected.size && !isDirectory && selectedFile === entry.path ? 'file-selected' : ''} ${isQuiet(entry) ? 'is-quiet' : ''}`}
      role="treeitem" aria-expanded={isDirectory ? open : undefined} aria-selected={selected.has(entry.path)}
      aria-level={depth + 1} aria-label={entry.name} title={`${entry.path || entry.name}${decoration ? ` · ${gitTitle(decoration.title)}` : ''}`} data-node-path={entry.path} data-node-kind={entry.kind} data-git-tone={decoration ? gitMark(decoration.code).tone : undefined}
      style={{ paddingLeft: indent(depth) }}
      onClick={event => { if (!choose(entry, event)) { if (isDirectory) onToggle(entry.path); else onSelect(entry.path); } }}
      onContextMenu={event => contextMenu(entry, event)}
      onKeyDown={event => navigateTree(event, open, isDirectory, () => onToggle(entry.path))}>
      <span className="tree-chevron">{isDirectory && (open ? <CaretDown size={12} /> : <CaretRight size={12} />)}</span>
      <FileIcon entry={entry} open={open} />
      <span className="tree-filename">{entry.name}</span>
      {decoration && (isDirectory ? <span className={`git-badge git-${gitMark(decoration.code).tone}`} aria-hidden="true" title={gitTitle(decoration.title)}>•</span> : <GitBadge code={decoration.code} />)}
      {loading && !listing && <SpinnerGap size={12} className="loading-spinner" />}
    </button>}
    {open && <div role="group" className="tree-children">
      {error ? <div className="tree-error" role="status" style={{ marginLeft: indent(depth + 1) + 18 }}>{error}</div> : <>
        {listing?.entries.filter(child => !hidden(child)).map(child => <TreeNode key={child.path} {...props} entry={child} depth={depth + 1} />)}
        {listing && !listing.entries.length && <div className="tree-placeholder" style={{ paddingLeft: indent(depth + 1) + 36 }}>{t('空文件夹')}</div>}
        {!listing && !loading && <div className="tree-placeholder" style={{ paddingLeft: indent(depth + 1) + 36 }}>{t('正在读取目录…')}</div>}
        {listing?.nextOffset !== null && listing?.nextOffset !== undefined && <button className="tree-load-more" disabled={loading} onClick={() => setPages(p => p + 1)} style={{ marginLeft: indent(depth + 1) + 18 }}>{t('加载更多（{shown} / {total}）', { shown: listing.entries.length, total: listing.total })}</button>}
      </>}
    </div>}
  </div>;
}

export function ProjectExplorer({ project, collapsed, hideNoise, expandedPaths, selectedFile, changeRevision, onCollapse, onHideNoiseChange, onExpandedChange, onSelectFile, onOpenChange, onReturn, onFilesRemoved, onPathRenamed }: {
  project: Project; collapsed: boolean; hideNoise: boolean; expandedPaths: string[]; selectedFile: string | null;
  // Counts up when the changes view kept or reverted a hunk, so the status and tree are read again at once.
  changeRevision: number;
  onCollapse: () => void; onHideNoiseChange: (hide: boolean) => void; onExpandedChange: (paths: string[]) => void; onSelectFile: (path: string) => void; onOpenChange: (path: string, mode: GitOpenMode) => void;
  onReturn: () => void;
  onFilesRemoved: (paths: string[]) => void; onPathRenamed: (oldPath: string, newPath: string) => void;
}) {
  const [revision, setRevision] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false), more = useRef<HTMLDivElement>(null);
  const [gitOpen, setGitOpen] = useState(false), [gitRevision, setGitRevision] = useState(0);
  const git = useGitStatus(project.id, !collapsed, revision);
  const decorations = useMemo(() => gitDecorations(git.status), [git.status]);
  const location = project.kind === 'ssh' ? `${project.ssh?.host}:${project.path}` : project.path;
  const expanded = new Set(expandedPaths);
  const files = useExplorerFileActions(project, directory => { setRevision(value => value + 1); if (directory !== undefined) onExpandedChange([...new Set([...expandedPaths, directory])]); }, onSelectFile, onFilesRemoved, onPathRenamed);
  useEffect(() => { if (changeRevision) { setRevision(value => value + 1); setGitRevision(value => value + 1); } }, [changeRevision]);
  useEffect(() => {
    if (collapsed) return;
    const refresh = () => setRevision(value => value + 1);
    const timer = setInterval(() => { if (document.hasFocus() && document.visibilityState === 'visible') refresh(); }, 3000);
    window.addEventListener('focus', refresh);
    refresh();
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [project.id, collapsed]);
  useEffect(() => {
    if (!moreOpen) return;
    const dismiss = (event: Event) => { if (event.type === 'pointerdown' ? !more.current?.contains(event.target as Node) : (event as globalThis.KeyboardEvent).key === 'Escape') setMoreOpen(false); };
    document.addEventListener('pointerdown', dismiss); document.addEventListener('keydown', dismiss);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', dismiss); };
  }, [moreOpen]);
  const toggle = (folder: string) => { const next = new Set(expanded); if (next.has(folder)) next.delete(folder); else next.add(folder); onExpandedChange([...next]); };

  const openGit = (open: boolean) => { window.agentrix.fileTreeFocus(project.id, false); setGitOpen(open); if (collapsed) onCollapse(); };
  const changes = git.status?.total || 0;
  return <aside className={`focus-sidebar ${collapsed ? 'is-collapsed' : ''}`} aria-label={t('项目侧边栏')}>
    <div className="explorer-navigation">
      <button className="explorer-back" onClick={onReturn} title={t('返回总览 · {key}', { key: shortcut('overview') })} aria-label={t('返回总览')}><CaretLeft size={14} weight="bold" /><span>{t('总览')}</span></button>
      {/* Collapsed, the rail offers the two panes themselves; each opens the sidebar again (as does the shortcut). */}
      {!collapsed && <button className="icon-button sidebar-toggle" onClick={onCollapse} title={collapsed ? t('展开目录栏 · {key}', { key: shortcut('explorer') }) : t('收起目录栏 · {key}', { key: shortcut('explorer') })} aria-label={collapsed ? t('展开目录栏') : t('收起目录栏')} aria-expanded={!collapsed}><SidebarSimple size={17} /></button>}
    </div>
    {collapsed && <div className="explorer-rail">
      <button className="icon-button" onClick={() => openGit(false)} title={t('文件')} aria-label={t('资源管理器')}><Folder size={18} /></button>
      <button className="icon-button" onClick={() => openGit(true)} title={t('Git 历史与未提交更改')} aria-label={t('Git 历史')}><GitBranch size={18} />{!!changes && <span className="rail-dot" aria-hidden="true" />}</button>
    </div>}
    <div className="explorer-content" hidden={collapsed}>
      <header className="explorer-title" title={`${project.name}\n${location}`}>
        <h2>{project.name}</h2>
        <span className="explorer-path" title={location}>{shortPath(location)}</span>
      </header>
      <div className="explorer-bar">
        <div className="explorer-tabs" role="group" aria-label={t('侧边栏内容')}>
          <button aria-label={t('资源管理器')} aria-pressed={!gitOpen} onClick={() => openGit(false)}>{t('文件')}</button>
          <button aria-label={t('Git 历史')} title={t('Git 历史与未提交更改')} aria-pressed={gitOpen} onClick={() => openGit(true)}>Git{!!changes && <span className="explorer-tab-count">{changes > 999 ? '999+' : changes}</span>}</button>
        </div>
        {!gitOpen && <div className="explorer-tools" onPointerDown={() => window.agentrix.fileTreeFocus(project.id, false)}>
          <button className="icon-button" aria-label={t('新建文件')} title={t('新建文件')} onClick={() => files.openCreate('file')}><FilePlus size={15} /></button>
          <button className="icon-button" aria-label={t('刷新项目目录')} title={t('刷新项目目录')} onClick={() => setRevision(r => r + 1)}><ArrowClockwise size={15} /></button>
          <div className="explorer-more" ref={more}>
            <button className="icon-button" aria-label={t('更多文件操作')} title={t('更多文件操作')} aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen(open => !open)}><DotsThree size={17} weight="bold" /></button>
            {moreOpen && <div className="dropdown explorer-more-menu" role="menu" aria-label={t('更多文件操作')} onClick={() => setMoreOpen(false)}>
              <button role="menuitem" onClick={() => files.openCreate('directory')}><FolderPlus size={16} />{t('新建文件夹')}</button>
              <button role="menuitem" onClick={files.pasteHere}><Clipboard size={16} />{t('粘贴文件')}</button>
              <button role="menuitem" onClick={() => onExpandedChange([''])}><ArrowsInLineVertical size={16} />{t('折叠所有文件夹')}</button>
              <button role="menuitemcheckbox" aria-checked={hideNoise} onClick={() => onHideNoiseChange(!hideNoise)}>{hideNoise ? <EyeSlash size={16} /> : <Eye size={16} />}{t('隐藏缓存和临时文件')}</button>
            </div>}
          </div>
        </div>}
      </div>
      <div ref={files.tree} className="file-tree" hidden={gitOpen} role="tree" tabIndex={0} aria-multiselectable="true" aria-label={t('{name} 的文件目录', { name: project.name })} onKeyDownCapture={files.onKeyDown} onClick={files.onBackgroundClick} onContextMenu={files.onBackgroundContextMenu}
        onFocusCapture={() => window.agentrix.fileTreeFocus(project.id, true)} onBlurCapture={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) window.agentrix.fileTreeFocus(project.id, false); }}>
        <TreeNode projectId={project.id} entry={{ name: project.name, path: '', kind: 'directory' }} depth={-1} expanded={expanded} revision={revision} enabled={!collapsed && !gitOpen} selectedFile={selectedFile} hideNoise={hideNoise} onToggle={toggle} onSelect={onSelectFile} selected={files.selected} choose={files.choose} contextMenu={files.contextMenu} decorations={decorations} />
      </div>
      {gitOpen && !collapsed && <GitPanel projectId={project.id} status={git.status} error={git.error} loading={git.loading} revision={gitRevision} onRefresh={() => { git.refresh(); setGitRevision(value => value + 1); }} onOpen={(path, mode) => mode === 'file' ? onSelectFile(path) : onOpenChange(path, mode)} />}
      {!gitOpen && files.status}
    </div>
    {files.overlays}
  </aside>;
}
