// The workers running right now (the models the lead has called, as the activity pane lists them), with how long each has run and
// how fast it writes. Live calls are global; a project filter keeps only the calls known to belong to that project.
import type { DashboardSummary } from '../../shared/dashboard-types';
import { t } from '../../shared/i18n';
import { callModelName } from '../../shared/call-model-name';
import { Marker } from './Charts';
import { clock, modelLabel, modelShort, speed } from './format';
import { useModels } from './model-look';
import { Panel } from './Panel';

export function LiveStrip({ live, projectId, now }: { live: DashboardSummary['live']; projectId: string | null; now: number }) {
  const { of } = useModels();
  const running = live.running.filter(run => projectId === null || run.project === projectId);
  const hint = <>{running.length > 0 && <span className="tag run"><i className="live-dot" />{t('{count} 个子任务', { count: running.length })}</span>} {t('来自活动面板里调用的模型')}</>;
  return <Panel title={t('正在运行')} hint={hint}>
    {running.length === 0 ? <p className="empty-line">{t('现在没有子任务在运行')}</p>
      : <div className="live-list">{running.map(run => <div key={run.id} className={`live-item ${of(run.model).dim}`}>
        <div className="l1"><Marker model={run.model} /><span title={run.modelUnconfirmed ? callModelName(run) : modelLabel(run.model)}>{run.modelUnconfirmed ? callModelName(run) : modelShort(run.model)}</span><span className="tag">{t(run.role)}</span></div>
        <div className="r1">{t('已运行')} <span>{clock(run.startedAt === null ? null : now - run.startedAt)}</span></div>
        <div className="l2" title={run.title}>{run.title}</div>
        <div className="r2"><b>{speed(run.tokensPerSecond)}</b></div>
      </div>)}</div>}
  </Panel>;
}
