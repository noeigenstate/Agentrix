import { useEffect, useRef, useState } from 'react';
import { Bell, CaretDown, House, ArrowsOutSimple, Terminal as TerminalIcon, Check, Power, ArrowCounterClockwise, Monitor, Cpu, Info, SpeakerHigh, Globe, Microphone, BookOpen, FloppyDisk, Palette, Robot, Keyboard, ImageSquare, ArrowLeft } from '@phosphor-icons/react';
import type { AgentsState, AppUpdateState, Project, Settings, Workspace } from '../../shared/types';
import { themes } from '../../shared/themes';
import { VoiceModelSetting } from '../voice/VoiceButton';
import { currentLanguage, t } from '../../shared/i18n';
import { shortcut } from '../shortcuts/shortcuts';
import { ShortcutSettings } from '../shortcuts/ShortcutSettings';
import { AgentsSettings } from '../agents/AgentsSettings';
import { isMac, isLinux } from '../../shared/platform';
import { recommendedAppearance } from '../../shared/theme-presets';
import { TerminalFontSettings } from './TerminalFontSettings';
import { UserAvatarSetting } from './UserAvatarSetting';
import { ProjectImagesSettings } from './ProjectImagesSettings';

// The theme picker shows one row; "更多主题" unfolds the rest. The theme in use is always in that row: one from further
// down takes the row's last place.
const THEME_ROW = 4;
function shownThemes<T extends { id: string }>(all: readonly T[], selected: string, everything: boolean) {
  if (everything) return all;
  const row = all.slice(0, THEME_ROW), chosen = all.find(theme => theme.id === selected);
  return chosen && !row.includes(chosen) ? [...row.slice(0, THEME_ROW - 1), chosen] : row;
}

export function SettingsDialog({ settings, projects = [], desktopGlass, localShell, agents, onAgents, initialSection, updates, onCheckUpdate, onInstallUpdate, onDownloadPage, onGuide, close, update, quit }: {
  localShell: Workspace['localShell']; agents: AgentsState | null; onAgents: (state: AgentsState) => void; initialSection: string;
  projects?: Project[]; desktopGlass?: Workspace['desktopGlass']; settings: Settings; close: () => void; update: (patch: Partial<Settings>) => void; quit: () => void; onGuide: () => void;
  updates: AppUpdateState | null; onCheckUpdate: () => void; onInstallUpdate: () => void; onDownloadPage: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const [activeSection, setActiveSection] = useState(initialSection), [allThemes, setAllThemes] = useState(false);
  const [projectImages, setProjectImages] = useState(false);
  // One category at a time: the sidebar chooses it and the pane beside it shows only that category.
  const sections = [
    { id: 'appearance', title: t('外观'), hint: t('主题、语言、材质与动画'), icon: <Palette size={17} /> },
    { id: 'notifications', title: t('提醒'), hint: t('系统通知与提示音'), icon: <Bell size={17} /> },
    { id: 'terminal', title: t('终端与编辑'), hint: t('终端、会话恢复与编辑器'), icon: <TerminalIcon size={17} /> },
    { id: 'agents', title: t('编码助手'), hint: t('Codex 与 Claude Code'), icon: <Robot size={17} /> },
    { id: 'shortcuts', title: t('键盘快捷键'), hint: t('查看和修改快捷键'), icon: <Keyboard size={17} /> },
    { id: 'about', title: t('更新与关于'), hint: t('版本与更新'), icon: <Info size={17} /> },
  ];
  const current = sections.find(section => section.id === activeSection) || sections[0];
  const preset = recommendedAppearance(settings.theme, !!desktopGlass?.supported);
  const choose = (id: string) => { setProjectImages(false); setActiveSection(id); pane.current?.scrollTo({ top: 0 }); };
  useEffect(() => { dialog.current?.showModal(); }, []);
  // Up and down move between categories while the sidebar has focus.
  const navKeys = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const index = sections.findIndex(section => section.id === current.id), next = sections[(index + (event.key === 'ArrowDown' ? 1 : sections.length - 1)) % sections.length];
    choose(next.id); dialog.current?.querySelector<HTMLElement>(`[data-settings-tab="${next.id}"]`)?.focus();
  };
  return <dialog className="settings-dialog settings-paned" ref={dialog} onCancel={close} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="settings-shell">
      <aside className="settings-sidebar">
        <div className="settings-brand"><span className="eyebrow">PREFERENCES</span><h2>{t('工作台设置')}</h2></div>
        <nav className="settings-nav" aria-label={t('设置分类')} onKeyDown={navKeys}>{sections.map(section => <button type="button" key={section.id} data-settings-tab={section.id} aria-controls={section.id === 'appearance' && projectImages ? 'settings-project-images' : `settings-${section.id}`} aria-current={current.id === section.id ? 'page' : undefined} onClick={() => choose(section.id)}>{section.icon}<span>{section.title}</span></button>)}</nav>
        <div className="settings-sidebar-footer"><button className="text-button" onClick={onGuide}><BookOpen size={15} />{t('使用指南')}</button><button className="text-button danger-text" onClick={quit}><Power size={15} />{t('退出应用')}</button></div>
      </aside>
      <div className="settings-main">
        <header className="settings-main-head"><h3>{projectImages ? t('项目缩略图') : current.title}</h3><p>{projectImages ? t('自动选择、固定图片与原有编号') : current.hint}</p></header>
        <div className="settings-pane" ref={pane}>
      <section className="settings-section" id="settings-appearance" aria-label={t('外观')} hidden={current.id !== 'appearance' || projectImages}>
      <fieldset className="theme-picker"><legend>{t('外观主题')}</legend><div className="theme-options">
        {shownThemes(themes, settings.theme, allThemes).map(theme => <label key={theme.id} className={`theme-option ${settings.theme === theme.id ? 'is-selected' : ''}`}>
          <input type="radio" name="theme" value={theme.id} checked={settings.theme === theme.id} aria-label={t(theme.name)} onChange={() => update({ theme: theme.id })} />
          <span className="theme-swatch" data-theme-preview={theme.id} aria-hidden="true"><span className="theme-mini-window"><i /><i /><i /></span><span className="theme-check"><Check size={12} weight="bold" /></span></span>
          <span className="theme-name">{t(theme.name)}</span><small>{t(theme.description)}</small>
        </label>)}
      </div>
      {themes.length > THEME_ROW && <button type="button" className="text-button theme-more" aria-expanded={allThemes} onClick={() => setAllThemes(value => !value)}>
        {allThemes ? t('收起') : t('更多主题 · {count}', { count: themes.length - THEME_ROW })}<CaretDown size={13} weight="bold" className={allThemes ? 'is-open' : undefined} /></button>}
      </fieldset>
      <label className="setting-row"><span><Globe size={19} /><span><b>{t('语言')}</b><small>{t('界面与提示的语言')}</small></span></span><select aria-label={t('语言')} value={settings.language} onChange={event => update({ language: event.target.value as Settings['language'] })}><option value="zh">中文</option><option value="en">English</option></select></label>
      <UserAvatarSetting avatar={settings.userAvatar} update={userAvatar => update({ userAvatar })} />
      <div className="setting-row" data-project-images-setting><span><ImageSquare size={19} /><span><b>{t('项目缩略图')}</b><small>{t('自动选择、固定图片与原有编号')}</small></span></span><button type="button" className="button secondary" data-project-images-open onClick={() => { setProjectImages(true); pane.current?.scrollTo({ top: 0 }); }}>{t('管理…')}</button></div>
      <label className="setting-row"><span><House size={19} /><span><b>{t('启动时打开')}</b><small>{t('决策：先看需要你决定的事；工作台：项目网格')}</small></span></span><select aria-label={t('启动时打开')} value={settings.startView} onChange={event => update({ startView: event.target.value as Settings['startView'] })}><option value="decisions">{t('决策')}</option><option value="workspace">{t('工作台')}</option></select></label>
      <label className="setting-row"><span><Monitor size={19} /><span><b>{t('界面材质')}</b><small>{t('实色：面板不透明，文字用 ClearType 渲染，最锐利，也更省显卡；玻璃：透出壁纸')}</small></span></span><select aria-label={t('界面材质')} value={settings.surface} onChange={event => update({ surface: event.target.value as Settings['surface'] })}><option value="glass">{t('液态玻璃')}</option><option value="solid">{t('实色（更清晰）')}</option></select></label>
      {settings.surface === 'glass' && <label className="setting-row"><span><Monitor size={19} /><span><b>{t('玻璃背景')}</b><small>{t('主题背景使用应用内壁纸；桌面背景模糊窗口背后的内容')}</small></span></span><select aria-label={t('玻璃背景')} value={settings.glassBackground} onChange={event => update({ glassBackground: event.target.value as Settings['glassBackground'] })}><option value="theme">{t('主题背景')}</option><option value="desktop" disabled={!desktopGlass?.supported}>{t('桌面背景')}</option></select></label>}
      {settings.surface === 'glass' && settings.glassBackground === 'desktop' && <p className="settings-note">{t(desktopGlass?.restart ? '重新打开应用后启用桌面磨玻璃；切换设置不会中断当前会话。' : desktopGlass?.active ? '窗口背后的内容由系统模糊；每个面板只叠加可调的透明底色。' : '系统磨玻璃暂不可用，继续使用应用内背景。')}{desktopGlass?.compatibility && <> {t('此系统的实验材质支持最大化，暂不支持系统全屏。')}</>}</p>}
      <label className="setting-row"><span><Monitor size={19} /><span><b>{t('玻璃透明度')}</b><small>{t('越高越通透；只影响背景，文字保持清晰')}</small></span></span><select aria-label={t('玻璃透明度模式')} disabled={settings.surface === 'solid'} value={settings.glassTransparency === null ? 'theme' : 'custom'} onChange={event => update({ glassTransparency: event.target.value === 'theme' ? null : 50 })}><option value="theme">{t('跟随主题')}</option><option value="custom">{t('自定义')}</option></select></label>
      {settings.glassTransparency !== null && <label className="setting-row glass-transparency-row"><span><b>{t('背景透明度')}</b></span><span className="glass-transparency-control"><input aria-label={t('背景透明度')} type="range" min="0" max="100" step="1" value={settings.glassTransparency} disabled={settings.surface === 'solid'} onChange={event => update({ glassTransparency: Number(event.target.value) })} /><output>{settings.glassTransparency}%</output><small className="glass-transparency-endpoints">{t('0% 不透明 · 100% 最透明')}</small></span></label>}
      <label className="setting-row"><span><Cpu size={19} /><span><b>{t('终端渲染')}</b><small>{t('GPU 加速：用显卡绘制终端文字，助手工作时处理器占用低得多；如果终端显示异常，改用兼容模式')}</small></span></span><select aria-label={t('终端渲染')} value={settings.terminalRenderer} onChange={event => update({ terminalRenderer: event.target.value as Settings['terminalRenderer'] })}><option value="gpu">{t('GPU 加速')}</option><option value="dom">{t('兼容模式')}</option></select></label>
      <label className="setting-row"><span><ArrowsOutSimple size={19} /><span><b>{t('界面动画')}</b><small>{t('窗口平滑放大与呼吸灯；默认不受 Windows“动画效果”开关影响')}</small></span></span><select aria-label={t('界面动画')} value={settings.focusAnimation} onChange={e => update({ focusAnimation: e.target.value as Settings['focusAnimation'] })}><option value="smooth">{t('开启')}</option><option value="system">{t('跟随系统')}</option><option value="off">{currentLanguage() === 'en' ? 'Off' : '关闭'}</option></select></label>
      <label className="setting-row"><span><TerminalIcon size={19} /><span><b>{t('终端字号')}</b><small>{t('全屏与网格共用字号')}</small></span></span><select aria-label={t('终端字号')} value={settings.fontSize} onChange={e => update({ fontSize: Number(e.target.value) })}>{[10, 11, 12, 13, 14, 16, 18, 20].map(n => <option key={n} value={n}>{n} px</option>)}</select></label>
      <label className="setting-row"><span><TerminalIcon size={19} /><span><b>{t('终端字重')}</b><small>{t('背景透明时可提高字重；不改变终端内容和字号')}</small></span></span><select aria-label={t('终端字重')} value={settings.terminalFontWeight} onChange={event => update({ terminalFontWeight: Number(event.target.value) as Settings['terminalFontWeight'] })}><option value="400">{t('标准')}</option><option value="500">{t('中等')}</option><option value="600">{t('更醒目')}</option></select></label>
      <TerminalFontSettings settings={settings} update={update} />
      <div className="setting-row"><span><Palette size={19} /><span><b>{t('主题推荐配置')}</b><small>{t('只调整外观；手动修改和切换主题不会自动覆盖你的配置')}</small><small>{t('{size}px · {weight} · {renderer} · {background}', { size: preset.fontSize, weight: t(preset.terminalFontWeight === 400 ? '标准' : '中等'), renderer: t(preset.terminalRenderer === 'gpu' ? 'GPU 加速' : '兼容模式'), background: t(preset.glassBackground === 'desktop' ? '桌面背景' : '主题背景') })}</small></span></span><button className="button secondary" onClick={() => update(preset)}>{t('应用推荐配置')}</button></div>
      </section>
      <section className="settings-section" id="settings-project-images" aria-label={t('项目缩略图')} hidden={current.id !== 'appearance' || !projectImages}>
        {projectImages && <><button type="button" className="text-button" data-project-images-back onClick={() => choose('appearance')}><ArrowLeft size={15} />{t('返回外观')}</button><ProjectImagesSettings projects={projects} /></>}
      </section>
      <section className="settings-section" id="settings-notifications" aria-label={t('提醒')} hidden={current.id !== 'notifications'}>
      <label className="setting-row"><span><Bell size={19} /><span><b>{t('桌面通知')}</b><small>{t('一轮结束时发送系统通知')}</small></span></span><input type="checkbox" checked={settings.notifications} onChange={e => update({ notifications: e.target.checked })} /></label>
      <label className="setting-row"><span><SpeakerHigh size={19} /><span><b>{t('通知声音')}</b><small>{t('播放系统默认提示音')}</small></span></span><input type="checkbox" checked={settings.sound} onChange={e => update({ sound: e.target.checked })} /></label>
      </section>
      <section className="settings-section" id="settings-terminal" aria-label={t('终端与编辑')} hidden={current.id !== 'terminal'}>
      {!isMac && <label className="setting-row"><span><TerminalIcon size={19} /><span><b>{t('终端')}</b><small>{t('新开或重启的本地终端使用；SSH 项目始终使用 Bash')}</small></span></span>{localShell
        ? <select aria-label={t('终端')} value={localShell.kind} onChange={event => update({ shell: event.target.value as Settings['shell'] })}><option value="bash">Bash</option><option value="zsh" disabled={!localShell.zsh}>{localShell.zsh ? 'zsh' : t('zsh（未安装）')}</option></select>
        : <select aria-label={t('终端')} value={settings.shell} onChange={event => update({ shell: event.target.value as Settings['shell'] })}><option value="powershell">PowerShell</option><option value="cmd">{t('命令提示符 (cmd)')}</option></select>}</label>}
      <label className="setting-row"><span><ArrowCounterClockwise size={19} /><span><b>{t('启动时恢复工作')}</b><small>{t('恢复 Codex 与 Claude Code 的最近会话，被中断的任务自动发送“继续”')}</small></span></span><input type="checkbox" checked={settings.restoreSessions} onChange={event => update({ restoreSessions: event.target.checked })} /></label>
      <label className="setting-row"><span><Monitor size={19} /><span><b>{t('关闭到托盘')}</b><small>{t('关闭窗口后，终端和任务继续运行')}</small></span></span><input type="checkbox" checked={settings.closeToTray} onChange={e => update({ closeToTray: e.target.checked })} /></label>
      <label className="setting-row"><span><FloppyDisk size={19} /><span><b>{t('自动保存')}</b><small>{t('停止输入约 1 秒后、切换文件或离开窗口时保存编辑中的文件；关闭后按 Ctrl+S 保存')}</small></span></span><input type="checkbox" checked={settings.autoSave} onChange={event => update({ autoSave: event.target.checked })} /></label>
      <div className="setting-row"><span><Microphone size={19} /><span><b>{t('本地语音输入')}</b><small>{t('按 {key} 或点击终端上的麦克风说话，按回车识别并发送，Esc 取消', { key: shortcut('voice') })}</small></span></span><VoiceModelSetting choice={settings.voiceModel} onChoose={voiceModel => update({ voiceModel })} /></div>
      </section>
      <section className="settings-section" id="settings-agents" aria-label={t('编码助手')} hidden={current.id !== 'agents'}>
      <AgentsSettings agents={agents} onChange={onAgents} />
      </section>
      {current.id === 'shortcuts' && <ShortcutSettings settings={settings} update={update} />}
      <section className="settings-section" id="settings-about" aria-label={t('更新与关于')} hidden={current.id !== 'about'}>
      {updates && <section className="update-section" aria-label={t('应用更新')}>
        <div className="update-heading"><b>{t('应用更新')}</b><span>{t('当前版本 v{version}', { version: updates.currentVersion })}</span></div>
        <p role="status">{updates.status === 'unavailable' ? isMac ? t('macOS 版不会自动更新。再次运行安装命令，即可更新到最新版本。') : isLinux ? t('Linux 版不会自动更新。在下载页面获取新版本的 AppImage 或压缩包。') : t('当前为便携版或开发版。安装 Windows 版后，即可自动检查和下载更新。')
          : updates.status === 'checking' ? t('正在检查更新…')
          : updates.status === 'current' ? t('当前已是最新版本。')
          : updates.status === 'downloading' ? t('正在下载 v{version} · {percent}%', { version: updates.version || '', percent: updates.percent })
          : updates.status === 'ready' ? t('v{version} 已下载，可在方便时重启安装。', { version: updates.version || '' })
          : updates.status === 'error' ? t(updates.error || '') : t('启动后自动检查更新，并在后台下载新版本。')}</p>
        {updates.status === 'downloading' && <progress aria-label={t('更新下载进度')} max={100} value={updates.percent} />}
        <div className="update-actions">{!updates.supported
          ? <button className="button secondary small" onClick={onDownloadPage}>{isMac || isLinux ? t('打开下载页面') : t('下载 Windows 安装版')}</button>
          : updates.status === 'ready' ? <button className="button primary small" onClick={onInstallUpdate}>{t('重启并安装更新')}</button>
          : <button className="button secondary small" disabled={updates.status === 'checking' || updates.status === 'downloading'} onClick={onCheckUpdate}>{updates.status === 'error' ? t('重试更新') : t('检查更新')}</button>}</div>
      </section>}
      <div className="settings-note"><Info size={15} /><p>{t('一轮结束时，方框从边缘缓缓呼吸三次，之后留一层柔光等你查看；在终端里发送新指令也算已查看。绿色常亮表示已查看的本轮完成。没有新指令时不会重复提醒。')}</p></div>
      </section>
        </div>
        <div className="settings-main-foot"><button className="button primary" onClick={close}>{t('完成')}</button></div>
      </div>
    </div>
  </dialog>;
}
