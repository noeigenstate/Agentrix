import { lazy, Suspense, useEffect, useState } from 'react';
import type { SeatsInfo } from '../../shared/types';
import { OPEN_SEATS, type SeatsRequest, type SeatsTarget } from '../../shared/routing-command.ts';

const SeatsDialog = lazy(() => import('./SeatsDialog').then(module => ({ default: module.SeatsDialog })));

export function SeatsHost({ onError }: { onError: (message: string) => void }) {
  const [dialog, setDialog] = useState<(SeatsTarget & { info: SeatsInfo; opener: HTMLElement | null; request: number }) | null>(null);
  const [migration, setMigration] = useState<{ text: string; acknowledged?: boolean } | null>(null);
  const rememberMigration = (text: string) => setMigration(current => current?.text === text ? current : { text });
  useEffect(() => {
    let request = 0;
    const open = async (event: Event) => {
      const { projectId, terminalId, info } = (event as CustomEvent<SeatsRequest>).detail ?? {};
      const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const mine = ++request;
      const seats = info ?? await window.agentrix?.skillSeats?.(projectId, terminalId).catch(() => null);
      if (request === mine && seats) {
        if (seats.migrated) rememberMigration(seats.migrated);
        setDialog({ projectId, terminalId, info: seats, opener, request: mine });
      }
    };
    window.addEventListener(OPEN_SEATS, open);
    return () => { request++; window.removeEventListener(OPEN_SEATS, open); };
  }, []);

  return dialog && <Suspense fallback={null}><SeatsDialog key={dialog.request} info={dialog.info} projectId={dialog.projectId} terminalId={dialog.terminalId}
    migration={migration?.acknowledged ? undefined : migration?.text} onMigration={rememberMigration} onError={onError}
    onDismissMigration={() => setMigration(current => current && current.text === migration?.text ? { ...current, acknowledged: true } : current)}
    onClose={() => { setDialog(null); dialog.opener?.focus(); }} /></Suspense>;
}
