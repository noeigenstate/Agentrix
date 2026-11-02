// Small bars under a figure: one bar per day, stacked by model where a model is given. The drawing scales to its tile, so it
// needs no measuring; a day with nothing is a one-pixel stub, never a gap that reads as missing.
import { useModels } from './model-look';

const SLOT = 4, BAR = 3, HEIGHT = 24;
export type SparkLayer = { model: string | null; values: number[] };

export function SparkBars({ layers, label }: { layers: SparkLayer[]; label: string }) {
  const { of } = useModels(), length = layers[0]?.values.length ?? 0;
  if (!length) return null;
  const totals = Array.from({ length }, (_, day) => layers.reduce((sum, layer) => sum + layer.values[day], 0)), top = Math.max(...totals, 1);
  const bars = totals.map((total, day) => {
    if (!total) return <rect key={day} x={day * SLOT} y={HEIGHT - 1} width={BAR} height={1} fill="var(--text-3)" />;
    let base = 0;
    return <g key={day}>{layers.map((layer, index) => {
      const value = layer.values[day];
      if (!value) return null;
      const style = layer.model ? of(layer.model) : null, y = HEIGHT - (base + value) / top * (HEIGHT - 2);
      base += value;
      return <rect key={index} className={style?.dim || undefined} x={day * SLOT} y={y} width={BAR} height={Math.max(1, value / top * (HEIGHT - 2) - 1)} fill={style?.colour ?? 'var(--text-3)'} />;
    })}</g>;
  });
  return <svg className="spark" viewBox={`0 0 ${length * SLOT} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={label}>{bars}</svg>;
}
