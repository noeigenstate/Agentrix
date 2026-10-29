// A real child process standing in for either CLI. All input/output stays in the test's temporary directory.
const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');

async function main() {
  const fixture = JSON.parse(fs.readFileSync(process.env.DISPATCH_FIXTURE, 'utf8'));
  let brief = '';
  for await (const chunk of process.stdin) brief += chunk;
  fs.writeFileSync(process.env.DISPATCH_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), brief, pid: process.pid }));
  for (const entry of fixture.lines || []) {
    if (entry.delay) await delay(entry.delay);
    const stream = entry.stderr ? process.stderr : process.stdout;
    stream.write(typeof entry.raw === 'string' ? entry.raw : JSON.stringify(entry.record) + '\n');
  }
  if (fixture.hold) await delay(fixture.hold);
  process.exitCode = fixture.exitCode || 0;
}
main().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
