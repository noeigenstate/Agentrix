import type { AgentScreen, ScreenChoice } from './agent-screen-types.ts';
export { parseAgentScreen } from '../cli-screens/index.ts';

// The one line a closed popup leaves as the waiting notice: the dialog's own heading. A terminal too short or narrow for
// the dialog scrolls the heading off, and the first row left is then the tail of a wrapped paragraph ("specify with
// --model."), which starts in lower case; no heading does. No title at all is better than that tail.
export function waitingTitle(screen: AgentScreen): string | null {
  const title = (screen.waiting ?? screen.choice)?.title ?? null;
  return title && !/^\p{Ll}/u.test(title) ? title : null;
}

// Display equivalence only: identical text is not a permission request identity.
// Cursor movement, ticks, typed answers and notes keep the dialog's identity so redraws do not reopen the popup.
// A new menu, question page or review has a new identity.
export function choiceIdentity(choice: ScreenChoice): string {
  const question = choice.question;
  if (question) return JSON.stringify([choice.kind, choice.title, choice.options.map(option => [option.number, option.role, option.role === 'input' ? null : option.label]), question.agent, question.tabs.map(tab => tab.label), question.position, question.multi, !!question.review]);
  return JSON.stringify([choice.kind, choice.title, choice.context, choice.options.map(({ number, label, detail, hotkey }) => [number, label, detail, hotkey]), choice.hint]);
}
