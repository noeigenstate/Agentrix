// One native GUI check at a time across workers (AGENTS.md): wrap each Electron launch, or a whole run of suites, in withGuiLock.
// The lock is a file created exclusively under .test-output; a long run keeps it fresh, and one untouched for 20 minutes was left by a crashed run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const output = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.test-output');
const LOCK = path.join(output, 'gui-probe.lock');
const STALE = 20 * 60 * 1000;

export async function withGuiLock(owner, run) {
  fs.mkdirSync(output, { recursive: true });
  for (;;) {
    try { fs.writeFileSync(LOCK, `${owner} ${new Date().toISOString()}\n`, { flag: 'wx' }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs > STALE) { fs.unlinkSync(LOCK); continue; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  const fresh = setInterval(() => { try { const now = new Date(); fs.utimesSync(LOCK, now, now); } catch {} }, 60_000);
  try { return await run(); } finally { clearInterval(fresh); try { fs.unlinkSync(LOCK); } catch {} }
}
