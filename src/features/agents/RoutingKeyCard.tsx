import { useEffect, useState } from 'react';
import { CaretRight, Path } from '@phosphor-icons/react';
import type { SeatsInfo } from '../../shared/types';
import { t } from '../../shared/i18n';
import { openSeats, routingRoleName, routingModelName } from '../../shared/routing-command.ts';

export function RoutingKeyCard({ projectId, terminalId, sessionId }: { projectId?: string; terminalId: string; sessionId: string | null }) {
  const [info, setInfo] = useState<SeatsInfo | null>(null);
  useEffect(() => {
    const api = window.agentrix;
    if (!api?.skillSeats) return;
    let active = true, request = 0;
    const load = () => {
      const mine = ++request;
      void api.skillSeats(projectId ?? null, terminalId).then(
        next => { if (active && request === mine) setInfo(next); },
        () => { if (active && request === mine) setInfo(null); },
      );
    };
    setInfo(null); load();
    const off = api.onSkills?.(load);
    return () => { active = false; off?.(); };
  }, [projectId, terminalId, sessionId]);
  if (!info?.roles?.length) return null;
  const map = info.current ?? info.effective;
  return <button type="button" className="activity-routing-key" aria-label={t('模型路由')} aria-haspopup="dialog"
    onClick={() => openSeats({ projectId, terminalId })}>
    <span className="activity-routing-title"><Path size={16} aria-hidden="true" />{t('模型路由')}<CaretRight size={14} aria-hidden="true" /></span>
    <span className="activity-routing-rows">{info.roles.map(role => {
      const seat = map[role.id];
      return <span key={role.id} className="activity-routing-row" data-seat={role.id}>
        <span title={routingRoleName(role.name, t)}>{routingRoleName(role.name, t)}</span><strong title={seat?.model}>{seat ? routingModelName(seat.model) : '—'}</strong>
        <span>{seat?.effort ?? '—'}{seat?.fast && <span title={t('快速')}> · {t('快速')}</span>}</span>
      </span>;
    })}</span>
  </button>;
}
