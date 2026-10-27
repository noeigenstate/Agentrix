import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ClockCounterClockwise, FolderSimple, Globe, X } from '@phosphor-icons/react';
import type { RecentProject, RecentSSH, Result, SSHInfo } from '../../shared/types';
import { currentLanguage, t } from '../../shared/i18n';

function openedAt(timestamp: number) {
  if (!timestamp) return '';
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(timestamp).setHours(0, 0, 0, 0)) / 86400000);
  return days <= 0 ? t('今天') : days === 1 ? t('昨天') : days < 7 ? t('{n} 天前', { n: days }) : new Date(timestamp).toLocaleDateString(currentLanguage() === 'en' ? 'en-US' : 'zh-CN');
}

// Projects opened before and not open now (local folders, or SSH connections): click one to add it again, or drop it
// from the list.
type RecentRow = { key: string; name: string; detail: string; at: number; title: string; missing?: boolean };
function RecentList<T>({ label, icon, load, forget, clear, view, busy, onOpen, onError }: {
  label: string; icon: ReactNode; load: () => Promise<Result<T[]>>; forget: (item: T) => Promise<Result<T[]>>; clear: () => Promise<Result<T[]>>;
  view: (item: T) => RecentRow; busy: boolean; onOpen: (item: T) => void; onError: (message: string) => void;
}) {
  const [items, setItems] = useState<T[]>([]);
  const update = async (request: Promise<Result<T[]>>) => {
    const result = await request; if (result.ok) setItems(result.value); else onError(result.error);
  };
  useEffect(() => { void update(load()); }, []);
  if (!items.length) return null;
  return <section className="recent-projects" aria-label={label}>
    <div className="recent-heading"><span><ClockCounterClockwise size={14} />{label}</span><button type="button" className="text-button" disabled={busy} onClick={() => void update(clear())}>{t('清空')}</button></div>
    <ul>{items.map(item => { const row = view(item); return <li key={row.key} className={row.missing ? 'is-missing' : ''}>
      <button type="button" className="recent-open" disabled={busy || row.missing} title={row.title} onClick={() => onOpen(item)}>
        {icon}<span><b>{row.name}</b><small>{row.detail}</small></span><time>{openedAt(row.at)}</time>
      </button>
      <button type="button" className="icon-button" disabled={busy} title={t('从最近列表删除')} aria-label={t('从最近列表删除 {name}', { name: row.name })} onClick={() => void update(forget(item))}><X size={13} /></button>
    </li>; })}</ul>
  </section>;
}

export function AddProjectDialog({ onClose, onAdded, onError }: { onClose: () => void; onAdded: () => void; onError: (message: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<'local' | 'ssh'>('local');
  const [info, setInfo] = useState<SSHInfo | null>(null);
  const [host, setHost] = useState('');
  const [folder, setFolder] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
    window.agentrix.getSSHInfo().then(result => { if (result.ok) setInfo(result.value); }).catch(() => {});
  }, []);
  const add = async (request: () => Promise<Result<string | string[]>>) => {
    setBusy(true); setError('');
    try {
      const result = await request();
      if (!result.ok) { setError(result.error); return; }
      if (typeof result.value === 'string' || result.value.length) { onAdded(); onClose(); }
    } catch (error) { const message = String(error); setError(message); onError(message); }
    finally { setBusy(false); }
  };
  const setRemotePath = (value: string) => {
    if (value.startsWith('vscode-remote://ssh-remote+')) {
      try { const uri = new URL(value); setHost(decodeURIComponent(uri.host.slice('ssh-remote+'.length))); setFolder(decodeURIComponent(uri.pathname)); return; } catch { }
    }
    setFolder(value);
  };
  return <dialog className="settings-dialog project-dialog" ref={dialog} onCancel={onClose} onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form className="dialog-content" onSubmit={event => { event.preventDefault(); void add(() => kind === 'local' ? window.agentrix.addProjects() : window.agentrix.addSSHProject({ host, path: folder, name })); }}>
      <div className="dialog-heading"><h2>{t('添加项目')}</h2><button type="button" className="icon-button" aria-label={t('关闭添加项目')} onClick={onClose}><X size={18} /></button></div>
      <div className="project-kind-selector">
        <button type="button" aria-pressed={kind === 'local'} onClick={() => { setKind('local'); setError(''); }}><FolderSimple size={22} /><span><b>{t('本地项目')}</b><small>{t('这台电脑上的文件夹')}</small></span></button>
        <button type="button" aria-pressed={kind === 'ssh'} onClick={() => { setKind('ssh'); setError(''); }}><Globe size={22} /><span><b>{t('SSH 远程项目')}</b><small>{t('Linux 服务器上的项目')}</small></span></button>
      </div>
      {kind === 'local' ? <><p className="project-add-note">{t('选择一个或多个目录，每个项目会打开独立终端。')}</p>
        <RecentList<RecentProject> key="local" label={t('最近的项目')} icon={<FolderSimple size={17} />} busy={busy} onOpen={item => void add(() => window.agentrix.addRecentProject(item.path))} onError={setError}
          load={() => window.agentrix.getRecentProjects()} forget={item => window.agentrix.forgetRecentProject(item.path)} clear={() => window.agentrix.clearRecentProjects()}
          view={item => ({ key: item.path, name: item.name, detail: item.exists ? item.path : t('文件夹不存在 · {path}', { path: item.path }), at: item.lastOpenedAt, missing: !item.exists, title: item.exists ? t('添加 {path}', { path: item.path }) : t('文件夹已不存在') })} /></> : <><div className="remote-project-fields">
        <label>{t('SSH 主机')}<input autoComplete="off" list="ssh-hosts" aria-label={t('SSH 主机')} placeholder={t('主机别名或 user@hostname')} value={host} onChange={event => setHost(event.target.value)} required /></label>
        <datalist id="ssh-hosts">{info?.hosts.map(host => <option value={host} key={host} />)}</datalist>
        <label>{t('远程项目目录')}<input aria-label={t('远程项目目录')} placeholder={t('/home/user/project 或 ~/project')} value={folder} onChange={event => setRemotePath(event.target.value)} required /></label>
        <label>{t('项目名称')} <span>{t('（可选）')}</span><input aria-label={t('项目名称')} placeholder={t('默认使用目录名称')} value={name} onChange={event => setName(event.target.value)} maxLength={120} /></label>
        <p className="project-add-note">{t('沿用 SSH 配置里的端口、密钥和跳板机。远端需要 Python 3、Bash；Codex 在远端运行。')}</p>
        {info?.configExists && <p className="ssh-config-path" title={info.configFile}>{t('SSH 配置：{file}', { file: info.configFile })}</p>}
      </div>
        <RecentList<RecentSSH> key="ssh" label={t('最近的连接')} icon={<Globe size={17} />} busy={busy} onOpen={item => void add(() => window.agentrix.addSSHProject({ host: item.host, path: item.path, name: item.name }))} onError={setError}
          load={() => window.agentrix.getRecentSSH()} forget={item => window.agentrix.forgetRecentSSH(item.host, item.path)} clear={() => window.agentrix.clearRecentSSH()}
          view={item => ({ key: `${item.host}\n${item.path}`, name: item.name, detail: `${item.host}:${item.path}`, at: item.lastOpenedAt, title: t('连接 {target}', { target: `${item.host}:${item.path}` }) })} /></>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-footer"><button type="button" className="text-button" disabled={busy} onClick={onClose}>{t('取消')}</button><button className="button primary" disabled={busy}>{busy ? t('正在添加…') : kind === 'local' ? t('选择本地文件夹') : t('连接并添加')}</button></div>
    </form>
  </dialog>;
}
