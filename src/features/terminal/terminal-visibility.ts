import type { ProjectTerminal } from '../../shared/types';

export function visibleTerminals(terminals: ProjectTerminal[], expanded: boolean) {
  return expanded ? terminals : terminals.filter(terminal => !!terminal.sessionId && (terminal.codexActive || terminal.agentStarting));
}
