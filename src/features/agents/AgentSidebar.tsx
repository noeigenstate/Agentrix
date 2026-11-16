import type { ReactNode } from 'react';
import type { Project } from '../../shared/types';
import { CallsCard } from './AgentCalls';
import { callSources, countBackground, countRunning } from './subagent-splits.ts';

// Gives the left bar (the files module) the content of its Agent tab without it knowing anything of the agents module: the called models of every terminal of the project as a ready
// node (a terminal picked in the grid changes nothing here), how many are running (a starting worker counts), and how many background commands run. Opening a row's split goes
// through the same row buttons as before, with the terminal the row belongs to.
export function AgentSidebar({ project, children }: { project: Project; children: (agent: { panel: ReactNode; running: number; background: number }) => ReactNode }) {
  const terminals = project.terminals;
  return <>{children({ panel: <CallsCard calls={[]} terminalId={terminals[0]?.id ?? ''} terminals={terminals} />, running: countRunning(callSources(terminals)), background: countBackground(terminals) })}</>;
}
