require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { harness, opening, textBlock, finish } = require('./fixtures/claude-real.cjs');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
// The evidence of a run is too large for a diagnostic line. It is kept in the OS temp directory and the run says where: nothing is written into the
// checkout, and a clean one has no folder for it.
const evidence = (t, name) => { const file = path.join(os.tmpdir(), name); t.diagnostic(`evidence: ${file}`); return file; };

for (const [version, variable] of [['2.1.317', 'AGENTRIX_REAL_CLAUDE'], ['2.1.318', 'AGENTRIX_REAL_CLAUDE_318']]) {
  for (const mode of ['default', 'window', 'setting-window', 'pct', 'pct-control', 'disabled-setting', 'disabled-env', 'disabled-compact', 'reactive', 'failure']) test(`real Claude ${version} auto compact ${mode}`, {
    skip: !process.env[variable] && `set ${variable}`, timeout: 45000,
  }, async t => {
    const requests = [], events = [], contexts = [], raw = []; let main = 0, compact = 0, query;
    const f = await harness(t, data => {
      const summary = JSON.stringify(data.messages.at(-1)).includes('Your task is to create a detailed summary');
      requests.push({ summary, model: data.model, last: JSON.stringify(data.messages.at(-1)).slice(0, 400), max: data.max_tokens });
      if (summary) compact++; else main++;
      if (['reactive', 'failure'].includes(mode) && !summary && main === 2) return { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' } } };
      if (mode === 'failure' && summary) return { status: 403, body: { type: 'error', error: { type: 'permission_error', message: 'offline compact failure' } } };
      const low = summary || compact, first = opening(data);
      first.message.usage = { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      const ending = finish('end_turn'); ending[0].usage.output_tokens = low ? 1 : mode === 'default' ? 195000 : mode.startsWith('pct') ? 50000 : 80000;
      return [first, ...textBlock(0, summary ? '<analysis>Offline fixture.</analysis><summary>OFFLINE_COMPACT_SUMMARY</summary>' : low ? 'OFFLINE_MAIN_REPLY' : 'Offline history. '.repeat(15000)), ...ending];
    });
    const binary = process.env[variable], v = spawnSync(binary, ['--version'], { env: f.env, encoding: 'utf8' });
    assert.equal(v.status, 0); assert.ok(v.stdout.startsWith(version), v.stdout);
    f.env.AGENTRIX_DATA_DIR = path.join(f.cwd, 'profile');
    if (['window', 'pct', 'pct-control', 'disabled-setting', 'disabled-env', 'disabled-compact'].includes(mode)) f.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '100000';
    if (mode === 'disabled-env') f.env.DISABLE_AUTO_COMPACT = '1';
    if (mode === 'disabled-compact') f.env.DISABLE_COMPACT = '1';
    if (mode === 'pct') f.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '50';
    f.env.CLAUDE_CODE_DEBUG_LOG_FILE = path.join(f.cwd, 'compact-debug.log');
    f.env.DEBUG = '1';
    if (mode === 'disabled-setting') fs.writeFileSync(path.join(f.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ autoCompactEnabled: false }));
    if (mode === 'setting-window') fs.writeFileSync(path.join(f.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ autoCompactWindow: 100000 }));
    const runtime = createClaudeRuntime({ directory: path.join(f.cwd, 'state'), resolveExecutable: async () => binary,
      loadSdk: async () => ({ ...f.sdk, query(value) {
        query = f.sdk.query({ ...value, options: { ...value.options, debug: true, debugFile: f.env.CLAUDE_CODE_DEBUG_LOG_FILE } });
        const iterate = query[Symbol.asyncIterator].bind(query);
        query[Symbol.asyncIterator] = async function* () { for await (const message of { [Symbol.asyncIterator]: iterate }) {
          if (mode === 'failure' && message.type !== 'stream_event') raw.push({ ...message, message: message.message ? { ...message.message, content: JSON.stringify(message.message.content).slice(0, 600) } : undefined });
          yield message;
        } }; return query;
      } }),
      safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
    f.cleanup(() => runtime.close()); runtime.credentials.save(f.env.ANTHROPIC_API_KEY);
    const session = runtime.create({ owner: 'gui', cwd: f.cwd, env: f.env, projectId: 'p', terminalId: 't', runtimeSessionId: randomUUID(), model: 'claude-sonnet-4-5' }, event => events.push(event));
    const wait = async count => { for (let i = 0; i < 1500; i++) { if (events.filter(row => row.type === 'turn.completed').length >= count) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail(JSON.stringify({ requests, events: events.slice(-5) })); };
    await session.start(); await session.send({ clientMessageId: 'one', text: 'Offline first turn' }); await wait(1);
    contexts.push(await query.getContextUsage());
    await session.send({ clientMessageId: 'two', text: 'Offline second turn' }); await wait(2);
    contexts.push(await query.getContextUsage());
    if (mode !== 'failure') { await session.send({ clientMessageId: 'three', text: 'Offline third turn' }); await wait(3); contexts.push(await query.getContextUsage()); }
    const boundaries = events.filter(row => row.type === 'context.compacted');
    if (fs.existsSync(f.env.CLAUDE_CODE_DEBUG_LOG_FILE)) fs.copyFileSync(f.env.CLAUDE_CODE_DEBUG_LOG_FILE, evidence(t, `agx-autocompact-claude-debug-${version}-${mode}.log`));
    t.diagnostic(JSON.stringify({ mode, compact, requests, contexts: contexts.map(row => ({ totalTokens: row.totalTokens, autoCompactThreshold: row.autoCompactThreshold, isAutoCompactEnabled: row.isAutoCompactEnabled })), boundaries }));
    const expected = ['window', 'setting-window', 'pct', 'reactive'].includes(mode);
    if (mode === 'failure') {
      fs.writeFileSync(evidence(t, `agx-autocompact-claude-failure-raw-${version}.json`), JSON.stringify({ raw, visible: events.filter(row => ['error', 'turn.completed', 'context.compacting', 'context.compacted'].includes(row.type)) }, null, 2));
      assert.equal(compact, 1);
      assert.match(events.map(row => row.payload.message || row.payload.content?.text || row.payload.error || '').join('\n'), /offline compact failure/);
      const count = requests.length; await new Promise(resolve => setTimeout(resolve, 200)); assert.equal(requests.length, count, 'failure never starts a host retry loop');
    } else assert.equal(compact, expected ? 1 : 0);
    assert.equal(boundaries.length, expected ? 1 : 0);
    if (expected) { assert.equal(boundaries[0].payload.trigger, 'auto'); assert.ok(events.some(row => row.type === 'context.compacting' && row.payload.active)); }
    if (['disabled-setting', 'disabled-env', 'disabled-compact'].includes(mode)) assert.equal(contexts[0].isAutoCompactEnabled, false);
    if (mode === 'window') assert.equal(contexts[0].autoCompactThreshold, 67000);
    // The context UI reports the nominal 67k threshold even with the override.
    // The paired 50k fixture proves the engine uses 40k only with pct=50.
    if (mode.startsWith('pct')) assert.equal(contexts[0].autoCompactThreshold, 67000);
    if (mode !== 'failure') { await session.send({ clientMessageId: 'four', text: 'Offline fourth turn' }); await wait(4); assert.equal(compact, expected ? 1 : 0, 'the CLI compact is not repeated by the host'); }
    fs.writeFileSync(evidence(t, `agx-autocompact-claude-${version}-${mode}.json`), JSON.stringify({ version, mode, requests, contexts, boundaries }, null, 2));
  });
}
