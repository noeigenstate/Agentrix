require('./fixtures/team-isolation.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { inputQueue } = require('../electron/features/claude-sdk/query.cjs');
const { harness, opening, textBlock, finish } = require('./fixtures/claude-real.cjs');
const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
const { findClaudeSession, listClaudeSessions } = require('../electron/claude-sessions.cjs');

test('real CLI history stays available through project aliases in the native runtime and history readers', {
  skip: !process.env.AGENTRIX_REAL_CLAUDE, timeout: 60000,
}, async t => {
  const requests = [];
  const f = await harness(t, data => { requests.push(data.messages); return [opening(data), ...textBlock(0, 'ALIAS_REPLY'), ...finish('end_turn')]; });
  const canonical = fs.realpathSync.native(f.cwd);
  let alias = f.cwd;
  const temporary = require('node:os').tmpdir(), realTemporary = fs.realpathSync.native(temporary);
  if (temporary !== realTemporary) {
    alias = path.join(temporary, path.relative(realTemporary, canonical));
    f.env.CLAUDE_CONFIG_DIR = path.join(temporary, path.relative(realTemporary, f.env.CLAUDE_CONFIG_DIR));
  }
  if (alias === canonical) {
    alias = path.join(path.dirname(f.cwd), 'project-alias');
    fs.symlinkSync(canonical, alias, process.platform === 'win32' ? 'junction' : 'dir');
  }
  assert.notEqual(alias, canonical);
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = f.env.CLAUDE_CONFIG_DIR;
  const runtime = createClaudeRuntime({ directory: path.join(f.env.CLAUDE_CONFIG_DIR, 'host'),
    loadSdk: async () => f.sdk, resolveExecutable: async () => process.env.AGENTRIX_REAL_CLAUDE,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  try {
    const clientId = randomUUID(), queue = inputQueue();
    const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    queue.push({ type: 'user', uuid: clientId, session_id: '', parent_tool_use_id: null, message: { role: 'user', content: [
      { type: 'text', text: 'ALIAS_OWNER_PROMPT' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } },
    ] } });
    const result = await f.run({}, async message => {
      if (message.type !== 'result') return;
      const real = await f.sdk.getSessionMessages(message.session_id, { dir: canonical });
      const unresolved = await f.sdk.getSessionMessages(message.session_id, { dir: alias });
      const unscoped = await f.sdk.getSessionMessages(message.session_id);
      const projects = fs.readdirSync(path.join(f.env.CLAUDE_CONFIG_DIR, 'projects'));
      const disk = projects.flatMap(folder => {
        const file = path.join(f.env.CLAUDE_CONFIG_DIR, 'projects', folder, message.session_id + '.jsonl');
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(line => {
          const row = JSON.parse(line); return { type: row.type, cwd: row.cwd, uuid: row.uuid };
        }).filter(row => ['user', 'assistant'].includes(row.type)) : [];
      });
      t.diagnostic(JSON.stringify({ alias, canonical, projects, canonicalMessages: real.length, aliasMessages: unresolved.length, unscopedMessages: unscoped.length, disk }));
      assert.ok(disk.some(row => row.type === 'assistant'), 'the transcript is already on disk before abort');
      assert.ok(unscoped.some(row => row.type === 'assistant'), 'the private-profile SDK decoder reads the existing file without a project filter');
    }, { cwd: alias }, queue);
    queue.close();
    await t.test('project history lists the owner session from the alias', async () => {
      assert.ok((await listClaudeSessions(alias, null, f.env.CLAUDE_CONFIG_DIR)).some(row => row.id === result.session_id));
    });
    await t.test('canonical project history includes the prior aliased session', async () => {
      assert.ok((await listClaudeSessions(canonical, null, f.env.CLAUDE_CONFIG_DIR)).some(row => row.id === result.session_id));
    });
    await t.test('strict transcript lookup resolves the same project identity', async () => {
      const found = await findClaudeSession(alias, result.session_id, f.env.CLAUDE_CONFIG_DIR, { strict: true });
      assert.ok(found);
      const canonicalFound = await findClaudeSession(canonical, result.session_id, f.env.CLAUDE_CONFIG_DIR, { strict: true });
      assert.ok(canonicalFound);
      assert.equal(fs.realpathSync.native(found), fs.realpathSync.native(canonicalFound));
    });
    await t.test('native resume replays history while keeping the caller project path', async () => {
      const events = []; runtime.credentials.save(f.env.ANTHROPIC_API_KEY);
      const spec = { owner: 'gui', cwd: alias, env: f.env, runtimeSessionId: 'alias-resume', providerSessionId: result.session_id };
      const session = runtime.create(spec, event => events.push(event));
      await session.resume(); await session.prepareResume();
      assert.equal(spec.cwd, alias);
      assert.ok(events.some(event => event.type === 'item.upsert' && event.payload.content?.text === 'ALIAS_OWNER_PROMPT'));
      assert.ok(events.some(event => event.type === 'item.upsert' && event.payload.content?.text === 'ALIAS_REPLY'));
      assert.ok(events.some(event => event.itemId === clientId && event.payload.content?.images?.[0] === `data:image/png;base64,${image}`));
      await session.send({ clientMessageId: randomUUID(), text: 'ALIAS_NEXT_PROMPT' });
      const deadline = Date.now() + 5000;
      while (!events.some(event => event.type === 'turn.completed') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(events.some(event => event.type === 'turn.completed'));
      assert.equal(requests.length, 2);
      assert.match(JSON.stringify(requests[1]), /ALIAS_OWNER_PROMPT/);
      assert.match(JSON.stringify(requests[1]), /ALIAS_NEXT_PROMPT/);
      await session.close();
    });
    await t.test('native resume from the canonical path keeps the legacy alias context', async () => {
      const events = [];
      const session = runtime.create({ owner: 'gui', cwd: canonical, env: f.env, runtimeSessionId: 'canonical-resume', providerSessionId: result.session_id }, event => events.push(event));
      await session.resume(); await session.prepareResume();
      assert.ok(events.some(event => event.itemId === clientId && event.payload.content?.images?.[0] === `data:image/png;base64,${image}`));
      await session.send({ clientMessageId: randomUUID(), text: 'CANONICAL_NEXT_PROMPT' });
      const deadline = Date.now() + 5000;
      while (!events.some(event => event.type === 'turn.completed') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(events.some(event => event.type === 'turn.completed'));
      assert.equal(requests.length, 3);
      assert.match(JSON.stringify(requests[2]), /ALIAS_OWNER_PROMPT/);
      assert.match(JSON.stringify(requests[2]), /ALIAS_NEXT_PROMPT/);
      assert.match(JSON.stringify(requests[2]), /CANONICAL_NEXT_PROMPT/);
      await session.close();
    });
  } finally {
    await runtime.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});
