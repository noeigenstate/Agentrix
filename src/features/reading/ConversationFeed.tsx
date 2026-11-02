import { createContext, Fragment, useContext, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { CaretDown, CaretUp } from '@phosphor-icons/react';
import type { ConversationEntry } from '../../shared/types';
import { t } from '../../shared/i18n';
import { UserAvatar } from '../../shared/UserAvatar';
import { stepVerb } from '../agents/action-text';
import { showPopup } from '../files/file-popup';
import { Markdown } from './Markdown';
import { PathText } from './PathText';
import { useReadingPaths } from './useReadingPaths';
import { UserMessage } from './PendingPromptEntries';
import { QuoteAction } from './ReadingQuote';
import { AgentMark, AgentTurnItem, stepTime, TimelineStep } from './Timeline';
import { groupSummary, ImageProgress, StepState } from './ResultCard';
import { latestResult, writtenBy } from './result-round';
import { FileCards, previewable } from './FileCards';
import { replyFiles } from './reply-files';
import { blocks, conversationTurns } from './useVisibleTail';
import './reading.css';
import './reading-flow.css';

// The interactive reader supplies presentation slots; standalone feeds need no reader, terminal or composer.
// quote: the reader's 引用 action (disabled holds the reason it cannot be used now); a feed without it offers none.
export const ConversationDecorations = createContext<{
  start: number; status: ReactNode; running: boolean; anchor?: string; beforeResult: ReactNode; afterResult: ReactNode;
  quote?: { disabled: string | null; pick: (who: string, text: string) => void };
  frame?: { ref: RefObject<HTMLDivElement | null>; style: CSSProperties; before: ReactNode };
} | null>(null);

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

// A message with words of its own can be quoted; one that was left out for size, or holds only a picture, cannot.
function QuoteOf({ entry, who }: { entry: ConversationEntry; who: string }) {
  const quote = useContext(ConversationDecorations)?.quote;
  return quote && entry.text && !entry.omitted ? <QuoteAction who={who} text={entry.text} disabled={quote.disabled} onQuote={quote.pick} /> : null;
}

// A reply card inside its agent's turn, with the local pictures, pages and videos it names shown under it
// (the agents are told they can show one this way: reading-note.cjs).
function AssistantReply({ entry, agent, projectId, result = false, onError }: { entry: ConversationEntry; agent: 'claude' | 'codex'; projectId: string; result?: boolean; onError: (message: string) => void }) {
  const named = useMemo(() => entry.text ? replyFiles(entry.text) : [], [entry.text]);
  const words = entry.text ? <Markdown text={entry.omitted ? t('此条对话过大，未在此显示。') : entry.text} /> : null;
  // The latest result shows its picture first with the words under it; anywhere else the words come first.
  const picture = entry.generated && entry.images?.[0] ? <GeneratedImage src={entry.images[0]} {...entry.generated} result={result}>{result && words}</GeneratedImage> : null;
  return <div data-reading-entry={entry.id} className={`reading-assistant is-${agent}`}>{result && picture}{!(result && picture) && words}
      {named.length > 0 && <FileCards projectId={projectId} files={named} renderMarkdown={text => <Markdown text={text} />} onError={onError} quiet />}
      {!result && picture}<QuoteOf entry={entry} who={agent === 'claude' ? 'Claude Code' : 'Codex'} /></div>;
}

function ToolGroup({ entries, live, projectId, onError }: { entries: ConversationEntry[]; live: boolean; projectId: string; onError: (message: string) => void }) {
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
      <StepState running={running} failed={failed > 0} />
      <span>{groupSummary(entries)}</span>
      {failed > 0 && <em>{t('{count} 个失败', { count: failed })}</em>}
      {edited.slice(0, 3).map(file => <code key={file} className="reading-tools-file"><PathText text={file} literal /></code>)}
      {edited.length > 3 && <small className="reading-tools-more">+{edited.length - 3}</small>}
      {shown ? <CaretUp size={13} weight="bold" className="reading-tools-caret" /> : <CaretDown size={13} weight="bold" className="reading-tools-caret" />}
    </button>
    {shown && <ul className="reading-tools-tree">{entries.map(entry => {
      const tool = entry.tool!;
      return <li key={entry.id} className={`${tool.done ? '' : 'is-running'} ${tool.failed ? 'is-failed' : ''} reading-tool-${tool.kind}`}>
        <StepState running={!tool.done} failed={tool.failed} filled />
        <b>{stepVerb(tool)}</b><code title={tool.target}><PathText text={tool.target} literal={tool.kind === 'read' || tool.kind === 'edit'} /></code>{tool.detail && <small><PathText text={tool.detail} /></small>}
      </li>;
    })}</ul>}
    {drawing && <ImageProgress step={drawing.id} />}
    {files.length > 0 && <FileCards projectId={projectId} files={files} renderMarkdown={text => <Markdown text={text} />} onError={onError} />}
  </div>;
}

export function ConversationFeed({ entries, agent: kind, projectId, live, onError, onOpenLink, children }: {
  entries: ConversationEntry[]; agent: 'claude' | 'codex'; projectId: string; live: boolean;
  onError: (message: string) => void; onOpenLink?: (target: string) => void; children?: ReactNode;
}) {
  const decorations = useContext(ConversationDecorations);
  const pathLinks = useReadingPaths(projectId, onError, decorations?.frame?.ref);
  const grouped = useMemo(() => blocks(entries), [entries]);
  const turns = useMemo(() => conversationTurns(grouped, decorations?.start ?? 0), [grouped, decorations?.start]);
  const result = useMemo(() => latestResult(entries, { idle: !live, interrupted: false }), [entries, live]);
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
    if (link) { event.preventDefault(); const href = link.getAttribute('href') || ''; if (href) onOpenLink?.(href); }
  }}>
      {decorations?.frame?.before}
      {turns.map((turn, index) => {
        if (turn.kind === 'user') {
          return <TimelineStep key={turn.entry.id} at={turn.entry.at} kind="user" who={t('你')} latest={index === latestUser} mark={<UserAvatar />}>
            <div data-reading-entry={turn.entry.id} className={`reading-user${turn.entry.answer ? ' is-answer' : ''}`}>
              {turn.entry.answer && <span className="reading-user-label">{t('你回答了它的问题')}</span>}<UserMessage text={turn.entry.text || ''} images={turn.entry.images} /><QuoteOf entry={turn.entry} who={t('你')} /></div>
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
                    <ToolGroup entries={block.entries} live={block === grouped.at(-1) && (live || decorations !== null)} projectId={projectId} onError={onError} />
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
