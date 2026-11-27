import { lazy, Suspense, useEffect, useState } from 'react';
import type { SeatsInfo } from '../../shared/types';
import { OPEN_SEATS, type SeatsRequest, type SeatsTarget } from '../../shared/routing-command.ts';

const SeatsDialog = lazy(() => import('./SeatsDialog').then(module => ({ default: module.SeatsDialog })));

export function SeatsHost({ onError }: { onError: (message: string) => void }) {
  const [dialog, setDialog] = useState<(SeatsTarget & { info: SeatsInfo; opener: HTMLElement | null; request: number }) | null>(null);
  useEffect(() => {
    let request = 0;
    const open = async (event: Event) => {
      const { projectId, terminalId, info } = (event as CustomEvent<SeatsRequest>).detail ?? {};
      const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const mine = ++request;
      const seats = info ?? await window.agentrix?.routingSeats?.(projectId, terminalId).catch(() => null);
      if (request === mine && seats) setDialog({ projectId, terminalId, info: seats, opener, request: mine });
    };
    window.addEventListener(OPEN_SEATS, open);
    return () => { request++; window.removeEventListener(OPEN_SEATS, open); };
  }, []);

  return dialog && <Suspense fallback={null}><SeatsDialog key={dialog.request} info={dialog.info} projectId={dialog.projectId} terminalId={dialog.terminalId}
    onError={onError}
    onClose={() => { setDialog(null); dialog.opener?.focus(); }} /></Suspense>;
}
