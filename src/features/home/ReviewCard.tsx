import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle, CircleNotch, XCircle } from '@phosphor-icons/react';
import type { AgentAction, ConversationEntry, GitStatus } from '../../shared/types';
import type { Decision } from './decisions';
import { decisionTitle, waited } from './DecisionCard';
import { Markdown } from '../reading/ReadingView';
import { FileCards, previewable } from '../reading/FileCards';
import { replyFiles } from '../reading/reply-files';
import { CHECKS, changeLabel, lastRound } from '../reading/result-round';
import { atPrompt, sendToAgent } from './send-to-agent';
import { parseDelivery } from './delivery';
import { showPopup } from '../files/file-popup';
import { VoiceButton } from '../voice/VoiceButton';
import { useDictatedBox } from '../voice/voice-input';
import { passed, recordAccepted, reviewHistory, sentBack } from './review-history';
import { t } from '../../shared/i18n';

export { acceptedToday } from './review-history';

// Anything the agent says about its checks beyond the steps it ran (CHECKS) is its own word, shown as such.
const SELF_REPORT = /测试(?:全部)?通过|tests? (?:all )?pass|all tests passed|构建成功|build succeeded/i;

// A round's work handed in: what was asked, what the agent says it did, what changed, what it made and how it was
// checked, then your call. Accepting records that you looked at it; it never commits, merges or pushes anything.
export function ReviewCard({ decision, now, kind, onOpen, onDone, onError }: {
  decision: Decision; now: number; kind: ReactNode; onOpen: (decision: Decision) => void; onDone: (message: string) => void; onError: (message: string) => void;
}) {
  const [entries, setEntries] = useState<ConversationEntry[] | null>(null), [actions, setActions] = useState<AgentAction[]>([]), [git, setGit] = useState<GitStatus | null>(null);
  const [feedback, setFeedback] = useState(''), [revising, setRevising] = useState(false), [busy, setBusy] = useState(false), [fullReply, setFullReply] = useState(false);
  // The comments can be spoken: the words go in at the caret, and are sent with the button as typed ones are.
  const feedbackBox = useRef<HTMLTextAreaElement>(null), voiceTarget = `review:${decision.id}`;
  useDictatedBox(voiceTarget, feedbackBox, setFeedback);
  useEffect(() => {
    let live = true;
    void window.agentrix.terminalConversation(decision.terminalId).then(result => { if (live) setEntries(result.ok ? result.value : []); });
    void window.agentrix.terminalActions(decision.terminalId).then(result => { if (live && result.ok) setActions(result.value); });
    void window.agentrix.gitStatus(decision.projectId).then(result => { if (live && result.ok && result.value.repository) setGit(result.value); });
    return () => { live = false; };
  }, [decision.terminalId, decision.projectId, decision.id]);
  const round = useMemo(() => lastRound(entries ?? []), [entries]);
  // Like homework: which submission this is, and the notes you sent back before it.
  const history = useMemo(() => reviewHistory(decision.projectId), [decision.projectId, decision.id]);
  const lastNote = history.notes.at(-1);
  const made = useMemo(() => [...new Set([...round.written.filter(previewable), ...replyFiles(round.reply)])], [round]);
  const checks = actions.filter(action => action.kind === 'command' && action.phrase && CHECKS.has(action.phrase));
  const accept = async () => {
    setBusy(true);
    const result = await window.agentrix.acknowledge(decision.projectId);
    setBusy(false);
    if (!result.ok) { onError(result.error); return; }
    recordAccepted(); passed(decision.projectId);
    onDone(history.submission > 1 ? t('「{project}」第 {count} 次提交已通过；改动留在工作区，没有自动提交。', { project: decision.projectName, count: history.submission })
      : t('「{project}」这一轮已通过；改动留在工作区，没有自动提交。', { project: decision.projectName }));
  };
  // Your notes go to the same agent as its next message, the way its own input takes one: only while it waits there.
  const revise = async () => {
    const text = feedback.trim();
    if (!text || busy) return;
    if (!decision.sessionId || !atPrompt(decision.terminalId, decision.agent)) { onError(t('它现在不在等你输入，打开来源再发送修改意见。')); return; }
    setBusy(true);
    try {
      const failed = await sendToAgent(decision.terminalId, decision.sessionId, decision.agent, text);
      if (failed) { onError(failed); return; }
      await window.agentrix.acknowledge(decision.projectId);
      sentBack(decision.projectId, decision.title, text);
      setFeedback(''); setRevising(false);
      onDone(t('已打回「{project}」，批语已发给它，改完会再交上来。', { project: decision.projectName }));
    } catch (error) { onError(String(error)); } finally { setBusy(false); }
  };
  const delivery = useMemo(() => parseDelivery(round.reply), [round.reply]);
  const foldReply = !!delivery || round.reply.length > 900;
  const title = decisionTitle(decision);
  return <article className="decision-card is-review" aria-label={title}>
    <header className="decision-card-head">{kind}<span className="decision-source">{decision.projectName}{decision.multipleTerminals ? ` · ${decision.terminalTitle}` : ''} · {decision.agent === 'claude' ? 'Claude Code' : 'Codex'} · {t('交付于 {time}', { time: waited(decision.since, now).replace(/^等了 /, '') })}</span></header>
    <h2 className="decision-title">{title}{history.submission > 1 && <span className="review-submission">{t('第 {count} 次提交', { count: history.submission })}</span>}</h2>
    <div className="decision-body">
      {lastNote && <section className="review-block review-last-note"><h4>{t('你上次的批语')}</h4><p>{lastNote.text}</p>
        {history.notes.length > 1 && <small>{t('之前还打回过 {count} 次', { count: history.notes.length - 1 })}</small>}</section>}
      {entries === null ? <p className="decision-why"><CircleNotch size={16} className="loading-spinner" /> {t('正在整理这一轮的交付…')}</p> : <>
        {round.goal && round.goal.trim() !== lastNote?.text.trim() && <section className="review-block"><h4>{t('你让它做的')}</h4><p className="review-goal">{round.goal}</p></section>}
        {/* What the grading is about, first: for a fix, the problem, its cause and the result; for an optimization, what
            was done, what it solves and the comparison. Its whole account folds under it. */}
        {delivery ? <section className={`review-block review-delivery is-${delivery.kind}`} aria-label={delivery.kind === 'fix' ? t('修复') : t('优化')}>
          {delivery.parts.map((part, index) => <div key={part.label} className="review-delivery-part"><span className="review-delivery-step">{index + 1}</span>
            <div><h4>{t(part.label)}</h4><Markdown text={part.text} /></div></div>)}
        </section> : round.reply && <p className="review-unverified">{t('它没有按“问题、原因、结果”写交付摘要，下面是它的原话。')}</p>}
        <section className="review-block"><h4>{delivery ? t('完整交付说明') : t('它的交付说明')}</h4>
          {round.reply ? <div className={`review-reply ${foldReply && !fullReply ? 'is-folded' : ''}`}><Markdown text={round.reply} /></div> : <p className="decision-why">{t('这一轮没有留下说明。')}</p>}
          {foldReply && round.reply && <button type="button" className="text-button" onClick={() => setFullReply(!fullReply)}>{fullReply ? t('收起') : t('展开全文')}</button>}
        </section>
        {made.length > 0 && <section className="review-block"><h4>{t('产出物')}</h4><FileCards projectId={decision.projectId} files={made} renderMarkdown={text => <Markdown text={text} />} onError={onError} quiet /></section>}
        <section className="review-block"><h4>{t('验证')}</h4>
          {checks.length ? <ul className="review-checks">{checks.map(check => <li key={check.id} className={check.failed ? 'is-failed' : check.done ? 'is-passed' : 'is-running'}>
            {check.failed ? <XCircle size={16} weight="bold" /> : check.done ? <CheckCircle size={16} weight="bold" /> : <CircleNotch size={16} className="loading-spinner" />}
            <b>{t(check.phrase!)}</b><code>{check.target}</code><span>{check.failed ? t('执行了，失败') : check.done ? t('执行了，通过') : t('还在运行')}</span>
          </li>)}</ul>
            : <p className="review-unverified">{SELF_REPORT.test(round.reply) ? t('这一轮没有运行验证命令；说明里的“通过”只是它自己说的。') : t('这一轮没有运行测试或检查。')}</p>}
        </section>
        {git && <section className="review-block"><h4>{git.total ? t('改动 · 工作区 {count} 个文件', { count: git.total }) : t('改动')}</h4>
          {git.total ? <ul className="review-files">{git.files.slice(0, 8).map(change => <li key={change.path}>
            <span className="review-file-status">{changeLabel(change)}</span>
            <button type="button" className="text-button" title={change.path} onClick={() => showPopup({ kind: 'file', projectId: decision.projectId, path: change.path })}>{change.path}</button>
          </li>)}</ul> : <p className="decision-why">{t('工作区没有未提交的改动。')}</p>}
          {git.total > 8 && <p className="review-more">{t('还有 {count} 个文件，在工作台的 Git 里查看。', { count: git.total - 8 })}</p>}
          {git.total > 0 && <p className="review-note">{t('这是工作区里所有未提交的改动，不一定都来自这一轮。')}</p>}
        </section>}
      </>}
    </div>
    {revising && <div className="review-feedback" data-voice-target={voiceTarget} aria-label={t('批语')}>
      <textarea ref={feedbackBox} value={feedback} rows={3} autoFocus placeholder={t('写批语：哪里不对、要改成什么样，比如“错误提示再明确一点”；也可以点麦克风说')} onChange={event => setFeedback(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void revise(); } }} />
      <VoiceButton terminalId={voiceTarget} sessionId={null} name={t('批语')} size={16} onError={onError} />
    </div>}
    <footer className="decision-actions">
      {revising
        ? <><button type="button" className="button primary" disabled={!feedback.trim() || busy} onClick={() => void revise()}>{busy ? <CircleNotch size={16} className="loading-spinner" /> : null}{t('打回并发送批语')}</button>
          <button type="button" className="button secondary" onClick={() => setRevising(false)}>{t('取消')}</button></>
        : <><button type="button" className="button primary" disabled={busy || entries === null} onClick={() => void accept()}>{t('通过')}</button>
          <button type="button" className="button secondary" disabled={busy} onClick={() => setRevising(true)}>{t('打回修改')}</button></>}
      <button type="button" className="button secondary" onClick={() => onOpen(decision)}>{t('在工作台查看')}</button>
    </footer>
  </article>;
}
