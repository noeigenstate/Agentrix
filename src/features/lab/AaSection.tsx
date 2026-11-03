// The AA lane's own part of the results: each approach's accuracy with its 95% Wilson interval, and beside it the number Artificial Analysis publishes for the
// model, dated and attributed. A published number is shown only for a single model (never the orchestration), and as "仅供参考" unless its harness and task set
// match ours. The url is text: the lab window has no link to open.
import type { LabExperiment } from '../../shared/lab-types';
import { t } from '../../shared/i18n';
import { DASH, outOf, percent } from './format';
import { ArmName, Panel, ScrollRegion, Tag } from './Marks';
import { armSummary, ranArms } from './results-math';
import { wilson } from './source-math';

export function AaSection({ experiment }: { experiment: LabExperiment }) {
  const published = experiment.lanes[0]?.published ?? null;
  return <Panel title={t('准确率与 AA 公布的分数')} hint={t('这里抽取的只是基准的一部分任务，分数不等同于 AA 公布的成绩')}>
    <ScrollRegion label={t('各方案的准确率与 AA 公布的分数')}>
      <table className="wide">
        <thead><tr><th>{t('方案')}</th><th className="num">{t('准确率')}</th><th className="num">{t('95% 区间')}</th><th className="num">{t('AA 公布')}</th></tr></thead>
        <tbody>{ranArms(experiment).map(arm => {
          const { tasks, tasksPassed, rate } = armSummary(experiment, arm), interval = wilson(tasksPassed, tasks), value = arm === 'orchestrated' ? undefined : published?.values[arm];
          return <tr key={arm}>
            <td><ArmName arm={arm} /></td>
            <td className="num">{percent(rate)} <span className="muted">({outOf(tasksPassed, tasks)})</span></td>
            <td className="num">{interval ? `${Math.round(interval.low * 100)}–${Math.round(interval.high * 100)}%` : DASH}</td>
            <td className="num">{value === undefined ? DASH : percent(value)}</td>
          </tr>;
        })}</tbody>
      </table>
    </ScrollRegion>
    {published ? <div className="published">
      <p className="note">{t('来源：Artificial Analysis · {label} · {url}', { label: published.label, url: published.url })}</p>
      <p className="note">{t('取得日期 {date} · 评测方式 {harness}', { date: published.asOf, harness: published.harness })}</p>
      {!published.comparable && <p className="note"><Tag tone="warning">{t('仅供参考')}</Tag> {t('评测方式或任务范围与这里不同，不能直接比较。')}</p>}
      {published.note && <p className="note">{published.note}</p>}
    </div> : <p className="note">{t('没有 AA 公布的分数：没有填写密钥，或没有取到。这里只显示本地得分。')}</p>}
  </Panel>;
}
