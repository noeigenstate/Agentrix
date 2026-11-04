// The activity pane's one bar and the figures around it, shared by the pane's pieces (the main model, each agent's run mode and allowance) so none imports another.
import type { ReactNode } from 'react';
import type { AgentTokens } from '../../shared/types';
import { t } from '../../shared/i18n';
import './activity-pane.css';

// 1234 → "1.2k", 828400 → "828k", 23898406 → "23.9M": token counts the way a person reads them at a glance.
export function tokenCount(value: number) {
  if (value < 1000) return String(Math.round(value));
  if (value < 1e6) return `${(value / 1e3).toFixed(value < 1e4 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(value / 1e6).toFixed(value < 1e7 ? 2 : 1).replace(/\.?0+$/, '')}M`;
}
export const exactCount = (value: number) => value.toLocaleString('en-US');
export const percentOf = (part: number, whole: number) => whole > 0 ? Math.min(100, Math.round(part / whole * 100)) : 0;

// When a window starts over: the time today, else the date and time.
export function resetTime(at: number) {
  const date = new Date(at), today = new Date().toDateString() === date.toDateString();
  return date.toLocaleString([], today ? { hour: '2-digit', minute: '2-digit', hour12: false } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

// One metric on an 88 | meter | 48 grid: a label, an optional meter, the figure in the pane's one right-hand number column, and a caption under the meter.
// The meter's fill is neutral; from 90% it, and the figure, take the warning colour.
export function Metric({ label, value, valueTitle, percent, meterLabel, note, title, className }: {
  label: ReactNode; value?: string; valueTitle?: string; percent?: number | null; meterLabel?: string; note?: string; title?: string; className?: string;
}) {
  return <div className={`activity-metric${percent != null && percent >= 90 ? ' is-warn' : ''}${className ? ` ${className}` : ''}`} title={title}>
    <span className="activity-metric-label">{label}</span>
    {percent !== undefined && <Meter percent={percent} label={meterLabel ?? ''} />}
    {value && <b title={valueTitle}>{value}</b>}
    {note && <small>{note}</small>}
  </div>;
}

export function Meter({ percent, label }: { percent: number | null; label: string }) {
  if (percent === null) return <span className="activity-meter is-expired" aria-hidden="true" />;
  const value = Math.max(0, Math.min(100, percent));
  return <span className="activity-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)} aria-label={label}><i style={{ width: `${value}%` }} /></span>;
}

// The round's or the conversation's tokens on one line: the label in its column, the breakdown from the meters' x.
export function TokenMetric({ label, tokens }: { label: string; tokens: AgentTokens }) {
  const parts = [t('输入 {count}', { count: tokenCount(tokens.input) }), tokens.input > 0 && tokens.cached > 0 && t('缓存命中 {percent}%', { percent: percentOf(tokens.cached, tokens.input) }), t('输出 {count}', { count: tokenCount(tokens.output) })].filter(Boolean);
  const title = [`${exactCount(tokens.input + tokens.output)} tokens`, t('输入 {count}', { count: exactCount(tokens.input) }), t('缓存命中 {count}', { count: exactCount(tokens.cached) }), t('输出 {count}', { count: exactCount(tokens.output) })].join(' · ');
  return <Metric className="activity-tokens" label={label} title={title} note={parts.join(' · ')} />;
}
