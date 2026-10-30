// What a terminal's reading view must remember across its own mounts. Switching to the raw terminal and back unmounts
// the view, and a dialog that has no input box draws nothing to learn it from again, so neither fact may live in a
// component. Rendering only reads this; the view writes it from effects.
type Run = { session: string | null | undefined; thread: string | undefined; start: number | null | undefined; active: boolean };
type Ready = { session: string; thread: string | undefined; start: number | null | undefined };
const ready = new Map<string, Ready>(), dialogs = new Map<string, string>();

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

// A dialog the CLI is waiting on opens the terminal popup once, however often the view mounts or the screen redraws.
// True the first time this dialog is seen; endDialog forgets it once the CLI has moved on, so the next one opens again.
export function startDialog(id: string, dialog: string): boolean {
  if (dialogs.get(id) === dialog) return false;
  dialogs.set(id, dialog); return true;
}
export const endDialog = (id: string) => { dialogs.delete(id); };
