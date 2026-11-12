import type { CliState, ProjectTerminal } from '../../shared/types.ts';
import type { AgentScreen, ScreenAgent } from '../agents/agent-screen-types.ts';
import { cliStateFor, type CliFrame } from '../agents/agent-screen-state.ts';
export { validCliState, nextCliState } from '../agents/agent-screen-state.ts';
export type { CliState } from '../../shared/types.ts';

// accepting: the CLI takes a message as its terminal would, busy or not, while no dialog or menu owns the keys. Unlike
// canDeliver it ignores a frame xterm is still parsing (Claude Code's busy output keeps one parsing most of the time):
// the send waits for a parsed frame before it writes. Keys that act at once (Shift+Tab, Esc) still need canDeliver.
export function readingState(agent: ScreenAgent, rows: string[], screen: AgentScreen, terminal: ProjectTerminal, signal?: CliState | null, frame?: CliFrame | null) {
  const state = cliStateFor(agent, frame ?? { rows }, terminal, signal, screen);
  return { ...state, accepting: state.input && !state.waiting };
}
