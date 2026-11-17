// What a terminal's reading view must remember across its own mounts. Switching to the raw terminal and back unmounts
// the view, and a dialog that has no input box draws nothing to learn it from again, so neither fact may live in a
// component. Rendering only reads this; the view writes it from effects.
type Run = { session: string | null | undefined; thread: string | undefined; start: number | null | undefined; active: boolean };
type Ready = { session: string; thread: string | undefined; start: number | null | undefined };
const ready = new Map<string, Ready>(), dialogs = new Map<string, { instance: string; dismissed: boolean }>();

// A dialog that disappears for less than this (a redraw frame) is still the same dialog.
export const DIALOG_SETTLE = 3000;

// Two values that are both known and differ: an unknown one (a thread the first turn has not bound yet) is no change.
function differ<T>(a: T | null | undefined, b: T | null | undefined) { return a != null && b != null && a !== b; }
// What was remembered, while it is still this run of this CLI: the same session, thread and start (the CLI can restart
// into the same session while the view is unmounted).
const kept = (id: string, run: Run) => {
  const known = ready.get(id);
  return known && run.active && known.session === run.session && !differ(known.thread, run.thread) && !differ(known.start, run.start) ? known : undefined;
};

// Whether this terminal's CLI has drawn its input in this run: from then on the screen is the live one rather than a
// restored history. Entries of closed terminals stay (a few short values each) until the id is seen again.
export const cliReady = (id: string, run: Run, inputShown: boolean) => (run.active && !!run.session && inputShown) || !!kept(id, run);

// Remembers (or forgets) readiness once the view has rendered it.
export function rememberReady(id: string, run: Run, inputShown: boolean) {
  const known = kept(id, run);
  if (run.active && run.session && inputShown) ready.set(id, { session: run.session, thread: run.thread ?? known?.thread, start: run.start ?? known?.start });
  else if (known) { known.thread ??= run.thread; known.start ??= run.start; }
  else ready.delete(id);
}

// Explicit dismissal belongs to the screen's prompt instance and survives remounts. An implicit close rearms only
// an open instance; endDialog forgets it once the CLI has moved on. Manual opening replaces an earlier dismissal.
export function startDialog(id: string, dialog: string, manual = false): boolean {
  if (!manual && dialogs.get(id)?.instance === dialog) return false;
  dialogs.set(id, { instance: dialog, dismissed: false }); return true;
}
export function dismissDialog(id: string, instance: string) { dialogs.set(id, { instance, dismissed: true }); }
// Losing the surface is not an owner's dismissal. A stale surface cannot rearm a newer prompt.
export function rearmDialog(id: string, instance: string) {
  const dialog = dialogs.get(id);
  if (dialog?.instance === instance && !dialog.dismissed) dialogs.delete(id);
}
export const endDialog = (id: string) => { dialogs.delete(id); };
