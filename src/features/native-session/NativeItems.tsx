// What the agent did, one card each: its words, a summary of its thinking, a command with its output, the files it changed with their diff,
// a tool call and its plan. A step is one pill that unfolds (the reading view's pill), so the answers stay in view.
import { useState, type ReactNode } from 'react';
import { CaretDown, CaretUp, Check, X } from '@phosphor-icons/react';
import { t } from '../../shared/i18n';
import { Markdown } from '../reading/ReadingView';
import type { NativeModel, NativeItem } from './native-model.ts';
import { type StepMark, commandOf, fileChanges, itemState, messageText, planText, reasoningText, toolOf } from './native-words';

const first = (value: string) => value.split('\n', 1)[0];

function Step({ state, label, detail, extra, open: initiallyOpen = false, children }: {
  state: StepMark; label: string; detail?: string; extra?: string; open?: boolean; children?: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen), shown = open || state === 'running';
  return <div className={`reading-tools native-step${state ? ` is-${state}` : ''}${shown ? ' is-open' : ''}`}>
    <button type="button" className="reading-tools-head" aria-expanded={shown} onClick={() => setOpen(!open)}>
      {state && <span className={`reading-step-state${state === 'done' ? '' : ` is-${state}`}`}>{state === 'failed' ? <X size={13} weight="bold" /> : state === 'done' ? <Check size={13} weight="bold" /> : null}</span>}
      <span>{label}</span>{detail && <code className="reading-tools-file" title={detail}>{detail}</code>}{extra && <small className="reading-tools-more">{extra}</small>}
      {shown ? <CaretUp size={13} weight="bold" className="reading-tools-caret" /> : <CaretDown size={13} weight="bold" className="reading-tools-caret" />}
    </button>
    {shown && children && <div className="native-step-body">{children}</div>}
  </div>;
}

// A diff keeps the colours of its added and removed lines on the marks beside them; the lines themselves stay in the text colour.
export function Diff({ text }: { text: string }) {
  return <pre className="native-pre native-diff">{text.split('\n').map((line, index) => {
    const mark = /^\+(?!\+\+)/.test(line) ? 'add' : /^-(?!--)/.test(line) ? 'del' : null;
    return <span key={index} className={mark ? `is-${mark}` : undefined}>{line}{'\n'}</span>;
  })}</pre>;
}

function CommandStep({ item }: { item: NativeItem }) {
  const { command, cwd, exitCode, durationMs, output } = commandOf(item), state: StepMark = exitCode ? 'failed' : itemState(item);
  const facts = [cwd, exitCode !== null && t('退出码 {code}', { code: exitCode }), durationMs !== null && t('用时 {seconds} 秒', { seconds: (durationMs / 1000).toFixed(1) })].filter(Boolean).join(' · ');
  return <Step state={state} label={t('运行命令')} detail={first(command)}>
    <pre className="native-pre">{`$ ${command}`}</pre>
    {facts && <small className="native-facts">{facts}</small>}
    {output && <pre className="native-pre">{output}</pre>}
  </Step>;
}

function FileStep({ item }: { item: NativeItem }) {
  const changes = fileChanges(item), names = changes.map(change => change.path.split(/[\\/]/).pop() || change.path).filter(Boolean);
  return <Step state={itemState(item)} label={t('修改文件')} detail={names[0]} extra={names.length > 1 ? `+${names.length - 1}` : undefined}>
    {changes.map((change, index) => <div key={`${change.path}:${index}`} className="native-change">
      {change.path && <b className="native-path" title={change.path}>{change.path}{change.kind && <small> · {change.kind}</small>}</b>}
      {change.diff && <Diff text={change.diff} />}
    </div>)}
  </Step>;
}

function ToolStep({ item }: { item: NativeItem }) {
  const { name, server, input, result } = toolOf(item);
  return <Step state={itemState(item)} label={server ? `${server} · ${name}` : name} detail={first(input)}>
    {input && <pre className="native-pre">{input}</pre>}
    {result && <pre className="native-pre">{result}</pre>}
  </Step>;
}

export function NativeItemView({ item }: { item: NativeItem }) {
  switch (item.kind) {
    case 'agent-message': {
      const words = messageText(item);
      return words ? <div className="reading-assistant"><Markdown text={words} /></div> : null;
    }
    case 'reasoning-summary': {
      const words = reasoningText(item);
      return words ? <Step state={itemState(item)} label={t('思考摘要')}><p className="reading-plain native-thought">{words}</p></Step> : null;
    }
    case 'command': return <CommandStep item={item} />;
    case 'file-change': return <FileStep item={item} />;
    case 'plan': {
      const words = planText(item);
      return words ? <Step state={itemState(item)} label={t('计划')} open><Markdown text={words} /></Step> : null;
    }
    default: return <ToolStep item={item} />;
  }
}

// The turn's cumulative diff and the plan's steps: one card each at the end of the conversation, each replaced as the agent updates it.
export function NativeSummary({ model }: { model: NativeModel }) {
  const { diff, plan } = model;
  return <>
    {plan && plan.steps.length > 0 && <Step state={null} label={t('计划')} detail={t('{done} / {total} 步', { done: plan.steps.filter(step => /^(completed|done)$/i.test(step.status ?? '')).length, total: plan.steps.length })} open>
      {plan.explanation && <p className="reading-plain native-thought">{plan.explanation}</p>}
      <ol className="native-plan">{plan.steps.map((step, index) => <li key={index} className={/^(completed|done)$/i.test(step.status ?? '') ? 'is-done' : undefined}>{step.text}</li>)}</ol>
    </Step>}
    {diff && <Step state={null} label={t('本轮改动')}><Diff text={diff} /></Step>}
  </>;
}
