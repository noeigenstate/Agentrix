import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react';
import { ArrowUp, CircleNotch, FolderSimple, X } from '@phosphor-icons/react';
import type { Project, Result } from '../../shared/types';
import type { Decision } from './decisions';
import { DecisionCard } from './DecisionCard';
import { DecisionInbox } from './DecisionInbox';
import { inboxItems, isWorking } from './inbox-items';
import { SessionDetail } from './SessionDetail';
import { acceptedToday } from './ReviewCard';
import { sendToAgent, untilAtPrompt } from './send-to-agent';
import { dataUrl, thumbnail } from '../reading/image-thumbnail';
import { VoiceButton } from '../voice/VoiceButton';
import { useDictatedBox } from '../voice/voice-input';
import { showPopup } from '../files/file-popup';
import { t } from '../../shared/i18n';
import { Select } from '../../shared/Select';
import './home.css';

// The home page as an inbox, for grading the work like a teacher: one list of what needs you and of every session, by
// urgency, on the left; the selected decision (or session) in full on the right, with the box that says what comes next
// docked under it. Nothing here is solved by looking at it.
export function DecisionHome({ projects, decisions, snoozed, onOpenProject, onOpenDecision, onAction, onError }: {
  projects: readonly Project[]; decisions: readonly Decision[]; snoozed: number;
  onOpenProject: (projectId: string) => void; onOpenDecision: (decision: Decision) => void;
  onAction: <T,>(promise: Promise<Result<T>>) => Promise<T | undefined>; onError: (message: string) => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  const [notice, setNotice] = useState('');
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer); }, [notice]);
  const items = useMemo(() => inboxItems(projects, decisions), [projects, decisions]);
  // A pick that is gone (a decision answered, or a session that now has one) falls back to the most urgent decision.
  const [picked, setPicked] = useState<string | null>(null);
  const selected = items.find(item => item.id === picked) ?? items.find(item => item.decision);
  const working = items.filter(({ terminal }) => isWorking(terminal)).length;
  const accepted = useMemo(() => acceptedToday(), [decisions]);
  const headline = decisions.length ? t('{count} 件事需要你决定', { count: decisions.length }) : t('项目');
  const summary = [accepted > 0 && t('今天已接受 {count} 项交付', { count: accepted }), snoozed > 0 && t('{count} 件已暂缓', { count: snoozed })].filter(Boolean).join(' · ');
  return <div className="home-page decision-home">
    <section className="home-pane home-inbox" aria-label={headline}>
      <header className="home-head">
        <h1>{headline}</h1>
        {summary && <p className="home-counts">{summary}</p>}
      </header>
      {notice && <p className="home-notice" role="status">{notice}</p>}
      <DecisionInbox items={items} selectedId={selected?.id ?? null} now={now} onSelect={setPicked} />
    </section>
    <div className={`home-right${selected ? '' : ' is-empty'}`}>
      {!selected ? <div className="home-empty">
        <h2>{working > 0 ? t('现在没有需要你处理的事') : t('接下来想创造什么？')}</h2>
        <p>{working > 0 ? t('{count} 个会话正在工作', { count: working }) : t('描述一个目标，选择项目后开始。')}</p>
      </div> : selected.decision
        ? <DecisionCard decision={selected.decision} now={now} onOpen={onOpenDecision} onDone={setNotice} onError={onError} />
        : <SessionDetail item={selected} now={now} onOpenProject={onOpenProject}>
          <NewWork inCard projects={projects} takeFocus={false} onAction={onAction} onDone={setNotice} onError={onError} />
        </SessionDetail>}
      {!(selected && !selected.decision) && <NewWork projects={projects} takeFocus={!selected} onAction={onAction} onDone={setNotice} onError={onError} />}
    </div>
  </div>;
}

const VOICE_TARGET = 'decision-home';
const AGENT_OPTIONS = [{ value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }];

// "What next": a goal sent to a project's agent from here, without leaving the page. One that runs gets it at once (it
// queues it while it works); otherwise the chosen agent is started first and gets it when its input is ready. Its
// progress then shows in the session list beside it and its work comes back as a card.
function NewWork({ projects, takeFocus, inCard, onAction, onDone, onError }: {
  projects: readonly Project[]; takeFocus: boolean; inCard?: boolean;
  onAction: <T,>(promise: Promise<Result<T>>) => Promise<T | undefined>; onDone: (message: string) => void; onError: (message: string) => void;
}) {
  const local = useMemo(() => projects.filter(project => project.kind !== 'ssh' || project.terminals[0]?.codexActive), [projects]);
  const [text, setText] = useState(''), [projectId, setProjectId] = useState(''), [agent, setAgent] = useState<'claude' | 'codex'>('claude'), [busy, setBusy] = useState(false);
  const project = local.find(item => item.id === projectId) ?? local[0], terminal = project?.terminals[0];
  // Dictation (its microphone or the voice shortcut) puts the words where the cursor is; Enter only puts them in, since
  // the project to send to is chosen below once there is something to send.
  const box = useRef<HTMLTextAreaElement>(null);
  useDictatedBox(VOICE_TARGET, box, setText);
  // With nothing to decide the page's one job is this box, so it takes the focus.
  useEffect(() => { if (takeFocus) box.current?.focus({ preventScroll: true }); }, [takeFocus, local.length]);
  // Pictures pasted here go as files: the agent may not run yet to take them from the clipboard, so each is saved and
  // its path sent with the goal for the agent to look at.
  const [images, setImages] = useState<{ blob: Blob; preview: string }[]>([]);
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.items].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => !!file);
    if (!files.length || event.clipboardData.getData('text/plain')) return;
    event.preventDefault();
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) { onError(t('图片太大（超过 25 MB），请压缩后再粘贴。')); continue; }
      void thumbnail(file).catch(() => dataUrl(file)).then(preview => setImages(list => [...list, { blob: file, preview }].slice(-6))).catch(() => onError(t('无法读取这张图片。')));
    }
  };
  const start = async () => {
    let goal = text.trim();
    if ((!goal && !images.length) || !project || !terminal || busy) return;
    const kind = terminal.codexActive ? (terminal.agent === 'codex' ? 'codex' : 'claude') : agent, name = kind === 'codex' ? 'Codex' : 'Claude Code';
    setBusy(true);
    try {
      if (!terminal.codexActive) {
        if (terminal.sessionId && terminal.shellReady) window.agentrix.writeTerminal(terminal.id, `${agent}\r`);
        else if (!terminal.sessionId && await onAction(window.agentrix.agentLaunch(terminal.id, agent, 'new')) === undefined) return;
        onDone(t('正在启动 {agent}，准备好就把任务发给它…', { agent: name }));
        if (!await untilAtPrompt(terminal.id, kind)) { onError(t('{agent} 还没准备好接收任务，任务留在这里，稍后再点开始。', { agent: name })); return; }
      }
      // A just-started terminal has its session only now.
      const state = await window.agentrix.getState();
      const sessionId = state.ok ? state.value.projects.flatMap(item => item.terminals).find(item => item.id === terminal.id)?.sessionId : null;
      if (!sessionId) { onError(t('它的终端还没有准备好，请稍后再试。')); return; }
      if (images.length) {
        const paths: string[] = [];
        for (const image of images) {
          const saved = await window.agentrix.saveImage(terminal.id, await image.blob.arrayBuffer(), image.blob.type);
          if (!saved.ok) { onError(saved.error); return; }
          paths.push(saved.value);
        }
        goal = [goal, t('附图（请先打开看看）：'), ...paths].filter(Boolean).join('\n');
      }
      const failed = await sendToAgent(terminal.id, sessionId, kind, goal);
      if (failed) { onError(failed); return; }
      setText(''); setImages([]); onDone(t('已交给「{project}」的 {agent}，它的进展会出现在下面。', { project: project.name, agent: name }));
    } catch (error) { onError(String(error)); } finally { setBusy(false); }
  };
  if (!local.length) return null;
  const empty = !text.trim() && !images.length;
  return <section className={`home-pane new-work${inCard ? ' is-inline' : ''}`} aria-label={t('新任务')}>
    <h3>{inCard ? t('接下来要做什么？') : t('告诉 Agentrix 接下来要做什么')}</h3>
    <div className="new-work-input" data-voice-target={VOICE_TARGET} aria-label={t('新任务')}>
      <textarea ref={box} value={text} rows={2} placeholder={inCard ? t('描述目标、提出问题，或粘贴截图…') : t('描述要做的事，比如“给登录页加上验证码”；可以直接粘贴截图')} onChange={event => setText(event.target.value)} onPaste={paste}
        onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void start(); } }} />
      {images.length > 0 && <div className="new-work-images" role="list" aria-label={t('附图')}>{images.map((image, index) => <span key={index} role="listitem">
        <button type="button" className="new-work-zoom" title={t('点击放大')} aria-label={t('放大 {name}', { name: t('附加的图片 {n}', { n: index + 1 }) })}
          onClick={() => showPopup({ kind: 'picture', src: image.preview, path: t('附加的图片 {n}', { n: index + 1 }) })}><img src={image.preview} alt={t('附加的图片 {n}', { n: index + 1 })} /></button>
        <button type="button" aria-label={t('移除这张图片')} onClick={() => setImages(list => list.filter((_, at) => at !== index))}><X size={12} weight="bold" /></button>
      </span>)}</div>}
      <div className="new-work-bar">
        <Select className="new-work-select" label={t('项目')} icon={inCard ? <FolderSimple size={16} aria-hidden="true" /> : undefined} value={project?.id ?? ''} onChange={setProjectId} options={local.map(item => ({ value: item.id, label: item.name }))} />
        {!empty && <span className="new-work-note">{terminal?.codexActive ? t('直接发给它，不离开这一页') : t('先启动助手，准备好就发给它')}</span>}
        {terminal && !terminal.codexActive && <Select className="new-work-select is-agent" label={t('助手')} value={agent} onChange={value => setAgent(value as 'claude' | 'codex')} options={AGENT_OPTIONS} />}
        <VoiceButton terminalId={VOICE_TARGET} sessionId={null} name={t('新任务')} size={16} onError={onError} />
        <button type="button" className={`button ${empty ? 'secondary' : 'primary'} new-work-start`} title={t('开始 (Ctrl + Enter)')} aria-label={t('开始 (Ctrl + Enter)')} disabled={busy || empty} onClick={() => void start()}>{busy ? <CircleNotch size={16} className="loading-spinner" /> : <ArrowUp size={16} weight="bold" />}</button>
      </div>
    </div>
  </section>;
}
