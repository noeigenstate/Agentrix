// Exponential attack/release is based on elapsed time, so a 32 Hz remote display and a
// high-refresh monitor follow the same envelope. These time constants are in milliseconds.
export function easeVoiceLevel(current: number, measured: number, elapsed: number) {
  const target = Math.max(0, Math.min(1, Number.isFinite(measured) ? measured : 0));
  const level = Math.max(0, Math.min(1, Number.isFinite(current) ? current : 0));
  if (!(elapsed > 0)) return level;
  return level + (target - level) * -Math.expm1(-elapsed / (target > level ? 40 : 180));
}
