const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Typed commands go straight to the visible CLI: what waits in its input is cleared first (Ctrl+U), then the command and
// Enter, each after a pause the CLI needs to take the keys. Every slash command, /resume included, is answered in the
// terminal popup the reading view opens for it.
export async function typeReadingCommand(text: string, write: (text: string) => void, active: () => boolean, ready = () => true) {
  // A write may transiently hide input while xterm parses it. Wait for readiness,
  // but never survive a dialog, popup close or session change that cancels ownership.
  const settled = async () => {
    for (let attempt = 0; active() && attempt <= 50; attempt++) {
      if (ready()) return true;
      await pause(20);
    }
    return false;
  };
  if (!active() || !ready()) return false;
  write('\x15'); await pause(60);
  if (!(await settled()) || !active()) return false;
  write(text); await pause(150);
  if (!(await settled()) || !active()) return false;
  write('\r');
  return true;
}
