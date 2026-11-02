// The combined view of an experiment with several sources: which approach leads in how many of them, and the cost and time summed over every run.
// There is no combined score on purpose: each source grades on its own scale, so adding or averaging them would say nothing.
import type { LabExperiment } from '../../shared/lab-types';
import { t } from '../../shared/i18n';
import { duration, money, outOf, sentenceName } from './format';
import { ArmName, Panel, ScrollRegion } from './Marks';
import { combine } from './source-math';

export function Combined({ experiment }: { experiment: LabExperiment }) {
  const { sources, rows } = combine(experiment), most = Math.max(0, ...rows.map(row => row.leads)), leaders = rows.filter(row => most > 0 && row.leads === most);
  return <Panel title={t('综合对比')} hint={t('各来源分别评分，不相加也不平均；这里只数领先的来源，并把成本和耗时相加')}>
    {leaders.length ? leaders.map(row => <p key={row.arm} className="lead-line" role="status">{t('{arm}在 {k}/{n} 个来源中领先', { arm: sentenceName(row.arm), k: row.leads, n: sources })}</p>)
      : <p className="muted" role="status">{t('还没有足够的结果可以比较。')}</p>}
    <ScrollRegion label={t('各方案领先的来源数，以及成本和耗时合计')}>
      <table className="wide">
        <thead><tr><th>{t('方案')}</th><th className="num">{t('领先的来源')}</th><th className="num">{t('成本合计')}</th><th className="num">{t('耗时合计')}</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.arm}>
          <td><ArmName arm={row.arm} /></td>
          <td className="num">{outOf(row.leads, sources)}</td>
          <td className="num">{money(row.costUsd)}{row.unpriced > 0 && <span className="muted"> {t('{n} 次运行未计价', { n: row.unpriced })}</span>}</td>
          <td className="num">{duration(row.ms)}</td>
        </tr>)}</tbody>
      </table>
    </ScrollRegion>
  </Panel>;
}
