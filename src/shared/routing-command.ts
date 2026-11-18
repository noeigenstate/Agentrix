import { modelName } from './model-name.ts';

export const OPEN_SEATS = 'agentrix:open-seats';
export type SeatsTarget = { projectId?: string; terminalId?: string };

export const isRoutingCommand = (words: string) => /^\/(?:model|effort|fast)(?:\s|$)/.test(words.trim());

export function openSeats(target: SeatsTarget) {
  window.dispatchEvent(new CustomEvent(OPEN_SEATS, { detail: target }));
}

export function routingRoleName(name: string, t: (key: string) => string) {
  const key = '席位 · ' + name;
  const label = t(key);
  return label === key ? t(name) : label;
}

export const routingModelName = (model: string) =>
  /^(opus|sonnet|haiku)$/.test(model) ? model[0].toUpperCase() + model.slice(1) : modelName(model);
