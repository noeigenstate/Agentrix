import type { ScreenChoice } from '../agents/agent-screen-types';

export function selectedChoiceIndex(choice: ScreenChoice): number {
  return Math.max(0, choice.options.findIndex(option => option.selected));
}

// Use positions, not printed numbers: menus may start at a number other than one.
export function choiceKeys(selected: number, target: number): string[] {
  const distance = target - selected;
  return [...Array.from({ length: Math.abs(distance) }, () => distance > 0 ? '\x1b[B' : '\x1b[A'), '\r'];
}

// Everything the CLI drew for a choice except its cursor: it changes when an answer took effect.
export function choiceContent(choice: ScreenChoice): string {
  return JSON.stringify([choice.title, choice.options.map(({ number, label, detail, checked }) => [number, label, detail, checked]), choice.hint, choice.question]);
}

export async function writeChoiceKeys(selected: number, target: number, write: (key: string) => void, active: () => boolean = () => true) {
  return writeKeys(choiceKeys(selected, target), write, active);
}

export async function writeKeys(keys: readonly string[], write: (key: string) => void, active: () => boolean = () => true) {
  for (let index = 0; index < keys.length; index++) {
    if (!active()) return;
    write(keys[index]);
    if (index < keys.length - 1) await new Promise(resolve => setTimeout(resolve, 25));
  }
}
