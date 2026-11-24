import type { AgentSettings, Seat } from '../../shared/types';
import { modelName } from '../../shared/model-name.ts';

export type LeadSeat = Seat & { ultracode?: boolean };
export type LeadStep =
  | { kind: 'model'; target: string }
  | { kind: 'effort'; target: string; ultracode?: boolean }
  | { kind: 'fast'; target: boolean; model: string };

export const comparableModel = (model: string) => modelName(model.trim().replace(/\s*(?:\[1m\]|\(1m\))$/i, '')).toLowerCase();

export const sameModel = (chosen: string, actual: string) => {
  const a = comparableModel(chosen), b = comparableModel(actual);
  const family = /^(opus|sonnet|haiku|fable)$/;
  return a === b || family.test(a) && b.startsWith(a + ' ') || family.test(b) && a.startsWith(b + ' ');
};

// What to type so the running lead matches the seat; empty when it already does or what it runs is not known yet.
export function leadSteps(seat: LeadSeat | null | undefined, actual: AgentSettings | null | undefined, skipFast = false): LeadStep[] {
  if (!seat || !actual?.model) return [];
  const steps: LeadStep[] = [];
  const changeModel = !sameModel(seat.model, actual.model);
  if (changeModel) steps.push({ kind: 'model', target: seat.model });
  const effort = seat.effort && (changeModel || actual.effort !== seat.effort) ? seat.effort : '';
  const ultracode = seat.ultracode === true, changeUltra = ultracode !== (actual.ultracode === true);
  if (effort || changeUltra || changeModel && ultracode) {
    steps.push({ kind: 'effort', target: effort, ...((changeUltra || ultracode) ? { ultracode } : {}) });
  }
  const fast = seat.fast === true;
  if (!skipFast && typeof actual.fast === 'boolean' && actual.fast !== fast) steps.push({ kind: 'fast', target: fast, model: seat.model });
  return steps;
}
