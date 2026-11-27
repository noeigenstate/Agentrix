// The main chart: one row per model, most reliable first. Each row has its pass rate as the large figure, a bar of what its tasks
// came to and the task count. Small samples come last, under a caption that says why they are not ranked, and read weaker.
import { Fragment } from 'react';
import type { DashboardModelRow } from '../../shared/dashboard-types';
import { t } from '../../shared/i18n';
import { Marker } from './Charts';
import { OUTCOMES, type Outcome, shares } from './chart-math';
import { modelTitle, percent } from './format';

export const outcomeName = (outcome: Outcome) =>
  ({ passed: t('测试通过'), failed: t('测试失败'), untested: t('没有测试'), unfinished: t('没做完') })[outcome];

// The swatch of an outcome: success and danger fills, a hollow box for untested and a hatch for unfinished, so the four read apart without colour.
const Swatch = ({ outcome }: { outcome: Outcome }) => <i className={`swatch ${outcome}`} aria-hidden="true" />;

export function OutcomeKey() {
  return <div className="outcome-key">{OUTCOMES.map(outcome => <span key={outcome}><Swatch outcome={outcome} />{outcomeName(outcome)}</span>)}</div>;
}

function Row({ row }: { row: DashboardModelRow }) {
  const title = modelTitle(row.model), parts = shares(row).filter(part => part.count > 0);
  const said = parts.map(part => `${outcomeName(part.outcome)} ${part.count}`).join(' · ');
  return <li className={row.small ? 'rel-row is-small' : 'rel-row'}>
    <span className="who"><Marker model={row.model} /><span className="name" title={title}>{title}</span></span>
    <span className="rate">{percent(row.passRate)}</span>
    <div className="rel-body">
      <div className="rel-bar" role="img" aria-label={t('{model}：{parts}', { model: title, parts: said })}>
        {parts.map(part => <i key={part.outcome} className={`seg ${part.outcome}`} style={{ width: `${part.share * 100}%` }} />)}
      </div>
      <div className="rel-counts">{parts.map(part => <span key={part.outcome}><Swatch outcome={part.outcome} />{outcomeName(part.outcome)} {part.count}</span>)}</div>
    </div>
    <span className="tasks">{t('{count} 次任务', { count: row.tasks })}</span>
  </li>;
}

export function Reliability({ models, minTasks }: { models: DashboardModelRow[]; minTasks: number }) {
  const firstSmall = models.findIndex(row => row.small);
  return <>
    <OutcomeKey />
    <ol className="rel-list" aria-label={t('各模型的测试通过率，最可靠的在前')}>
      {models.map((row, index) => <Fragment key={row.model}>
        {index === firstSmall && <li className="rel-caption">{t('样本少：任务不到 {count} 次，不参与排名', { count: minTasks })}</li>}
        <Row row={row} />
      </Fragment>)}
    </ol>
  </>;
}
