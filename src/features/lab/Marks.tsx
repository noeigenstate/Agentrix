// The small drawn parts every screen shares: an approach's marker (its shape and colour), a ring, a legend, a tag and the labelled scroll region.
import type { ReactNode } from 'react';
import { CaretLeft } from '@phosphor-icons/react';
import type { LabArm } from '../../shared/lab-types';
import { t } from '../../shared/i18n';
import { arc, shapePath } from './chart-math';
import { armName } from './format';
import { SHAPES } from './results-math';

// The colour comes from the `arm-<name>` class on the element or an ancestor, which sets --ink.
export const ArmMark = ({ arm, size = 16 }: { arm: LabArm; size?: number }) =>
  <svg className="mark" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true"><path d={shapePath(SHAPES[arm], 8, 8, 6)} /></svg>;

export const ArmName = ({ arm, long = false }: { arm: LabArm; long?: boolean }) =>
  <span className={`who arm-${arm}`}><ArmMark arm={arm} />{armName(arm, long)}</span>;

export const Legend = ({ arms }: { arms: LabArm[] }) =>
  <div className="legend" aria-label="legend">{arms.map(arm => <ArmName key={arm} arm={arm} />)}</div>;

// A ring that fills `share` of its circle; what it says goes in the middle.
export function Ring({ share, size, stroke = 8, children }: { share: number | null; size: number; stroke?: number; children?: ReactNode }) {
  const radius = (size - stroke) / 2, centre = size / 2;
  return <div className="ring" style={{ width: size, height: size }}>
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle className="ring-track" cx={centre} cy={centre} r={radius} strokeWidth={stroke} />
      {share !== null && share > 0 && <circle className="ring-fill" cx={centre} cy={centre} r={radius} strokeWidth={stroke} strokeDasharray={arc(radius, share)} transform={`rotate(-90 ${centre} ${centre})`} />}
    </svg>
    <div className="ring-text">{children}</div>
  </div>;
}

// The way back to the list: one button, the same on every screen that has one.
export const BackButton = ({ onClick }: { onClick: () => void }) =>
  <button type="button" className="button small back" onClick={onClick}><CaretLeft size={12} />{t('返回实验列表')}</button>;

export const Tag =({ children, tone }: { children: ReactNode; tone?: 'running' | 'success' | 'warning' | 'danger' }) =>
  <span className={`tag ${tone ? `tone-${tone}` : ''}`}>{children}</span>;

// Every region that scrolls is labelled and can take the keyboard's focus, so a wide table stays reachable without a pointer.
export const ScrollRegion = ({ label, children }: { label: string; children: ReactNode }) =>
  <div className="scroll" role="region" aria-label={label} tabIndex={0}>{children}</div>;

export const Panel = ({ title, hint, children, className = '' }: { title: string; hint?: string; children: ReactNode; className?: string }) =>
  <section className={`panel ${className}`}><h2>{title}{hint && <span className="hint">{hint}</span>}</h2>{children}</section>;
