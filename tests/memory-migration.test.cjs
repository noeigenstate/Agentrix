const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { teamAt, memoryExcerpt, recordFindings } = require('../electron/features/team/team.cjs');
const { WIRE_FIELDS } = require('../electron/features/agents/dispatch-events.cjs');

function project(t) {
  const common = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'memory-migration-')));
  t.after(() => fs.rmSync(common, { recursive: true, force: true }));
  return { common, team: teamAt(common, common, true) };
}

const rows = filename => fs.readFileSync(filename, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));

test('memory imports legacy Markdown once and keeps its exact original beside the rendered view', t => {
  const { common, team } = project(t);
  const original = '\uFEFFProject preface\r\n\r\n## Round 1 · Storage\r\n\r\n    Indented body\r\n\r\n# Nested title\r\nUncut body\r\n\r\n'
    + '### 2026-01-02 12:34 · First finding\r\n\r\n- Keep this.\r\n\r\n### 2026-01-03\r\n\r\n- Keep this too.\r\n';
  fs.writeFileSync(team.memory, original);
  assert.equal(fs.existsSync(team.memoryJsonl), false);
  const newest = team.context(null, null, { brief: 'Storage' })[0];
  const backup = path.join(team.directory, 'memory.legacy.md');
  assert.equal(fs.readFileSync(backup, 'utf8'), original);
  const records = rows(team.memoryJsonl);
  assert.deepEqual(records.map(row => row.title), ['', '## Round 1 · Storage', '### 2026-01-02 12:34 · First finding', '### 2026-01-03']);
  assert.equal(records[2].at, Date.UTC(2026, 0, 2, 12, 34));
  assert.ok(records[1].text.startsWith('    Indented body'));
  assert.match(newest, /Keep this too[\s\S]*First finding[\s\S]*Nested title[\s\S]*Uncut body/);
  assert.doesNotMatch(newest, /Project preface/);
  const rendered = fs.readFileSync(team.memory, 'utf8');
  assert.match(rendered, /Project preface[\s\S]*Nested title[\s\S]*Uncut body/);
  for (const row of records) {
    const { required, optional } = WIRE_FIELDS.memory['memory.entry'];
    assert.ok(required.every(key => Object.hasOwn(row, key)));
    assert.ok(Object.keys(row).every(key => [...required, ...optional].includes(key)));
  }
  fs.writeFileSync(team.memory, 'Projection edit only');
  assert.equal(teamAt(common, common).context(null, null, { brief: 'Storage' })[0], newest);
  assert.deepEqual(rows(team.memoryJsonl), records);
  assert.equal(fs.readFileSync(team.memory, 'utf8'), rendered);
  assert.equal(fs.readFileSync(backup, 'utf8'), original);
});

test('an interrupted Markdown render retries from the published JSONL without duplicating the import', t => {
  const { team } = project(t);
  const original = '## Round 1 · First\nFirst item.\n\n\n### 2026-01-03 · Second\nSecond item.\n';
  fs.writeFileSync(team.memory, original);
  const failure = new Error('test render interruption');
  const rename = t.mock.method(fs, 'renameSync', () => { throw failure; });
  assert.throws(() => team.context(null, null), error => error === failure);
  rename.mock.restore();
  assert.equal(fs.readFileSync(team.memory, 'utf8'), original);
  assert.equal(rows(team.memoryJsonl).length, 2);
  assert.match(team.context(null, null)[0], /Second item[\s\S]*First item/);
  assert.equal(rows(team.memoryJsonl).length, 2);
  assert.match(fs.readFileSync(team.memory, 'utf8'), /First item\.\n\n###/);
});

test('structured findings write to JSONL and the explicit ledger, with a 1.6.4 fallback for final text', async t => {
  const { team } = project(t), id = randomUUID(), ledger = path.join(team.directory, 'ledger.md');
  const options = { agent: 'codex', title: 'Task', role: 'build', ledger };
  const report = { id, header: 'Structured result', reason: 'exit', answer: '## Findings for the ledger\n\nPrefer the old answer.' };
  await team.finish(options, { ...report, findings: ['First line\n### 2026-01-03 · Part of a finding', 'Second finding'] });
  assert.equal(recordFindings({ memory: team.memory, ledger: team.memory }, [], 'Empty findings'), false);
  await team.finish(options, { ...report, findings: [], header: 'Completed with no findings' });
  await team.finish(options, { ...report, header: 'Legacy result' });
  assert.equal(recordFindings({ memory: team.memory, ledger: team.memory }, ['Write once.'], 'Same destination'), true);
  const records = rows(team.memoryJsonl), markdown = fs.readFileSync(team.memory, 'utf8'), taskLedger = fs.readFileSync(ledger, 'utf8');
  assert.deepEqual(records.map(row => row.source), ['findings', 'legacy-findings', 'findings']);
  assert.equal(records[0].runId, id);
  assert.equal(records[0].text, '- First line\n### 2026-01-03 · Part of a finding\n- Second finding');
  assert.doesNotMatch(records[0].text, /old answer/);
  assert.match(taskLedger, /Structured result[\s\S]*Second finding[\s\S]*Legacy result[\s\S]*Prefer the old answer/);
  assert.equal(markdown.split('Write once.').length, 2);
  assert.doesNotMatch(markdown, /Completed with no findings/);
});

test('a failed journal append retains earlier findings and one copy of the current run', async t => {
  const { team } = project(t), previous = randomUUID(), current = randomUUID();
  const ledger = path.join(team.directory, 'ledger.md');
  const options = { agent: 'codex', title: 'Task', role: 'build', ledger };
  await team.finish(options, { id: previous, header: 'Previous', findings: ['Previous finding'], reason: 'exit' });
  fs.writeFileSync(team.memory, '');
  const failure = new Error('journal append failed');
  t.mock.method(team, 'append', () => { throw failure; });
  const report = { id: current, header: 'Current', findings: ['Current finding'], reason: 'exit' };
  await assert.rejects(team.finish(options, report), error => error === failure);
  assert.deepEqual(rows(team.memoryJsonl).map(row => row.runId), [previous, current]);
  for (const file of [team.memory, ledger]) {
    assert.equal(fs.readFileSync(file, 'utf8').split('Current finding').length, 2);
  }
});

test('memory includes the newest two entries and matches older bodies within its byte budget', () => {
  const entry = (title, text) => ({ title, text });
  const records = [entry('Storage', 'src/a.js and the complete old finding.'), entry('Routing', '审核读取权限。'),
    entry('Transport', 'Uses sharedBinder. Blue packets.\n\n' + '汉字'.repeat(1200)), entry('Database', 'Other notes.'),
    entry('Quota', 'Other findings.'), entry('Progress', 'Other facts.')];
  const excerpt = memoryExcerpt(records, { brief: 'Review sharedBinder and src/a.js for 权限规则' });
  assert.ok(excerpt.startsWith('### Progress\n\nOther facts.\n\n### Quota\n\nOther findings.'));
  assert.match(excerpt, /Blue packets\.\n\n\[Entry truncated\]/);
  assert.match(excerpt, /审核读取权限/);
  assert.match(excerpt, /complete old finding/);
  assert.doesNotMatch(excerpt, /Database|汉字/);
  assert.ok(Buffer.byteLength(excerpt) <= 6 * 1024);
  const large = memoryExcerpt([...records, entry('Very recent', 'a'.repeat(9000)), entry('Latest', 'b'.repeat(9000))]);
  assert.match(large, /Latest[\s\S]*Entry truncated[\s\S]*Very recent[\s\S]*Entry truncated/);
});

test('an unknown memory version reports the channel and preserves the existing Markdown', t => {
  const { team } = project(t);
  const future = '{"v":8,"type":"memory.entry","at":0,"title":"Future","text":"New"}\n';
  fs.writeFileSync(team.memory, 'Preserve the last human view.\n');
  fs.writeFileSync(team.memoryJsonl, future);
  const error = { code: 'wire.unsupported_version', message: 'memory.jsonl: unsupported version 8' };
  assert.throws(() => team.context(null, null), error);
  assert.throws(() => recordFindings({ memory: team.memory }, ['Pending'], 'New entry'), error);
  assert.equal(fs.readFileSync(team.memoryJsonl, 'utf8'), future);
  assert.equal(fs.readFileSync(team.memory, 'utf8'), 'Preserve the last human view.\n');
});
