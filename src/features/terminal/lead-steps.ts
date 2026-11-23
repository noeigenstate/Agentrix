import type { AgentSettings, Seat } from '../../shared/types';
import { modelName } from '../../shared/model-name.ts';

// The two Claude Code pickers that can apply a routing change to the running session.
export type LeadStep = { kind: 'model' | 'effort'; target: string };

const comparableModel = (model: string) => modelName(model.trim().replace(/\s*(?:\[1m\]|\(1m\))$/i, '')).toLowerCase();

export const sameModel = (chosen: string, actual: string) => {
  const a = comparableModel(chosen), b = comparableModel(actual);
  const family = /^(opus|sonnet|haiku|fable)$/;
  return a === b || family.test(a) && b.startsWith(a + ' ') || family.test(b) && a.startsWith(b + ' ');
};

// What to type so the running lead matches the seat; empty when it already does or what it runs is not known yet.
export function leadSteps(seat: Seat | null | undefined, actual: AgentSettings | null | undefined): LeadStep[] {
  if (!seat || !actual?.model) return [];
  const steps: LeadStep[] = [];
  const changeModel = !sameModel(seat.model, actual.model);
  if (changeModel) steps.push({ kind: 'model', target: seat.model });
  if (seat.effort && (changeModel || actual.effort !== seat.effort)) steps.push({ kind: 'effort', target: seat.effort });
  return steps;
}
