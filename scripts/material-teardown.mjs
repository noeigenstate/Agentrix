import { execFileSync } from 'node:child_process';
import { timeoutScale } from './wait.mjs';

export async function closeMaterialApp(app, timeout = 15000 * timeoutScale) {
  const child = app.process();
  let timer;
  try {
    // Playwright waits for Electron to exit without a close deadline of its own.
    await Promise.race([
      app.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Material teardown timed out after ${timeout}ms (Electron PID ${child.pid})`)), timeout);
      }),
    ]);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        // Only the child launched with this smoke's isolated profile and its descendants.
        if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 * timeoutScale, stdio: 'pipe' });
        else child.kill('SIGKILL');
      } catch (cause) { error.cause ??= cause; }
    }
    throw error;
  } finally { clearTimeout(timer); }
}
