import type { ProjectTerminal } from '../../shared/types';
import { t } from '../../shared/i18n';
import { RoutingKeyCard } from './RoutingKeyCard';
import { ApiUsage } from './ApiUsage';
import './activity-pane.css';

export { SeatsHost } from './SeatsHost';

export function ActivityPane({ terminal, projectId }: { terminal: ProjectTerminal; projectId?: string }) {
  return <aside className="activity-pane" aria-label={t('活动')}>
    {!terminal.codexActive && <section className="activity-card">
      <p className="activity-empty">{t('在终端里启动 Codex 或 Claude Code 后，这里显示它的模型路由、上下文长度和用量。')}</p>
    </section>}
    <ApiUsage terminal={terminal} projectId={projectId} />
    <RoutingKeyCard projectId={projectId} terminalId={terminal.id} sessionId={terminal.sessionId} />
  </aside>;
}
