import type { CliState, ProjectTerminal } from '../../shared/types.ts';
import type { AgentScreen, ScreenAgent } from '../agents/agent-screen-types.ts';
import { cliStateFor, type CliFrame } from '../agents/agent-screen-state.ts';
export { validCliState, nextCliState } from '../agents/agent-screen-state.ts';
export type { CliState } from '../../shared/types.ts';

export function readingState(agent: ScreenAgent, rows: string[], screen: AgentScreen, terminal: ProjectTerminal, signal?: CliState | null, frame?: CliFrame | null) {
  return cliStateFor(agent, frame ?? { rows }, terminal, signal, screen);
}
