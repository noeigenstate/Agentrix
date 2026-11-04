import type { ReactNode } from 'react';
import type { AgentCall, Project, ProjectTerminal } from '../../shared/types';
import { useActiveTerminal } from '../terminal/active-terminal';
import { terminalInUse, visibleTerminals } from '../terminal/terminal-visibility';
import { CallsCard } from './AgentCalls';

// How many of the called models' calls are running right now; the left bar shows it on its Agent tab and its collapsed icon.
export const runningCalls = (calls: readonly AgentCall[] | undefined) => (calls ?? []).reduce((sum, call) => sum + call.items.filter(item => item.state === 'running').length, 0);

// The terminal the activity pane follows: the one picked, else the first, of an expanded project.
export const terminalOf = (project: Project, pickedId: string | null): ProjectTerminal | undefined => terminalInUse(visibleTerminals(project.terminals, true), pickedId);

// Gives the left bar (the files module) the content of its Agent tab without it knowing anything of the agents module: the called models of the current
// terminal as a ready node, and how many are running. Opening a row's split goes through the same row buttons as before.
export function AgentSidebar({ project, children }: { project: Project; children: (agent: { panel: ReactNode; running: number }) => ReactNode }) {
  const terminal = terminalOf(project, useActiveTerminal(project.id));
  const calls = terminal?.agentUsage?.calls ?? [];
  return <>{children({ panel: <CallsCard calls={calls} terminalId={terminal?.id ?? ''} />, running: runningCalls(calls) })}</>;
}
