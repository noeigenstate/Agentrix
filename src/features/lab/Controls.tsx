// The form controls every step shares: a choice card (a native toggle button, and only the chosen one carries the tick) and a stepper.
import type { ReactNode } from 'react';
import { Check, Minus, Plus } from '@phosphor-icons/react';
import { t } from '../../shared/i18n';

const Tick = () => <span className="tick" aria-hidden="true"><Check size={12} weight="bold" /></span>;

export function Choice({ chosen, disabled = false, onClick, className = '', children }: { chosen: boolean; disabled?: boolean; onClick: () => void; className?: string; children: ReactNode }) {
  return <button type="button" className={`choice ${className}`} aria-pressed={chosen} disabled={disabled} onClick={onClick}>{chosen && <Tick />}{children}</button>;
}

export function Stepper({ label, hint, value, min, max, onChange }: { label: string; hint: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return <div className="field"><div><b>{label}</b><p className="muted">{hint}</p></div>
    <div className="control"><div className="stepper" role="group" aria-label={label}>
      <button type="button" className="icon-button" aria-label={t('减少')} disabled={value <= min} onClick={() => onChange(value - 1)}><Minus size={16} /></button>
      <output aria-live="polite">{value}</output>
      <button type="button" className="icon-button" aria-label={t('增加')} disabled={value >= max} onClick={() => onChange(value + 1)}><Plus size={16} /></button>
    </div></div></div>;
}
