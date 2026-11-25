import type { AgentScreen, ScreenChoice } from './agent-screen-types.ts';
export { parseAgentScreen } from '../cli-screens/index.ts';

export function waitingTitle(screen: AgentScreen): string | null {
  return screen.waiting ? screen.waiting.title : screen.waitingHeadingClipped ? null : screen.choice?.title ?? null;
}

// Display equivalence only: identical text is not a permission request identity.
// Cursor movement, ticks, typed answers and notes keep the dialog's identity so redraws do not reopen the popup.
// A new menu, question page or review has a new identity.
export function choiceIdentity(choice: ScreenChoice): string {
  const question = choice.question;
  if (question) return JSON.stringify([choice.kind, choice.title, choice.options.map(option => [option.number, option.role, option.role === 'input' ? null : option.label]), question.agent, question.tabs.map(tab => tab.label), question.position, question.multi, !!question.review]);
  return JSON.stringify([choice.kind, choice.title, choice.context, choice.options.map(({ number, label, detail, hotkey }) => [number, label, detail, hotkey]), choice.hint]);
}
