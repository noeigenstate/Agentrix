// The pieces the charts share: the model marks, the legend, the hover tip, the drawing width and the data-table toggle.
// A model is told apart by colour and shape together; every chart also names it in words (legend, end label or row).
import { type PointerEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { t } from '../../shared/i18n';
import type { Shape } from './chart-math';
import { modelShort } from './format';
import { useModels } from './model-look';

export function MarkShape({ shape, cx, cy, r }: { shape: Shape; cx: number; cy: number; r: number }) {
  if (shape === 'circle') return <circle cx={cx} cy={cy} r={r} />;
  if (shape === 'square') return <rect x={cx - r + 1} y={cy - r + 1} width={2 * r - 2} height={2 * r - 2} rx="1" />;
  const points = {
    diamond: [[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]],
    triangle: [[cx, cy - r], [cx + r, cy + r * 0.8], [cx - r, cy + r * 0.8]],
    inverted: [[cx - r, cy - r * 0.8], [cx + r, cy - r * 0.8], [cx, cy + r]],
    hexagon: [[cx - r, cy], [cx - r / 2, cy - r * 0.87], [cx + r / 2, cy - r * 0.87], [cx + r, cy], [cx + r / 2, cy + r * 0.87], [cx - r / 2, cy + r * 0.87]],
  }[shape];
  return <polygon points={points.map(point => point.join(',')).join(' ')} />;
}

// A model's mark inline with its name, in the model's colour.
export function Marker({ model, size = 12 }: { model: string; size?: number }) {
  const { look, colour } = useModels().of(model);
  return <svg className="mk" width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill={colour} aria-hidden="true"><MarkShape shape={look.shape} cx={size / 2} cy={size / 2} r={size / 2 - 1} /></svg>;
}

export function Legend({ models }: { models: string[] }) {
  const { of } = useModels();
  return <div className="legend">{models.map(model => <span key={model} className={of(model).dim}><Marker model={model} />{modelShort(model)}</span>)}</div>;
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
