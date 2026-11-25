import type { Decision } from './features/home/decisions';

export function openDecisionTerminal(
  decision: Decision, focusProject: (id: string) => Promise<boolean>, setReading: (id: string, reading: boolean) => void,
  focusTerminal: (id: string) => void, nextFrame: (callback: FrameRequestCallback) => void,
) {
  void focusProject(decision.projectId).then(accepted => {
    if (!accepted || (decision.kind !== 'approval' && decision.choice?.kind !== 'permission')) return;
    setReading(decision.terminalId, false);
    nextFrame(() => focusTerminal(decision.terminalId));
  });
}
