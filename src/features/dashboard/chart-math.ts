// The dashboard's chart arithmetic: how a model is told apart, which days a series covers, and where things go on a plot.
// Pure, so the SVG components only draw.
import type { DashboardDailyPoint, DashboardKindRate, DashboardSpeedPoint, DashboardSummary } from '../../shared/dashboard-types';
import { modelShort } from './format';

export type Shape = 'circle' | 'square' | 'diamond' | 'triangle' | 'inverted' | 'hexagon';
export const SHAPES: readonly Shape[] = ['circle', 'square', 'diamond', 'triangle', 'inverted', 'hexagon'];
// The page's categorical palette (--m-0..5 in dashboard.css). The models told apart since the first dashboard keep their slot;
// any other model takes the next free one, and past six the colour repeats with another shape, so a (colour, shape) pair stays unique.
export const PALETTE = 6;
const KNOWN = ['opus', 'sonnet', 'sol', 'terra', 'haiku', 'luna'];

export type Look = { slot: number; colour: number; shape: Shape };
export const lookOf = (slot: number): Look => ({ slot, colour: slot % PALETTE, shape: SHAPES[(slot + Math.floor(slot / PALETTE)) % SHAPES.length] });

// One look per model for the whole page: every chart, the key and the tables read the same map.
export function modelLooks(models: Iterable<string>) {
  const looks = new Map<string, Look>(), taken = new Set<number>();
  let next = KNOWN.length;
  for (const model of [...new Set(models)].sort()) {
    const known = KNOWN.indexOf(modelShort(model).toLowerCase()), slot = known >= 0 && !taken.has(known) ? known : next++;
    taken.add(slot);
    looks.set(model, lookOf(slot));
  }
  return looks;
}

// Every model any part of the summary mentions.
export const summaryModels = (summary: Pick<DashboardSummary, 'models' | 'daily' | 'kinds' | 'speed' | 'live'>) =>
  [...summary.models, ...summary.daily, ...summary.kinds, ...summary.speed, ...summary.live.running].map(item => item.model);

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

const pad = (value: number) => String(value).padStart(2, '0');
// The local calendar day of a time as yyyy-mm-dd, and the `count` days ending with that one, oldest first (a model's 14-day trend).
export const localDay = (at: number) => { const date = new Date(at); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; };
export function recentDays(at: number, count: number) {
  const date = new Date(at);
  return Array.from({ length: count }, (_, back) => localDay(new Date(date.getFullYear(), date.getMonth(), date.getDate() - (count - 1 - back), 12).getTime()));
}

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

export type RunDay = { day: string; runs: Record<string, number>; total: number; passes: number };
// One row per local day of the daily series, oldest first, with each model's run count and the confirmed first passes of the day.
export function runsByDay(daily: DashboardDailyPoint[]): RunDay[] {
  const days = new Map<string, RunDay>();
  for (const point of daily) {
    const entry = days.get(point.day) ?? { day: point.day, runs: {}, total: 0, passes: 0 };
    entry.runs[point.model] = (entry.runs[point.model] ?? 0) + point.runs;
    entry.total += point.runs;
    entry.passes += point.firstPass;
    days.set(point.day, entry);
  }
  return [...days.values()].sort((a, b) => a.day < b.day ? -1 : a.day > b.day ? 1 : 0);
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

// A heat cell's step on the five-step slate ramp (1 lightest in dark, darkest in light: more is always further along the ramp).
// A first-pass rate spans 45%..100% of the ramp; a count spans 0..the largest count shown.
const step = (ratio: number) => Math.min(5, Math.max(1, Math.ceil(ratio * 5)));
export const rateStep = (rate: number) => step((rate - 0.45) / 0.55);
export const countStep = (value: number, max: number) => max > 0 ? step(value / max) : 1;

// The share each phase takes of a round's measured build time; a phase with no runs takes none.
export function phaseShares(phases: Record<string, number | null>) {
  const total = Object.values(phases).reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return Object.fromEntries(Object.entries(phases).map(([name, value]) => [name, total && value ? value / total : 0])) as Record<string, number>;
}
