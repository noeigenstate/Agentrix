// The dashboard's chart arithmetic: which models become series, how they are told apart without colour, and where
// things go on a plot. Pure, so the SVG components only draw.
import type { DashboardKindRate, DashboardModelRow, DashboardSpeedPoint } from '../../shared/dashboard-types';
import { modelShort } from './format';

export type Shape = 'circle' | 'square' | 'diamond' | 'triangle';
// A model keeps its shape everywhere (tables and charts); the chart colour, dash and bar texture are per chart slot.
export const SHAPES: readonly Shape[] = ['circle', 'square', 'diamond', 'triangle'];
export const DASHES = ['', '6 4', '10 3 2 3'] as const;
export const MAX_SERIES = DASHES.length;

export type Series = { model: string; label: string; shape: Shape; slot: number };

export const shapeOf = (models: DashboardModelRow[], model: string): Shape => SHAPES[Math.max(0, models.findIndex(row => row.model === model)) % SHAPES.length];

// The models a chart can draw: the first MAX_SERIES (in the table's order) that have a value; the rest only in the data table.
export function chartSeries(models: DashboardModelRow[], withData: Set<string>) {
  const ordered = models.map(row => row.model).filter(model => withData.has(model));
  const extra = [...withData].filter(model => !ordered.includes(model));
  const all = [...ordered, ...extra];
  const series: Series[] = all.slice(0, MAX_SERIES).map((model, slot) => ({ model, label: modelShort(model), shape: shapeOf(models, model), slot }));
  return { series, all, hidden: all.length - series.length };
}

export const modelsWithRate = (kinds: DashboardKindRate[]) => new Set(kinds.filter(row => row.firstPassRate !== null).map(row => row.model));
export const modelsWithSpeed = (speed: DashboardSpeedPoint[]) => new Set(speed.filter(point => point.tokensPerSecond !== null).map(point => point.model));

// The smallest 1, 2 or 5 times a power of ten that holds the value, so the top gridline is a round number.
export function niceMax(value: number) {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value)), unit = value / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
}

// Value to y: 0 at the bottom of the plot, max at its top, snapped to a half pixel so axis-aligned strokes stay crisp.
export const yScale = (max: number, top: number, height: number) => (value: number) => Math.round(top + height * (1 - value / max)) + 0.5;

// End labels sit at their line's last value; neighbours closer than `gap` are pushed apart and the block is kept in the plot.
export function spreadLabels(ys: number[], gap: number, low: number, high: number) {
  const order = ys.map((y, index) => ({ y, index })).sort((a, b) => a.y - b.y), placed: number[] = [];
  order.forEach((item, i) => placed.push(Math.max(i ? placed[i - 1] + gap : low, item.y)));
  for (let i = placed.length - 1; i >= 0; i--) placed[i] = Math.min(placed[i], i === placed.length - 1 ? high : placed[i + 1] - gap);
  const result: number[] = [];
  order.forEach((item, i) => { result[item.index] = placed[i]; });
  return result;
}

// Runs of consecutive indexes that hold a value: a missing reading breaks the line instead of drawing a zero.
export function runs(values: (number | null)[]) {
  const out: number[][] = [];
  values.forEach((value, index) => {
    if (value === null) return;
    if (index > 0 && values[index - 1] !== null) out[out.length - 1].push(index); else out.push([index]);
  });
  return out;
}

// yyyy-mm-dd as a day count, so a gap of idle days takes its width on the axis.
export const dayNumber = (day: string) => { const [year, month, date] = day.split('-').map(Number); return Math.round(Date.UTC(year, month - 1, date) / 86_400_000); };

// The index of the position nearest to x.
export function nearest(xs: number[], x: number) {
  let best = 0;
  xs.forEach((candidate, index) => { if (Math.abs(candidate - x) < Math.abs(xs[best] - x)) best = index; });
  return best;
}

// Which points of a long series carry a marker: all of a short one, every k-th and the last of a long one.
export const markerEvery = (points: number, limit = 16) => points <= limit ? 1 : Math.ceil(points / 8);

export type SpeedDay = { day: string; values: Record<string, number | null> };
// One row per local day, newest last, with every model's reading (null when it had none that day).
export function speedByDay(speed: DashboardSpeedPoint[]): SpeedDay[] {
  const days = new Map<string, Record<string, number | null>>();
  for (const point of speed) days.set(point.day, { ...days.get(point.day), [point.model]: point.tokensPerSecond });
  return [...days.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([day, values]) => ({ day, values }));
}

export type KindGroup = { kind: string; rates: Record<string, { rate: number | null; runs: number }> };
const KIND_ORDER = ['core', 'frontend', 'test', 'ui-check', 'docs', 'small', 'review', 'investigate', 'roundtable'];
// One group per task kind, known kinds in their usual order and any other after them.
export function kindGroups(kinds: DashboardKindRate[]): KindGroup[] {
  const groups = new Map<string, KindGroup>();
  for (const row of kinds) {
    const group = groups.get(row.kind) ?? { kind: row.kind, rates: {} };
    group.rates[row.model] = { rate: row.firstPassRate, runs: row.runs };
    groups.set(row.kind, group);
  }
  const rank = (kind: string) => KIND_ORDER.indexOf(kind) < 0 ? KIND_ORDER.length : KIND_ORDER.indexOf(kind);
  return [...groups.values()].sort((a, b) => rank(a.kind) - rank(b.kind) || (a.kind < b.kind ? -1 : 1));
}

// The share each phase takes of a round's measured build time; a phase with no runs takes none.
export function phaseShares(phases: Record<string, number | null>) {
  const total = Object.values(phases).reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return Object.fromEntries(Object.entries(phases).map(([name, value]) => [name, total && value ? value / total : 0])) as Record<string, number>;
}
