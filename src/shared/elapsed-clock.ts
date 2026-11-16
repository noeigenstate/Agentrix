// How long something has been going, as a clock: 2:14, or 1:05:09 past the hour.
export function elapsedClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000)), hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), seconds = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}
