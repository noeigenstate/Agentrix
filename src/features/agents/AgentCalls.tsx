import { CheckCircle, Circle, CircleNotch, Record as RecordDot, WarningCircle } from '@phosphor-icons/react';
import type { AgentCall, TokenRate } from '../../shared/types';
import { t } from '../../shared/i18n';
import { callModelName } from '../../shared/call-model-name';
import { modelName } from '../../shared/model-name';
import { ClaudeLogo, CodexLogo } from './AgentBrandIcon';
import { exactCount } from './Metric';
import { isSplitOpen, listedCalls, toggleSplit, useSplits } from './subagent-splits.ts';
import './activity-pane.css';

// How fast a model writes, at the right end of its head: the average over its recent replies (output tokens per second of the time it spent writing). The column is a fixed width, so
// a figure arriving or changing moves nothing. Not yet a finished reply: waiting. Records that cannot be read: a dash, and the tooltip says so.
// Output tokens per second of the time the replies took; null until a reply has finished.
export const rateValue = (rate: TokenRate | null | undefined) => rate && rate.samples > 0 && rate.activeMs > 0 ? Math.round(1000 * rate.outputTokens / rate.activeMs) : null;

function Rate({ rate }: { rate: TokenRate | null | undefined }) {
  const partial = rate?.partial ? '\n' + t('（部分记录）') : '';
  const value = rateValue(rate);
  if (rate && value !== null) {
    const title = t('平均输出速率：最近 {samples} 条回复，共 {tokens} token，用时 {seconds} 秒', { samples: rate.samples, tokens: exactCount(rate.outputTokens), seconds: (rate.activeMs / 1000).toFixed(1) }) + partial;
    return <span className="activity-row-end activity-rate is-live" title={title}>{value} token/s</span>;
  }
  if (rate) return <span className="activity-row-end activity-rate" title={t('还没有完成一条回复，暂时没有速率。') + partial}>{t('等待中')}</span>;
  return <span className="activity-row-end activity-rate" title={t('这个模型的记录在这里读不到，所以没有速率。')}>— token/s</span>;
}

// A head row: the name, recorded effort and speed, any non-default service (which gives way first), and a fixed rate column.
export function ModelHead({ agent, name, effort, fast, provider, title, rate }: { agent: AgentCall['agent']; name: string; effort?: string | null; fast?: boolean | null; provider: string | null | undefined; title: string; rate: TokenRate | null | undefined }) {
  const Mark = agent === 'Codex' ? CodexLogo : ClaudeLogo;
  const visibleProvider = provider === (agent === 'Codex' ? 'OpenAI' : 'Anthropic') ? null : provider;
  const how = [effort === 'default' ? t('默认') : effort, fast != null && (fast ? t('快速') : t('普通'))].filter(Boolean).join(' · ');
  return <li className="activity-call-head" title={[title, how].filter(Boolean).join('\n')}>
    <span className="activity-row-icon"><Mark size={16} /></span>
    <p><b>{name}</b>{how && <span className="activity-call-settings">{how}</span>}{visibleProvider && <span className="activity-call-provider">{visibleProvider}</span>}</p>
    <Rate rate={rate} />
  </li>;
}

// A call's state: the icon in the row's 16px box and the word at its right. Running is the one colour (the spinner).
export const CALL_STATES = {
  preparing: { word: '准备中', icon: <Circle size={14} aria-hidden="true" /> },
  running: { word: '运行中', icon: <CircleNotch size={14} weight="bold" className="loading-spinner" aria-hidden="true" /> },
  reviewing: { word: '审核中', icon: <RecordDot size={14} aria-hidden="true" /> },
  done: { word: '已完成', icon: <CheckCircle size={14} weight="fill" aria-hidden="true" /> },
} as const;
const MAX_CALL_ITEMS = 4;

// A dispatched worker that did not finish cleanly, in words in the state column (skills/agent-dispatch).
export function failureWord(failure: NonNullable<AgentCall['items'][number]['failure']>) {
  if (failure.reason === 'unconfirmed') return t('未能启动');
  if (failure.reason === 'capacity') return t('模型满载');
  if (failure.reason === 'killed') return t('已停止');
  if (failure.reason === 'scope') return t('越界');
  return failure.exitCode == null ? t('出错退出') : t('出错退出（代码 {code}）', { code: failure.exitCode });
}

// The sub-agents the agent called, listed in the left bar's Agent tab and in the narrow window's header popover: per model one head (its mark, name, settings, service and rate),
// then two lines for each of its calls (what it does; its role and state in words). A model's calls past the fourth fold into "+N". With no call there is one quiet line saying what will appear.
// A call whose record can be read is one button on the same row: it opens (or closes) a read-only view of that sub-agent beside the conversation.
// The calls listed are `listedCalls`' (hidden ones left out), and the "+N" counts those.
export function CallsCard({ calls, terminalId }: { calls: AgentCall[]; terminalId: string }) {
  const open = useSplits();
  const groups = listedCalls(calls, open, terminalId);
  if (!groups.length) return <section className="activity-card activity-calls" aria-label={t('调用的模型')}><p className="activity-empty">{t('还没有调用其他模型。规划员分派任务后，会显示在这里。')}</p></section>;
  return <section className="activity-card activity-calls" aria-label={t('调用的模型')}>
    <ul className="activity-call-groups">
      {groups.map(({ call, items }) => {
        const name = callModelName(call);
        return <li key={JSON.stringify([call.agent, call.provider, call.model, call.modelUnconfirmed, call.effort, call.fast])}>
          <ul className="activity-call-rows">
            <ModelHead agent={call.agent} name={name} effort={call.effort} fast={call.fast} provider={call.provider} title={[call.agent, call.provider, name].filter(Boolean).join(' / ')} rate={call.rate} />
            {items.slice(0, MAX_CALL_ITEMS).map(item => {
              const failure = item.failure ? failureWord(item.failure) : null, word = failure ?? t(CALL_STATES[item.state].word), opened = isSplitOpen(open, terminalId, item.id);
              // A dispatched worker that runs other settings than the lead declared says so in its tooltip.
              const declared = item.declared && t('分派时声明 {model} · {effort} · {mode}', { model: modelName(item.declared.model), effort: item.declared.effort ?? t('未报告'), mode: item.declared.fast == null ? t('未报告') : t(item.declared.fast ? '快速' : '普通') });
              const outside = item.failure?.files?.length ? t('改了允许范围之外的文件：{files}', { files: item.failure.files.join('、') }) : null;
              const cells = <>
                <span className="activity-row-icon">{failure ? <WarningCircle size={14} weight="fill" aria-hidden="true" /> : CALL_STATES[item.state].icon}</span>
                <span className="activity-call-text"><p>{item.title}</p><small className="activity-call-sub">{t(item.role)} · {word}</small></span>
              </>;
              const hint = item.viewable ? t(opened ? '点击关闭旁边的分屏' : '点击在旁边查看它在做什么') : null;
              return <li key={item.id} className={`activity-call-item is-${item.state}${failure ? ' is-failed' : ''}`} title={[item.title, failure, outside, declared, hint].filter(Boolean).join('\n')}>
                {item.viewable
                  ? <button type="button" className="activity-call-open activity-call-body" aria-pressed={opened} aria-label={t('{role} {title}，{state}', { role: t(item.role), title: item.title, state: word })} onClick={() => toggleSplit(terminalId, item.id)}>{cells}</button>
                  : <div className="activity-call-body">{cells}</div>}
              </li>;
            })}
            {items.length > MAX_CALL_ITEMS && <li className="activity-call-more"><span /><p>{t('+{count} 个', { count: items.length - MAX_CALL_ITEMS })}</p></li>}
          </ul>
        </li>;
      })}
    </ul>
  </section>;
}
