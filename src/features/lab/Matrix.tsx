// Figure c: every task against every approach. A cell is the hidden tests that passed over the repeats, with its verdict by the pass rule written as a mark.
import { Check, X } from '@phosphor-icons/react';
import type { LabExperiment } from '../../shared/lab-types';
import { t } from '../../shared/i18n';
import { percent, outOf } from './format';
import { matrixCell, ranArms } from './results-math';
import { ArmName, Panel, ScrollRegion } from './Marks';

export function Matrix({ experiment }: { experiment: LabExperiment }) {
  const arms = ranArms(experiment);
  return <Panel title={t('任务 × 方案')} hint={t('隐藏测试通过数；打勾 = 多数次重复全部通过')}>
    <ScrollRegion label={t('每个任务在每种方案下的隐藏测试结果')}>
      <table className="matrix">
        <thead><tr><th>{t('任务（共 {n} 个）', { n: experiment.tasks.length })}</th>{arms.map(arm => <th key={arm}><ArmName arm={arm} /></th>)}</tr></thead>
        <tbody>{experiment.tasks.map(task => <tr key={task.id}>
          <th scope="row" className="task-title">{task.title}</th>
          {arms.map(arm => {
            const cell = matrixCell(experiment, arm, task.id);
            return <td key={arm} className={`arm-${arm}`}>
              <span className="cell" title={percent(cell.share)}>
                <span className="cellbar"><i style={{ width: `${(cell.share ?? 0) * 100}%` }} /></span>
                <span className="celltext">{outOf(cell.testsPassed, cell.testsTotal)}</span>
                {cell.settled && <span className={`verdict ${cell.passes ? 'pass' : 'fail'}`} role="img" aria-label={cell.passes ? t('通过') : t('未通过')}>{cell.passes ? <Check size={12} weight="bold" /> : <X size={12} weight="bold" />}</span>}
              </span>
            </td>;
          })}
        </tr>)}</tbody>
      </table>
    </ScrollRegion>
  </Panel>;
}
