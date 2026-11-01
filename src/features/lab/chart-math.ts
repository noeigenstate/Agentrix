// The arithmetic of the lab's plots: a linear scale and round axis ticks. Charts are drawn from real data, so every plot goes through these.

export type Scale = (value: number) => number;

export function linear([d0, d1]: [number, number], [r0, r1]: [number, number]): Scale {
  return value => d1 === d0 ? r0 : r0 + (value - d0) / (d1 - d0) * (r1 - r0);
}

// A round upper bound at or above max, and evenly spaced ticks from 0 to it (about `want` of them).
export function niceScale(max: number, want = 4) {
  if (!(max > 0)) return { max: 1, ticks: [0, 1] };
  const raw = max / want, power = 10 ** Math.floor(Math.log10(raw)), unit = [1, 2, 2.5, 5, 10].map(step => step * power).find(step => step >= raw)!;
  const top = Math.ceil(max / unit - 1e-9) * unit;
  return { max: top, ticks: Array.from({ length: Math.round(top / unit) + 1 }, (_, index) => +(index * unit).toFixed(6)) };
}

export const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

// The error bar of a score in 0..1 is cut at the ends of the axis.
export const barEnds = (mean: number, sd: number): [number, number] => [clamp(mean - sd, 0, 1), clamp(mean + sd, 0, 1)];

// The dash pattern that fills `share` of a ring's circle; the circle is rotated in CSS so the arc starts at 12 o'clock.
export function arc(radius: number, share: number) {
  const length = 2 * Math.PI * radius;
  return `${(clamp(share, 0, 1) * length).toFixed(2)} ${length.toFixed(2)}`;
}

// The outline of an approach's marker, centred on (cx, cy) with radius r. Each approach has its own shape, so a plot reads without its colours.
export function shapePath(shape: 'circle' | 'square' | 'diamond' | 'triangle', cx: number, cy: number, r: number) {
  const f = (value: number) => +value.toFixed(2);
  if (shape === 'circle') return `M${f(cx - r)} ${f(cy)}a${r} ${r} 0 1 0 ${f(2 * r)} 0a${r} ${r} 0 1 0 ${f(-2 * r)} 0Z`;
  if (shape === 'square') { const h = 0.85 * r; return `M${f(cx - h)} ${f(cy - h)}h${f(2 * h)}v${f(2 * h)}h${f(-2 * h)}Z`; }
  if (shape === 'diamond') return `M${f(cx)} ${f(cy - 1.2 * r)}L${f(cx + 1.2 * r)} ${f(cy)}L${f(cx)} ${f(cy + 1.2 * r)}L${f(cx - 1.2 * r)} ${f(cy)}Z`;
  return `M${f(cx)} ${f(cy - 1.15 * r)}L${f(cx + 1.15 * r)} ${f(cy + 0.9 * r)}L${f(cx - 1.15 * r)} ${f(cy + 0.9 * r)}Z`;
}
