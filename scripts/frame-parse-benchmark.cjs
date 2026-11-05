// Isolated process: legal worst-shape frames, including many small history objects.
const { performance } = require('node:perf_hooks');
const { jsonFrames, MAX_FRAME } = require('../electron/oversized-record.cjs');
const bytes = Number(process.argv[2] || 64) * 1024 * 1024;
if (!Number.isSafeInteger(bytes) || bytes < 1024 * 1024 || bytes > MAX_FRAME) throw new RangeError('Use 1 to 64 MiB');
function frame(kind) {
  const unit = JSON.stringify({ id: 'item', type: 'agentMessage', text: 'x'.repeat(150) }) + ',';
  const image = kind === 'small-image' ? '"image":{"type":"imageGeneration","result":"pixels"},' : '';
  const prefix = kind === 'long-image' ? '{"item":{"type":"imageGeneration","result":"' : '{' + image + '"items":[';
  const suffix = kind === 'long-image' ? '"}}' : '{"padding":"' + '"}]}';
  const middle = kind === 'long-image' ? '' : unit.repeat(Math.floor((bytes - prefix.length - suffix.length) / unit.length));
  const before = kind === 'long-image' ? prefix : prefix + middle + '{"padding":"';
  const after = kind === 'long-image' ? suffix : '"}]}';
  return Buffer.from(before + 'x'.repeat(bytes - Buffer.byteLength(before + after)) + after + '\n');
}
const results = [];
for (const kind of ['long-image', 'small', 'small-image']) {
  const value = frame(kind), times = [];
  for (let n = 0; n < 3; n++) {
    const read = jsonFrames(message => {
      if (message.item?.result || message.image?.result) throw new Error('pixels retained');
    }, () => { throw new Error('unexpected drop'); }, code => { throw new Error(code); });
    const start = performance.now(); read(value); times.push(performance.now() - start);
  }
  results.push({ kind, bytes: value.length - 1, synchronousMs: times, maxMs: Math.max(...times) });
}
console.log(JSON.stringify(results, null, 2));
