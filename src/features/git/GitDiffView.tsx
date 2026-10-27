import { useCallback, useEffect, useState } from 'react';
import { ArrowClockwise, ArrowCounterClockwise, Check, GitDiff as GitDiffIcon, PencilSimple, SpinnerGap, Terminal, X } from '@phosphor-icons/react';
import type { GitDiff, GitHunk } from '../../shared/types';
import { t } from '../../shared/i18n';

type GitDiffMode = 'worktree' | 'staged' | 'untracked';

// One changed file from the Git sidebar, shown as git shows it: the lines that went away in red, the lines
// that came in green, numbered on both sides. Each hunk is decided on its own: kept (staged, so it leaves the
// working-tree list) or put back the way it was. A staged hunk can be taken out of the index again.
export function GitDiffView({ projectId, filePath, mode, onClose, onOpenFile, onError, onChanged }: {
  projectId: string; filePath: string; mode: GitDiffMode;
  onClose: () => void; onOpenFile: () => void; onError: (message: string) => void; onChanged: () => void;
}) {
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const staged = mode === 'staged', untracked = mode === 'untracked';
  useEffect(() => {
    let active = true; setLoading(true);
    window.agentrix.gitDiff(projectId, filePath, { staged, untracked }).then(result => {
      if (!active) return;
      if (result.ok) { setDiff(result.value); setError(''); } else { setDiff(null); setError(result.error); }
    }).catch(err => { if (active) { setDiff(null); setError(String(err)); } }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId, filePath, staged, untracked, revision]);

  // Applies one hunk's patch (or the whole file's) and shows what is left.
  const apply = useCallback(async (patch: string, options: { reverse?: boolean; cached?: boolean }) => {
    setBusy(true);
    try {
      const result = await window.agentrix.gitApply(projectId, patch, { path: filePath, ...options });
      if (!result.ok) { onError(result.error); return; }
      if (result.value.applied) { onChanged(); setRevision(value => value + 1); }
    } catch (err) { onError(String(err)); }
    finally { setBusy(false); }
  }, [projectId, filePath, onChanged, onError]);
  const keep = (patch: string) => apply(patch, staged ? { reverse: true, cached: true } : { cached: true });
  const revert = async (patch: string, count: number) => {
    const confirmed = await window.agentrix.confirmGitRevert(projectId, filePath, count);
    if (!confirmed.ok) { onError(confirmed.error); return; }
    if (confirmed.value) await apply(patch, { reverse: true });
  };
  const keepLabel = staged ? t('取消暂存') : t('保留');
  const keepTitle = staged ? t('把这处修改移出暂存区，回到工作区更改') : untracked ? t('采用这个新文件：加入暂存区') : t('采用这处修改：加入暂存区，准备提交');
  const revertTitle = untracked ? t('不要这个新文件：从磁盘删除') : t('不要这处修改：把这些行恢复成修改前的样子');
  const name = filePath.split('/').at(-1);
  const hunks = diff?.hunks || [];

  let body;
  if (loading && !diff) body = <div className="file-preview-message"><SpinnerGap size={22} className="loading-spinner" />{t('正在读取更改…')}</div>;
  else if (error) body = <div className="file-preview-message" role="status"><GitDiffIcon size={28} /><p>{error}</p><button className="button secondary small" onClick={() => setRevision(value => value + 1)}>{t('重试')}</button></div>;
  else if (diff?.binary) body = <div className="file-preview-message" role="status"><GitDiffIcon size={28} /><p>{t('二进制文件，无法按行显示更改。')}</p><button className="button secondary small" onClick={onOpenFile}>{t('打开文件')}</button></div>;
  else if (!hunks.length) body = <div className="file-preview-message" role="status"><Check size={28} /><p>{staged ? t('这个文件没有已暂存的更改了。') : t('这个文件没有待处理的更改了。')}</p><button className="button secondary small" onClick={onClose}>{t('返回终端')}</button></div>;
  else body = <div className="git-diff-body" role="list" aria-label={t('文件更改')}>
    {!diff?.text && <p className="git-diff-note" role="status">{t('这个文件不是 UTF-8 文本，只能查看，不能逐块保留或还原。')}</p>}
    {hunks.map((hunk, index) => <HunkView key={`${hunk.header}:${index}`} hunk={hunk} index={index} disabled={busy || !diff?.text} keepLabel={keepLabel} keepTitle={keepTitle} revertTitle={revertTitle}
      onKeep={() => void keep(hunk.patch)} onRevert={() => void revert(hunk.patch, 1)} />)}
  </div>;

  return <section className="file-preview git-diff-view" aria-label={t('文件更改')}>
    <div className="file-tabs"><button className="terminal-tab" onClick={onClose}><Terminal size={15} />{t('返回终端')}</button><div className="selected-file-tab"><GitDiffIcon size={15} /><span>{name}</span><button className="icon-button" title={t('关闭更改视图')} aria-label={t('关闭更改视图')} onClick={onClose}><X size={14} /></button></div><span className="preview-readonly" role="status">{t('更改 · 逐块保留或还原')}</span></div>
    <div className="file-preview-toolbar"><span title={filePath}>{filePath.split('/').join('  /  ')}</span><div>
      <span className="git-diff-summary">{staged ? t('已暂存') : untracked ? t('新文件') : t('工作区更改')}{diff && !diff.binary ? ` · +${diff.added} −${diff.removed}` : ''}</span>
      {hunks.length > 1 && diff?.text && <>
        <button className="preview-option editor-action" disabled={busy} title={keepTitle} onClick={() => void keep(diff.patch)}><Check size={14} />{staged ? t('全部取消暂存') : t('全部保留')}</button>
        {!staged && <button className="preview-option editor-action git-revert" disabled={busy} title={revertTitle} onClick={() => void revert(diff.patch, hunks.length)}><ArrowCounterClockwise size={14} />{t('全部还原')}</button>}
      </>}
      <button className="preview-option editor-action" onClick={onOpenFile}><PencilSimple size={15} />{t('打开文件')}</button>
      <button className="icon-button" disabled={busy} title={t('刷新更改')} aria-label={t('刷新更改')} onClick={() => setRevision(value => value + 1)}><ArrowClockwise size={16} className={loading ? 'loading-spinner' : undefined} /></button>
    </div></div>
    {body}
    <div className="file-preview-footer"><span>{hunks.length ? t('{count} 处更改', { count: hunks.length }) : ''}</span><span>{staged ? t('取消暂存后，更改回到工作区列表') : t('保留会把修改加入暂存区；还原会丢弃修改')}</span></div>
  </section>;
}

function HunkView({ hunk, index, disabled, keepLabel, keepTitle, revertTitle, onKeep, onRevert }: {
  hunk: GitHunk; index: number; disabled: boolean; keepLabel: string; keepTitle: string; revertTitle: string; onKeep: () => void; onRevert: () => void;
}) {
  let oldLine = hunk.oldStart, newLine = hunk.newStart;
  let removed = 0, added = 0;
  for (const line of hunk.lines) {
    if (line.type === '-') removed++;
    else if (line.type === '+') added++;
  }
  const title = t('第 {n} 处', { n: index + 1 });
  return <div className="git-hunk" role="listitem" aria-label={t('第 {n} 处更改', { n: index + 1 })}>
    <div className="git-hunk-bar">
      <span title={hunk.header}>{title} · {t('原第 {line} 行起', { line: hunk.oldStart })} · <b className="git-added">+{added}</b> <b className="git-deleted">−{removed}</b></span>
      <button type="button" className="git-hunk-action git-keep" disabled={disabled} title={keepTitle} aria-label={`${keepLabel} ${title}`} onClick={onKeep}><Check size={13} weight="bold" />{keepLabel}</button>
      <button type="button" className="git-hunk-action git-revert" disabled={disabled} title={revertTitle} aria-label={`${t('还原')} ${title}`} onClick={onRevert}><ArrowCounterClockwise size={13} weight="bold" />{t('还原')}</button>
    </div>
    <div className="git-hunk-lines">
      {hunk.lines.map((line, at) => {
        if (line.type === '\\') return <div key={at} className="git-line git-line-note"><span /><span /><span /><pre>{t('（文件末尾没有换行）')}</pre></div>;
        const numbers = [line.type === '+' ? '' : String(oldLine++), line.type === '-' ? '' : String(newLine++)];
        return <div key={at} className={`git-line ${line.type === '+' ? 'git-line-added' : line.type === '-' ? 'git-line-removed' : ''}`}>
          <span>{numbers[0]}</span><span>{numbers[1]}</span><span aria-hidden="true">{line.type.trim()}</span><pre>{line.text.replace(/\r$/, '')}</pre>
        </div>;
      })}
    </div>
  </div>;
}
