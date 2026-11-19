import { useEffect, useState } from 'react';
import { CaretRight, Path } from '@phosphor-icons/react';
import type { SeatsInfo } from '../../shared/types';
import { t } from '../../shared/i18n';
import { openSeats, routingRoleName, routingModelName } from '../../shared/routing-command.ts';
import { editableOperation, operationLabel, operationName } from './OperationRows';
import { operationDiff } from './skill-seats';

const SUMMARY_NAMES = { background: '后台小任务', subagent: '子代理', review: '审查' } as const;

function OperationSummary({ operations }: { operations: NonNullable<SeatsInfo['operations']> }) {
  const values = operations.current?.values ?? operations.effective;
  const changes = operationDiff(values, operations.defaults);
  const rows = operations.rows.filter(editableOperation).filter(row => changes[row.id] !== undefined);
  const title = t('操作模型');
  const names = rows.map(row => row.id in SUMMARY_NAMES ? t(SUMMARY_NAMES[row.id as keyof typeof SUMMARY_NAMES]) : operationName(row));
  const details = rows.map(row => {
    const value = changes[row.id];
    const label = operationLabel(row, value, routingModelName);
    return [`${operationName(row)} · ${label}`, value !== 'follow' && value?.effort].filter(Boolean).join(' · ');
  });
  return <span className="activity-routing-operations" title={[title, ...details].join('\n')}>
    {names.length ? <strong>{names.join(' · ')}</strong> : <><span>{title} · </span><strong>{t('默认')}</strong></>}
  </span>;
}

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
        <span className="activity-routing-setting" title={seat?.fast ? `${seat.effort} · ${t('快速')}` : seat?.effort}>
          {seat?.effort ?? '—'}{seat?.fast && <span className="activity-routing-fast"> · {t('快速')}</span>}
        </span>
      </span>;
    })}</span>
    {info.operations && <OperationSummary operations={info.operations} />}
  </button>;
}
