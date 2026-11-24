import type { AgentSettings, Seat } from '../../shared/types';
import { sameModel } from '../../shared/lead-model.ts';
import type { LeadStep } from '../cli-screens/index.ts';
export { comparableModel } from '../../shared/lead-model.ts';
export type { LeadStep } from '../cli-screens/index.ts';

export type LeadSeat = Seat & { ultracode?: boolean };
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
