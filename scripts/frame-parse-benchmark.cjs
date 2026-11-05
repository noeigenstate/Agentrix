// Isolated process: measure the synchronous work done for one legal 64 MiB frame.
const { performance } = require('node:perf_hooks');
const { jsonFrames, MAX_FRAME } = require('../electron/oversized-record.cjs');
const frameBytes = Number(process.argv[2] || 64) * 1024 * 1024;
if (!Number.isSafeInteger(frameBytes) || frameBytes < 1024 * 1024 || frameBytes > MAX_FRAME) throw new RangeError('Use 1 to 64 MiB');
const results = [];
for (let sample = 0; sample < 5; sample++) {
  const prefix = '{"method":"item/completed","params":{"item":{"type":"imageGeneration","result":"';
  const suffix = '","savedPath":"/project/generated_images/run/image.png"}}}';
  const frame = Buffer.from(prefix + 'x'.repeat(frameBytes - Buffer.byteLength(prefix + suffix)) + suffix + '\n');
  let seen = false;
  const read = jsonFrames(message => { seen = !Object.hasOwn(message.params.item, 'result'); }, () => { throw Error('unexpected drop'); }, code => { throw Error(code); });
  const began = performance.now(); read(frame); results.push(performance.now() - began);
  if (!seen) throw Error('pixels retained');
}
console.log(JSON.stringify({ bytes: frameBytes, synchronousMs: results, maxMs: Math.max(...results) }, null, 2));
