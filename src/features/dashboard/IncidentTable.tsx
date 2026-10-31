// Incidents: CI or release failures, scope breaks and rework, each naming the model mainly responsible, the fix and any weight change.
// Wide windows get the table; narrow ones the same rows stacked (the other is hidden by the stylesheet).
import type { DashboardIncident, DashboardModelRow } from '../../shared/dashboard-types';
import { t } from '../../shared/i18n';
import { Marker } from './Charts';
import { shapeOf } from './chart-math';
import { dateLabel, kindLabel, leadNote, modelLabel, NONE, weightChange } from './format';
import { ScrollRegion } from './ScrollRegion';

const responsible = (incident: DashboardIncident) => [t('{model} 主责', { model: modelLabel(incident.model) }), leadNote(incident.lead)].filter(Boolean).join(' · ');
const rowKey = (incident: DashboardIncident, index: number) => `${incident.at}-${incident.model}-${index}`;

export function IncidentTable({ incidents, models }: { incidents: DashboardIncident[]; models: DashboardModelRow[] }) {
  const columns = [t('日期'), t('模型'), t('任务类型'), t('原因'), t('改进'), t('权重')];
  return <>
    <div className="wide-only">
      <ScrollRegion label={t('事故记录表，可横向滚动')}>
        <table className="incident">
          <thead><tr>{columns.map(name => <th key={name}>{name}</th>)}</tr></thead>
          <tbody>
            {incidents.length === 0 && <tr><td colSpan={columns.length} className="muted">{t('这段时间没有事故')}</td></tr>}
            {incidents.map((incident, index) => <tr key={rowKey(incident, index)}>
              <td>{dateLabel(incident.at)}</td>
              <td><span className="who"><Marker shape={shapeOf(models, incident.model)} />{responsible(incident)}</span></td>
              <td>{kindLabel(incident.kind)}</td><td>{incident.cause}</td><td>{incident.fix}</td>
              <td>{incident.weight ? <span className="weight">{weightChange(incident.weight)}</span> : NONE}</td>
            </tr>)}
          </tbody>
        </table>
      </ScrollRegion>
    </div>
    <div className="stack-only" role="list" aria-label={t('事故记录（窄窗口的堆叠视图）')}>
      {incidents.length === 0 && <p className="empty">{t('这段时间没有事故')}</p>}
      {incidents.map((incident, index) => <div key={rowKey(incident, index)} className="inc-card" role="listitem">
        <div className="inc-head"><span className="muted">{dateLabel(incident.at)}</span><span>{responsible(incident)}</span><span>{kindLabel(incident.kind)}</span></div>
        <div className="inc-row"><span>{t('原因')}</span><span>{incident.cause}</span></div>
        <div className="inc-row"><span>{t('改进')}</span><span>{incident.fix}</span></div>
        <div className="inc-row"><span>{t('权重')}</span><span>{incident.weight ? weightChange(incident.weight) : NONE}</span></div>
      </div>)}
    </div>
  </>;
}
