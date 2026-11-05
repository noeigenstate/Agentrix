import { useEffect, useState } from 'react';
import type { AgentCommand } from '../../shared/types';
import { nativeBridge } from './native-bridge.ts';

// The commands this session runs without a terminal, for the "/" list. Read once when the owner starts a command (`wanted`) and again when the
// session's state changes (a command may only be there once the session is ready). A read that fails, a main without the call or a window without
// the bridge leave what was known (nothing at first): the owner is never stopped while typing.
export function useNativeCommands(terminalId: string, sessionId: string, wanted: boolean, state: string | undefined): AgentCommand[] {
  const [commands, setCommands] = useState<AgentCommand[]>([]);
  useEffect(() => {
    if (!wanted) return;
    let active = true;
    void Promise.resolve().then(() => nativeBridge()?.commands?.(terminalId, sessionId)).then(result => { if (active && result?.ok && Array.isArray(result.value)) setCommands(result.value); }).catch(() => {});
    return () => { active = false; };
  }, [terminalId, sessionId, wanted, state]);
  return commands;
}
