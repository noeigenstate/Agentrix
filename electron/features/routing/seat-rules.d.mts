import type { AgentProvider } from '../../../src/shared/agent-events';

export { adapterOfModel, agentOfModel } from '../cli-adapters/registry.mjs';

export const EFFORT: RegExp;
export function validModel(model: unknown): model is string;
export function allowsUltracode(model: string, isLead: boolean): boolean;
export function rankByName(model: string): 1 | 2 | 3;
export function unsupportedEffort(family: AgentProvider): string;
