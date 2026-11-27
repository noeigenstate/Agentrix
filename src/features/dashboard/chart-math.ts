// The dashboard's chart arithmetic: how a model is told apart, how the trend lines up with its buckets and where things go
// on a plot. Pure, so the SVG components only draw.
import type { DashboardKindCell, DashboardOutcomes, DashboardTrend } from '../../shared/dashboard-types';
import { ALIAS, modelShort } from './format';

export type Shape = 'circle' | 'square' | 'diamond' | 'triangle' | 'inverted' | 'hexagon';
export const SHAPES: readonly Shape[] = ['circle', 'square', 'diamond', 'triangle', 'inverted', 'hexagon'];
// The page's categorical palette (--m-0..5 in dashboard.css). The models told apart since the first dashboard keep their slot;
// any other model takes the next free one, and past six the colour repeats with another shape, so a (colour, shape) pair stays unique.
export const PALETTE = 6;
const KNOWN = ['opus', 'sonnet', 'sol', 'terra', 'haiku', 'luna'];

// neutral: the look of what the records do not name, so it is never mistaken for a model's colour.
export type Look = { slot: number; colour: number; shape: Shape; neutral?: true };
export const lookOf = (slot: number): Look => ({ slot, colour: slot % PALETTE, shape: SHAPES[(slot + Math.floor(slot / PALETTE)) % SHAPES.length] });

// The model the records do not name ("unreported" in the summary) is drawn grey, outside the palette.
export const UNREPORTED = 'unreported';
export const NEUTRAL: Look = { slot: -1, colour: -1, shape: 'circle', neutral: true };

// One look per model for the whole page: every chart and table reads the same map. An alias ("sonnet") takes the look of the full id
// of the same model when the page has one, so one model never shows as two.
export function modelLooks(models: Iterable<string>) {
  const looks = new Map<string, Look>(), taken = new Set<number>(), all = [...new Set(models)].sort();
  let next = KNOWN.length;
  const fresh = (model: string) => {
    const known = KNOWN.indexOf(modelShort(model).toLowerCase()), slot = known >= 0 && !taken.has(known) ? known : next++;
    taken.add(slot);
    return lookOf(slot);
  };
  for (const model of all.filter(model => model !== UNREPORTED && !ALIAS.test(model))) looks.set(model, fresh(model));
  for (const alias of all.filter(model => ALIAS.test(model))) {
    const twin = all.find(model => model !== alias && !ALIAS.test(model) && modelShort(model) === modelShort(alias));
    looks.set(alias, twin ? looks.get(twin)! : fresh(alias));
  }
  if (all.includes(UNREPORTED)) looks.set(UNREPORTED, NEUTRAL);
  return looks;
}

// The four parts of a reliability bar, in the order they are drawn, each a share of the tasks.
export const OUTCOMES = ['passed', 'failed', 'untested', 'unfinished'] as const;
export type Outcome = typeof OUTCOMES[number];
export const shares = (row: DashboardOutcomes) => OUTCOMES.map(outcome => ({ outcome, count: row[outcome], share: row.tasks ? row[outcome] / row.tasks : 0 }));

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

// Runs of consecutive indexes that hold a value: a bucket without tasks breaks the line instead of drawing a zero.
export function runs(values: (number | null)[]) {
  const out: number[][] = [];
  values.forEach((value, index) => {
    if (value === null) return;
    if (index > 0 && values[index - 1] !== null) out[out.length - 1].push(index); else out.push([index]);
  });
  return out;
}

// The index of the position nearest to x.
export function nearest(xs: number[], x: number) {
  let best = 0;
  xs.forEach((candidate, index) => { if (Math.abs(candidate - x) < Math.abs(xs[best] - x)) best = index; });
  return best;
}

// Which points of a long series carry a marker: all of a short one, every k-th and the last of a long one.
export const markerEvery = (points: number, limit = 16) => points <= limit ? 1 : Math.ceil(points / 8);

export type TrendCell = { tasks: number; passed: number; passRate: number } | null;
// One series per model, in the order given, with a cell per bucket (null where the model had no task).
export function trendSeries(trend: DashboardTrend, models: string[]) {
  const index = new Map(trend.buckets.map((bucket, at) => [bucket, at]));
  return models.map(model => {
    const cells: TrendCell[] = trend.buckets.map(() => null);
    for (const point of trend.points) if (point.model === model && index.has(point.bucket)) {
      cells[index.get(point.bucket)!] = { tasks: point.tasks, passed: point.passed, passRate: point.passRate };
    }
    return { model, cells };
  }).filter(series => series.cells.some(Boolean));
}

const KIND_ORDER = ['core', 'frontend', 'test', 'ui-check', 'docs', 'small', 'review', 'investigate', 'roundtable', 'unreported'];
export type KindRow = { kind: string; cells: Record<string, DashboardKindCell> };
// One row per task kind, known kinds in their usual order and any other after them.
export function kindRows(kinds: DashboardKindCell[]): KindRow[] {
  const rows = new Map<string, KindRow>();
  for (const cell of kinds) {
    const row = rows.get(cell.kind) ?? { kind: cell.kind, cells: {} };
    row.cells[cell.model] = cell;
    rows.set(cell.kind, row);
  }
  const rank = (kind: string) => KIND_ORDER.indexOf(kind) < 0 ? KIND_ORDER.length : KIND_ORDER.indexOf(kind);
  return [...rows.values()].sort((a, b) => rank(a.kind) - rank(b.kind) || (a.kind < b.kind ? -1 : 1));
}
