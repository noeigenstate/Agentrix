import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { Project } from '../../shared/types';
import { shortcut } from '../shortcuts/shortcuts';
import { t } from '../../shared/i18n';

type Rect = { top: number; left: number; width: number; height: number };
type Step = {
  id: string; title: string; body: string[];
  // The part of the window this step is about; everything else is dimmed and cannot be used.
  target: () => Element | null;
  // Whether the target itself can be used (type in the terminal, click the button) or is only pointed at.
  interactive: boolean;
  // The step moves on by itself once the user has done what it asks.
  done?: () => boolean;
};

const visible = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].find(element => element.getClientRects().length) || null;

// The tutorial happens in the window itself: one step at a time, a bubble points at the place to act,
// that place stays usable and the rest of the window is blocked until the step is done or skipped.
// withAdd: the tutorial began with an empty workspace, so it starts by adding a project (and keeps that
// step in its count after a project exists).
export function GuideTour({ projects, focusedId, withAdd, onClose }: { projects: Project[]; focusedId: string | null; withAdd: boolean; onClose: () => void }) {
  const project = projects.find(item => item.id === focusedId) || projects[0];
  const steps: Step[] = [
    ...(withAdd ? [{
      id: 'add', title: t('添加项目'), interactive: true,
      body: [t('点击这里，选择你的项目文件夹（可以多选）。每个项目会得到一个方框和一个真实终端。'), t('之后按 {key} 可以继续添加，也支持 SSH 远程项目。', { key: shortcut('addProject') })],
      target: () => visible('.empty-workspace .button.primary'), done: () => projects.length > 0,
    }] : []),
    {
      id: 'start', title: t('启动编码助手'), interactive: true,
      body: [project?.terminals[0]?.sessionId ? t('在这个终端里输入 codex 或 claude，按回车启动。') : t('在方框里选择 Claude Code 或 Codex：有开发记录时可以接着上次继续，也可以开始新开发。'), t('还没有安装？稍后可在设置的「编码助手」里一键安装。')],
      target: () => visible('.project-panel .panel-terminal-area'), done: () => !!project?.codexActive,
    },
    {
      id: 'prompt', title: t('下达指令'), interactive: true,
      body: [t('直接写下要做的事，按回车发送；按 {key} 可以用说的。', { key: shortcut('voice') }), t('全部做完后，方框亮起白色呼吸光并语音提醒，你不必盯着。')],
      target: () => visible('.project-panel'), done: () => !!project?.codexActive && project.codexActivity === 'working',
    },
    {
      id: 'expand', title: t('放大查看'), interactive: true,
      body: [t('点击标题栏放大这个项目：左边是文件和 Git 更改，可以逐块保留或还原；右边的活动栏列出它的每一步。'), t('按 {key} 返回总览。', { key: shortcut('overview') })],
      target: () => visible('.project-panel .panel-header'), done: () => !!focusedId,
    },
    {
      id: 'settings', title: t('设置与更多'), interactive: false,
      body: [t('标志和标题是应用菜单：新建项目、返回项目、全屏，以及设置（主题、提醒、快捷键，一键安装 Codex 和 Claude Code，还能再看一遍这个教程）。'), t('按 {key} 添加更多项目。', { key: shortcut('addProject') })],
      target: () => visible('.titlebar-brand'),
    },
  ];
  const [index, setIndex] = useState(0);
  const step = steps[Math.min(index, steps.length - 1)], last = index >= steps.length - 1;
  const [rect, setRect] = useState<Rect | null>(null);
  const [paused, setPaused] = useState(false);
  const bubble = useRef<HTMLDivElement>(null);
  const [bubbleHeight, setBubbleHeight] = useState(190);
  const next = () => { if (last) onClose(); else setIndex(value => value + 1); };

  // The window changes under the tutorial (a project appears, a card expands), so the target is measured
  // again a few times a second. A dialog the step opened (the folder picker, SSH sign-in) takes over until it closes.
  const stepRef = useRef(step); stepRef.current = step;
  const measureRef = useRef(() => {});
  // A new step points somewhere else at once, not at the next tick.
  useLayoutEffect(() => { measureRef.current(); }, [index]);
  useEffect(() => {
    const measure = () => {
      setPaused(!!document.querySelector('dialog[open]'));
      const box = stepRef.current.target()?.getBoundingClientRect();
      setRect(current => {
        const value = box && box.width && box.height ? { top: Math.round(box.top), left: Math.round(box.left), width: Math.round(box.width), height: Math.round(box.height) } : null;
        return current?.top === value?.top && current?.left === value?.left
          && current?.width === value?.width && current?.height === value?.height ? current : value;
      });
    };
    measureRef.current = measure; measure();
    const timer = setInterval(measure, 200);
    window.addEventListener('resize', measure);
    return () => { clearInterval(timer); window.removeEventListener('resize', measure); };
  }, []);
  useLayoutEffect(() => { if (bubble.current) setBubbleHeight(bubble.current.offsetHeight); }, [index, rect, paused]);
  // What the step asks for has happened: move on.
  const done = step.done?.() === true;
  useEffect(() => { if (done) { const timer = setTimeout(next, 500); return () => clearTimeout(timer); } }, [done, index]);
  // A step about the terminal puts the cursor there, ready to type.
  useEffect(() => {
    if (paused || !['start', 'prompt'].includes(step.id)) return;
    const timer = setTimeout(() => visible('.project-panel .xterm-helper-textarea')?.focus(), 150);
    return () => clearTimeout(timer);
  }, [step.id, paused, !!rect]);
  // Keys reach only the step's target and the bubble; Escape leaves the tutorial.
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      const target = event.target as Node | null, area = stepRef.current.interactive ? stepRef.current.target() : null;
      if (bubble.current?.contains(target) || area?.contains(target) || area?.closest('.project-panel')?.contains(target) && stepRef.current.id !== 'add') return;
      event.preventDefault(); event.stopPropagation();
    };
    window.addEventListener('keydown', keys, true);
    return () => window.removeEventListener('keydown', keys, true);
  }, [onClose]);

  if (paused) return null;
  const width = window.innerWidth, height = window.innerHeight, pad = 6;
  const hole = rect && { top: Math.max(0, rect.top - pad), left: Math.max(0, rect.left - pad), right: Math.min(width, rect.left + rect.width + pad), bottom: Math.min(height, rect.top + rect.height + pad) };
  // A small target gets the bubble under it (or above when there is no room); a large one, such as the
  // terminal, keeps the bubble inside its upper right corner so what is typed stays in view.
  const bubbleWidth = 340;
  let place: CSSProperties = { top: height / 2 - bubbleHeight / 2, left: width / 2 - bubbleWidth / 2 }, arrow = '';
  if (hole) {
    const large = hole.bottom - hole.top > height * .45;
    const left = Math.min(Math.max(12, large ? hole.right - bubbleWidth - 18 : (hole.left + hole.right) / 2 - bubbleWidth / 2), width - bubbleWidth - 12);
    if (large) place = { top: Math.min(hole.top + 62, height - bubbleHeight - 12), left };
    else if (hole.bottom + 14 + bubbleHeight <= height) { place = { top: hole.bottom + 14, left }; arrow = 'tour-arrow-up'; }
    else { place = { top: Math.max(12, hole.top - 14 - bubbleHeight), left }; arrow = 'tour-arrow-down'; }
  }
  const arrowLeft = hole ? Math.min(Math.max(20, (hole.left + hole.right) / 2 - (place.left as number)), bubbleWidth - 20) : 0;
  return <div className="tour-layer" aria-live="polite">
    {hole ? <>
      <div className="tour-shade" style={{ top: 0, left: 0, width, height: hole.top }} />
      <div className="tour-shade" style={{ top: hole.top, left: 0, width: hole.left, height: hole.bottom - hole.top }} />
      <div className="tour-shade" style={{ top: hole.top, left: hole.right, width: width - hole.right, height: hole.bottom - hole.top }} />
      <div className="tour-shade" style={{ top: hole.bottom, left: 0, width, height: height - hole.bottom }} />
      <div className={`tour-ring ${step.interactive ? '' : 'tour-blocked'}`} style={{ top: hole.top, left: hole.left, width: hole.right - hole.left, height: hole.bottom - hole.top }} />
    </> : <div className="tour-shade" style={{ inset: 0 }} />}
    <div className={`tour-bubble ${arrow}`} ref={bubble} role="dialog" aria-label={t('操作教程')} style={{ ...place, width: bubbleWidth, '--tour-arrow': `${arrowLeft}px` } as CSSProperties}>
      <span className="eyebrow">{t('操作教程')} · {Math.min(index, steps.length - 1) + 1} / {steps.length}</span>
      <h3>{step.title}</h3>
      {step.body.map(line => <p key={line}>{line}</p>)}
      <div className="tour-actions">
        <button type="button" className="text-button" onClick={onClose}>{t('跳过教程')}</button>
        <button type="button" className="button primary small" onClick={next}>{last ? t('完成') : t('下一步')}</button>
      </div>
    </div>
  </div>;
}
