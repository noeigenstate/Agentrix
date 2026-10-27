import { useState } from 'react';
import { ArrowLeft, ArrowUpRight, CaretRight, DownloadSimple, Info, ListBullets } from '@phosphor-icons/react';
import type { AppUpdateState, Distribution } from '../../shared/types';
import { t } from '../../shared/i18n';
import { WHATS_NEW } from '../guide/guide';

type Page = 'changelog' | 'info';
type ProjectPage = Parameters<Window['agentrix']['openProjectPage']>[0];

const distributionName = (distribution: Distribution) => ({
  development: t('开发版'), portable: t('便携版'), installed: t('已安装版本'), macos: t('macOS 版'), linux: t('Linux 版'),
})[distribution];

// What the update block says and offers: one state, one line, the one action that fits it. A build that cannot update itself says why and
// where to get an installed build; one that can shows the live status and only the action that status calls for.
function updateBlock(updates: AppUpdateState): { line: string; progress?: boolean; download?: string; install?: string; check?: string } {
  if (!updates.supported) {
    if (updates.distribution === 'development') return { line: t('这是开发版，随源码更新，不会自动检查更新。') };
    if (updates.distribution === 'macos') return { line: t('macOS 版不会自动更新。再次运行安装命令，即可更新到最新版本。'), download: t('打开下载页面') };
    if (updates.distribution === 'linux') return { line: t('Linux 版不会自动更新。在下载页面获取新版本的 AppImage 或压缩包。'), download: t('打开下载页面') };
    return { line: t('便携版不会自动更新。下载 Windows 安装版后，即可自动检查和下载更新。'), download: t('下载 Windows 安装版') };
  }
  switch (updates.status) {
    case 'checking': return { line: t('正在检查更新…') };
    case 'current': return { line: t('当前已是最新版本。'), check: t('检查更新') };
    case 'downloading': return { line: t('正在下载 v{version} · {percent}%', { version: updates.version || '', percent: updates.percent }), progress: true };
    case 'ready': return { line: t('v{version} 已下载，可在方便时重启安装。', { version: updates.version || '' }), install: t('重启并安装更新') };
    case 'error': return { line: t(updates.error || ''), check: t('重试更新') };
    default: return { line: t('启动后自动检查更新，并在后台下载新版本。'), check: t('检查更新') };
  }
}

const open = (page: ProjectPage) => { void window.agentrix.openProjectPage(page); };

function EntryRow({ icon, title, hint, onClick }: { icon: React.ReactNode; title: string; hint: string; onClick: () => void }) {
  return <button type="button" className="about-row" onClick={onClick}>{icon}<span><b>{title}</b><small>{hint}</small></span><CaretRight size={16} /></button>;
}

function LinkRow({ title, page }: { title: string; page: ProjectPage }) {
  return <button type="button" className="about-link" onClick={() => open(page)}><span>{title}</span><ArrowUpRight size={14} /></button>;
}

export function AboutSettings({ updates, onCheck, onInstall, onDownloadPage }: { updates: AppUpdateState | null; onCheck: () => void; onInstall: () => void; onDownloadPage: () => void }) {
  const [page, setPage] = useState<Page | null>(null);
  const version = updates?.currentVersion;
  const back = <button type="button" className="text-button" onClick={() => setPage(null)}><ArrowLeft size={15} />{t('返回更新与关于')}</button>;
  if (page === 'changelog') return <div className="about-page">{back}
    <h3 className="about-heading">{t('更新日志')}{version && <span>v{version}</span>}</h3>
    <ul className="about-notes">{WHATS_NEW.map(item => <li key={item}>{t(item)}</li>)}</ul>
    <LinkRow title={t('在 GitHub 查看全部版本')} page="releases" />
  </div>;
  if (page === 'info') return <div className="about-page">{back}
    <h3 className="about-heading">{t('关于 Agentrix')}</h3>
    <dl className="about-facts">
      <div><dt>{t('版本')}</dt><dd>{version ? `v${version}` : '—'}</dd></div>
      {updates && <div><dt>{t('分发形式')}</dt><dd>{distributionName(updates.distribution)}</dd></div>}
      <div><dt>{t('许可证')}</dt><dd>MIT</dd></div>
      <div><dt>{t('版权')}</dt><dd>© 2026 Agentrix contributors</dd></div>
    </dl>
    <div className="about-links">
      <LinkRow title={t('使用文档')} page="docs" /><LinkRow title={t('开源许可')} page="license" />
      <LinkRow title={t('第三方许可')} page="notices" /><LinkRow title={t('GitHub 项目')} page="repository" />
    </div>
  </div>;
  const block = updates && updateBlock(updates);
  return <div className="about-page">
    <section className="about-product" aria-label={t('产品与更新')}>
      <div className="about-product-head">
        <span className="about-tile" aria-hidden="true"><span className="brand-mark"><i /><i /><i /><i /></span></span>
        <span className="about-product-name"><b>Agentrix</b><small>{version ? t('版本 v{version}', { version }) : ''}</small></span>
        {updates && <span className="about-chip">{distributionName(updates.distribution)}</span>}
      </div>
      {block && updates && <section className="update-module" aria-label={t('应用更新')}>
        <div className="update-module-title"><DownloadSimple size={18} /><b>{t('应用更新')}</b></div>
        <p role="status">{block.line}</p>
        {block.progress && <progress aria-label={t('更新下载进度')} max={100} value={updates.percent} />}
        {block.download && <button className="button primary" onClick={onDownloadPage}>{block.download}<ArrowUpRight size={14} /></button>}
        {block.install && <button className="button primary" onClick={onInstall}>{block.install}</button>}
        {block.check && <button className="button secondary" onClick={onCheck}>{block.check}</button>}
      </section>}
    </section>
    <div className="about-rows">
      <EntryRow icon={<ListBullets size={19} />} title={t('更新日志')} hint={t('了解最近的版本改进与修复')} onClick={() => setPage('changelog')} />
      <EntryRow icon={<Info size={19} />} title={t('关于 Agentrix')} hint={t('产品信息、文档与开源许可')} onClick={() => setPage('info')} />
    </div>
  </div>;
}
