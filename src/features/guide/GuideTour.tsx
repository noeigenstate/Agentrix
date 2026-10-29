import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Project } from '../../shared/types';
import { shortcut } from '../shortcuts/shortcuts';
import { t } from '../../shared/i18n';
import { observeBounds, type Bounds } from '../../shared/observeBounds';
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
      body: [t('点击标题栏进入这个项目：左边是文件和 Git 更改，可以逐块保留或还原；右边的活动栏列出它的每一步。'), t('按 {key} 返回总览。', { key: shortcut('overview') })],
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
  const [hasTarget, setHasTarget] = useState(false);
  const [paused, setPaused] = useState(false);
  const bubble = useRef<HTMLDivElement>(null), ring = useRef<HTMLDivElement>(null);
  const shades = useRef<(HTMLDivElement | null)[]>([]);
  const next = () => { if (last) onClose(); else setIndex(value => value + 1); };

  // Follow a moving target at display refresh without rendering or remeasuring the text on each frame.
  // A dialog the step opened (the folder picker, SSH sign-in) takes over until it closes.
  const stepRef = useRef(step); stepRef.current = step;
  useLayoutEffect(() => {
    const node = bubble.current;
    if (!node) return;
    let rect: Bounds | null = null, bubbleHeight = node.offsetHeight;
    let wasPaused: boolean | undefined, hadTarget: boolean | undefined;
    const position = () => {
      const width = window.innerWidth, height = window.innerHeight, pad = 6, bubbleWidth = 340;
      const hole = rect && {
        top: Math.max(0, Math.round(rect.top) - pad), left: Math.max(0, Math.round(rect.left) - pad),
        right: Math.min(width, Math.round(rect.left) + Math.round(rect.width) + pad),
        bottom: Math.min(height, Math.round(rect.top) + Math.round(rect.height) + pad),
      };
      let top = height / 2 - bubbleHeight / 2, left = width / 2 - bubbleWidth / 2, arrow = '';
      if (hole) {
        // Large targets keep the bubble inside their upper right corner; small targets point from below/above.
        const large = hole.bottom - hole.top > height * .45;
        left = Math.min(Math.max(12, large ? hole.right - bubbleWidth - 18 : (hole.left + hole.right) / 2 - bubbleWidth / 2), width - bubbleWidth - 12);
        if (large) top = Math.min(hole.top + 62, height - bubbleHeight - 12);
        else if (hole.bottom + 14 + bubbleHeight <= height) { top = hole.bottom + 14; arrow = 'tour-arrow-up'; }
        else { top = Math.max(12, hole.top - 14 - bubbleHeight); arrow = 'tour-arrow-down'; }
        const boxes = [[0, 0, width, hole.top], [0, hole.top, hole.left, hole.bottom - hole.top],
          [hole.right, hole.top, width - hole.right, hole.bottom - hole.top], [0, hole.bottom, width, height - hole.bottom],
          [hole.left, hole.top, hole.right - hole.left, hole.bottom - hole.top]];
        for (const [index, element] of [...shades.current, ring.current].entries()) {
          if (!element) continue;
          const [x, y, w, h] = boxes[index];
          if (element === ring.current) Object.assign(element.style, { left: '0px', top: '0px', width: `${w}px`, height: `${h}px`, transform: `translate3d(${x}px, ${y}px, 0)` });
          else element.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${w}, ${h})`;
        }
      }
      node.style.transform = `translate3d(${left}px, ${top}px, 0)`;
      node.style.setProperty('--tour-arrow', `${hole ? Math.min(Math.max(20, (hole.left + hole.right) / 2 - left), bubbleWidth - 20) : 0}px`);
      node.classList.toggle('tour-arrow-up', arrow === 'tour-arrow-up'); node.classList.toggle('tour-arrow-down', arrow === 'tour-arrow-down');
    };
    const stop = observeBounds(() => {
      const nowPaused = !!document.querySelector('dialog[open]');
      if (wasPaused !== nowPaused) { wasPaused = nowPaused; setPaused(nowPaused); }
      return stepRef.current.target();
    }, box => {
      rect = box; position();
      if (hadTarget !== !!box) { hadTarget = !!box; setHasTarget(!!box); }
    });
    const resize = new ResizeObserver(() => { bubbleHeight = node.offsetHeight; position(); });
    resize.observe(node);
    return () => { stop(); resize.disconnect(); };
  }, [index]);
  // What the step asks for has happened: move on.
  const done = step.done?.() === true;
  useEffect(() => { if (done) { const timer = setTimeout(next, 500); return () => clearTimeout(timer); } }, [done, index]);
  // A step about the terminal puts the cursor there, ready to type.
  useEffect(() => {
    if (paused || !['start', 'prompt'].includes(step.id)) return;
    const timer = setTimeout(() => visible('.project-panel .xterm-helper-textarea')?.focus(), 150);
    return () => clearTimeout(timer);
  }, [step.id, paused, hasTarget]);
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

  return <div className="tour-layer" aria-live="polite" style={{ visibility: paused ? 'hidden' : undefined }}>
    {Array.from({ length: 4 }, (_, index) => <div key={index} ref={node => { shades.current[index] = node; }} className={hasTarget ? 'tour-shade' : undefined}
      style={{ left: 0, top: 0, width: 1, height: 1, transformOrigin: '0 0', display: hasTarget ? undefined : 'none' }} />)}
    <div ref={ring} className={`tour-ring ${step.interactive ? '' : 'tour-blocked'}`} style={{ display: hasTarget ? undefined : 'none' }} />
    {!hasTarget && <div className="tour-shade" style={{ inset: 0 }} />}
    <div className="tour-bubble" ref={bubble} role="dialog" aria-label={t('操作教程')} style={{ top: 0, left: 0, width: 340 }}>
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
