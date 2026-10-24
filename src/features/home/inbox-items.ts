import type { Project, ProjectTerminal } from '../../shared/types';
import type { Decision } from './decisions';

export type Group = 'decide' | 'working' | 'other';
export type InboxItem = { id: string; group: Group; project: Project; terminal: ProjectTerminal; decision?: Decision };

export const isWorking = (terminal: ProjectTerminal) => terminal.codexActive && terminal.codexActivity === 'working';

// What the inbox lists, by urgency: every decision (already in the order it matters), then the sessions with nothing
// to decide, the working ones first. A session that waits on a decision is listed by its decision only.
export function inboxItems(projects: readonly Project[], decisions: readonly Decision[]): InboxItem[] {
  const terminals = projects.flatMap(project => project.terminals.map(terminal => ({ project, terminal })));
  const waiting = new Set(decisions.map(decision => decision.terminalId));
  const decide = decisions.flatMap(decision => {
    const found = terminals.find(({ terminal }) => terminal.id === decision.terminalId);
    return found ? [{ id: decision.id, group: 'decide' as const, ...found, decision }] : [];
  });
  const sessions = terminals.filter(({ terminal }) => !waiting.has(terminal.id))
    .map(found => ({ id: `s:${found.terminal.id}`, group: isWorking(found.terminal) ? 'working' as const : 'other' as const, ...found }));
  return [...decide, ...sessions.filter(item => item.group === 'working'), ...sessions.filter(item => item.group === 'other')];
}

// The task a session was given, or the one it is on right now.
export const sessionTask = (terminal: ProjectTerminal) => (terminal.prompts || []).find(prompt => prompt.state === 'working')?.text || terminal.task;
