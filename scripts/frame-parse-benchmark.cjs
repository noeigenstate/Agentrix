// Isolated stress matrix through the product RPC transport. No provider or account is contacted.
const { performance } = require('node:perf_hooks');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createRpc, MAX_FRAME } = require('../electron/features/codex-app-server/rpc.cjs');
const requested = process.argv.slice(2).find(value => /^\d+$/.test(value));
const sizes = requested ? [Number(requested)] : [8, 16, 32, 64];
const kinds = process.argv.includes('--dense') ? ['dense'] : ['plain', 'escaped', 'image', 'mixed'];
function frame(mib, kind) {
  const bytes = mib * 1024 * 1024;
  if (!Number.isSafeInteger(bytes) || bytes < 1024 * 1024 || bytes > MAX_FRAME) throw Error('Use 1 to 64 MiB');
  let prefix = '{"method":"item/completed","params":{"item":{"id":"stress","type":"commandExecution","aggregatedOutput":"';
  let suffix = '"}}}';
  if (kind === 'escaped') prefix += '\\u001b[32m';
  if (kind === 'image') prefix = '{"method":"item/completed","params":{"item":{"id":"stress","type":"imageGeneration","result":"';
  if (kind === 'mixed') {
    const unit = '{"type":"agentMessage","text":"' + 'x'.repeat(150) + '"},';
    prefix = '{"method":"stress","params":{"items":[' + unit.repeat(Math.floor(bytes * 0.65 / unit.length))
      + '{"t\\u0079pe":"imageGeneration","result":"';
    suffix = '"}]}}';
  }
  if (kind === 'dense') {
    const unit = '{"x":1},';
    prefix = '{"method":"stress","params":{"items":[' + unit.repeat(Math.floor(bytes * 0.99 / unit.length)) + '{"t\\u0079pe":"imageGeneration","result":"';
    suffix = '"}]}}';
  }
  return Buffer.from(prefix + 'x'.repeat(bytes - Buffer.byteLength(prefix + suffix)) + suffix + '\n');
}
const results = [];
for (const mib of sizes) for (const kind of kinds) {
  const value = frame(mib, kind), times = [];
  for (let iteration = 0; iteration < 3; iteration++) {
    global.gc?.();
    const child = new EventEmitter(), notices = [], errors = [];
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new Writable({ write(_data, _encoding, done) { done(); } });
    const rpc = createRpc(child, { onNotification: (method, params) => { notices.push(method);
      if (params.item?.result || params.items?.at(-1)?.result) throw Error('image pixels retained');
    }, onDisconnect: code => errors.push(code), onDropped: () => errors.push('dropped') });
    const start = performance.now();
    child.stdout.write(value); child.stdout.write('{"method":"alive","params":{}}\n');
    times.push(performance.now() - start);
    if (errors.length || notices.at(-1) !== 'alive') throw Error(JSON.stringify({ mib, kind, errors, notices }));
    rpc.close(); child.stdout.destroy(); child.stderr.destroy();
  }
  results.push({ mib, kind, bytes: value.length - 1, synchronousMs: times, maxMs: Math.max(...times), disconnected: false });
}
console.log(JSON.stringify(results, null, 2));
