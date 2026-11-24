import { modelName } from './model-name.ts';

export const comparableModel = (model: string) => modelName(model.trim().replace(/\s*(?:\[1m\]|\(1m\))$/i, '')).toLowerCase();

export const sameModel = (chosen: string, actual: string) => {
  const a = comparableModel(chosen), b = comparableModel(actual);
  const family = /^(opus|sonnet|haiku|fable)$/;
  return a === b || family.test(a) && b.startsWith(a + ' ') || family.test(b) && a.startsWith(b + ' ');
};
