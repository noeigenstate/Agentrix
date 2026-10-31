// One row per round: the questions the roundtable raised, what review found, rework, scope breaks, incidents and where the time went.
import type { DashboardRound } from '../../shared/dashboard-types';
import { t } from '../../shared/i18n';
import { phaseShares } from './chart-math';
import { count, dateLabel, duration, NONE } from './format';
import { ScrollRegion } from './ScrollRegion';

const phaseNames = () => [['roundtable', t('圆桌')], ['build', t('开发')], ['review', t('审查')], ['rework', t('返工')]] as const;
const share = (value: number) => Math.round(value * 100);

// The bar's segments are the phases in order (grey), rework a different step; the figure beside it says the rework share in words.
function PhaseBar({ phases }: { phases: DashboardRound['phases'] }) {
  const shares = phaseShares(phases), shown = phaseNames().filter(([key]) => shares[key] > 0);
  if (!shown.length) return <span className="muted">{NONE}</span>;
  return <div className="stagecell">
    <div className="stagebar" role="img" aria-label={shown.map(([key, name]) => `${name} ${share(shares[key])}%`).join(' · ')}>
      {shown.map(([key]) => <i key={key} className={key === 'rework' ? 'rework' : undefined} style={{ width: `${shares[key] * 100}%` }} />)}
    </div>
    <small>{t('返工 {percent}%', { percent: share(shares.rework) })}</small>
  </div>;
}

export function RoundTable({ rounds, showProject }: { rounds: DashboardRound[]; showProject: boolean }) {
  const columns = [t('轮次'), t('任务'), t('圆桌问题'), t('审查发现'), t('返工'), t('越界'), t('事故'), t('耗时'), t('各阶段用时')];
  return <>
    <div className="legend">
      <span><i className="swatch" />{t('圆桌 · 开发 · 审查')}</span><span><i className="swatch rework" />{t('返工')}</span>
    </div>
    <ScrollRegion label={t('每轮经过表，可横向滚动；轮次列和用时条固定')}>
      <table className="sticky wide">
        <thead><tr>{columns.map((name, index) => <th key={name} className={index > 0 && index < 8 ? 'num' : undefined}>{name}</th>)}</tr></thead>
        <tbody>
          {rounds.length === 0 && <tr><td colSpan={columns.length} className="muted">{t('这段时间没有完成的轮次')}</td></tr>}
          {rounds.map(round => <tr key={`${round.project}-${round.meeting}-${round.at}`}>
            <td><span>{round.meeting}</span><small className="cost-note">{showProject ? `${round.project} · ` : ''}{dateLabel(round.at)}</small></td>
            <td className="num">{round.tasks}</td><td className="num">{count(round.questions)}</td><td className="num">{round.findings}</td>
            <td className="num">{round.rework}</td><td className="num">{round.outOfScope}</td><td className="num">{round.incidents}</td>
            <td className="num">{duration(round.durationMs)}</td>
            <td><PhaseBar phases={round.phases} /></td>
          </tr>)}
        </tbody>
      </table>
    </ScrollRegion>
  </>;
}
