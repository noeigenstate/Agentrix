import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { X } from '@phosphor-icons/react';
import { t } from '../../shared/i18n';
import './reset-countdown.css';

const RADIUS = 100, CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const WARNING_FROM = 3;

// The countdown before a limit reset, over the whole window: the seconds in a ring that drains once a second. It is cancelled by its button, by Escape or by a click on the
// empty window; focus stays on the button, and the keys meant for it never reach the terminal or the composer behind it.
export function ResetCountdown({ count, total, onCancel }: { count: number; total: number; onCancel: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  // Armed after the first frame, so the ring starts full and then drains toward the next second.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    cancel.current?.focus({ preventScroll: true });
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setArmed(true)));
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); }
      else if (event.key === 'Tab') { event.preventDefault(); cancel.current?.focus({ preventScroll: true }); }
    };
    window.addEventListener('keydown', keys, true);
    return () => window.removeEventListener('keydown', keys, true);
  }, [onCancel]);
  // Screen readers hear the start and the last five seconds, not every tick.
  const announcement = count === total ? t('{seconds} 秒后重置额度', { seconds: count }) : count === 5 ? t('还剩 {seconds} 秒', { seconds: count }) : '';
  return createPortal(<CountdownView count={count} total={total} armed={armed} announcement={announcement} cancel={cancel} onCancel={onCancel} />, document.body);
}

export function CountdownView({ count, total, armed, announcement, cancel, onCancel }: {
  count: number; total: number; armed: boolean; announcement: string; cancel?: React.Ref<HTMLButtonElement>; onCancel: () => void;
}) {
  const ring = { '--ring-now': CIRCUMFERENCE * (1 - count / total), '--ring-next': CIRCUMFERENCE * (1 - (count - 1) / total) } as CSSProperties;
  return <div className={`reset-countdown${armed ? ' is-draining' : ''}${count <= WARNING_FROM ? ' is-warning' : ''}`} role="timer" aria-label={t('{seconds} 秒后重置额度', { seconds: count })}
    onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}>
    <div className="reset-countdown-stack">
      <div className="reset-countdown-ring" style={ring}>
        <svg viewBox="0 0 240 240" aria-hidden="true"><circle className="reset-countdown-track" cx="120" cy="120" r={RADIUS} /><circle className="reset-countdown-arc" cx="120" cy="120" r={RADIUS} /></svg>
        <span className="reset-countdown-number">{count}</span><span className="reset-countdown-unit">{t('秒')}</span>
      </div>
      <p className="reset-countdown-title">{t('秒后重置 Codex 额度')}</p>
      <button ref={cancel} type="button" className="reset-countdown-cancel" onClick={onCancel}><X size={14} aria-hidden="true" />{t('取消')}</button>
      <span className="reset-countdown-hint"><kbd>Esc</kbd>{t('或点击空白处取消')}</span>
    </div>
    <span className="reset-countdown-announce" role="status">{announcement}</span>
  </div>;
}
