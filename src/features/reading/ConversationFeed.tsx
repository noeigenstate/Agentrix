import { createContext, Fragment, useContext, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { CaretDown, CaretUp, Robot } from '@phosphor-icons/react';
import type { ConversationEntry, GeneratedPicture } from '../../shared/types';
import { t } from '../../shared/i18n';
import { UserAvatar } from '../../shared/UserAvatar';
import { modelName } from '../../shared/model-name.ts';
import { stepVerb } from '../agents/action-text';
import { showPopup } from '../files/file-popup.ts';
import { Markdown } from './Markdown';
import { PathText } from './PathText';
import { useReadingPaths } from './useReadingPaths';
import { generatedCopies, openReplyLink } from './reply-links.ts';
import { pathTooltip } from './reading-paths';
import { UserMessage, type MessageEntry } from './PendingPromptEntries';
import { MessageCard } from './MessageMenu';
import { AgentMark, AgentTurnItem, stepTime, TimelineStep } from './Timeline';
import { groupSummary, ImageProgress, StepState } from './ResultCard';
import { latestResult, unconfirmed, writtenBy } from './result-round';
import { FileCards, previewable } from './FileCards';
import { replyFiles } from './reply-files';
import { blocks, conversationTurns } from './useVisibleTail';
import './reading.css';
import './reading-flow.css';

// The interactive reader supplies presentation slots; standalone feeds need no reader, terminal or composer.
// quote: the reader's 引用 action, offered in a message's right-click menu (disabled holds the reason it cannot be used now); a feed without it offers none.
export const ConversationDecorations = createContext<{
  start: number; status: ReactNode; running: boolean; anchor?: string; beforeResult: ReactNode; afterResult: ReactNode;
  quote?: { disabled: string | null; pick: (who: string, text: string) => void };
  frame?: { ref: RefObject<HTMLDivElement | null>; style: CSSProperties; before: ReactNode };
} | null>(null);

// Where a generated picture's copy in the project is, as a path a click shows in the file tree (a modifier click previews
// it), or the line on that copy: being made, or why it could not be.
function GeneratedCopy({ picture, projectId, onError }: { picture: GeneratedPicture; projectId: string; onError: (message: string) => void }) {
  const { copied, copyNote } = picture;
  if (copied) return <p className="reading-generated-copy">{t('已复制到项目：')}<button type="button" data-reading-path={copied} title={pathTooltip(copied)}
    onClick={() => void openReplyLink(projectId, copied, new Map(), undefined, onError)}>{copied}</button></p>;
  return copyNote ? <p className="reading-generated-copy" role="status">{copyNote}</p> : null;
}

// A picture the agent generated, shown where it answered; a click shows it full size in a popup (read where the project is).
// Its prompt is a two-line summary under it; when the summary is cut off, a text toggle shows the whole prompt (not
// remembered); its copy in the project is named last. The latest result's picture is larger and carries the agent's
// one-sentence reply (children) between itself and its prompt.
function GeneratedImage({ src, picture, projectId, result = false, onError, children }: { src: string; picture: GeneratedPicture; projectId: string; result?: boolean; onError: (message: string) => void; children?: ReactNode }) {
  const { path, prompt } = picture;
  const open = () => showPopup({ kind: 'image', projectId, path });
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
    <GeneratedCopy picture={picture} projectId={projectId} onError={onError} />
  </figure>;
}

// A picture from the older part of a resumed SSH conversation: read back over the connection only when asked
// (features/generated-images), then shown as any generated picture is.
function DeferredPicture({ picture, projectId, result, onError }: { picture: GeneratedPicture; projectId: string; result: boolean; onError: (message: string) => void }) {
  const [src, setSrc] = useState<string | null>(null), [loading, setLoading] = useState(false);
  if (src) return <GeneratedImage src={src} picture={picture} projectId={projectId} result={result} onError={onError} />;
  const load = () => {
    setLoading(true);
    void window.agentrix.agentImage(picture.path, projectId).then(found => { if (found.ok) setSrc(found.value.url); else onError(found.error); })
      .catch(error => onError(String(error))).finally(() => setLoading(false));
  };
  return <>
    <p className="reading-generated-copy"><button type="button" disabled={loading} onClick={load}>{t(loading ? '正在取回图片…' : '点击加载图片')}</button></p>
    <GeneratedCopy picture={picture} projectId={projectId} onError={onError} />
  </>;
}

// A message card with the right-click menu (引用 / 复制). A message with words of its own can be quoted; one that was left out
// for size, or holds only a picture, has no menu.
function Message({ entry, who, className, onError, children }: { entry: ConversationEntry; who: string; className: string; onError: (message: string) => void; children: ReactNode }) {
  const quote = useContext(ConversationDecorations)?.quote;
  return <MessageCard id={entry.id} className={className} text={entry.omitted ? undefined : entry.text} who={who} quote={quote} onError={onError}>{children}</MessageCard>;
}

// A reply card inside its agent's turn, with the local pictures, pages and videos it names shown under it
// (the agents are told they can show one this way: reading-note.cjs).
function AssistantReply({ entry, agent, projectId, result = false, onError }: { entry: ConversationEntry; agent: 'claude' | 'codex'; projectId: string; result?: boolean; onError: (message: string) => void }) {
  const named = useMemo(() => entry.text ? replyFiles(entry.text) : [], [entry.text]);
  const words = entry.text ? <Markdown text={entry.omitted ? t('此条对话过大，未在此显示。') : entry.text} /> : null;
  // The latest result shows its picture first with the words under it; anywhere else the words come first. A picture
  // waiting to be read back shows its button in place of the words that say so.
  const deferred = !entry.images?.[0] && entry.generated?.deferred;
  const picture = entry.generated && entry.images?.[0] ? <GeneratedImage src={entry.images[0]} picture={entry.generated} projectId={projectId} result={result} onError={onError}>{result && words}</GeneratedImage>
    : deferred ? <DeferredPicture picture={entry.generated!} projectId={projectId} result={result} onError={onError} /> : null;
  return <Message entry={entry} who={agent === 'claude' ? 'Claude Code' : 'Codex'} className={`reading-assistant is-${agent}`} onError={onError}>{result && picture}{!(result && picture) && !deferred && words}
      {entry.generated && !picture && <GeneratedCopy picture={entry.generated} projectId={projectId} onError={onError} />}
      {named.length > 0 && <FileCards projectId={projectId} files={named} excludeImages={picture && entry.generated ? [entry.generated.path] : []} renderMarkdown={text => <Markdown text={text} />} onError={onError} quiet />}
      {!result && picture}</Message>;
}

// The native view hides what a tool printed: the step line stays, and a failed step keeps one short reason. A "!" line's card (shell:), a change's diff and the plan (native:) keep theirs.
const quietOutput = (entry: ConversationEntry) => !entry.id.startsWith('shell:') && !entry.id.startsWith('native:') && entry.tool?.kind !== 'edit';
const failureReason = (output: string) => { const line = output.split(/\r?\n/).find(row => row.trim())?.trim() || ''; return line.length > 140 ? `${line.slice(0, 139)}…` : line; };

function ToolGroup({ entries, live, projectId, hideToolOutput = false, onError }: { entries: ConversationEntry[]; live: boolean; projectId: string; hideToolOutput?: boolean; onError: (message: string) => void }) {
  const running = entries.some(entry => !entry.tool?.done);
  const [open, setOpen] = useState(false);
  const failed = entries.filter(entry => entry.tool?.failed).length;
  const shown = open || (live && running);
  // A picture being generated: Codex reports no progress, so the wait is shown as such, with the time it has taken.
  const drawing = entries.find(entry => !entry.tool?.done && /image_?gen/i.test(`${entry.tool?.tool} ${entry.tool?.target}`));
  // The documents, pages and videos these steps finished writing, each once.
  const files = useMemo(() => writtenBy(entries).filter(previewable), [entries]);
  // The files its edits changed, by name, a few of them on the pill itself.
  const edited = useMemo(() => [...new Set(entries.flatMap(entry => entry.tool?.kind === 'edit' ? entry.tool.written?.length ? entry.tool.written : entry.tool.target.split('、') : []))]
    .map(file => file.split(/[\\/]/).pop() || file).filter(Boolean), [entries]);
  return <div data-reading-entry={entries[0]?.id} className={`reading-tools${running ? ' is-running' : ''}${shown ? ' is-open' : ''}${failed ? ' has-failed' : ''}`}>
    <button type="button" className="reading-tools-head" aria-expanded={shown} onClick={() => setOpen(!open)}>
      <StepState running={running} failed={failed > 0} unconfirmed={entries.some(entry => unconfirmed(entry.tool))} />
      <span>{groupSummary(entries)}</span>
      {failed > 0 && <em>{t('{count} 个失败', { count: failed })}</em>}
      {edited.slice(0, 3).map(file => <code key={file} className="reading-tools-file"><PathText text={file} literal /></code>)}
      {edited.length > 3 && <small className="reading-tools-more">+{edited.length - 3}</small>}
      {shown ? <CaretUp size={13} weight="bold" className="reading-tools-caret" /> : <CaretDown size={13} weight="bold" className="reading-tools-caret" />}
    </button>
    {shown && <ul className="reading-tools-tree">{entries.map(entry => {
      const tool = entry.tool!, quiet = hideToolOutput && quietOutput(entry), output = quiet ? '' : tool.output || '', reason = quiet && tool.failed ? failureReason(tool.output || '') : '';
      return <li key={entry.id} className={`${tool.done ? '' : 'is-running'} ${tool.failed ? 'is-failed' : ''} reading-tool-${tool.kind}`}>
        <StepState running={!tool.done} failed={tool.failed} unconfirmed={unconfirmed(tool)} filled />
        <b>{stepVerb(tool)}</b><code title={tool.target}><PathText text={tool.target} literal={tool.kind === 'read' || tool.kind === 'edit'} /></code>{tool.detail && <small title={tool.detail}><PathText text={tool.detail} /></small>}
        {reason && <small className="reading-tool-reason" title={reason}>{reason}</small>}
        {output && <pre className="reading-tool-output">{output}</pre>}
      </li>;
    })}</ul>}
    {drawing && <ImageProgress step={drawing.id} />}
    {files.length > 0 && <FileCards projectId={projectId} files={files} renderMarkdown={text => <Markdown text={text} />} onError={onError} />}
  </div>;
}

export function ConversationFeed({ entries, agent: kind, projectId, live, hideToolOutput = false, onError, onOpenLink, children }: {
  entries: ConversationEntry[]; agent: 'claude' | 'codex'; projectId: string; live: boolean; hideToolOutput?: boolean;
  onError: (message: string) => void; onOpenLink?: (target: string) => void; children?: ReactNode;
}) {
  const decorations = useContext(ConversationDecorations);
  const pathLinks = useReadingPaths(projectId, onError, decorations?.frame?.ref);
  const grouped = useMemo(() => blocks(entries), [entries]);
  const turns = useMemo(() => conversationTurns(grouped, decorations?.start ?? 0), [grouped, decorations?.start]);
  const result = useMemo(() => latestResult(entries, { idle: !live, interrupted: false }), [entries, live]);
  const copies = useMemo(() => generatedCopies(entries), [entries]);
  const agent = kind === 'claude' ? 'Claude Code' : 'Codex';
  // The newest round is the one after your last message; earlier ones keep their words but speak more quietly.
  let latestUser = -1, latestAgent = -1;
  for (let index = turns.length - 1; index >= 0; index--) {
    if (turns[index].kind === 'user') { latestUser = index; break; }
    if (latestAgent < 0) latestAgent = index;
  }
  // Every rail node, including pending messages, stays in one content container for spacing and scroll anchoring.
  return <div className="reading-content conversation-feed" data-agent={kind} style={decorations?.frame?.style} {...pathLinks} onClick={event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-copy-code]');
    const toggle = (event.target as Element).closest<HTMLButtonElement>('[data-code-source]');
    if (toggle) { const source = toggle.closest('.reading-code')!.classList.toggle('is-source'); toggle.textContent = t(source ? '预览' : '源码'); return; }
    if (button) { const code = button.closest('.reading-code')?.querySelector(':scope > pre')?.textContent || ''; void window.agentrix.copy(code).then(result => { if (result.ok) { button.textContent = t('已复制'); setTimeout(() => { button.textContent = t('复制'); }, 1400); } else onError(result.error); }); return; }
    const link = (event.target as Element).closest<HTMLAnchorElement>('.reading-markdown a');
    if (link) { event.preventDefault(); const href = link.getAttribute('data-reading-path') || link.getAttribute('href') || ''; if (href) void openReplyLink(projectId, href, copies, onOpenLink, onError); }
  }}>
      {decorations?.frame?.before}
      {turns.map((turn, index) => {
        if (turn.kind === 'user') {
          const sender = turn.entry.sender, planner = sender?.kind === 'planner';
          const identified = planner && sender.agent && sender.model;
          const who = identified ? modelName(sender.model!) : planner ? t('主模型') : t('你');
          const mark = planner ? identified ? <AgentMark agent={sender.agent!} /> : <Robot size={18} /> : <UserAvatar />;
          return <TimelineStep key={turn.entry.id} at={turn.entry.at} kind="user" who={who} latest={index === latestUser} mark={mark}>
            <Message entry={turn.entry} who={who} className={`reading-user${turn.entry.answer ? ' is-answer' : ''}`} onError={onError}>
              {turn.entry.answer && <span className="reading-user-label">{planner ? t('{name} 回答了它的问题', { name: who }) : t('你回答了它的问题')}</span>}<UserMessage text={turn.entry.text || ''} images={turn.entry.images} imagesOmitted={(turn.entry as MessageEntry).imagesOmitted} rendered={planner} /></Message>
          </TimelineStep>;
        }
        const liveStatus = index === turns.length - 1 ? decorations?.status : null;
        const tools = turn.blocks.flatMap(block => block.kind === 'tools' ? block.entries : []);
        const state = liveStatus && decorations?.running || tools.some(entry => !entry.tool?.done) ? 'running' : tools.some(entry => entry.tool?.failed) ? 'failed' : null;
        let shownTime = stepTime(turn.at);
        return <TimelineStep key={turn.id} at={turn.at} kind="agent" agent={kind} who={agent} state={state} latest={index === latestAgent} mark={<AgentMark agent={kind} />}>
          <div className="reading-turn">
            {turn.blocks.map(block => {
              const at = block.kind === 'tools' ? block.entries[0]?.at : block.entry.at, time = stepTime(at), showTime = time !== shownTime;
              shownTime = time;
              if (block.kind === 'tools') {
                const state = block.entries.some(entry => !entry.tool?.done) ? 'running' : block.entries.some(entry => entry.tool?.failed) ? 'failed' : null;
                return <Fragment key={block.id}>
                  <AgentTurnItem at={at} showTime={showTime} kind="tools" state={state}>
                    <ToolGroup entries={block.entries} live={block === grouped.at(-1) && (live || decorations !== null)} projectId={projectId} hideToolOutput={hideToolOutput} onError={onError} />
                  </AgentTurnItem>
                  {index === latestAgent && block.entries.some(entry => entry.id === decorations?.anchor) && <div className="result-block">{decorations?.beforeResult}{decorations?.afterResult}</div>}
                </Fragment>;
              }
              const holdsResult = index === latestAgent && block.entry.id === (decorations ? decorations.anchor : result?.anchor);
              // The status row says when the round ended: the result's own entry needs no stamp of its own.
              return <AgentTurnItem key={block.entry.id} at={at} showTime={showTime && !holdsResult} kind="message">
                {holdsResult && decorations?.beforeResult}
                <AssistantReply entry={block.entry} agent={kind} projectId={projectId} result={holdsResult} onError={onError} />
                {holdsResult && decorations?.afterResult}
              </AgentTurnItem>;
            })}
            {liveStatus}
          </div>
        </TimelineStep>;
      })}
      {children}
  </div>;
}
