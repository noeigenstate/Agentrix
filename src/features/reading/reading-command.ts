const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Typed commands go straight to the visible CLI: what waits in its input is cleared first (Ctrl+U), then the command and
// Enter, each after a pause the CLI needs to take the keys. Every slash command, /resume included, is answered in the
// terminal popup the reading view opens for it.
export async function typeReadingCommand(text: string, write: (text: string) => void, active: () => boolean) {
  if (!active()) return false;
  write('\x15'); await pause(60);
  if (!active()) return false;
  write(text); await pause(150);
  if (!active()) return false;
  write('\r');
  return true;
}
