// How current the page is: a dot and a word (live, refreshing, stale), the age of the numbers and a refresh button. The main process
// pushes every change and a tick each minute, so there is no polling here; the chip only says when that has stopped.
import { ArrowsClockwise } from '@phosphor-icons/react';
import { t } from '../../shared/i18n';
import { age } from './format';

// No push for this long means the window missed its minute ticks: the numbers are old, whatever the connection says.
export const STALE_MS = 120_000;

export type Freshness = 'live' | 'refetch' | 'stale';
export const freshness = (generatedAt: number, now: number, loading: boolean, failed: boolean): Freshness =>
  loading ? 'refetch' : failed || now - generatedAt >= STALE_MS ? 'stale' : 'live';

export function FreshnessChip({ generatedAt, now, loading, failed, onRefresh }: { generatedAt: number; now: number; loading: boolean; failed: boolean; onRefresh(): void }) {
  const state = freshness(generatedAt, now, loading, failed);
  const word = { live: t('实时'), refetch: t('刷新中…'), stale: t('已过期') }[state];
  return <div className="fresh" data-state={state}>
    <span className="state"><i className={`live-dot is-${state}`} /><b role="status">{word}</b><span className="muted">{t('更新于 {time}', { time: age(now - generatedAt) })}</span></span>
    <button type="button" className="refresh" aria-label={t('立即刷新')} disabled={loading} onClick={onRefresh}><ArrowsClockwise size={16} />{t('刷新')}</button>
  </div>;
}
