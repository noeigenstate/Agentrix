// What a terminal's reading view must remember across its own mounts. Switching to the raw terminal and back unmounts
// the view, and a dialog that has no input box draws nothing to learn it from again, so neither fact may live in a
// component.
type Ready = { session: string; thread: string | undefined };
const ready = new Map<string, Ready>(), opened = new Map<string, string>();

// Whether this terminal's CLI has drawn its input in this session (and thread): from then on the screen is the live one
// rather than a restored history. Readiness ends when the CLI stops, the session changes, or a different thread shows;
// a thread learned later (the first turn binds it) is not a change. Entries of closed terminals stay (two short strings
// each) until the id is seen again: a new run never shares their session.
export function cliReady(id: string, session: string | null | undefined, thread: string | undefined, active: boolean, inputShown: boolean): boolean {
  const known = ready.get(id);
  const kept = known && active && known.session === session && !(thread && known.thread && thread !== known.thread) ? known : undefined;
  if (active && session && inputShown) ready.set(id, { session, thread: thread ?? kept?.thread });
  else if (kept) kept.thread ??= thread;
  else ready.delete(id);
  return ready.has(id);
}

// A dialog the CLI is waiting on opens the terminal popup once, however often the view mounts or the screen redraws.
// True the first time this dialog is seen; endDialog forgets it once nothing waits any more, so the next one opens again.
export function startDialog(id: string, dialog: string): boolean {
  if (opened.get(id) === dialog) return false;
  opened.set(id, dialog); return true;
}
export const endDialog = (id: string) => { opened.delete(id); };
