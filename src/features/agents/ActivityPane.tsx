import type { ProjectTerminal, SeatId } from '../../shared/types';
import { t } from '../../shared/i18n';
import { cliStateFor, useScreen } from '../terminal/terminal-screen.ts';
import { RoutingKeyCard } from './RoutingKeyCard';
import { ApiUsage } from './ApiUsage';
import './activity-pane.css';

export { SeatsHost } from './SeatsHost';

export function ActivityPane({ terminal, terminals = [terminal], projectId }: {
  terminal: ProjectTerminal; terminals?: readonly ProjectTerminal[]; projectId?: string;
}) {
  const screen = useScreen(terminal.id, terminal.sessionId);
  const leadWorking = terminal.codexActive && cliStateFor(terminal.agent ?? 'codex', screen, terminal).working;
  const workingSeats = new Set<SeatId>();
  for (const { agentUsage } of terminals) for (const call of agentUsage?.calls ?? []) for (const item of call.items) {
    if (item.seat && item.endedAt == null && item.state !== 'done' && item.state !== 'reviewing') workingSeats.add(item.seat);
  }
  return <aside className="activity-pane" aria-label={t('活动')}>
    {!terminal.codexActive && <section className="activity-card">
      <p className="activity-empty">{t('在终端里启动 Codex 或 Claude Code 后，这里显示它的模型路由、上下文长度和用量。')}</p>
    </section>}
    <ApiUsage terminal={terminal} projectId={projectId} />
    <RoutingKeyCard projectId={projectId} terminalId={terminal.id} sessionId={terminal.sessionId} workingSeats={workingSeats} leadWorking={leadWorking} />
  </aside>;
}
