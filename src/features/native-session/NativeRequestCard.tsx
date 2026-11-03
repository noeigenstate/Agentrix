// What the agent waits for you to decide: allow a command, a file change or a permission once, or answer its questions. Nothing is allowed by
// itself — a card stays until you answer or the main process resolves it (stop and session end deny it there). The answer goes to the main
// process by the request's id; a secret answer lives only in this card's fields until sent.
import { useState } from 'react';
import { Check } from '@phosphor-icons/react';
import { t } from '../../shared/i18n';
import { type NativeAnswer, nativeBridge } from './native-bridge.ts';
import type { NativeRequest, Payload } from './native-model.ts';

const KIND_WORDS: Record<string, string> = {
  command: '它要运行命令', 'file-change': '它要修改文件', permissions: '它要更多权限', tool: '它要使用工具', question: '它有问题要问你', elicitation: '它需要你填写信息',
};

type Draft = { picked: string[]; typed: string };
type Drafts = Record<string, Draft>;
const NONE: Draft = { picked: [], typed: '' };

const word = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
const options = (question: Payload) => (Array.isArray(question.options) ? question.options.map(option => typeof option === 'string' ? { label: option, description: null } : { label: word((option as Payload)?.label) ?? '', description: word((option as Payload)?.description) }).filter(option => option.label) : []);
const keyOf = (question: Payload, index: number) => word(question.id) ?? word(question.question) ?? String(index);
const isMultiple = (question: Payload) => question.multiSelect === true || question.multiple === true;

// One question's answer: what you wrote wins over a pick (a multiple one keeps both); empty when you gave none.
const answerOf = (question: Payload, draft: Draft): string | string[] | null => {
  const typed = draft.typed.trim();
  if (isMultiple(question)) return [...draft.picked, ...(typed ? [typed] : [])];
  return typed || draft.picked[0] || null;
};

// One question: its options (a pick, or several for a multiple one) and a field of your own words; a secret one is a password field.
function Question({ question, draft, onChange, disabled }: { question: Payload; draft: Draft; onChange(draft: Draft): void; disabled: boolean }) {
  const choices = options(question), multiple = isMultiple(question), secret = question.isSecret === true || question.secret === true;
  const title = word(question.question) ?? word(question.header) ?? '', toggle = (label: string) => onChange({
    ...draft, picked: multiple ? (draft.picked.includes(label) ? draft.picked.filter(entry => entry !== label) : [...draft.picked, label]) : [draft.picked[0] === label ? '' : label].filter(Boolean),
  });
  return <fieldset className="native-ask" disabled={disabled}>
    <legend className="reading-question-title">{title}</legend>
    {choices.length > 0 && <div className={`reading-choice-options${multiple ? ' is-multi' : ''}`} role={multiple ? 'group' : 'radiogroup'} aria-label={title}>
      {choices.map((choice, index) => {
        const on = draft.picked.includes(choice.label);
        return <button type="button" key={choice.label} role={multiple ? 'checkbox' : 'radio'} aria-checked={on} className={`reading-choice-option reading-question-option${on ? ' is-checked' : ''}`} onClick={() => toggle(choice.label)}>
          <span className="reading-question-mark">{on ? <Check size={12} weight="bold" /> : index + 1}</span>
          <span className="reading-choice-label"><b>{choice.label}</b>{choice.description && <small>{choice.description}</small>}</span>
        </button>;
      })}
    </div>}
    <label className="reading-question-input">
      <input type={secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} aria-label={choices.length ? t('其他回答：{question}', { question: title }) : title} placeholder={choices.length ? t('或写下你自己的回答') : t('你的回答')}
        value={draft.typed} onChange={event => onChange({ ...draft, typed: event.target.value })} />
    </label>
  </fieldset>;
}

function QuestionForm({ request, drafts, onDraft, busy, onAnswer }: { request: NativeRequest; drafts: Drafts; onDraft(key: string, draft: Draft): void; busy: boolean; onAnswer(answer: NativeAnswer): void }) {
  const answers = request.questions.map((question, index) => answerOf(question, drafts[keyOf(question, index)] ?? NONE));
  const complete = answers.every(answer => (Array.isArray(answer) ? answer.length > 0 : !!answer));
  return <>
    {request.questions.map((question, index) => {
      const key = keyOf(question, index);
      return <Question key={key} question={question} draft={drafts[key] ?? NONE} disabled={busy} onChange={draft => onDraft(key, draft)} />;
    })}
    <div className="reading-question-actions">
      <button type="button" className="button primary" disabled={busy || !complete} onClick={() => onAnswer({ answers: Object.fromEntries(request.questions.map((question, index) => [keyOf(question, index), answers[index] ?? ''])) })}>{t('提交回答')}</button>
      <button type="button" className="button" disabled={busy} onClick={() => onAnswer({ decision: 'deny' })}>{t('不回答')}</button>
    </div>
  </>;
}

export function NativeRequestCard({ request, terminalId, sessionId }: { request: NativeRequest; terminalId: string; sessionId: string }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [drafts, setDrafts] = useState<Drafts>({});
  // A sent answer keeps the card shut until the main process resolves the request; a refused one opens it again with the reason.
  const answer = async (value: NativeAnswer) => {
    const bridge = nativeBridge();
    if (busy || !bridge) return;
    setBusy(true); setError(null);
    const result = await bridge.answer(terminalId, sessionId, request.id, value).catch((failure: unknown) => ({ ok: false as const, error: failure instanceof Error ? failure.message : String(failure) }));
    if (!result.ok) { setError(result.error); setBusy(false); }
  };
  const asking = request.questions.length > 0, title = request.title || t(KIND_WORDS[request.kind] ?? '它在等你的回答');
  return <section className={`reading-choice native-request${asking ? ' is-question' : ''}`} role="group" aria-label={title} aria-busy={busy}>
    <div className="reading-choice-head"><strong>{title}</strong></div>
    {request.preview && <pre className="reading-choice-context native-preview">{request.preview}</pre>}
    {asking
      ? <QuestionForm request={request} drafts={drafts} onDraft={(key, draft) => setDrafts(current => ({ ...current, [key]: draft }))} busy={busy} onAnswer={value => void answer(value)} />
      : <div className="reading-question-actions">
        <button type="button" className="button primary" disabled={busy} onClick={() => void answer({ decision: 'allow' })}>{t('允许本次')}</button>
        <button type="button" className="button" disabled={busy} onClick={() => void answer({ decision: 'deny' })}>{t('拒绝')}</button>
      </div>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
