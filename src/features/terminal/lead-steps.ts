import type { AgentSettings, Seat } from '../../shared/types';

// What to type into a running Claude Code so its model and effort match the lead seat (lead-sync.ts types it).
export type LeadStep = { command: string; confirm: boolean };

const sameModel = (chosen: string, actual: string) => {
  const a = chosen.toLowerCase().replace(/\[[^\]]*\]$/, ''), b = actual.toLowerCase().replace(/\[[^\]]*\]$/, '');
  return a === b || /^[a-z]+$/.test(a) && b.split(/[-\s]/).includes(a);
};

// What to type so the running lead matches the seat; empty when it already does or what it runs is not known yet.
export function leadSteps(seat: Seat | null | undefined, actual: AgentSettings | null | undefined): LeadStep[] {
  if (!seat || !actual?.model) return [];
  const steps: LeadStep[] = [];
  if (!sameModel(seat.model, actual.model)) steps.push({ command: `/model ${seat.model}`, confirm: true });
  if (seat.effort && actual.effort !== seat.effort) steps.push({ command: `/effort ${seat.effort}`, confirm: false });
  return steps;
}
