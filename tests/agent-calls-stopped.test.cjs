const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { UsageMeter } = require('../electron/features/agents/agent-usage.cjs');
const { TranscriptTail } = require('../electron/agent-actions.cjs');
const { HISTORY_WINDOW } = require('../electron/transcript-window.cjs');

for (const incremental of [false, true]) test(`stopped and retried Codex calls settle through bounded ${incremental ? 'startup and incremental tail' : 'startup history'}`, async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-stopped-'));
  const meter = new UsageMeter('claude', { codexHome: folder });
  meter.calls.setFolder(folder);
  t.after(async () => { meter.reset(); await fs.rm(folder, { recursive: true, force: true }); });
  const body = await fs.readFile(path.join(__dirname, 'fixtures/agent-calls-stopped.jsonl'), 'utf8');
  const records = body.trim().split('\n').map(line => JSON.parse(line.replaceAll('<home>', folder.replace(/\\/g, '/'))));
  const lines = records => records.map(record => JSON.stringify(record) + '\n').join('');
  await fs.writeFile(path.join(folder, 'brief.md'), '# Task W1: Implement metrics\nOnly edit parser.cjs. All other files are read-only.\nKeep user data read-only.');
  await fs.writeFile(path.join(folder, 'worker.log'), 'OpenAI Codex\nuser\nImplement metrics.\ncodex\nFinished.\ntokens used\n100\n');
  const filename = path.join(folder, 'session.jsonl');
  const padding = lines([{ type: 'file-history-snapshot', padding: 'x'.repeat(65536) }]);
  const prefix = padding.repeat(Math.ceil(HISTORY_WINDOW / Buffer.byteLength(padding)) + 1);
  const initial = incremental ? 2 : records.length;
  await fs.writeFile(filename, prefix + lines(records.slice(0, initial)));
  const history = [];
  let prefixRecords = 0;
  const tail = new TranscriptTail(filename, { onHistory: ready => { history.push(ready); if (!ready) meter.reset(); },
    onWorkRecord: () => prefixRecords++, onReset: partial => { meter.rates.partial = partial; } });
  const read = async () => {
    do { await tail.read(record => meter.apply(record)); } while (tail.historyPending || tail.offset < tail.fileSize);
    await meter.calls.work;
  };
  await read();
  assert.ok(prefixRecords > 0, 'main.cjs keeps prefix work records separate from display and usage');
  assert.deepEqual(history, [false, true]);
  if (incremental) {
    assert.equal(meter.calls.calls.get('first-launch').done, false);
    for (const [index, record] of records.slice(initial).entries()) {
      await fs.appendFile(filename, lines([record])); await read();
      if (index === 0) assert.equal(meter.calls.calls.get('first-launch').done, false, 'a stop request alone is not completion');
      if (index === 1) assert.equal(meter.calls.calls.get('first-launch').done, true, 'the successful TaskStop receipt ends its matching worker');
    }
  }
  assert.deepEqual(meter.snapshot().calls, [], 'neither the stopped attempt nor the completed retry stays running after Stop and compaction');
  for (const call of meter.calls.calls.values()) {
    assert.equal(call.done, true); assert.equal(call.reviewed, true);
    assert.equal(call.role, '执行', 'read-only restrictions on other files do not make an implementation task an investigation');
  }
  assert.equal(meter.calls.timer, null);
});
