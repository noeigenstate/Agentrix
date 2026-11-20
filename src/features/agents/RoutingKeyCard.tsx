import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CaretRight, Lightning } from '@phosphor-icons/react';
import type { SeatsInfo } from '../../shared/types';
import { t } from '../../shared/i18n';
import { openSeats, routingRoleName, routingModelName } from '../../shared/routing-command.ts';
import { displayedSeat } from './skill-seats';

export function RoutingKeyCard({ projectId, terminalId, sessionId }: { projectId?: string; terminalId: string; sessionId: string | null }) {
  const [info, setInfo] = useState<SeatsInfo | null>(null);
  const rowsRef = useRef<HTMLSpanElement>(null);
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
  useLayoutEffect(() => {
    const rows = rowsRef.current, pane = rows?.closest('.activity-pane');
    if (!rows || !pane) return;
    const fit = () => {
      // Usage and wrapped labels take their measured space before the routing list changes columns.
      rows.removeAttribute('data-compact');
      rows.removeAttribute('data-dense');
      if (rows.toggleAttribute('data-dense', pane.scrollHeight > pane.clientHeight)) {
        rows.toggleAttribute('data-compact', pane.scrollHeight > pane.clientHeight);
      }
    };
    const resize = new ResizeObserver(fit);
    const observe = () => {
      resize.disconnect();
      resize.observe(pane);
      for (const child of pane.children) resize.observe(child);
      fit();
    };
    const mutation = new MutationObserver(observe);
    mutation.observe(pane, { childList: true });
    observe();
    return () => { mutation.disconnect(); resize.disconnect(); };
  }, [info]);
  if (!info?.roles?.length) return null;
  const roles = info.roles.filter(role => role.enabled !== false);
  const pending = info.routing?.state === 'pending' || info.routing?.state === 'invalid';
  const titleOf = (role: typeof roles[number]) => role.source === 'custom' ? role.name : routingRoleName(role.name, t);
  const fast = t('快速');
  const title = t('模型路由'), badge = pending ? t('路由文件待确认') : '';
  return <button type="button" className="activity-routing-key" aria-label={badge ? `${title} · ${badge}` : title} aria-haspopup="dialog"
    onClick={() => openSeats({ projectId, terminalId })}>
    <span className="activity-card-title activity-routing-title">{title}{badge && <span data-routing-pending>{badge}</span>}<CaretRight size={14} aria-hidden="true" /></span>
    <span ref={rowsRef} className="activity-routing-rows">{roles.map(role => {
      const seat = displayedSeat(info, role.id);
      const name = titleOf(role), effort = seat?.effort ?? '—';
      return <span key={role.id} className={`activity-routing-row${info.conductor || role.id === info.lead ? '' : ' is-unavailable'}`} data-seat={role.id}>
        <span className="activity-routing-role" title={name}>{name}</span>
        <strong className="activity-routing-model" title={seat?.model}>{seat ? routingModelName(seat.model) : '—'}</strong>
        <span className="activity-routing-setting" title={seat?.fast ? `${seat.effort} · ${fast}` : seat?.effort}>
          {effort}{seat?.fast && <><span className="activity-routing-fast"> · {fast}</span>
            <Lightning className="activity-routing-fast-icon" size={14} aria-hidden="true" /></>}
        </span>
      </span>;
    })}</span>
  </button>;
}
