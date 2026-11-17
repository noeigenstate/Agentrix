import type { AgentScreen } from '../agents/agent-screen-types';

// Hard wraps can split a token as well as move option text between label and detail. Ignore whitespace in both
// title and joined option text; context and footer rows stay outside identity. Approval stamps remain separate.
export function popupIdentity(screen: AgentScreen): string | null {
  const compact = (text: string) => text.replace(/\s+/g, '');
  const choice = screen.choice;
  if (choice) return JSON.stringify([choice.kind, compact(choice.title), choice.options.map(option => [option.number, option.role, option.role === 'input' ? null : compact(option.label + option.detail)])]);
  if (screen.waiting?.title) return JSON.stringify(['waiting', compact(screen.waiting.title)]);
  return screen.overlay !== 'none' ? JSON.stringify(['overlay', screen.overlay]) : null;
}
