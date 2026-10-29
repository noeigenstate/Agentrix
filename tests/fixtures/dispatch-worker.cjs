// A real child process standing in for either CLI. All input/output stays in the test's temporary directory.
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

async function main() {
  const fixture = JSON.parse(fs.readFileSync(process.env.DISPATCH_FIXTURE, 'utf8'));
  let brief = '';
  for await (const chunk of process.stdin) brief += chunk;
  fs.writeFileSync(process.env.DISPATCH_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), brief, pid: process.pid }));
  for (const entry of fixture.lines || []) {
    if (entry.delay) await delay(entry.delay);
    // A worker editing its project: the scope check compares these with --allow.
    if (entry.write) { fs.mkdirSync(path.dirname(path.resolve(entry.write)), { recursive: true }); fs.writeFileSync(path.resolve(entry.write), entry.text || ''); continue; }
    if (entry.rollout || entry.rolloutRaw) {
      const folder = path.join(process.env.CODEX_HOME, 'sessions/2026/01/01');
      fs.mkdirSync(folder, { recursive: true });
      fs.appendFileSync(path.join(folder, `rollout-fixture-${entry.rolloutSession || fixture.sessionId}.jsonl`),
        entry.rolloutRaw || JSON.stringify(entry.rollout) + '\n');
      continue;
    }
    const stream = entry.stderr ? process.stderr : process.stdout;
    stream.write(typeof entry.raw === 'string' ? entry.raw : JSON.stringify(entry.record) + '\n');
  }
  // Stays until the test has seen the helper's start line (bounded, so a broken helper cannot hang the test run).
  for (const end = Date.now() + 60000; fixture.release && !fs.existsSync(fixture.release) && Date.now() < end;) await delay(10);
  if (fixture.hold) await delay(fixture.hold);
  process.exitCode = fixture.exitCode || 0;
}
main().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
