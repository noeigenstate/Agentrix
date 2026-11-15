// Synthetic CLI used only through the dispatch helper; edits are made by the worker process.
// Stand-in contract (tests/fake-cli-contract.test.cjs): --version answers at once and writes nothing; AGENTRIX_STAND_IN_ECHO names the file that gets the arguments, --settings and hooks it was given.
if (process.env.AGENTRIX_STAND_IN_ECHO) require('./stand-in-echo.cjs')();
if (process.argv.includes('--version')) { console.log('2.1.317 (Claude Code)'); process.exit(0); }
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
async function main() {
  const config = JSON.parse(fs.readFileSync(process.env.DISPATCH_SCOPE_FIXTURE, 'utf8'));
  for await (const _ of process.stdin) { /* Drain the helper's brief. */ }
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: config.sessionId, model: 'synthetic-model', effort: 'high' }));
  const wait = async file => {
    for (const end = Date.now() + 15000; !fs.existsSync(file);) {
      if (Date.now() > end) throw new Error('Synthetic worker gate timed out');
      await delay(10);
    }
  };
  await wait(config.writeGate);
  for (const [file, text] of config.writes) {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  }
  fs.writeFileSync(config.written, 'done');
  console.log(JSON.stringify({ type: 'result', session_id: config.sessionId, result: 'Synthetic answer' }));
  await wait(config.release);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
