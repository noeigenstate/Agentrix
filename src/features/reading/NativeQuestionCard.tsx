import { useRef, useState, type KeyboardEvent } from 'react';
import type { NativeApproval, NativeQuestionAnswer, NativeQuestionField, NativeQuestionValue } from '../../shared/types';
import { t } from '../../shared/i18n';
import './native-question.css';

type Values = Record<string, NativeQuestionValue>;
const defaults = (request: NativeApproval): Values => Object.fromEntries(request.question!.fields.filter(field => field.default !== undefined).map(field => [field.id, field.default!]));
// The tool names main puts in `title` when the agent sent no message of its own; they are never shown.
const TOOL_TITLES = new Set(['AskUserQuestion', 'request_user_input', 'elicitation']);
const TYPE_NOTES: Record<NativeQuestionField['type'], () => string> = { string: () => t('文本'), number: () => t('数字'), integer: () => t('整数'), boolean: () => t('是或否'), single: () => t('单选'), multi: () => t('多选') };

// Mirrors validFormat and validValue of electron/features/terminal/native-questions.cjs, which stay the authority
// (a test compares both). The card only says why main would refuse, so the owner can fix it before sending.
function formatProblem(value: string, format: NativeQuestionField['format']): string | undefined {
  if (format === 'email' && !/^[^\s@]+@[^\s@]+$/.test(value)) return t('请输入有效的邮箱地址');
  if (format === 'uri') {
    try { if (new URL(value).protocol) return; } catch { /* not a URL */ }
    return t('请输入有效的网址，如 https://example.com');
  }
  const date = (text: string) => { const parsed = new Date(text); return /^\d{4}-\d{2}-\d{2}$/.test(text) && Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === text; };
  if (format === 'date' && !date(value)) return t('请按 2026-01-31 的格式填写日期');
  if (format !== 'date-time') return;
  const parts = /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || !date(parts[1]) || Number(parts[2]) > 23 || Number(parts[3]) > 59 || Number(parts[4]) > 59 || !Number.isFinite(Date.parse(value))) return t('请按 2026-01-31T09:30:00Z 的格式填写日期和时间');
}

function problem(field: NativeQuestionField, value: NativeQuestionValue | undefined): string | undefined {
  if (value === undefined) return field.required ? (field.options || field.type === 'boolean' ? t('请选择') : t('请填写')) : undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return t('请输入数字');
    if (field.type === 'integer' && !Number.isSafeInteger(value)) return t('请输入整数');
    if (field.minimum != null && value < field.minimum) return t('不能小于 {limit}', { limit: field.minimum });
    if (field.maximum != null && value > field.maximum) return t('不能大于 {limit}', { limit: field.maximum });
  } else if (Array.isArray(value)) {
    if (field.minItems != null && value.length < field.minItems) return t('至少选择 {limit} 项', { limit: field.minItems });
    if (field.maxItems != null && value.length > field.maxItems) return t('最多选择 {limit} 项', { limit: field.maxItems });
    if (new Set(value).size !== value.length) return t('与已选项重复');
  } else if (typeof value === 'string') {
    const length = [...value].length;
    if (field.minLength != null && length < field.minLength) return t('至少 {limit} 个字符', { limit: field.minLength });
    if (field.maxLength != null && length > field.maxLength) return t('最多 {limit} 个字符', { limit: field.maxLength });
    return formatProblem(value, field.format);
  }
}

// Main validates before it consumes a token, so a refusal of the values leaves the request live; any other error means it is gone.
const refusal = (message: string) => message.startsWith('Invalid native question');

// This card owns no terminal keys or focus effects. A token is sent once at a time, and for good once its request is gone.
export function NativeQuestionCard({ request, source, onOpen, onError }: { request: NativeApproval; source?: string; onOpen?: () => void; onError: (message: string) => void }) {
  const question = request.question!;
  const [values, setValues] = useState<Values>(() => defaults(request)), [other, setOther] = useState<Record<string, string>>({});
  // A reason shows once the owner has touched its field, or pressed Enter on an unfinished form.
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [state, setState] = useState<'idle' | 'sent' | 'failed'>('idle'), [refused, setRefused] = useState(false), sending = useRef(false);
  const disabled = state !== 'idle';
  const touch = (...ids: string[]) => setTouched(previous => ({ ...previous, ...Object.fromEntries(ids.map(id => [id, true])) }));
  const edited = (id: string) => { touch(id); setRefused(false); };
  const change = (id: string, value: NativeQuestionValue | undefined) => { edited(id); setValues(previous => {
    const next = { ...previous };
    if (value === undefined) delete next[id]; else next[id] = value;
    return next;
  }); };
  // What would be sent for a field: an empty text, number or list is no answer at all.
  const answerOf = (field: NativeQuestionField) => {
    const typed = other[field.id]?.trim() ? other[field.id] : '', value = values[field.id], numeric = field.type === 'number' || field.type === 'integer';
    const answer = typed ? field.type === 'multi' ? [...(Array.isArray(value) ? value : []), typed] : typed
      : numeric && typeof value === 'string' && value !== '' ? Number(value) : value;
    return answer === '' || Array.isArray(answer) && !answer.length ? undefined : answer;
  };
  const answered = question.fields.map(answerOf), problems = question.fields.map((field, index) => problem(field, answered[index]));
  const unfinished = problems.filter(Boolean).length, shown = question.fields.map((field, index) => touched[field.id] ? problems[index] : undefined);
  const send = async (decision: NativeQuestionAnswer['decision']) => {
    if (sending.current) return;
    sending.current = true; setState('sent');
    const payload = Object.fromEntries(question.fields.flatMap((field, index) => answered[index] === undefined ? [] : [[field.id, answered[index]!]]));
    const answer: NativeQuestionAnswer = decision === 'submit' ? { token: request.token, decision, values: payload } : { token: request.token, decision };
    try {
      const result = await window.agentrix.answerNativeQuestion(request.terminalId, answer);
      if (result.ok) return;
      if (decision === 'submit' && refusal(result.error)) { sending.current = false; setState('idle'); setRefused(true); return; }
      setState('failed'); onError(result.error);
    } catch (error) { setState('failed'); onError(String(error)); }
  };
  // The submit button is disabled while unfinished, so the browser never submits: Enter there shows what is missing instead.
  const enter = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Enter' && unfinished && !event.nativeEvent.isComposing && (event.target as HTMLElement).tagName === 'INPUT') touch(...question.fields.map(field => field.id));
  };
  const control = (field: NativeQuestionField, index: number) => {
    const id = `native-${request.token}-${index}`, value = values[field.id], invalid = shown[index] ? true : undefined;
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
      {field.allowOther && <label className="native-question-other">{t('自己填写')}<input className="native-question-input" type={field.secret ? 'password' : 'text'} value={other[field.id] || ''} disabled={disabled} maxLength={8192} aria-invalid={invalid}
        onChange={event => { edited(field.id); setOther(previous => ({ ...previous, [field.id]: event.target.value })); if (field.type !== 'multi') change(field.id, undefined); }} /></label>}
    </>;
    if (field.type === 'boolean') return <select id={id} className="native-question-input" value={value === undefined ? '' : String(value)} disabled={disabled} aria-required={field.required} aria-invalid={invalid}
      onChange={event => change(field.id, event.target.value === '' ? undefined : event.target.value === 'true')}>
      <option value="">{t('请选择')}</option><option value="true">{t('是')}</option><option value="false">{t('否')}</option>
    </select>;
    const numeric = field.type === 'number' || field.type === 'integer';
    // Only the hard cap of what main accepts limits typing: a longer text shows its reason instead of being cut silently.
    return <input id={id} className="native-question-input" type={numeric ? 'number' : field.secret ? 'password' : field.format === 'email' ? 'email' : 'text'}
      value={typeof value === 'string' || typeof value === 'number' ? value : ''} disabled={disabled} aria-required={field.required} aria-invalid={invalid} maxLength={8192}
      min={field.minimum} max={field.maximum} step={field.type === 'integer' ? 1 : 'any'}
      onChange={event => change(field.id, numeric && event.target.value === '' ? undefined : event.target.value)} />;
  };
  const server = [request.params.serverName, request.params.mcp_server_name].find(name => typeof name === 'string' && name) as string | undefined;
  const message = TOOL_TITLES.has(question.title) ? '' : question.title;
  const statusId = `native-${request.token}-status`;
  const note = state === 'sent' ? t('回答已发送，正在等待会话继续。') : state === 'failed' ? t('此操作已失效，请查看当前会话。') : unfinished ? t('还有 {count} 项未完成', { count: unfinished }) : '';
  const head = t('{name} 需要你回答', { name: server ?? (request.provider === 'codex' ? 'Codex' : 'Claude') });
  return <section className="reading-choice native-question" data-approval-mode="native" aria-label={head}>
    <form className="native-question-form" noValidate onKeyDown={enter}
      onSubmit={event => { event.preventDefault(); event.stopPropagation(); if (!unfinished && request.decisions.includes('submit')) void send('submit'); }}>
      <div className="native-question-body">
        <div className="reading-choice-head"><strong>{head}</strong></div>
        {message && <p className="native-question-message">{message}</p>}
        {source && <p className="native-question-source">{source}</p>}
        {question.unsupported && <p className="native-question-message" role="status">{t('此表单暂不支持，请拒绝或取消后继续。')}</p>}
        {question.fields.map((field, index) => <fieldset className="native-question-field" key={field.id} disabled={disabled} onBlur={() => touch(field.id)}
          aria-describedby={shown[index] ? `native-${request.token}-${index}-reason` : undefined}>
          <legend>{field.label} <span className="native-question-note">{field.required ? t('必填') : t('选填')} · {TYPE_NOTES[field.type]()}</span></legend>
          {field.description && <p className="native-question-note">{field.description}</p>}
          <label className="native-question-label" htmlFor={`native-${request.token}-${index}`}>{field.label}</label>
          {control(field, index)}
          {shown[index] && <p className="native-question-reason" id={`native-${request.token}-${index}-reason`}>{shown[index]}</p>}
        </fieldset>)}
      </div>
      <div className="native-question-footer">
        {state === 'idle' && refused && <p className="native-question-reason" role="alert">{t('回答未被接受，请检查各项后重试。')}</p>}
        {note && <p className="native-question-status" id={statusId} role={state === 'idle' ? undefined : 'status'}>{note}</p>}
        <div className="reading-question-actions native-question-actions">
          {request.decisions.includes('submit') && <button type="submit" className="button primary small" disabled={disabled || !!unfinished} aria-describedby={unfinished ? statusId : undefined}>{t('提交回答')}</button>}
          {request.decisions.includes('decline') && <button type="button" className="button small" disabled={disabled} onClick={() => void send('decline')}>{t('拒绝')}</button>}
          {request.decisions.includes('cancel') && <button type="button" className="button small" disabled={disabled} onClick={() => void send('cancel')}>{t('取消')}</button>}
          {onOpen && <button type="button" className="text-button native-question-source-link" onClick={onOpen}>{t('查看来源')}</button>}
        </div>
      </div>
    </form>
  </section>;
}
