import type { AgentScreen } from '../agents/agent-screen-types';

// Option text can move between label and detail when xterm reflows. Join it before normalizing; context and footer
// rows stay outside popup identity. Approval stamps retain their stricter, separate identity in terminal-screen.
export function popupIdentity(screen: AgentScreen): string | null {
  const words = (text: string) => text.trim().replace(/\s+/g, ' ');
  const choice = screen.choice;
  if (choice) return JSON.stringify([choice.kind, words(choice.title), choice.options.map(option => [option.number, option.role, option.role === 'input' ? null : words(option.label + ' ' + option.detail)])]);
  if (screen.waiting?.title) return JSON.stringify(['waiting', words(screen.waiting.title)]);
  return screen.overlay !== 'none' ? JSON.stringify(['overlay', screen.overlay]) : null;
}
