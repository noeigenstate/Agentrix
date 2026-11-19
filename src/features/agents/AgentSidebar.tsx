import type { ReactNode } from 'react';
import type { Project } from '../../shared/types';
import { useActiveTerminal } from '../terminal/active-terminal';
import { terminalInUse } from '../terminal/terminal-visibility.ts';
import { CallsCard } from './AgentCalls';
import { MainModelGroup } from './MainModel';
import { callSources, countBackground, countRunning } from './subagent-splits.ts';

// The lead follows the selected terminal. Worker and background rows still span the whole project.
export function AgentSidebar({ project, children }: { project: Project; children: (agent: { panel: ReactNode; running: number; background: number }) => ReactNode }) {
  const terminals = project.terminals;
  const panel = <>
    <MainModelGroup terminal={terminalInUse(terminals, useActiveTerminal(project.id))} />
    <CallsCard calls={[]} terminalId={terminals[0]?.id ?? ''} terminals={terminals} />
  </>;
  return <>{children({ panel, running: countRunning(callSources(terminals)), background: countBackground(terminals) })}</>;
}
