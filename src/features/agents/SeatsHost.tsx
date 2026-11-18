import { lazy, Suspense, useEffect, useState } from 'react';
import type { SeatsInfo } from '../../shared/types';
import { OPEN_SEATS, type SeatsTarget } from '../../shared/routing-command.ts';

const SeatsDialog = lazy(() => import('./SeatsDialog').then(module => ({ default: module.SeatsDialog })));

export function SeatsHost() {
  const [dialog, setDialog] = useState<(SeatsTarget & { info: SeatsInfo; opener: HTMLElement | null; request: number }) | null>(null);
  useEffect(() => {
    let request = 0;
    const open = (event: Event) => {
      const { projectId, terminalId } = (event as CustomEvent<SeatsTarget>).detail ?? {};
      const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const mine = ++request;
      void window.agentrix?.skillSeats?.(projectId, terminalId).then(info => {
        if (request === mine && info) setDialog({ projectId, terminalId, info, opener, request: mine });
      }, () => {});
    };
    window.addEventListener(OPEN_SEATS, open);
    return () => { request++; window.removeEventListener(OPEN_SEATS, open); };
  }, []);

  return dialog && <Suspense fallback={null}><SeatsDialog key={dialog.request} info={dialog.info} projectId={dialog.projectId} terminalId={dialog.terminalId}
    onClose={() => { setDialog(null); dialog.opener?.focus(); }} /></Suspense>;
}
