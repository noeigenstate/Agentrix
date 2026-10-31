// The pieces both charts share: the model marks, the bar textures, the legend, the hover tip and the data-table toggle.
// A model is told apart by shape, line style and texture, never by colour alone.
import { type PointerEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { t } from '../../shared/i18n';
import { DASHES, MAX_SERIES, type Series, type Shape } from './chart-math';

export function MarkShape({ shape, cx, cy, r }: { shape: Shape; cx: number; cy: number; r: number }) {
  if (shape === 'circle') return <circle cx={cx} cy={cy} r={r} />;
  if (shape === 'square') return <rect x={cx - r} y={cy - r} width={2 * r} height={2 * r} />;
  const points = shape === 'diamond' ? [[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]] : [[cx, cy - r], [cx + r, cy + r], [cx - r, cy + r]];
  return <polygon points={points.map(point => point.join(',')).join(' ')} />;
}

// A model's mark inline with its name, in the text colour.
export function Marker({ shape, size = 12 }: { shape: Shape; size?: number }) {
  return <svg className="mk" width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="currentColor" aria-hidden="true"><MarkShape shape={shape} cx={size / 2} cy={size / 2} r={size / 2 - 1} /></svg>;
}

// The bar textures, defined once for the whole page: lines, diagonal stripes and dots, in the chart colours.
export function ChartDefs() {
  return <svg className="dash-defs" width="0" height="0" aria-hidden="true" focusable="false"><defs>
    <pattern id="dash-pattern-0" width="4" height="4" patternUnits="userSpaceOnUse"><rect className="pattern-ground" width="4" height="4" /><rect className="pattern-ink s0" width="4" height="1" /></pattern>
    <pattern id="dash-pattern-1" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect className="pattern-ground" width="6" height="6" /><rect className="pattern-ink s1" width="2" height="6" /></pattern>
    <pattern id="dash-pattern-2" width="6" height="6" patternUnits="userSpaceOnUse"><rect className="pattern-ground" width="6" height="6" /><circle className="pattern-ink s2" cx="3" cy="3" r="1.1" /></pattern>
  </defs></svg>;
}

export const barFill = (slot: number) => `url(#dash-pattern-${slot % MAX_SERIES})`;

export function Legend({ series, kind, hidden }: { series: Series[]; kind: 'bar' | 'line'; hidden: number }) {
  return <div className="legend">
    {series.map(item => <span key={item.model} className={`s${item.slot}`}>
      {kind === 'bar'
        ? <svg width="16" height="12" aria-hidden="true"><rect className="bar" x=".5" y=".5" width="15" height="11" fill={barFill(item.slot)} /></svg>
        : <svg width="28" height="12" aria-hidden="true"><line className="line" x1="0" x2="28" y1="6" y2="6" strokeDasharray={DASHES[item.slot]} /><g className="marker" transform="translate(8 0)"><MarkShape shape={item.shape} cx={6} cy={6} r={5} /></g></svg>}
      {item.label}
    </span>)}
    {hidden > 0 && <span className="legend-note">{t('另有 {count} 个模型只在数据表里', { count: hidden })}</span>}
  </div>;
}

// A tip that follows the pointer over a chart. It sits on the other side of the pointer near the window's right edge.
export function useTip() {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  return {
    show: (event: PointerEvent, text: string) => setTip({ x: event.clientX, y: event.clientY, text }),
    hide: () => setTip(null),
    node: tip && <div className="tip" role="presentation" style={tip.x > innerWidth - 260 ? { right: innerWidth - tip.x + 12, top: tip.y + 16 } : { left: tip.x + 12, top: tip.y + 16 }}>{tip.text}</div>,
  };
}

// The drawing width follows the element, so a resized window redraws the plot; 640 until it is measured.
export function useWidth<T extends Element>() {
  const ref = useRef<T>(null), [width, setWidth] = useState(640);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const read = () => setWidth(Math.round(node.getBoundingClientRect().width) || 640);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

// The chart's numbers as a table, one click away: the picture is never the only way to read them.
export function DataToggle({ children }: { children: ReactNode }) {
  return <details className="data"><summary>{t('查看数据表')}</summary>{children}</details>;
}
