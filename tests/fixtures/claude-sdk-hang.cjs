const { test } = require('node:test');
const { fixtureProcesses } = require('./claude-sdk-processes.cjs');

test('intentional silent fake provider is cancelled and reaped', { timeout: 300 }, async t => {
  const scope = fixtureProcesses(t, 'agx-hang-probe-');
  const child = scope.spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: ['pipe', 'pipe', 'pipe'] });
  console.log(`FIXTURE_PID=${child.pid}`);
  console.log(`FIXTURE_DIR=${scope.directory}`);
  await new Promise(() => {});
});
