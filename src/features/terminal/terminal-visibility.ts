import type { ProjectTerminal } from '../../shared/types';

export function visibleTerminals(terminals: ProjectTerminal[], expanded: boolean) {
  return expanded ? terminals : terminals.filter(terminal => !!terminal.sessionId && (terminal.codexActive || terminal.agentStarting));
}

// The terminal in use: the one the reader picked, else the first.
export const terminalInUse = (terminals: ProjectTerminal[], pickedId: string | null) => terminals.find(terminal => terminal.id === pickedId) ?? terminals[0];
