// Long answers are parsed in a worker, one at a time. A parse that takes too long is stopped (the worker is replaced)
// and its text shows as plain text instead of freezing the window. Results are kept for texts seen recently, so a
// conversation shown again is not parsed again.
const TIMEOUT = 2000, KEPT = 300;
type Job = { id: number; text: string; softBreaks: boolean; done: (html: string | null) => void };
let worker: Worker | null = null, running: (Job & { timer: ReturnType<typeof setTimeout> }) | null = null, sequence = 0;
const queue: Job[] = [];
const results = new Map<string, string | null>();

const cacheKey = (text: string, softBreaks: boolean) => `${softBreaks ? 's' : 'h'}${text}`;
function remember(text: string, softBreaks: boolean, html: string | null) {
  const key = cacheKey(text, softBreaks);
  results.delete(key); results.set(key, html);
  if (results.size > KEPT) results.delete(results.keys().next().value!);
}
function start() {
  if (running || !queue.length) return;
  const job = queue.shift()!;
  worker ??= new Worker(new URL('./markdown.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<{ id: number; html: string | null }>) => {
    if (!running || event.data.id !== running.id) return;
    const done = running; clearTimeout(done.timer); running = null;
    remember(done.text, done.softBreaks, event.data.html); done.done(event.data.html); start();
  };
  running = { ...job, timer: setTimeout(() => {
    const stuck = running!; running = null;
    worker?.terminate(); worker = null;
    remember(stuck.text, stuck.softBreaks, null); stuck.done(null); start();
  }, TIMEOUT) };
  worker.postMessage({ id: job.id, text: job.text, softBreaks: job.softBreaks });
}

// The HTML marked makes of text (not yet sanitized), or null when it could not be made in time.
export function parseMarkdown(text: string, softBreaks = false): Promise<string | null> {
  const key = cacheKey(text, softBreaks);
  if (results.has(key)) { const html = results.get(key)!; remember(text, softBreaks, html); return Promise.resolve(html); }
  return new Promise(done => { queue.push({ id: ++sequence, text, softBreaks, done }); start(); });
}
export const parsedMarkdown = (text: string, softBreaks = false) => results.get(cacheKey(text, softBreaks));
