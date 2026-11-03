// Bounded lifetimes for synthetic peers only. Track close before any await: a signal exit
// leaves exitCode null, and subscribing to exit after it fired can wait forever.
const { test: nodeTest } = require('node:test');
const scale = Math.max(1, Number(process.env.AGENTRIX_TEST_TIMEOUT_SCALE) || 1);
const TEST_TIMEOUT = 15000 * scale, CLEANUP_TIMEOUT = 2500 * scale;

function test(name, options, body) {
  if (typeof options === 'function') { body = options; options = {}; }
  return nodeTest(name, { timeout: TEST_TIMEOUT, ...options }, body);
}
function deadline(promise, label, timeout = CLEANUP_TIMEOUT) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${label} (${timeout} ms)`)), timeout);
  })]).finally(() => clearTimeout(timer));
}
function resources(t, label = t.name) {
  const children = [], cleanup = [];
  const kill = () => {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  t.signal.addEventListener('abort', kill, { once: true });
  t.after(async () => {
    const errors = [];
    try {
      for (const [name, action] of cleanup.reverse()) {
        try { await deadline(Promise.resolve().then(action), `${label}: ${name}`); } catch (error) { errors.push(error); }
      }
      kill();
      for (const { child, closed } of children) {
        try { await deadline(closed, `${label}: peer pid=${child.pid} exit=${child.exitCode} signal=${child.signalCode}`); }
        catch (error) {
          child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); errors.push(error);
        }
      }
    } finally { t.signal.removeEventListener('abort', kill); }
    if (errors.length) throw new AggregateError(errors, `Synthetic resource cleanup failed: ${label}: ${errors.map(error => error.message).join('; ')}`);
  });
  return {
    child(child) {
      const closed = new Promise(resolve => child.once('close', resolve));
      children.push({ child, closed }); return child;
    },
    defer: (name, action) => cleanup.push([name, action]),
    wait: (promise, name) => deadline(promise, `${label}: ${name}`),
  };
}
module.exports = { test, resources, deadline, TEST_TIMEOUT };
