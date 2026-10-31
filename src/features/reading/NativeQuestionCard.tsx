import { useRef, useState } from 'react';
import type { NativeApproval, NativeQuestionAnswer, NativeQuestionField, NativeQuestionValue } from '../../shared/types';
import { t } from '../../shared/i18n';
import './native-question.css';

type Values = Record<string, NativeQuestionValue>;
const defaults = (request: NativeApproval): Values => Object.fromEntries(request.question!.fields.filter(field => field.default !== undefined).map(field => [field.id, field.default!]));

// This card owns no terminal keys or focus effects. A token can be sent only once, including after an error.
export function NativeQuestionCard({ request, source, onOpen, onError }: { request: NativeApproval; source?: string; onOpen?: () => void; onError: (message: string) => void }) {
  const question = request.question!;
  const [values, setValues] = useState<Values>(() => defaults(request)), [other, setOther] = useState<Record<string, string>>({});
  const [state, setState] = useState<'idle' | 'sent' | 'failed'>('idle'), sending = useRef(false);
  const disabled = state !== 'idle';
  const change = (id: string, value: NativeQuestionValue | undefined) => setValues(previous => {
    const next = { ...previous };
    if (value === undefined) delete next[id]; else next[id] = value;
    return next;
  });
  const answers = () => Object.fromEntries(question.fields.filter(field => Object.hasOwn(values, field.id) || !!other[field.id]?.trim()).map(field => {
    let value = values[field.id];
    if (field.type === 'number' || field.type === 'integer') value = typeof value === 'string' && value !== '' ? Number(value) : value;
    if (other[field.id]?.trim()) value = field.type === 'multi' ? [...(Array.isArray(value) ? value : []), other[field.id]] : other[field.id];
    return [field.id, value];
  }));
  const complete = question.fields.every(field => !field.required || !!other[field.id]?.trim() || Object.hasOwn(values, field.id)
    && (Array.isArray(values[field.id]) ? (values[field.id] as string[]).length > 0 : values[field.id] !== ''));
  const send = async (decision: NativeQuestionAnswer['decision']) => {
    if (sending.current) return;
    sending.current = true; setState('sent');
    const answer: NativeQuestionAnswer = decision === 'submit' ? { token: request.token, decision, values: answers() } : { token: request.token, decision };
    try {
      const result = await window.agentrix.answerNativeQuestion(request.terminalId, answer);
      if (!result.ok) { setState('failed'); onError(result.error); }
    } catch (error) { setState('failed'); onError(String(error)); }
  };
  const control = (field: NativeQuestionField, index: number) => {
    const id = `native-${request.token}-${index}`, value = values[field.id];
    if (field.options) return <>
      <div className="reading-choice-options">{field.options.map((option, optionIndex) => {
        const selected = field.type === 'multi' ? Array.isArray(value) && value.includes(option.value) : value === option.value && !other[field.id];
        return <label className={`reading-choice-option${selected ? ' is-selected' : ''}`} key={option.value}>
          <input type={field.type === 'multi' ? 'checkbox' : 'radio'} name={id} value={option.value} checked={selected} disabled={disabled}
            onChange={() => {
              if (field.type === 'multi') change(field.id, selected ? (value as string[]).filter(item => item !== option.value) : [...(Array.isArray(value) ? value : []), option.value]);
              else { change(field.id, option.value); setOther(previous => ({ ...previous, [field.id]: '' })); }
            }} />
          <span><span>{option.label}</span>{option.description && <span className="native-question-note">{option.description}</span>}
            {option.preview && <pre className="reading-choice-context">{option.preview}</pre>}</span>
          <span className="native-question-number" aria-hidden="true">{optionIndex + 1}</span>
        </label>;
      })}</div>
      {field.allowOther && <label className="native-question-other">{t('自己填写')}<input className="native-question-input" type={field.secret ? 'password' : 'text'} value={other[field.id] || ''} disabled={disabled} maxLength={8192}
        onChange={event => { setOther(previous => ({ ...previous, [field.id]: event.target.value })); if (field.type !== 'multi') change(field.id, undefined); }} /></label>}
    </>;
    if (field.type === 'boolean') return <select id={id} className="native-question-input" value={value === undefined ? '' : String(value)} disabled={disabled} required={field.required}
      onChange={event => change(field.id, event.target.value === '' ? undefined : event.target.value === 'true')}>
      <option value="">{t('请选择')}</option><option value="true">{t('是')}</option><option value="false">{t('否')}</option>
    </select>;
    const numeric = field.type === 'number' || field.type === 'integer';
    return <input id={id} className="native-question-input" type={numeric ? 'number' : field.secret ? 'password' : field.format === 'email' ? 'email' : 'text'}
      value={typeof value === 'string' || typeof value === 'number' ? value : ''} disabled={disabled} required={field.required} minLength={field.minLength} maxLength={field.maxLength ?? 8192}
      min={field.minimum} max={field.maximum} step={field.type === 'integer' ? 1 : 'any'}
      onChange={event => change(field.id, numeric && event.target.value === '' ? undefined : event.target.value)} />;
  };
  return <section className="reading-choice native-question" data-approval-mode="native" aria-label={t('原生提问')}>
    <div className="reading-choice-head"><strong>{request.provider} · {t('原生提问')}</strong></div>
    <p className="native-question-title">{question.title}</p>
    {source && <p>{source}</p>}
    {question.unsupported && <p role="status">{t('此表单暂不支持，请拒绝或取消后继续。')}</p>}
    <form onSubmit={event => { event.preventDefault(); event.stopPropagation(); if (complete && request.decisions.includes('submit')) void send('submit'); }}>
      {question.fields.map((field, index) => <fieldset className="native-question-field" key={field.id} disabled={disabled}>
        <legend>{field.label} <span className="native-question-note">{field.required ? t('必填') : t('选填')} · {field.type === 'single' ? t('单选') : field.type === 'multi' ? t('多选') : field.type}</span></legend>
        {field.description && <p className="native-question-note">{field.description}</p>}
        <label className="native-question-label" htmlFor={`native-${request.token}-${index}`}>{field.label}</label>
        {control(field, index)}
      </fieldset>)}
      <div className="native-question-actions">
        {request.decisions.includes('submit') && <button type="submit" className="button primary" disabled={disabled || !complete}>{t('提交回答')}</button>}
        {request.decisions.includes('decline') && <button type="button" className="button" disabled={disabled} onClick={() => void send('decline')}>{t('拒绝')}</button>}
        {request.decisions.includes('cancel') && <button type="button" className="button" disabled={disabled} onClick={() => void send('cancel')}>{t('取消')}</button>}
      </div>
    </form>
    {state === 'sent' && <p role="status">{t('回答已发送，正在等待会话继续。')}</p>}
    {state === 'failed' && <p role="status">{t('此操作已失效，请查看当前会话。')}</p>}
    {onOpen && <button type="button" className="text-button" onClick={onOpen}>{t('查看来源')}</button>}
  </section>;
}
