import { t } from '../../shared/i18n';

type SwitchTarget = { name: string; index: number; position: number; total: number; sequence: number };

export function ProjectSwitchHud({ target }: { target: SwitchTarget | null }) {
  // Keep the live region mounted so changes are announced without taking keyboard focus.
  return <div className="project-switch-hud" role="status" aria-live="polite" aria-atomic="true">
    {target && <div key={target.sequence} className="project-switch-hud-content">
      <span className="project-switch-index" aria-hidden="true">{String(target.index).padStart(2, '0')}</span>
      <span className="project-switch-name">{target.name}</span>
      <span className="project-switch-position">{t('{position} / {total}', { position: target.position, total: target.total })}</span>
    </div>}
  </div>;
}
