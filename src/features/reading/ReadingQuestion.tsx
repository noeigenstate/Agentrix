import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CaretLeft, CaretRight, Check, CircleNotch, PaperPlaneRight } from '@phosphor-icons/react';
import type { ScreenChoice } from '../agents/agent-screen-types';
import { questionCursor, questionKeys, type QuestionAction } from './question-keys';
import { choiceContent, writeKeys } from './choice-keys';
import { t } from '../../shared/i18n';

// What the CLIs print in English for their own rows, in the window's words.
const OWN_LABELS: Record<string, string> = {
  'Type something.': '自己填写', 'Type something': '自己填写', 'Chat about this': '不选了，直接聊这个问题',
  'None of the above': '以上都不是', 'Submit answers': '提交回答', 'Cancel': '取消',
};
const ownLabel = (label: string) => OWN_LABELS[label] ? t(OWN_LABELS[label]) : label;
const placeholder = (label: string) => /^Type something\.?$/i.test(label);

// A question the agent asked with options (Claude Code's AskUserQuestion, Codex's request_user_input), answered here
// with the same keys the CLI takes: pick one, tick several and submit, type an own answer, switch questions or cancel.
// The card lives as long as the question's page; ticks, typed text and the cursor redraw it in place.
export function ReadingQuestion({ choice, terminalId, onError }: { choice: ScreenChoice; terminalId: string; onError: (message: string) => void }) {
  const question = choice.question!;
  const cursor = questionCursor(choice);
  const options = choice.options.map((option, index) => ({ option, index }));
  const answers = options.filter(({ option }) => option.role !== 'chat');
  const chats = options.filter(({ option }) => option.role === 'chat');
  const inputAt = choice.options.findIndex(option => option.role === 'input');
  const [highlight, setHighlight] = useState(() => 'option' in cursor && choice.options[cursor.option]?.role !== 'chat' ? cursor.option : answers[0]?.index ?? 0);
  const [pending, setPending] = useState<string | null>(null);
  const [text, setText] = useState(() => inputAt >= 0 && !placeholder(choice.options[inputAt].label) ? choice.options[inputAt].label : question.notes?.text ?? '');
  const sending = useRef(false), active = useRef(true), latest = useRef(choice), card = useRef<HTMLDivElement>(null), field = useRef<HTMLInputElement>(null);
  latest.current = choice;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { card.current?.querySelector<HTMLElement>('[data-highlighted="true"]')?.scrollIntoView({ block: 'nearest' }); }, [highlight]);
  // An answer shows once the CLI redraws what it changed; a key it ignores (Right on the last question) changes
  // nothing, so the card is free again after a moment either way.
  const content = choiceContent(choice);
  useEffect(() => { setPending(null); }, [content]);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setPending(null), 1500);
    return () => clearTimeout(timer);
  }, [pending]);

  const act = async (action: QuestionAction, mark: string) => {
    if (sending.current) return;
    // A typed answer that wrapped is shown in pieces, so its full length (to erase it) is unknown.
    if (action.type === 'answer' && question.agent === 'claude' && latest.current.options[action.option]?.detail) { onError(t('回答已换行，请切换到终端修改后提交。')); return; }
    const keys = questionKeys(latest.current, action);
    if (!keys.length) return;
    sending.current = true; setPending(mark);
    if (document.activeElement !== field.current) card.current?.focus();
    try {
      await writeKeys(keys, key => window.agentrix.writeTerminal(terminalId, key), () => active.current);
    } catch (error) {
      if (active.current) { setPending(null); onError(String(error)); }
    } finally { sending.current = false; }
  };
  const pick = (index: number) => {
    const option = choice.options[index];
    if (!option) return;
    setHighlight(index);
    if (option.role === 'input') { field.current?.focus(); return; }
    if (question.multi && option.role === 'answer') void act({ type: 'toggle', option: index }, `option-${index}`);
    else void act({ type: 'choose', option: index }, `option-${index}`);
  };
  // Claude: the own answer. Codex: notes sent with the highlighted option (or the option alone when empty).
  const sendText = () => {
    if (question.agent === 'claude') { if (inputAt >= 0) void act({ type: 'answer', option: inputAt, text }, 'text'); return; }
    if (text.trim()) void act({ type: 'answer', option: highlight, text }, 'text');
    else pick(highlight);
  };
  const fieldKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); sendText(); }
    else if (event.key === 'Escape') { event.preventDefault(); card.current?.focus(); }
  };
  const switchable = question.tabs.length > 1 || (question.position?.count ?? 1) > 1;
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target === field.current || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    event.stopPropagation();
    // Enter and Space on a focused button (Cancel, Submit, a question switch) press that button.
    if ((event.key === 'Enter' || event.key === ' ') && (event.target as HTMLElement).closest('button')) return;
    const moves = answers.map(({ index }) => index), at = Math.max(0, moves.indexOf(highlight));
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { setHighlight(moves[Math.max(0, Math.min(moves.length - 1, at + (event.key === 'ArrowUp' ? -1 : 1)))]); card.current?.focus(); }
    else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && switchable) void act({ type: 'switch', direction: event.key === 'ArrowLeft' ? -1 : 1 }, event.key === 'ArrowLeft' ? 'previous' : 'next');
    else if (event.key === 'Enter' || (event.key === ' ' && question.multi)) pick(highlight);
    else if (event.key === 'Escape') void act({ type: 'cancel' }, 'cancel');
    else if (/^[1-9]$/.test(event.key)) { const index = choice.options.findIndex(option => option.number === Number(event.key)); if (index >= 0) pick(index); else return; }
    else return;
    event.preventDefault();
  };
  const busy = pending !== null;
  const spinner = (mark: string) => pending === mark && <CircleNotch size={13} className="loading-spinner" />;
  const hint = [t('↑↓ 移动'), question.multi ? t('空格勾选') : t('Enter 选择'), ...(switchable ? [t('←→ 切换问题')] : []), t('Esc 取消')].join(' · ');

  return <div ref={card} className={`reading-choice is-question${question.multi ? ' is-multi' : ''}`} role="group" aria-label={choice.title} aria-busy={busy} tabIndex={-1} onKeyDown={keys}
    onFocus={() => window.agentrix.terminalFocus(terminalId, false)}>
    <div className="reading-question-head">
      {question.tabs.length > 1 && <span className="reading-question-tabs">{question.tabs.map(tab =>
        <span key={tab.label} className={`reading-question-tab${tab.answered ? ' is-answered' : ''}`}>{tab.answered && <Check size={11} weight="bold" />}{tab.label}</span>)}</span>}
      {question.position && question.position.count > 1 && <span className="reading-question-tab">{t('问题 {index}/{count}', question.position)}</span>}
      <span className="reading-question-spacer" />
      {switchable && <>
        <button type="button" className="icon-button reading-question-switch" title={t('上一题')} aria-label={t('上一题')} disabled={busy} onClick={() => void act({ type: 'switch', direction: -1 }, 'previous')}>{pending === 'previous' ? <CircleNotch size={13} className="loading-spinner" /> : <CaretLeft size={13} />}</button>
        <button type="button" className="icon-button reading-question-switch" title={t('下一题')} aria-label={t('下一题')} disabled={busy} onClick={() => void act({ type: 'switch', direction: 1 }, 'next')}>{pending === 'next' ? <CircleNotch size={13} className="loading-spinner" /> : <CaretRight size={13} />}</button>
      </>}
      <button type="button" className="text-button" disabled={busy} onClick={() => void act({ type: 'cancel' }, 'cancel')}>{spinner('cancel')}{t('取消')}</button>
    </div>
    {question.review
      ? <>
        <strong className="reading-question-title">{t('检查你的回答')}</strong>
        <dl className="reading-question-review">{question.review.map(item => <div key={item.question}><dt>{item.question}</dt><dd>{item.answer}</dd></div>)}</dl>
      </>
      : <strong className="reading-question-title">{choice.title}</strong>}
    <div className="reading-choice-options">{answers.map(({ option, index }) => option.role === 'input'
      ? <div key={option.number} className={`reading-question-input${option.checked ? ' is-checked' : ''}`} data-highlighted={index === highlight}>
        <span className="reading-question-mark">{question.multi ? option.checked && <Check size={11} weight="bold" /> : option.number}</span>
        <input ref={field} value={text} disabled={busy} placeholder={t('自己填写回答…')} aria-label={t('自己填写回答')}
          onChange={event => setText(event.target.value)} onFocus={() => setHighlight(index)}
          onKeyDown={fieldKeys} />
        <button type="button" className="icon-button" title={question.multi ? t('填入并勾选') : t('发送回答')} aria-label={question.multi ? t('填入并勾选') : t('发送回答')} disabled={busy || !text.trim()} onClick={sendText}>{pending === 'text' ? <CircleNotch size={13} className="loading-spinner" /> : <PaperPlaneRight size={13} weight="fill" />}</button>
      </div>
      : <button type="button" key={option.number} className={`reading-choice-option reading-question-option${option.selected ? ' is-cli-selected' : ''}${option.checked ? ' is-checked' : ''}`}
        data-highlighted={index === highlight} aria-pressed={question.multi ? !!option.checked : undefined} disabled={busy} onClick={() => pick(index)}>
        <span className="reading-question-mark">{question.multi ? option.checked && <Check size={11} weight="bold" /> : option.number}</span>
        <span className="reading-choice-label"><b>{ownLabel(option.label)}</b>{option.detail && !(question.agent === 'codex' && option.label === 'None of the above') && <small>{option.detail}</small>}</span>
        {spinner(`option-${index}`)}
      </button>)}
    </div>
    {question.agent === 'codex' && <div className="reading-question-input is-notes">
      <input ref={field} value={text} disabled={busy} placeholder={t('补充说明（可选），按 Enter 随所选答案一起提交')} aria-label={t('补充说明')}
        onChange={event => setText(event.target.value)}
        onKeyDown={fieldKeys} />
      <button type="button" className="icon-button" title={t('提交')} aria-label={t('提交')} disabled={busy} onClick={sendText}>{pending === 'text' ? <CircleNotch size={13} className="loading-spinner" /> : <PaperPlaneRight size={13} weight="fill" />}</button>
    </div>}
    {(question.multi || chats.length > 0) && <div className="reading-question-actions">
      {question.multi && <button type="button" className="button primary small" disabled={busy} onClick={() => void act({ type: 'submit' }, 'submit')}>{spinner('submit')}{t('提交这一题')}</button>}
      {chats.map(({ option, index }) => <button type="button" key={option.number} className="text-button" disabled={busy} onClick={() => pick(index)}>{spinner(`option-${index}`)}{ownLabel(option.label)}</button>)}
    </div>}
    <small className="reading-choice-hint">{hint}</small>
  </div>;
}
