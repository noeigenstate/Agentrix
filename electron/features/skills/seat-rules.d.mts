type Family = 'claude' | 'codex';

export const BASE_EFFORTS: Record<Family, string[]>;
export const EFFORT: RegExp;
export function validModel(model: unknown): model is string;
export function familyOf(model: string): Family;
export function rankByName(model: string): 1 | 2 | 3;
export function unsupportedEffort(family: Family): string;
