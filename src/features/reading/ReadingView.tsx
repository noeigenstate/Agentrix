import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { readingMarked } from './markdown-escape';
import createDOMPurify from 'dompurify';
import { ArrowDown, CaretDown, CaretUp, CheckCircle, FileText, Globe, Image as ImageIcon, MagnifyingGlass, PaperPlaneRight, PencilSimple, Plugs, Robot, Sparkle, Stop, TerminalWindow, Wrench, X, XCircle, type Icon } from '@phosphor-icons/react';
import type { AgentCommand, ConversationEntry, ProjectTerminal } from '../../shared/types';
import { actionText, stepVerb } from '../agents/action-text';
import { CodexLogo } from '../agents/AgentBrandIcon.ts';
import { dictateInto } from '../voice/voice-input';
import { createDictationSend } from './dictation-send';
import { readScreen, useScreen } from '../terminal/terminal-screen';
import { parseAgentScreen } from '../agents/agent-screen';
import { cliDialogShown, cliInputDraft, hasCliInput, isAtPrompt } from './cli-panel';
import { ReadingWelcome } from './ReadingWelcome';
import { ReadingChoice } from './ReadingChoice';
import { NativeApprovalCard } from './NativeApprovalCard';
import { ManagedSession } from './ManagedSession';
import { ReadingQuestion } from './ReadingQuestion';
import { ReadingSessions } from './ReadingSessions';
import { typeReadingCommand, usesSessionPicker } from './reading-sessions';
import { dataUrl, thumbnail } from './image-thumbnail';
import { rememberPicture, withPictures } from './pasted-pictures';
import { useWelcomeStarting } from './reading-welcome';
import { ReadingTerminalPopup } from './ReadingTerminalPopup';
import { ReadingSignIn } from './ReadingSignIn';
import { signInScreen } from '../agents/sign-in-screen';
import { bindApproval, choiceIdentity } from './choice-keys';
import { setChoiceVisible } from './reading-mode';
import { isTyping, markTyping } from './typing';
import { useStickToBottom } from './useStickToBottom';
import { conversationKey, useReadingConversation } from './useReadingConversation';
import { blocks, conversationTurns, useVisibleTail } from './useVisibleTail';
import './reading.css';
import './reading-flow.css';
import { currentLanguage, t } from '../../shared/i18n';
import { UserAvatar } from '../../shared/UserAvatar';
import { useMentions } from './useMentions';
import { parseMarkdown, parsedMarkdown } from './markdown-parse';
import { MentionPalette } from './MentionPalette';
import { isTypedCommand, pendingPromptCards, sameMessage, type PendingPrompt } from './pending-prompts';
import { usePendingPrompts } from './usePendingPrompts';
import { PendingPromptEntries, UserImages, UserMessage } from './PendingPromptEntries';
import { AgentTurnItem, ClaudeSpark, stepTime, TimelineStep } from './Timeline';
import { ResultActions, ResultFiles, ResultStatus } from './ResultCard';
import { latestResult } from './result-round';
import { AgentCommandRun } from './AgentCommandRun';
import { FileCards, previewable } from './FileCards';
import { replyFiles } from './reply-files';
import { onComposerPrefill } from './composer-prefill';
import { showPopup } from '../files/file-popup';

const purifier = createDOMPurify(window);
// Switching to the CLI unmounts the composer; sent messages still belong to that terminal.
const history = new Map<string, string[]>();
// The entries on screen when /clear (or Codex's /new) was sent from here, per conversation. The agent starts a new
// conversation at once, but its file only appears with the next message; until then these stay hidden.
const cleared = new Map<string, ReadonlySet<string>>();
const clears = (agent: ProjectTerminal['agent'], text: string) => (agent === 'claude' ? /^\/clear(?:\s|$)/ : /^\/(?:clear|new)(?:\s|$)/).test(text.trim());
// Picture previews may still be decoding after the CLI has accepted the attachment.
const IMAGE_PLACEHOLDER = /\[Image #\d+\]/;
// A Markdown block the agent shows (a file's content, a draft) is laid out like the answer around it, its source a
// click away; inside it, Markdown blocks stay source. A very long one stays source too: this runs on the window's thread.
const DOCUMENT = /^(?:markdown|md|mdx)$/i, DOCUMENT_LIMIT = 20000;
// What the agent wrote, laid out as Markdown. Only plain structure survives: no raw HTML, no images (an
// answer has no business loading anything), and links open outside through the window's link handler.
function finish(parsed: string, nested = false): string {
  const html = purifier.sanitize(parsed, {
    ALLOWED_TAGS: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'hr', 'br', 'em', 'strong', 's', 'del', 'input', 'kbd'],
    ALLOWED_ATTR: ['href', 'class', 'type', 'checked', 'disabled', 'start', 'align'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
  });
  const root = document.createElement('div'); root.innerHTML = html;
  for (const box of root.querySelectorAll('input')) { box.type = 'checkbox'; box.disabled = true; }
  // Each code block gets a copy button over its top right corner.
  for (const pre of root.querySelectorAll('pre')) {
    const frame = document.createElement('div'); frame.className = 'reading-code';
    const language = pre.querySelector('code')?.className.match(/language-([\w+-]+)/)?.[1];
    const bar = document.createElement('div'); bar.className = 'reading-code-bar';
    bar.innerHTML = `<span></span><button type="button" data-copy-code>${t('复制')}</button>`;
    bar.querySelector('span')!.textContent = language || '';
    pre.replaceWith(frame); frame.append(bar, pre);
    const source = pre.textContent || '';
    if (nested || !language || !DOCUMENT.test(language) || !source.trim() || source.length > DOCUMENT_LIMIT) continue;
    const doc = document.createElement('div'); doc.className = 'reading-code-doc';
    doc.innerHTML = finish(readingMarked.parse(source) as string, true);
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.dataset.codeSource = ''; toggle.textContent = t('源码');
    bar.querySelector('span')!.textContent = 'Markdown';
    bar.insertBefore(toggle, bar.querySelector('[data-copy-code]'));
    frame.classList.add('is-document'); frame.insertBefore(doc, pre);
  }
  return root.innerHTML;
}

const safely = (make: () => string) => { try { return make(); } catch { return null; } };
// Short answers are parsed here at once. A long one is parsed in a worker (markdown-parse): until it is ready the
// previous version stays (an answer still streaming) or the text shows plain, and a parse that takes too long leaves
// it plain rather than freezing the window. One parse per answer runs at a time, always of its latest text.
const QUICK = 4000;
export function Markdown({ text }: { text: string }) {
  const language = currentLanguage(), short = text.length <= QUICK;
  const quick = useMemo(() => short ? safely(() => finish(readingMarked.parse(text) as string)) : undefined, [text, language, short]);
  const [long, setLong] = useState<{ text: string; parsed: string | null } | null>(() => {
    const parsed = short ? undefined : parsedMarkdown(text);
    return parsed === undefined ? null : { text, parsed };
  });
  const target = useRef(text), pumping = useRef(false), alive = useRef(true);
  target.current = text;
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => {
    if (short || pumping.current) return;
    pumping.current = true;
    void (async () => {
      let value = target.current;
      while (alive.current) {
        const parsed = await parseMarkdown(value);
        if (!alive.current) break;
        setLong({ text: value, parsed });
        if (target.current === value || target.current.length <= QUICK) break;
        value = target.current;
      }
      pumping.current = false;
    })();
  }, [text, short]);
  const html = useMemo(() => short ? quick : long?.parsed == null ? null : safely(() => finish(long.parsed!)), [short, quick, long, language]);
  if (html == null || (!short && long?.parsed === null && long.text === text)) return <p className="reading-plain">{text}</p>;
  return <div className="reading-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

// A picture the agent generated, shown where it answered; a click shows it full size in a popup. Its prompt is a two-line summary
// under it; when the summary is cut off, a text toggle shows the whole prompt (not remembered). The latest result's picture
// is larger and carries the agent's one-sentence reply (children) between itself and its prompt.
function GeneratedImage({ src, path, prompt, result = false, children }: { src: string; path: string; prompt: string; result?: boolean; children?: ReactNode }) {
  const open = () => showPopup({ kind: 'image', path });
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const caption = useRef<HTMLElement>(null);
  const captionId = useId();
  useEffect(() => {
    const element = caption.current;
    if (!element || expanded) return;
    const measure = () => setClipped(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [prompt, expanded]);
  return <figure className={`reading-generated${result ? ' is-result' : ''}`}>
    <button type="button" className="reading-generated-picture" title={t('打开原图')} aria-label={t('打开原图')} onClick={open}><img src={src} alt={prompt || t('生成的图片')} /></button>
    {children}
    {prompt && <figcaption id={captionId} ref={caption} className={expanded ? 'is-expanded' : undefined}>{prompt}</figcaption>}
    {prompt && (clipped || expanded) && <button type="button" className="reading-generated-toggle" aria-expanded={expanded} aria-controls={captionId} onClick={() => setExpanded(!expanded)}>
      {expanded ? t('收起') : t('展开提示词')}{expanded ? <CaretUp size={12} aria-hidden="true" /> : <CaretDown size={12} aria-hidden="true" />}
    </button>}
  </figure>;
}

// A reply card inside its agent's turn, with the local pictures, pages and videos it names shown under it
// (the agents are told they can show one this way: reading-note.cjs).
function AssistantReply({ entry, agent, projectId, result = false, onError }: { entry: ConversationEntry; agent: 'claude' | 'codex'; projectId: string; result?: boolean; onError: (message: string) => void }) {
  const named = useMemo(() => entry.text ? replyFiles(entry.text) : [], [entry.text]);
  const words = entry.text ? <Markdown text={entry.text} /> : null;
  // The latest result shows its picture first with the words under it; anywhere else the words come first.
  const picture = entry.generated && entry.images?.[0] ? <GeneratedImage src={entry.images[0]} {...entry.generated} result={result}>{result && words}</GeneratedImage> : null;
  return <div className={`reading-assistant is-${agent}`}>{result && picture}{!(result && picture) && words}
      {named.length > 0 && <FileCards projectId={projectId} files={named} renderMarkdown={text => <Markdown text={text} />} onError={onError} quiet />}
      {!result && picture}</div>;
}
// The agent's mark on its replies' nodes.
const AgentMark = ({ agent }: { agent: 'claude' | 'codex' }) => agent === 'claude' ? <ClaudeSpark /> : <CodexLogo />;

// Where a generated picture will appear: a bar that keeps moving and the seconds so far, so a picture that takes
// half a minute does not look stuck.
// When each picture began to be drawn, by its step: the card is drawn again as the conversation grows.
const drawingSince = new Map<string, number>();
function ImageProgress({ step }: { step: string }) {
  if (!drawingSince.has(step)) { drawingSince.set(step, Date.now()); if (drawingSince.size > 20) drawingSince.delete(drawingSince.keys().next().value!); }
  const since = drawingSince.get(step)!, [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return <div className="reading-generating" role="status">
    <span className="reading-generating-bar" aria-hidden="true"><i /></span>
    <span>{t('正在生成图片… {seconds} 秒', { seconds: Math.max(0, Math.floor((now - since) / 1000)) })}</span><small>{t('通常需要 20–40 秒')}</small>
  </div>;
}

type ConversationEntryTool = NonNullable<ConversationEntry['tool']>;
// What a group of steps did, by kind, in the order the kinds first came: "读取 2 个文件 · 运行 1 条命令".
const GROUP_PARTS: Record<ConversationEntryTool['kind'], string> = {
  read: '读取 {count} 个文件', edit: '编辑 {count} 个文件', command: '运行 {count} 条命令', search: '搜索 {count} 处', web: '访问 {count} 个网页',
  skill: '使用 {count} 个技能', mcp: '调用 {count} 个 MCP 工具', agent: '派出 {count} 个子代理', other: '调用 {count} 个工具',
};
const STEP_ICONS: Record<ConversationEntryTool['kind'], Icon> = { read: FileText, edit: PencilSimple, command: TerminalWindow, search: MagnifyingGlass, web: Globe, skill: Sparkle, mcp: Plugs, agent: Robot, other: Wrench };
export function groupSummary(entries: readonly ConversationEntry[]) {
  const counts = new Map<ConversationEntryTool['kind'], number>();
  // An edit counts the files it changed (its target names them, "a、b"), every other step counts once.
  for (const entry of entries) if (entry.tool) {
    const files = entry.tool.kind === 'edit' ? Math.max(1, entry.tool.written?.length || entry.tool.target.split('、').filter(Boolean).length) : 1;
    counts.set(entry.tool.kind, (counts.get(entry.tool.kind) || 0) + files);
  }
  return [...counts].map(([kind, count]) => t(GROUP_PARTS[kind], { count })).join(' · ');
}

function ToolGroup({ entries, live, projectId, onError }: { entries: ConversationEntry[]; live: boolean; projectId: string; onError: (message: string) => void }) {
  const running = entries.some(entry => !entry.tool?.done);
  const [open, setOpen] = useState(false);
  const failed = entries.filter(entry => entry.tool?.failed).length;
  const shown = open || (live && running);
  // A picture being generated: Codex reports no progress, so the wait is shown as such, with the time it has taken.
  const drawing = entries.find(entry => !entry.tool?.done && /image_?gen/i.test(`${entry.tool?.tool} ${entry.tool?.target}`));
  // The documents, pages and videos these steps finished writing, each once.
  const files = useMemo(() => [...new Set(entries.flatMap(entry => entry.tool?.done && !entry.tool.failed ? entry.tool.written ?? [] : []))].filter(previewable), [entries]);
  // The files its edits changed, by name, a few of them on the pill itself.
  const edited = useMemo(() => [...new Set(entries.flatMap(entry => entry.tool?.kind === 'edit' ? entry.tool.written?.length ? entry.tool.written : entry.tool.target.split('、') : []))]
    .map(file => file.split(/[\\/]/).pop() || file).filter(Boolean), [entries]);
  return <div className={`reading-tools${running ? ' is-running' : ''}${shown ? ' is-open' : ''}${failed ? ' has-failed' : ''}`}>
    <button type="button" className="reading-tools-head" aria-expanded={shown} onClick={() => setOpen(!open)}>
      <StepState running={running} failed={failed > 0} />
      <span>{groupSummary(entries)}</span>
      {failed > 0 && <em>{t('{count} 个失败', { count: failed })}</em>}
      {edited.slice(0, 3).map(file => <code key={file} className="reading-tools-file">{file}</code>)}
      {edited.length > 3 && <small className="reading-tools-more">+{edited.length - 3}</small>}
      {shown ? <CaretUp size={13} weight="bold" className="reading-tools-caret" /> : <CaretDown size={13} weight="bold" className="reading-tools-caret" />}
    </button>
    {shown && <ul className="reading-tools-tree">{entries.map(entry => {
      const tool = entry.tool!, Step = STEP_ICONS[tool.kind];
      return <li key={entry.id} className={`${tool.done ? '' : 'is-running'} ${tool.failed ? 'is-failed' : ''} reading-tool-${tool.kind}`}>
        <StepState running={!tool.done} failed={tool.failed} filled />
        <Step size={16} className="reading-tool-icon" />
        <b>{stepVerb(tool)}</b><code title={tool.target}>{tool.target}</code>{tool.detail && <small>{tool.detail}</small>}
      </li>;
    })}</ul>}
    {drawing && <ImageProgress step={drawing.id} />}
    {files.length > 0 && <FileCards projectId={projectId} files={files} renderMarkdown={text => <Markdown text={text} />} onError={onError} />}
  </div>;
}
// A step's state: a dot sending out a soft ring while it runs (as its node on the line does), a check when it is done,
// a cross when it failed.
function StepState({ running, failed, filled = false }: { running: boolean; failed: boolean; filled?: boolean }) {
  if (running) return <span className="reading-step-state is-running" role="img" aria-label={t('进行中')} />;
  return failed ? <XCircle size={17} weight="fill" className="reading-step-state is-failed" aria-label={t('失败')} />
    : <CheckCircle size={17} weight={filled ? 'fill' : 'regular'} className="reading-step-state" aria-label={t('已完成')} />;
}

// The agent's conversation laid out for reading: your prompts, its answers as Markdown with copyable code,
// and its tool calls folded between them. The real terminal stays underneath; what is written here goes to
// it, and the toggle in the card header switches back to it at any time. autoFocus: the card is expanded and
// this is its terminal in use, so the message box takes the keyboard (never a small card's).
// The agent at work, as its CLI shows it: a live mark, what it is doing, how long the round has run and how to stop it.
function WorkingLine({ agent, label }: { agent: 'claude' | 'codex'; label: string }) {
  const [started] = useState(() => Date.now()), [now, setNow] = useState(started);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return <div className={`reading-status is-working is-${agent}`} role="status">
    <i className="reading-status-mark" aria-hidden="true">{agent === 'claude' ? null : '•'}</i>
    <span>{label}…</span><small>{t('（{seconds} 秒 · Esc 中断）', { seconds: Math.floor((now - started) / 1000) })}</small>
  </div>;
}

export function ReadingView(props: Parameters<typeof LegacyReadingView>[0]) {
  return props.terminal.nativeMode === 'claude-sdk' ? <ManagedSession key={props.terminal.sessionId} terminal={props.terminal} onError={props.onError} /> : <LegacyReadingView {...props} />;
}

function LegacyReadingView({ projectId, terminal, remote = false, autoFocus, active = true, onShowTerminal, onError, onOpenLink }: { projectId: string; terminal: ProjectTerminal; remote?: boolean; autoFocus: boolean; active?: boolean; onShowTerminal: () => void; onError: (message: string) => void; onOpenLink: (target: string) => void }) {
  const conversationEntries = useReadingConversation(terminal.id, terminal.sessionId);
  const [hidden, setHidden] = useState(() => cleared.get(conversationKey(terminal.id, terminal.sessionId)));
  useEffect(() => { setHidden(cleared.get(conversationKey(terminal.id, terminal.sessionId))); }, [terminal.id, terminal.sessionId]);
  // What /clear hid stays hidden only while that conversation is the one shown: once the agent has moved to another
  // (its new conversation came in), resuming the old one later shows it again rather than an empty page.
  useEffect(() => {
    if (!hidden || !conversationEntries.length || conversationEntries.some(entry => hidden.has(entry.id))) return;
    cleared.delete(conversationKey(terminal.id, terminal.sessionId)); setHidden(undefined);
  }, [conversationEntries, hidden]);
  const entries = useMemo(() => conversationEntries.filter(entry => !entry.queued && !hidden?.has(entry.id)), [conversationEntries, hidden]);
  const { pending, echo, cancelEcho } = usePendingPrompts(terminal.id, terminal.sessionId, conversationEntries);
  // Queued records wait after the active turn, with or without a renderer echo. They never start a new agent turn.
  const cards = useMemo(() => pendingPromptCards(pending, conversationEntries.filter(entry => !hidden?.has(entry.id))), [pending, conversationEntries, hidden]);
  const queued = (prompt: PendingPrompt) => cards.queuedIds.has(prompt.id);
  const visibleEntries = useMemo(() => [...entries, ...cards.prompts], [entries, cards]);
  const sendCounter = useRef(0);
  const visibleScreen = useScreen(terminal.id);
  const screen = useMemo(() => {
    const agent = terminal.agent === 'claude' ? 'claude' : 'codex';
    const parsed = parseAgentScreen(agent, visibleScreen?.rows ?? []);
    return { ...parsed, choice: bindApproval(parsed.choice, agent, visibleScreen) };
  }, [terminal.agent, visibleScreen]);
  // The CLI signing in before its input exists (a link to open, a code to paste): a popup, never a stuck welcome.
  const signIn = useMemo(() => {
    const kind = terminal.agent === 'claude' ? 'claude' : 'codex';
    return terminal.codexActive && visibleScreen && !screen.choice && !hasCliInput(kind, visibleScreen.rows, screen) ? signInScreen(kind, visibleScreen.rows) : null;
  }, [terminal.agent, terminal.codexActive, visibleScreen, screen]);
  const choiceKey = screen.choice ? `${terminal.sessionId}:${screen.choice.approval?.instance ?? ''}:${choiceIdentity(screen.choice)}` : null;
  const [sessionsOpen, setSessionsOpen] = useState(false);
  useEffect(() => { setSessionsOpen(false); }, [terminal.id, terminal.sessionId, terminal.agent]);
  const welcomeIsStarting = useWelcomeStarting(terminal.agentStartedAt, screen);
  const hasChoice = screen.choice !== null || sessionsOpen, choiceVisible = useRef(hasChoice); choiceVisible.current = hasChoice;
  const mounted = useRef(true);
  const choiceHost = useRef<HTMLDivElement>(null), restoreComposer = useRef(false), wasChoice = useRef(false), typingAtChoice = useRef(false);
  const [draft, setDraft] = useState('');
  const [sendingSoon, setSendingSoon] = useState(false);
  const [commands, setCommands] = useState<AgentCommand[]>([]), [requested, setRequested] = useState(false);
  const [dismissed, setDismissed] = useState(false), [selection, setSelection] = useState(0);
  const historyAt = useRef<number | null>(null), unsent = useRef(''), caret = useRef<number | null>(null), sending = useRef(false);
  // Images pasted for the next message. The agent holds them itself; this only counts them.
  const [images, setImages] = useState<string[]>([]);
  // An SSH project's pictures for the next message: files saved on that computer. Their paths join the message only as
  // it is sent (both CLIs take a picture's path as the picture); the message box shows the words alone.
  const [serverPictures, setServerPictures] = useState<string[]>([]);
  const scroller = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const [terminalPopup, setTerminalPopup] = useState<{ command: string } | null>(null);
  choiceVisible.current = hasChoice || terminalPopup !== null;
  const popupReady = useRef<(() => void) | null>(null);
  const readyPopup = () => { popupReady.current?.(); popupReady.current = null; };
  const cancelSend = () => { sendCounter.current++; sending.current = false; readyPopup(); };
  const closePopup = (restoreFocus = true) => {
    cancelSend(); setTerminalPopup(null);
    if (restoreFocus) {
      if (inputBlocked) (choiceHost.current?.firstElementChild as HTMLElement | null)?.focus({ preventScroll: true });
      else input.current?.focus({ preventScroll: true });
    }
  };
  useLayoutEffect(() => {
    setTerminalPopup(null);
    return cancelSend;
  }, [terminal.id, terminal.sessionId]);
  const ownership = useRef({ active, autoFocus });
  useLayoutEffect(() => {
    const previous = ownership.current; ownership.current = { active, autoFocus };
    if (previous.active && !active || previous.autoFocus && !autoFocus) { cancelSend(); setTerminalPopup(null); }
  }, [active, autoFocus]);
  // A question's own key hint with no card read from it (the question is taller than the view, or its hint wrapped):
  // a message typed here would land in the question, so the box waits and the terminal shows the question instead.
  const unreadQuestion = !screen.choice && !!visibleScreen?.rows.some(row => /\benter to submit (?:answer|all)\b/i.test(row) || /^\s*Enter to select\b.*\bEsc to cancel\b/i.test(row));
  useEffect(() => { if (unreadQuestion) setTerminalPopup({ command: '' }); }, [unreadQuestion]);
  const inputBlocked = sessionsOpen || !!screen.choice && screen.choice.kind !== 'menu' || unreadQuestion;
  const conversation = conversationKey(terminal.id, terminal.sessionId);
  const { stuck, unseen, toBottom, ready, holdPosition } = useStickToBottom(scroller, content, visibleEntries, conversation);
  // A step hops only when the pointer moves onto it: moving arms the hops, any scroll disarms them until it moves again,
  // so the steps sliding under a still pointer stay put (marked on the element itself, without a render).
  useEffect(() => {
    const node = scroller.current; if (!node) return;
    const onMove = () => { if (!('hover' in node.dataset)) node.dataset.hover = ''; };
    const onScroll = () => { if ('hover' in node.dataset) delete node.dataset.hover; };
    node.addEventListener('pointermove', onMove, { passive: true }); node.addEventListener('scroll', onScroll, { passive: true });
    return () => { node.removeEventListener('pointermove', onMove); node.removeEventListener('scroll', onScroll); };
  }, [conversation]);
  useLayoutEffect(() => { if (caret.current !== null) { input.current?.setSelectionRange(caret.current, caret.current); caret.current = null; } });
  useEffect(() => { if (draft.startsWith('/') || !entries.length) setRequested(true); }, [draft, entries.length]);
  // Capture composer ownership before disabling it; another card's focus must stay where it is.
  // A card that comes while someone writes in the box never takes the keyboard: the next Enter would answer it.
  if (hasChoice && !wasChoice.current) {
    restoreComposer.current = document.activeElement === input.current || sessionsOpen;
    typingAtChoice.current = isTyping(document.activeElement);
  }
  useLayoutEffect(() => {
    setChoiceVisible(terminal.id, hasChoice || terminalPopup !== null);
    if (hasChoice && terminalPopup === null) {
      if (restoreComposer.current && !typingAtChoice.current && (!wasChoice.current || document.activeElement === document.body)) (choiceHost.current?.firstElementChild as HTMLElement | null)?.focus();
    } else if (wasChoice.current) {
      if (restoreComposer.current && document.activeElement === document.body) input.current?.focus();
      restoreComposer.current = false;
    }
    wasChoice.current = hasChoice;
  }, [terminal.id, hasChoice, choiceKey, terminalPopup]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; setChoiceVisible(terminal.id, false);
    };
  }, [terminal.id]);
  useEffect(() => {
    setCommands([]);
    if (!requested) return;
    let active = true;
    void window.agentrix.terminalCommands(terminal.id).then(result => {
      if (active) { setCommands(result.ok ? result.value : []); if (!result.ok) onError(result.error); }
    }).catch(error => { if (active) onError(String(error)); });
    return () => { active = false; };
  }, [terminal.id, terminal.agent, requested]);
  const matches = useMemo(() => {
    const query = draft.slice(1).toLowerCase(), name = (command: AgentCommand) => command.name.slice(1).toLowerCase();
    // The command named exactly comes first (a project's /doc before the built-in /doctor), then those it begins.
    const rank = (command: AgentCommand) => name(command) === query ? 0 : name(command).startsWith(query) ? 1 : 2;
    return commands.filter(command => name(command).includes(query)).sort((a, b) => rank(a) - rank(b));
  }, [commands, draft]);
  // A command recalled from history (↑) is sent as it is: the list stays shut, so ↑ goes on through history.
  const palette = !inputBlocked && !dismissed && historyAt.current === null && /^\/[^\s]*$/.test(draft), selected = matches[selection];
  const listId = `reading-commands-${terminal.id}`, optionId = (index: number) => `${listId}-${index}`;
  useEffect(() => { setSelection(0); }, [draft, commands]);
  useEffect(() => { if (palette) document.getElementById(optionId(selection))?.scrollIntoView({ block: 'nearest' }); }, [palette, selection]);
  const edit = (value: string) => { dictationSend.cancel(); setDraft(value); setDismissed(false); historyAt.current = null; };
  // Text written for this terminal on the home page waits here for the reader to send it.
  useEffect(() => onComposerPrefill(terminal.id, text => { dictationSend.cancel(); setDraft(text); setDismissed(true); requestAnimationFrame(() => input.current?.focus()); }), [terminal.id]);
  const complete = (command: AgentCommand) => {
    caret.current = command.name.length + 1; edit(command.name + ' '); input.current?.focus();
  };
  const mentions = useMentions({ projectId, draft, input, disabled: inputBlocked || /^\/[^\s]*$/.test(draft), edit, onError });
  useEffect(() => {
    if (!autoFocus) return;
    if (choiceVisible.current) { restoreComposer.current = true; (choiceHost.current?.firstElementChild as HTMLElement | null)?.focus(); }
    else if (terminalPopup === null) input.current?.focus();
  }, [terminal.id, autoFocus]);
  // Claude's own screen has the last word: a round its hooks opened without closing (a local slash command) must not
  // keep "thinking" on screen while Claude sits idle at its prompt.
  // It is at its prompt even with an interrupted prompt put back in its input.
  const claudeIdle = terminal.agent === 'claude' && !!visibleScreen && isAtPrompt('claude', visibleScreen.rows, screen);
  const working = terminal.codexActive && terminal.codexActivity === 'working' && !claudeIdle;
  const agent = terminal.agent === 'claude' ? 'Claude Code' : 'Codex';
  const grouped = useMemo(() => blocks(entries), [entries]);
  const tail = useVisibleTail(grouped, conversation, scroller, stuck, holdPosition);
  const turns = useMemo(() => conversationTurns(grouped, tail.earlier), [grouped, tail.earlier]);
  // Returning from session A to B to A must not revive an earlier send's delayed keys.
  const ownsSend = (owner: number) => mounted.current && sendCounter.current === owner;
  const send = async (text = draft.trim(), own = true) => {
    if (own) dictationSend.cancel();
    if (sending.current) return;
    const owner = ++sendCounter.current;
    sending.current = true;
    try { await deliver(text, own, owner); } catch (error) { if (ownsSend(owner)) onError(String(error)); } finally { if (ownsSend(owner)) sending.current = false; }
  };
  const interrupt = () => window.agentrix.writeTerminal(terminal.id, '\x1b');
  // The CLI recognises slash commands and shell mode from typed keys, not bracketed paste.
  // own: written in the composer here (it is cleared, with its pictures); otherwise a message sent again, which leaves
  // whatever is being written now alone and takes no pictures with it.
  const deliver = async (words: string, own: boolean, owner: number) => {
    const attached = own ? images : [], pictures = own ? serverPictures : [];
    const text = pictures.length ? (isTypedCommand(words) ? [words, ...pictures] : [...pictures, words]).filter(Boolean).join(' ') : words;
    if ((!text && !attached.length) || !terminal.sessionId) return;
    if (usesSessionPicker(terminal, text, remote)) {
      if (inputBlocked) return;
      choiceVisible.current = true; restoreComposer.current = document.activeElement === input.current;
      if (own) edit('');
      setSessionsOpen(true); return;
    }
    const remember = () => { if (words) history.set(terminal.id, [...(history.get(terminal.id) || []), words].slice(-50)); };
    if (isTypedCommand(text)) {
      if (own) { edit(''); setImages([]); setServerPictures([]); }
      remember();
      const ready = new Promise<void>(resolve => { popupReady.current = resolve; });
      setTerminalPopup({ command: text });
      await ready;
      const sent = await typeReadingCommand(text, value => window.agentrix.writeTerminal(terminal.id, value), () => ownsSend(owner));
      if (sent && clears(terminal.agent, text)) { const ids = new Set(conversationEntries.map(entry => entry.id)); cleared.set(conversation, ids); setHidden(ids); }
      return;
    }
    // A closed popup can leave the CLI's dialog open. Looking is harmless; guessing a close key is not.
    const agentKind = terminal.agent === 'claude' ? 'claude' : 'codex', rows = readScreen(terminal.id)?.rows ?? [];
    const parsed = parseAgentScreen(agentKind, rows);
    if (!hasCliInput(agentKind, rows, parsed) || cliDialogShown(agentKind, rows, parsed)) { setTerminalPopup({ command: '' }); return; }
    if (inputBlocked) return;
    const pendingId = text ? echo(text, attached) : null;
    if (pendingId) toBottom();
    const left = text && !attached.length ? inputDraft(agentKind) : '';
    if (own) { edit(''); setImages([]); setServerPictures([]); }
    if (left && sameMessage(text, left)) {
      toBottom(); window.agentrix.writeTerminal(terminal.id, '\r'); await submitted(agentKind, text, owner);
      remember(); return;
    }
    if (left && pending.some(prompt => sameMessage(prompt.text, left))) { window.agentrix.writeTerminal(terminal.id, '\r'); await submitted(agentKind, left, owner); }
    else if (left && !IMAGE_PLACEHOLDER.test(left)) await clearInput(agentKind, owner);
    if (!ownsSend(owner)) return;
    if (text) {
      const pasted = await window.agentrix.pasteTerminal(terminal.id, text, terminal.sessionId);
      if (!ownsSend(owner)) return;
      if (!pasted.ok) {
        if (pendingId) cancelEcho(pendingId);
        if (own && !input.current?.value) { edit(words); setServerPictures(pictures); }
        onError(pasted.error); return;
      }
      remember();
    }
    toBottom();
    if (text) await new Promise(resolve => setTimeout(resolve, 400));
    if (!ownsSend(owner) || choiceVisible.current) return;
    window.agentrix.writeTerminal(terminal.id, '\r');
    if (text) await submitted(agentKind, text, owner);
  };
  // What is typed in the CLI's own input right now.
  const inputDraft = (agent: 'claude' | 'codex') => { const current = readScreen(terminal.id); return current ? cliInputDraft(agent, current.rows, parseAgentScreen(agent, current.rows)) : ''; };
  // Ctrl+U clears a row of the CLI's input: Claude Code clears only the visual row of a long draft wrapped over several,
  // so it is pressed again until the input is empty (a few more than the rows, at most).
  const clearInput = async (agent: 'claude' | 'codex', owner: number) => {
    for (let tries = 0; tries < 30 && ownsSend(owner) && inputDraft(agent); tries++) { window.agentrix.writeTerminal(terminal.id, '\x15'); await new Promise(resolve => setTimeout(resolve, 80)); }
  };
  // A message is sent once it has left the CLI's input. An Enter the CLI did not take (it arrived while the CLI was
  // busy redrawing, compacting or taking the paste) leaves it there: Enter again, a few times.
  const submitted = async (agent: 'claude' | 'codex', text: string, owner: number) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 700));
      if (!ownsSend(owner) || choiceVisible.current || !sameMessage(text, inputDraft(agent))) return;
      window.agentrix.writeTerminal(terminal.id, '\r');
    }
  };
  const sendRef = useRef(send); sendRef.current = send;
  const [dictationSend] = useState(() => createDictationSend(() => { void sendRef.current(); }, setSendingSoon));
  // A terminal can stay mounted when another split is selected. Cancel before it loses composer ownership.
  useLayoutEffect(() => () => { dictationSend.cancel(); }, [dictationSend, terminal.id, terminal.sessionId, active, autoFocus]);
  // A command another part of the window sends this agent (the activity pane's limit reset) goes as one typed here
  // would, its popup showing what the agent answers.
  useEffect(() => {
    const take = (event: Event) => {
      const detail = (event as CustomEvent<{ terminalId: string; text: string }>).detail;
      if (detail?.terminalId !== terminal.id) return;
      event.preventDefault(); void sendRef.current(detail.text, false);
    };
    window.addEventListener('agentrix:command', take);
    return () => window.removeEventListener('agentrix:command', take);
  }, [terminal.id]);
  // The safety net: a message no record has shown once its echo timed out, while the agent sits idle, is sent again
  // (twice at most). Only the pending-prompt reconciler can acknowledge a matching, newly observed record.
  const retries = useRef({ conversation, counts: new Map<string, number>() });
  if (retries.current.conversation !== conversation) retries.current = { conversation, counts: new Map() };
  const resent = retries.current.counts;
  const [idleSince, setIdleSince] = useState(() => Date.now()), [, setTick] = useState(0);
  useEffect(() => { if (!working) setIdleSince(Date.now()); }, [working]);
  // A message in Claude Code's queue has arrived: it is taken up when the current step is done, never sent again.
  const stalled = pending.filter(prompt => !prompt.sending && !queued(prompt)), idle = !working && terminalPopup === null && !hasChoice && Date.now() - idleSince >= 5000;
  useEffect(() => {
    if (!stalled.length || working || terminalPopup !== null || hasChoice) return;
    const wait = idleSince + 5000 - Date.now();
    if (wait > 0) { const timer = setTimeout(() => setTick(tick => tick + 1), wait + 50); return () => clearTimeout(timer); }
    for (const prompt of stalled) {
      const tries = resent.get(prompt.text) ?? 0;
      if (tries >= 2 || sending.current) continue;
      resent.set(prompt.text, tries + 1);
      cancelEcho(prompt.id); void sendRef.current(prompt.text, false);
      break;
    }
  });
  const undelivered = (prompt: PendingPrompt) => idle && !prompt.sending && !queued(prompt) && (resent.get(prompt.text) ?? 0) >= 2;
  const resend = (prompt: PendingPrompt) => { cancelEcho(prompt.id); void send(prompt.text, false); };
  // Dictation into this terminal lands here while the reading view shows: the words appear at the cursor as
  // soon as they are recognised. Enter (or the shortcut again) allows a second to edit before sending normally.
  useEffect(() => dictateInto(terminal.id, (text, submit) => {
    if (choiceVisible.current || terminalPopup !== null) return;
    const node = input.current, value = node?.value ?? '', here = !!node && document.activeElement === node;
    const at = here ? node.selectionStart : value.length, end = here ? node.selectionEnd : value.length;
    const next = value.slice(0, at) + text + value.slice(end);
    caret.current = at + text.length; edit(next); node?.focus();
    if (submit) dictationSend.start();
  }), [terminal.id]);
  // An image pasted here goes to the agent the way it takes one in its own input: it reads the clipboard on its
  // paste key (Ctrl+V in Codex, Alt+V in Claude Code on Windows) and attaches the image to the next message.
  const pasteImage = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const owner = sendCounter.current;
    const data = event.clipboardData;
    if (data.getData('text/plain') || ![...data.items].some(item => item.kind === 'file' && item.type.startsWith('image/'))) return;
    event.preventDefault();
    if (!terminal.codexActive || !terminal.sessionId) { onError(t('启动 Codex 或 Claude Code 后才能粘贴图片。')); return; }
    // The first picture goes into a clean input: text left there (a prompt Claude put back after an interrupt) would be
    // sent with this message, and once pictures are in it Ctrl+U would take them too. One of ours still waiting stays.
    const agentKind = terminal.agent === 'claude' ? 'claude' : 'codex', left = !images.length && !remote ? inputDraft(agentKind) : '';
    const clearFirst = !!left && !IMAGE_PLACEHOLDER.test(left) && !pending.some(prompt => sameMessage(prompt.text, left));
    // The clipboard is read during the event; clearing the input and pressing the paste key follow it.
    const cleared = clearFirst ? clearInput(agentKind, owner) : Promise.resolve();
    // Over SSH the CLI cannot reach this computer's clipboard: the picture goes over as a file on that computer, whose
    // path joins the message when it is sent (serverPictures).
    if (remote) {
      const file = [...data.items].find(item => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile();
      if (!file) return;
      void file.arrayBuffer().then(bytes => window.agentrix.saveImage(terminal.id, bytes, file.type)).then(saved => {
        if (!ownsSend(owner)) return;
        if (!saved.ok) { onError(saved.error); return; }
        // The picture shows as itself (in the box above the composer and in the message), never as its long path.
        void thumbnail(file).catch(() => dataUrl(file)).then(small => { rememberPicture(saved.value, small); setPictureTick(tick => tick + 1); }).catch(() => {});
        setServerPictures(list => [...list, saved.value].slice(-4));
      }).catch(error => onError(String(error)));
      return;
    }
    const pasteKey = terminal.agent === 'claude' ? '\x1bv' : '\x16';
    if (clearFirst) void cleared.then(() => setTimeout(() => { if (ownsSend(owner)) window.agentrix.writeTerminal(terminal.id, pasteKey); }, 60));
    else window.agentrix.writeTerminal(terminal.id, pasteKey);
    // The agent takes the picture from the clipboard; a copy is kept here to show in the message, small (a 4K
    // screenshot decoded at full size costs tens of megabytes per copy).
    const file = [...data.items].find(item => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile();
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { onError(t('图片太大（超过 25 MB），请压缩后再粘贴。')); return; }
    // A picture this window cannot decode still went to the agent: it is listed as it came.
    void thumbnail(file).catch(() => dataUrl(file)).then(small => {
      if (ownsSend(owner)) setImages(list => [...list, small].slice(-4));
    }).catch(() => onError(t('无法读取这张图片。')));
  };
  // The attached pictures wait in the CLI's own input as "[Image #1]" placeholders, which Ctrl+U clears with them.
  // An SSH project's pictures show above the composer by the copies made when they were pasted.
  const [, setPictureTick] = useState(0);
  const shownImages = [...images, ...withPictures(serverPictures.join(' ')).images];
  const attachedCount = images.length + serverPictures.length;
  const removeImages = () => {
    setServerPictures([]);
    if (!images.length) { input.current?.focus(); return; }
    window.agentrix.writeTerminal(terminal.id, '');
    setImages([]); input.current?.focus();
  };
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    markTyping(event.currentTarget);
    if (event.key === 'Escape' && dictationSend.cancel()) { event.preventDefault(); event.stopPropagation(); return; }
    if (event.nativeEvent.isComposing) { dictationSend.cancel(); return; }
    if (event.key === 'Enter') dictationSend.cancel();
    if (event.key === 'Tab' && event.shiftKey) { event.preventDefault(); window.agentrix.writeTerminal(terminal.id, '\x1b[Z'); return; }
    // A picker open beside an empty box: up and down move into it.
    if (screen.choice && !draft.trim() && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault(); restoreComposer.current = true; (choiceHost.current?.firstElementChild as HTMLElement | null)?.focus(); return;
    }
    if (mentions.keys(event)) return;
    if (palette) {
      if (event.key === 'Escape') { event.preventDefault(); setDismissed(true); return; }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); if (matches.length) setSelection(index => (index + (event.key === 'ArrowUp' ? -1 : 1) + matches.length) % matches.length); return; }
      if (selected && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))) {
        event.preventDefault(); if (event.key === 'Enter' && draft === selected.name) void send(); else complete(selected); return;
      }
    } else {
      if (event.key === 'Escape') { if (working) { event.preventDefault(); interrupt(); } return; }
      const node = event.currentTarget, sent = history.get(terminal.id) || [];
      if (!event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && node.selectionStart === node.selectionEnd && ((event.key === 'ArrowUp' && node.selectionStart === 0) || (event.key === 'ArrowDown' && node.selectionEnd === draft.length))) {
        if (event.key === 'ArrowUp' && sent.length) {
          event.preventDefault(); dictationSend.cancel(); if (historyAt.current === null) { unsent.current = draft; historyAt.current = sent.length; }
          historyAt.current = Math.max(0, historyAt.current - 1); caret.current = 0; setDraft(sent[historyAt.current]);
        } else if (event.key === 'ArrowDown' && historyAt.current !== null) {
          event.preventDefault(); dictationSend.cancel(); historyAt.current++;
          const next = historyAt.current >= sent.length ? unsent.current : sent[historyAt.current];
          if (historyAt.current >= sent.length) historyAt.current = null;
          caret.current = next.length; setDraft(next);
        } else return;
        node.setSelectionRange(caret.current!, caret.current!);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
  };
  // What the agent is doing, written at the end of the conversation the way its CLI writes it, never in a corner.
  const status = screen.choice?.kind === 'question' ? <div className="reading-status is-waiting" role="status">{t('等待你回答问题')}</div>
    // Without a choice to answer here (one the reading view cannot lay out), the terminal is a click away.
    : terminal.needsInput !== null ? <div className="reading-status is-waiting" role="status"><span>{t('等待你确认：{message}', { message: terminal.needsInput })}</span>
      {!screen.choice && <button type="button" className="text-button" onClick={onShowTerminal}>{t('切换到终端')}</button>}</div>
    : working || pending.some(prompt => prompt.sending) ? <WorkingLine key={terminal.sessionId} agent={terminal.agent === 'claude' ? 'claude' : 'codex'} label={terminal.action ? t('正在{step}', { step: actionText(terminal.action) }) : t('{agent} 正在思考', { agent })} />
    : null;
  const kind = terminal.agent === 'claude' ? 'claude' : 'codex';
  const statusRunning = working || pending.some(prompt => prompt.sending);
  // The latest round once it has ended gets its status above the result and its actions under it; nothing while the agent
  // works or waits, and nothing for earlier rounds.
  const settled = !status && !statusRunning && terminal.codexActive && !cards.prompts.length && !hasChoice, interrupted = terminal.codexActivity === 'interrupted';
  const result = useMemo(() => latestResult(entries, { idle: settled, interrupted }), [entries, settled, interrupted]);
  const continueWith = (prefill?: string) => {
    if (prefill && !draft.trim()) { caret.current = prefill.length; edit(prefill); }
    input.current?.focus();
  };
  const resultStatus = result && <ResultStatus result={result} taskTitle={terminal.taskTitle} onShowTerminal={onShowTerminal} onError={onError} />;
  const resultActions = result && <>
    {result.kind === 'code' && <ResultFiles result={result} projectId={projectId} />}
    <ResultActions result={result} projectId={projectId} remote={remote} canSend={!inputBlocked && !!terminal.sessionId} onContinue={continueWith} onRetry={() => void send(result.request, false)} onError={onError} />
  </>;
  // The newest round is the one after your last message; earlier ones keep their words but speak more quietly.
  const lastTurn = (kind: 'user' | 'agent') => turns.map(turn => turn.kind).lastIndexOf(kind);
  const latestUser = lastTurn('user'), latestAgent = lastTurn('agent') > latestUser ? lastTurn('agent') : -1;
  let body: ReactNode, statusInTurn = false;
  // A run of the CLI that is no conversation (codex update): what it does and what it prints, no message box.
  if (terminal.agentCommand) body = <AgentCommandRun agent={terminal.agent === 'claude' ? 'claude' : 'codex'} command={terminal.agentCommand} rows={visibleScreen?.rows ?? []} onShowTerminal={onShowTerminal} />;
  else if (!entries.length && !cards.prompts.length) body = <ReadingWelcome agent={terminal.agent === 'claude' ? 'claude' : 'codex'} commands={commands} complete={complete} disabled={inputBlocked}
    screen={screen} starting={welcomeIsStarting} />;
  else {
    body = <>
      {tail.earlier > 0 && <button type="button" className="text-button reading-earlier" onClick={tail.showEarlier}>{t('显示更早的对话（{count}）', { count: tail.earlier })}</button>}
      {turns.map((turn, index) => {
        if (turn.kind === 'user') {
          return <TimelineStep key={turn.entry.id} at={turn.entry.at} kind="user" who={t('你')} latest={index === latestUser} mark={<UserAvatar />}>
            <div className={`reading-user${turn.entry.answer ? ' is-answer' : ''}`}>
              {turn.entry.answer && <span className="reading-user-label">{t('你回答了它的问题')}</span>}<UserMessage text={turn.entry.text || ''} images={turn.entry.images} /></div>
          </TimelineStep>;
        }
        const liveStatus = index === turns.length - 1 && pending.every(queued) ? status : null;
        if (liveStatus) statusInTurn = true;
        const tools = turn.blocks.flatMap(block => block.kind === 'tools' ? block.entries : []);
        const state = (liveStatus && statusRunning) || tools.some(entry => !entry.tool?.done) ? 'running' : tools.some(entry => entry.tool?.failed) ? 'failed' : null;
        let shownTime = stepTime(turn.at);
        return <TimelineStep key={turn.id} at={turn.at} kind="agent" agent={kind} who={agent} state={state} latest={index === latestAgent} mark={<AgentMark agent={kind} />}>
          <div className="reading-turn">
            {turn.blocks.map(block => {
              const at = block.kind === 'tools' ? block.entries[0]?.at : block.entry.at, time = stepTime(at), showTime = time !== shownTime;
              shownTime = time;
              if (block.kind === 'tools') {
                const Lead = STEP_ICONS[block.entries[0]?.tool?.kind ?? 'other'];
                const state = block.entries.some(entry => !entry.tool?.done) ? 'running' : block.entries.some(entry => entry.tool?.failed) ? 'failed' : null;
                return <Fragment key={block.id}>
                  <AgentTurnItem at={at} showTime={showTime} kind="tools" state={state} mark={<Lead size={12} weight="bold" />}>
                    <ToolGroup entries={block.entries} live={block === tail.visible.at(-1)} projectId={projectId} onError={onError} />
                  </AgentTurnItem>
                  {index === latestAgent && block.entries.some(entry => entry.id === result?.anchor) && <div className="result-block">{resultStatus}{resultActions}</div>}
                </Fragment>;
              }
              const holdsResult = index === latestAgent && block.entry.id === result?.anchor;
              // The status row says when the round ended: the result's own entry needs no stamp of its own.
              return <AgentTurnItem key={block.entry.id} at={at} showTime={showTime && !holdsResult} kind="message">
                {holdsResult && resultStatus}
                <AssistantReply entry={block.entry} agent={kind} projectId={projectId} result={holdsResult} onError={onError} />
                {holdsResult && resultActions}
              </AgentTurnItem>;
            })}
            {liveStatus}
          </div>
        </TimelineStep>;
      })}
    </>;
  }
  return <div className="reading-view" onClick={event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-copy-code]');
    const toggle = (event.target as Element).closest<HTMLButtonElement>('[data-code-source]');
    if (toggle) { const source = toggle.closest('.reading-code')!.classList.toggle('is-source'); toggle.textContent = t(source ? '预览' : '源码'); return; }
    if (button) { const code = button.closest('.reading-code')?.querySelector(':scope > pre')?.textContent || ''; void window.agentrix.copy(code).then(result => { if (result.ok) { button.textContent = t('已复制'); setTimeout(() => { button.textContent = t('复制'); }, 1400); } else onError(result.error); }); return; }
    const link = (event.target as Element).closest<HTMLAnchorElement>('.reading-markdown a');
    if (link) { event.preventDefault(); const href = link.getAttribute('href') || ''; if (href) onOpenLink(href); }
  }}>
    <div className="reading-scroll-area">
      <div className="reading-scroll" ref={scroller} tabIndex={0}><div className="reading-content" ref={content} style={{ visibility: entries.length && !ready ? 'hidden' : undefined }}>{body}<PendingPromptEntries prompts={cards.prompts} queued={queued} undelivered={undelivered} onResend={resend} onDiscard={prompt => cancelEcho(prompt.id)} />
        {status && !statusInTurn && <TimelineStep at={pending.at(-1)?.at ?? entries.at(-1)?.at} kind="agent" who={agent} state={statusRunning ? 'running' : null} agent={kind} mark={<AgentMark agent={kind} />}>{status}</TimelineStep>}</div></div>
      {terminalPopup === null && signIn && <ReadingSignIn agent={terminal.agent === 'claude' ? 'claude' : 'codex'} screen={signIn} terminalId={terminal.id} projectId={projectId} onError={onError} />}
      {!stuck && <div className="reading-latest">
        {unseen > 0 && <span className="reading-unseen" role="status">{t('{count} 条新消息', { count: unseen })}</span>}
        <button type="button" className="icon-button reading-jump" title={t('跳到最新消息')} aria-label={t('跳到最新消息')} onClick={() => toBottom('smooth')}><ArrowDown size={18} /></button>
      </div>}
    </div>
    {terminalPopup !== null && <ReadingTerminalPopup key={sendCounter.current} terminalId={terminal.id} sessionId={terminal.sessionId} command={terminalPopup.command} onReady={readyPopup} onClose={closePopup} onError={onError} />}
    {attachedCount > 0 && <div className="reading-attachments" role="status"><ImageIcon size={14} />{t('已附加 {count} 张图片，随下一条消息发送', { count: attachedCount })}<UserImages images={shownImages} />
      <button type="button" className="reading-attachments-remove" onClick={removeImages} title={t('移除图片')} aria-label={t('移除图片')}><X size={12} weight="bold" /></button></div>}
    {terminal.nativeApprovals?.map(request => <NativeApprovalCard key={request.token} request={request} onError={onError} />)}
    {screen.choice && !(screen.choice.kind === 'permission' && terminal.nativeApprovals?.length) && !sessionsOpen && <div className="reading-choice-host" ref={choiceHost} onFocusCapture={() => { restoreComposer.current = true; }} onBlurCapture={event => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) restoreComposer.current = false;
    }}>{screen.choice.kind === 'question'
      ? <ReadingQuestion key={choiceKey} choice={screen.choice} terminalId={terminal.id} onError={onError} />
      : <ReadingChoice key={choiceKey} choice={screen.choice} terminalId={terminal.id} agent={terminal.agent === 'claude' ? 'claude' : 'codex'} onShowTerminal={onShowTerminal} onError={onError} />}</div>}
    {sessionsOpen && <div className="reading-choice-host" ref={choiceHost} onFocusCapture={() => { restoreComposer.current = true; }} onBlurCapture={event => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) restoreComposer.current = false;
    }}><ReadingSessions key={`${terminal.id}-${terminal.sessionId}`} terminalId={terminal.id} agent={terminal.agent === 'codex' ? 'codex' : 'claude'} onError={onError} onClose={() => setSessionsOpen(false)} onSent={text => {
      history.set(terminal.id, [...(history.get(terminal.id) || []), text].slice(-50)); setImages([]); toBottom();
    }} /></div>}
    {/* The command list is part of the page, above the message box, not a popup over the conversation. */}
    {palette && <div className="reading-commands is-inline" id={listId} role="listbox" aria-label={t('命令')}>{matches.map((command, index) => <div key={command.name} id={optionId(index)} role="option" aria-selected={selection === index} className="reading-command" onMouseDown={event => event.preventDefault()} onClick={() => complete(command)}>
        <code>{command.name}</code><span>{command.source === 'builtin' ? t(command.description) : command.description}</span>{command.source !== 'builtin' && <small>{command.source === 'project' ? t('项目') : command.source === 'user' ? t('用户') : t('技能')}</small>}
    </div>)}</div>}
    <div className={`reading-composer${sendingSoon ? ' is-sending-soon' : ''}`} style={terminal.agentCommand ? { display: 'none' } : undefined}>
      <MentionPalette mentions={mentions} />
      <textarea ref={input} rows={1} disabled={inputBlocked} onPaste={pasteImage} onSelect={mentions.trackCaret} aria-label={t('给 {agent} 的消息', { agent })} aria-expanded={palette || mentions.open} aria-controls={palette ? listId : mentions.open ? mentions.listId : undefined} aria-activedescendant={palette && selected ? optionId(selection) : mentions.open && mentions.files[mentions.selection] ? mentions.optionId(mentions.selection) : undefined} placeholder={result ? t('继续修改，或描述下一步…') : terminal.codexActive ? t('给 {agent} 发消息，/ 查看命令，@ 提及文件，Enter 发送，Shift+Enter 换行', { agent }) : t('输入命令，Enter 发送')} value={draft} onChange={event => edit(event.target.value)} onKeyDown={keys}
        onCompositionStart={() => dictationSend.cancel()} onFocus={() => window.agentrix.terminalFocus(terminal.id, false)} />
      {working && <button type="button" className="icon-button" disabled={inputBlocked} title={t('中断（Esc）')} aria-label={t('中断（Esc）')} onClick={interrupt}><Stop size={15} weight="fill" /></button>}
      <button type="button" className="icon-button reading-send" title={t('发送')} aria-label={t('发送')} disabled={inputBlocked || (!draft.trim() && !attachedCount) || !terminal.sessionId} onClick={() => void send()}><PaperPlaneRight size={15} weight="fill" /></button>
    </div>
  </div>;
}
