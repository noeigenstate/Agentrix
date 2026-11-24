import type { CliScreen } from '../../src/features/cli-screens/index.ts';

const prompt = 'example> ';
export const screen: CliScreen = {
  input: rows => {
    const row = rows.findLast(value => value.startsWith(prompt));
    return row ? { text: row.slice(prompt.length) } : null;
  },
  working: rows => rows.includes('Working…'),
  atPrompt: rows => rows.some(row => row.startsWith(prompt)),
};
