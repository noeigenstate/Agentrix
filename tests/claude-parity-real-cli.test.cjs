const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { harness, opening, textBlock, finish } = require('./fixtures/claude-real.cjs');
const skip = !process.env.AGENTRIX_REAL_CLAUDE;
const { fork } = require('node:child_process');
const { once } = require('node:events');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 300; i++) { if (check()) return; await sleep(50); }
  assert.fail('the isolated CLI did not reach the expected state');
}

function product(t, f, emit, changes = {}) {
  const { createClaudeRuntime } = require('../electron/features/claude-sdk/index.cjs');
  const runtime = createClaudeRuntime({ directory: path.join(f.cwd, 'runtime-state'), loadSdk: async () => f.sdk,
    resolveExecutable: async () => process.env.AGENTRIX_REAL_CLAUDE,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } });
  runtime.credentials.save(f.env.ANTHROPIC_API_KEY);
  f.cleanup(() => runtime.close());
  return runtime.create({ owner: 'gui', cwd: f.cwd, env: f.env, runtimeSessionId: 'real-parity', model: 'claude-sonnet-4-5', monthlyBudgetUsd: 10, ...changes }, emit);
}

async function terminal(t, f, args = [], capture = false) {
  const env = { ...f.env }; delete env.CI;
  fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true,
    lastOnboardingVersion: '2.1.318', theme: 'dark', customApiKeyResponses: { approved: [env.ANTHROPIC_API_KEY.slice(-20)], rejected: [] },
    projects: { [f.cwd.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }));
  const child = fork(path.join(__dirname, 'fixtures/claude-terminal-peer.cjs'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.resume(); const ended = once(child, 'exit');
  f.cleanup(async () => {
    if (child.exitCode === null && child.signalCode === null && child.connected) child.send({ type: 'stop' });
    // ConPTY's synchronous kill can stall its owned peer. Bound cleanup rather
    // than leaving a completed CLI test waiting forever in its after hook.
    const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
    try { await ended; } finally { clearTimeout(timer); }
  });
  let output = '';
  child.on('message', message => { if (message.type === 'data') output = (output + message.data).slice(-65536); });
  child.send({ type: 'start', cli: process.env.AGENTRIX_REAL_CLAUDE, cwd: f.cwd, env, args, capture });
  await new Promise(resolve => { const ready = message => { if (message.type === 'ready') { child.off('message', ready); resolve(); } }; child.on('message', ready); });
  return Object.assign((text, paste = false) => child.send({ type: 'input', text, paste }), { output: () => output, key: text => child.send({ type: 'key', text }) });
}

test('real streaming input shell handling is observed rather than guessed', { skip, timeout: 60000 }, async t => {
  const requests = [], messages = [];
  const f = await harness(t, data => { requests.push(data); return [opening(data), ...textBlock(0, 'ACK'), ...finish('end_turn')]; });
  await f.run({}, message => messages.push(message), {}, '!echo OFFLINE_SHELL_PARITY');
  const context = JSON.stringify(requests.map(request => request.messages));
  // This records the transport's actual behavior; the host shell adapter is admitted only after this probe.
  assert.match(context, /!echo OFFLINE_SHELL_PARITY/);
  assert.doesNotMatch(context, /<bash-stdout>OFFLINE_SHELL_PARITY/);
});

test('real worker context differs from GUI only by the admitted owner capability append', { skip, timeout: 60000 }, async t => {
  const requests = [];
  const f = await harness(t, data => { requests.push(data); return [opening(data), ...textBlock(0, 'ACK'), ...finish('end_turn')]; });
  await f.run({}, () => {}, { owner: 'dispatch' });
  await f.run({}, () => {}, { owner: 'gui' });
  require('./fixtures/claude-parity.cjs').compareSystem(requests[0].system, requests[1].system, { sdkOwner: 'dispatch', tuiOwner: 'gui' });
});

test('real CLI refuses SDK fast mode and the native setter cannot claim it enabled', { skip, timeout: 60000 }, async t => {
  const messages = [];
  const f = await harness(t, data => [opening(data), ...textBlock(0, 'ACK'), ...finish('end_turn')]);
  await f.run({}, message => messages.push(message), {}, '/fast on');
  assert.match(JSON.stringify(messages), /Fast mode is not available in the Agent SDK/);
  const session = product(t, f, () => {}); await session.start();
  await assert.rejects(session.runOptions({ fast: true }), /Claude Agent SDK 目前不支持快速模式/);
  assert.equal((await session.runOptions({})).fast, false);
});

test('worker policy deny dominates loaded project allow hooks and permissions', { skip, timeout: 60000 }, async t => {
  const requests = [];
  const f = await harness(t, data => { requests.push(data); return JSON.stringify(data.messages).includes('tool_result')
    ? [opening(data), ...textBlock(0, 'FINISHED'), ...finish('end_turn')]
    : [opening(data), { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_policy', name: 'Write', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: 'denied.txt', content: 'not allowed' }) } },
      { type: 'content_block_stop', index: 0 }, ...finish('tool_use')]; });
  fs.mkdirSync(path.join(f.cwd, '.claude'), { recursive: true });
  const hook = `node -e "require('fs').writeFileSync('hook-ran.txt',JSON.stringify({key:!!process.env.ANTHROPIC_API_KEY,token:!!process.env.ANTHROPIC_AUTH_TOKEN}));process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}}))"`;
  fs.writeFileSync(path.join(f.cwd, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Write'] },
    hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: hook }] }] } }));
  await f.run({}, () => {}, { owner: 'dispatch', allow: ['allowed.txt'] });
  assert.equal(fs.existsSync(path.join(f.cwd, 'denied.txt')), false, 'project allow must not override host deny');
  assert.equal(fs.existsSync(path.join(f.cwd, 'hook-ran.txt')), true, 'project settings really loaded');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.cwd, 'hook-ran.txt'), 'utf8')), { key: false, token: false }, 'worker hooks cannot inherit the saved key');
  const system = requests[0].system.map(block => block.text).join('\n');
  assert.ok(system.includes("You are Claude Code, Anthropic's official CLI for Claude."));
  assert.doesNotMatch(system, /suggest they type `! <command>`|The fork subagent runs in the background, so you can keep chatting/);
});

test('real host shell keeps keys out, preserves CLI context wrappers and renews acknowledged options', { skip, timeout: 60000 }, async t => {
  const requests = [], events = [];
  const f = await harness(t, data => { requests.push(data); return [opening(data), ...textBlock(0, 'ACK'), ...finish('end_turn')]; });
  const session = product(t, f, event => events.push(event)); await session.start();
  assert.equal((await session.runOptions({})).model, null);
  assert.equal(requests.length, 0);
  await assert.rejects(session.runOptions({ fast: true }), /Claude Agent SDK 目前不支持快速模式/);
  assert.equal((await session.runOptions({})).fast, false);
  const command = 'printf "SHELL_SAFE:%s:%s:%s" "${ANTHROPIC_API_KEY-unset}" "${ANTHROPIC_AUTH_TOKEN-unset}" "${OPENAI_API_KEY-unset}"';
  assert.deepEqual(await session.shell('shell-proof', command), { exitCode: 0 });
  assert.deepEqual(await session.shell('shell-proof', command), { exitCode: 0 });
  const shell = events.findLast(event => event.itemId === 'shell:shell-proof');
  assert.equal(shell.payload.kind, 'command'); assert.equal(shell.payload.content.output, 'SHELL_SAFE:unset:unset:unset');
  await until(() => session.snapshot().state === 'idle' && requests.length > 0);
  assert.equal(events.filter(event => event.type === 'turn.started' && event.payload.origin === 'user').length, 1);
  const catalog = await session.commands(['clear', 'reset', 'new', 'model', 'effort', 'fast'].map(name => ({ name, builtin: true, view: 'reading' })));
  for (const name of ['clear', 'reset', 'new', 'model', 'effort', 'fast']) assert.ok(catalog.some(row => row.name === '/' + name), name);
  await session.send({ clientMessageId: 'shell-owner', text: 'AFTER_SHELL' });
  await until(() => session.snapshot().state === 'idle' && requests.length > 1);
  assert.match(JSON.stringify(requests[0].messages), /<bash-stdout>SHELL_SAFE:unset:unset:unset<\/bash-stdout>/);
  const { promptText, rememberClaudeSource } = require('../electron/prompt-queue.cjs');
  await sleep(300);
  const records = [];
  function transcripts(folder) {
    for (const file of fs.readdirSync(folder, { withFileTypes: true })) {
      const filename = path.join(folder, file.name);
      if (file.isDirectory()) transcripts(filename);
      else if (file.name.endsWith('.jsonl')) for (const line of fs.readFileSync(filename, 'utf8').split('\n')) { try { records.push(JSON.parse(line)); } catch {} }
    }
  }
  transcripts(path.join(f.env.CLAUDE_CONFIG_DIR, 'projects'));
  const record = records.find(row => row.type === 'user' && JSON.stringify(row.message?.content).includes('AFTER_SHELL'));
  assert.ok(record); rememberClaudeSource(record.sessionId, 'gui');
  assert.equal(promptText(record.message.content, record).trim(), 'AFTER_SHELL');
  const options = await session.runOptions({ model: 'claude-opus-4-6', effort: 'low', fast: false });
  assert.match(options.model, /opus/); assert.equal(options.effort, 'low');
  await session.send({ clientMessageId: 'renewed-owner', text: 'RENEWED' });
  await until(() => session.snapshot().state === 'idle' && requests.length > 2);
  assert.match(requests.at(-1).model, /opus/);
  assert.equal(requests.at(-1).output_config?.effort, 'low');
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages.at(-1)), /SHELL_SAFE/);
  const models = await session.models();
  assert.ok(models.some(model => model.value === options.model), 'catalog values use the same resolved id as the observed model');
  const defaults = await session.runOptions({ model: null });
  assert.notEqual(defaults.model, options.model);
  await session.send({ clientMessageId: 'default-owner', text: 'DEFAULT_AGAIN' });
  await until(() => session.snapshot().state === 'idle' && requests.length > 3);
  assert.equal(requests.at(-1).model, defaults.model);
});

test('automatic compaction records real CLI thresholds and decision evidence offline', { skip, timeout: 60000 }, async t => {
  let requests = 0;
  const f = await harness(t, data => {
    const start = opening(data);
    start.message.usage.input_tokens = ++requests === 1 ? 195000 : 1;
    return [start, ...textBlock(0, 'SHORT_OFFLINE_REPLY'), ...finish('end_turn')];
  });
  // Count each fragment according to its size instead of claiming that each
  // individual tool definition costs 195k tokens (which only inflates /context).
  f.stats.countTokens = data => Math.ceil(JSON.stringify(data).length / 4);
  const { inputQueue } = require('../electron/features/claude-sdk/query.cjs');
  const queue = inputQueue(), debugFile = path.join(f.cwd, 'auto-debug.log'), options = f.options({ debug: true, debugFile });
  const query = f.sdk.query({ prompt: queue, options });
  const contexts = [], compactions = [], statuses = [];
  const send = text => queue.push({ type: 'user', uuid: require('node:crypto').randomUUID(), session_id: '', parent_tool_use_id: null, message: { role: 'user', content: text } });
  let rounds = 0; send('AUTO_FIRST\n' + 'token '.repeat(180000));
  try {
    for await (const record of query) {
      if (record.type === 'system' && record.subtype === 'compact_boundary') compactions.push(record.compact_metadata);
      if (record.type === 'system' && record.subtype === 'status') statuses.push(record.status);
      if (record.type !== 'result') continue;
      contexts.push(await query.getContextUsage());
      if (++rounds === 2) break;
      send('AUTO_SECOND');
    }
  } finally { queue.close(); options.abortController.abort(); query.close(); }
  await sleep(100);
  const debug = fs.readFileSync(debugFile, 'utf8').split('\n').filter(line => /autocompact|auto.compact|microcompact|threshold/i.test(line));
  const evidence = { sdk: { requests, countRequests: f.stats.countRequests || 0,
    contexts: contexts.map(({ totalTokens, autoCompactThreshold, isAutoCompactEnabled, apiUsage, messageBreakdown }) =>
      ({ totalTokens, autoCompactThreshold, isAutoCompactEnabled, apiUsage, messageBreakdown })), compactions, statuses, debug,
    debugTail: fs.readFileSync(debugFile, 'utf8').split('\n').slice(-30) } };
  requests = 0;
  const tuiDebug = path.join(f.cwd, 'tui-debug.log'), input = await terminal(t, f, ['--debug', '--debug-file', tuiDebug]);
  input('AUTO_FIRST');
  await until(() => requests >= 1); await sleep(1000);
  input('AUTO_SECOND'); await until(() => requests >= 2); await sleep(1000);
  const tuiLines = fs.readFileSync(tuiDebug, 'utf8').split('\n');
  evidence.tui = { requests, debug: tuiLines.filter(line => /autocompact|auto.compact|microcompact|threshold/i.test(line)), debugTail: tuiLines.slice(-30) };
  if (process.env.AGENTRIX_AUTO_EVIDENCE) fs.writeFileSync(process.env.AGENTRIX_AUTO_EVIDENCE, JSON.stringify(evidence, null, 2));
  assert.equal(rounds, 2); assert.equal(contexts.length, 2);
  // A stub's reported usage alone is not proof of compaction. Preserve the CLI's
  // decision inputs, including the token estimate it actually compared.
  assert.ok(contexts.every(context => context.isAutoCompactEnabled === true));
});

test('guide catalog difference persists without CI and never changes the CLI entrypoint', { skip, timeout: 60000 }, async t => {
  const catalogs = [];
  const f = await harness(t, data => [opening(data), ...textBlock(0, 'DONE'), ...finish('end_turn')]);
  for (const ci of [true, false]) {
    if (ci) f.env.CI = '1'; else delete f.env.CI;
    let catalog;
    await f.run({}, (message, query) => { if (message.type === 'system' && message.subtype === 'init') catalog = query.supportedAgents(); });
    catalogs.push((await catalog).map(row => row.name));
  }
  assert.deepEqual(catalogs[0], catalogs[1]);
  assert.equal(catalogs[0].includes('claude-code-guide'), false);
  let childStarted = false;
  const results = [], invocation = await harness(t, data => {
    const last = data.messages.at(-1)?.content;
    if (Array.isArray(last) && last.some(block => block.type === 'text' && block.text === 'GUIDE_CHILD')) {
      childStarted = true; return [opening(data), ...textBlock(0, 'GUIDE_DONE'), ...finish('end_turn')];
    }
    if (JSON.stringify(data.messages).includes('tool_result')) return [opening(data), ...textBlock(0, 'DONE'), ...finish('end_turn')];
    return [opening(data), { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_guide', name: 'Agent', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ subagent_type: 'claude-code-guide', prompt: 'GUIDE_CHILD', description: 'Offline guide availability' }) } },
      { type: 'content_block_stop', index: 0 }, ...finish('tool_use')];
  });
  await invocation.run({}, message => { if (message.type === 'user') results.push(...message.message.content); });
  assert.equal(childStarted, false);
  assert.ok(results.some(block => block.is_error && block.content.includes("Agent type 'claude-code-guide' not found")), 'the gap is execution capability, not only catalog wording');
});

test('real workers load project memory and skills from the same settings sources', { skip, timeout: 60000 }, async t => {
  const requests = [], f = await harness(t, data => { requests.push(data); return [opening(data), ...textBlock(0, 'DONE'), ...finish('end_turn')]; });
  fs.writeFileSync(path.join(f.cwd, 'CLAUDE.md'), 'WORKER_PROJECT_MEMORY\n');
  fs.mkdirSync(path.join(f.cwd, '.claude/skills/worker-proof'), { recursive: true });
  fs.writeFileSync(path.join(f.cwd, '.claude/skills/worker-proof/SKILL.md'), '---\nname: worker-proof\ndescription: WORKER_PROJECT_SKILL\n---\nWORKER_PROJECT_SKILL $ARGUMENTS\n');
  await f.run({}, () => {}, { owner: 'dispatch', allow: ['allowed.txt'] }, '/worker-proof FROM_WORKER');
  assert.match(JSON.stringify(requests), /WORKER_PROJECT_MEMORY/);
  assert.match(JSON.stringify(requests), /WORKER_PROJECT_SKILL/);
  assert.match(JSON.stringify(requests), /FROM_WORKER/);
});

test('real SDK fork returns the parent turn while its child is still running', { skip, timeout: 60000 }, async t => {
  let childStarted = false, childResponse, agents;
  const f = await harness(t, (data, response) => {
    const last = JSON.stringify(data.messages.at(-1));
    if ((data.messages.at(-1)?.content || []).some?.(block => block.type === 'text' && block.text.includes('FORK_CHILD') && !block.text.includes('FORK_PARENT'))) {
      childStarted = true; childResponse = response;
      const timer = setTimeout(() => response.end([...textBlock(0, 'CHILD_DONE'), ...finish('end_turn')].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')), 5000); timer.unref();
      return { events: [opening(data)], hold: true };
    }
    if (JSON.stringify(data.messages).includes('tool_result')) return [opening(data), ...textBlock(0, 'PARENT_DONE'), ...finish('end_turn')];
    return [opening(data), { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_fork', name: 'Agent', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ subagent_type: 'fork', prompt: 'FORK_CHILD', description: 'Offline fork', run_in_background: true }) } },
      { type: 'content_block_stop', index: 0 }, ...finish('tool_use')];
  });
  const observed = { childStarted: false, parentWhileChild: false, agents: [], toolResults: [] };
  try {
    await f.run({}, (message, query) => {
      if (message.type === 'system' && message.subtype === 'init') {
        // supportedAgents is the public CLI catalog, not a guess from the tool description.
        agents = query.supportedAgents().then(rows => { observed.agents = rows.map(row => row.name); });
      }
      if (message.type === 'user') observed.toolResults.push(message.message?.content);
      if (message.type === 'result') {
        observed.childStarted = childStarted;
        observed.parentWhileChild = childStarted && !childResponse.writableEnded;
      }
    }, {}, 'FORK_PARENT');
    await agents;
  } finally { childResponse?.end(); }
  if (process.env.AGENTRIX_FORK_EVIDENCE) fs.writeFileSync(process.env.AGENTRIX_FORK_EVIDENCE, JSON.stringify(observed, null, 2));
  assert.ok(observed.toolResults.flat().some(block => JSON.stringify(block.content).includes('Async agent launched successfully')), 'fork launched asynchronously');
  assert.equal(observed.parentWhileChild, true, 'the parent must return before the background child ends');

});

test('real terminal shell context and SDK request parity have an exact difference whitelist', { skip, timeout: 70000 }, async t => {
  const bodies = [], sdkAgents = [];
  const f = await harness(t, data => { bodies.push(data); return [opening(data), ...textBlock(0, 'PARITY_REPLY'), ...finish('end_turn')]; });
  fs.writeFileSync(path.join(f.cwd, 'CLAUDE.md'), 'PARITY_PROJECT_MEMORY\n');
  fs.mkdirSync(path.join(f.cwd, '.claude/skills/parity-skill'), { recursive: true });
  fs.writeFileSync(path.join(f.cwd, '.claude/skills/parity-skill/SKILL.md'), '---\nname: parity-skill\ndescription: PARITY_PROJECT_SKILL\n---\nPARITY_PROJECT_SKILL $ARGUMENTS\n');
  fs.mkdirSync(path.join(f.cwd, '.claude/agents'), { recursive: true });
  fs.writeFileSync(path.join(f.cwd, '.claude/agents/parity-project.md'), '---\nname: parity-project\ndescription: PARITY_PROJECT_AGENT\n---\nRead the project instructions.\n');
  let catalog;
  await f.run({}, (message, query) => {
    if (message.type === 'system' && message.subtype === 'init') catalog = query.supportedAgents().then(rows => sdkAgents.push(...rows.map(row => row.name)));
  }, {}, '/parity-skill PARITY_HELLO');
  await catalog;
  const sdk = bodies.find(body => body.tools?.length); bodies.length = 0;
  const input = await terminal(t, f);
  input('!printf SHELL_CONTEXT_PARITY'); await sleep(2500);
  input('/parity-skill PARITY_HELLO');
  for (let i = 0; i < 250 && !bodies.some(body => body.tools?.length && JSON.stringify(body.messages).includes('PARITY_HELLO')); i++) await sleep(100);
  const tui = bodies.find(body => body.tools?.length && JSON.stringify(body.messages).includes('PARITY_HELLO')); assert.ok(tui, 'terminal sent a request');
  if (process.env.AGENTRIX_PARITY_EVIDENCE) fs.writeFileSync(process.env.AGENTRIX_PARITY_EVIDENCE, JSON.stringify({sdkSystem:sdk.system,tuiSystem:tui.system,sdkTools:sdk.tools,tuiTools:tui.tools,tuiMessages:tui.messages,sdkAgents},null,2));
  for (const body of [sdk, tui]) {
    assert.match(JSON.stringify(body), /PARITY_PROJECT_MEMORY/); assert.match(JSON.stringify(body), /PARITY_PROJECT_SKILL/);
  }
  assert.deepEqual(sdk.tools.map(tool => tool.name), tui.tools.map(tool => tool.name));
  assert.ok(sdkAgents.includes('parity-project'));
  const inventory = tui.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).find(block => block.text?.includes('Available agent types for the Agent tool:'));
  assert.ok(inventory);
  const terminalAgents = [...inventory.text.matchAll(/^- ([\w-]+):/gm)].map(match => match[1]);
  assert.ok(terminalAgents.includes('claude-code-guide'));
  assert.deepEqual(sdkAgents, terminalAgents.filter(name => name !== 'claude-code-guide'));
  const { compareTools, compareSystem } = require('./fixtures/claude-parity.cjs');
  const version = compareSystem(sdk.system, tui.system);
  compareTools(sdk.tools, tui.tools, version);
  for (const key of ['model', 'thinking', 'context_management', 'max_tokens']) assert.deepEqual(sdk[key], tui[key], key);
  const terminalMessages = JSON.stringify(tui.messages);
  assert.match(terminalMessages, /<bash-input>printf SHELL_CONTEXT_PARITY<\/bash-input>/);
  assert.match(terminalMessages, /<bash-stdout>SHELL_CONTEXT_PARITY<\/bash-stdout>/);
  assert.match(terminalMessages, /<bash-stderr>[\s\S]*<\/bash-stderr>/);
});

test('S1 S2 real terminal and native shell have the same immediate independent request flow', { skip, timeout: 70000 }, async t => {
  const bodies = [], f = await harness(t, data => { bodies.push(data); return [opening(data), ...textBlock(0, 'FLOW_ACK'), ...finish('end_turn')]; });
  const input = await terminal(t, f, [], true);
  input('!printf REVIEW_FLOW');
  await until(() => bodies.some(body => body.tools?.length && JSON.stringify(body.messages).includes('REVIEW_FLOW')));
  const tui = bodies.find(body => body.tools?.length && JSON.stringify(body.messages).includes('REVIEW_FLOW'));
  const shellMessage = body => body.messages.find(message => message.role === 'user' && Array.isArray(message.content)
    && message.content.some(block => block.text?.startsWith('<bash-input>')));
  const expected = shellMessage(tui); assert.ok(expected, 'terminal shell request arrived before any next prompt');
  const terminalRecords = () => {
    const folder = path.join(f.env.CLAUDE_CONFIG_DIR, 'projects');
    return fs.readdirSync(folder, { recursive: true }).filter(name => String(name).endsWith('.jsonl')).flatMap(name =>
      fs.readFileSync(path.join(folder, name), 'utf8').trim().split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }));
  };
  await until(() => terminalRecords().some(record => record.type === 'assistant' && JSON.stringify(record.message?.content).includes('FLOW_ACK')));
  // The real request's two blocks are the record body handed to the product parser.
  const shellRecord = { type: 'user', message: expected };
  assert.equal(require('../electron/prompt-queue.cjs').promptText(shellRecord.message.content, shellRecord), null);
  const shellLog = new (require('../electron/conversation.cjs').ConversationLog)();
  require('../electron/conversation.cjs').claudeConversation(shellLog, shellRecord, f.cwd);
  assert.equal(shellLog.snapshot().some(item => item.role === 'user'), false);
  const terminalCompactStart = bodies.length;
  input('/compact');
  try { await until(() => terminalRecords().some(record => record.type === 'system' && record.subtype === 'compact_boundary' && record.compactMetadata?.trigger === 'manual')); }
  catch (error) { t.diagnostic(JSON.stringify({ screen: input.output(), records: terminalRecords().map(record => ({ type: record.type, subtype: record.subtype, compactMetadata: record.compactMetadata })) })); throw error; }
  assert.ok(!bodies.slice(terminalCompactStart).some(body => JSON.stringify(body.messages.at(-1)).includes('/compact')),
    'the terminal also compacts immediately after its independent shell round');
  const before = bodies.length, events = [];
  const session = product(t, f, event => events.push(event)); await session.start();
  await session.shell('flow', 'printf REVIEW_FLOW');
  await until(() => session.snapshot().state === 'idle' && bodies.length > before);
  const native = bodies.slice(before).find(body => body.tools?.length);
  await until(() => terminalRecords().some(record => record.type === 'user' && Array.isArray(record.message?.content)
    && record.message.content.some(block => block.text?.startsWith('<bash-input>'))));
  for (const record of terminalRecords().filter(record => record.type === 'user' && Array.isArray(record.message?.content)
    && record.message.content.some(block => block.text?.startsWith('<bash-input>')))) {
    assert.equal(require('../electron/prompt-queue.cjs').promptText(record.message.content, record), null, 'real SDK transcript never becomes an owner bubble');
    const log = new (require('../electron/conversation.cjs').ConversationLog)();
    require('../electron/conversation.cjs').claudeConversation(log, record, f.cwd);
    assert.equal(log.snapshot().some(item => item.role === 'user'), false);
  }
  const bash = message => message.content.filter(block => block.text?.startsWith('<bash-input>') || block.text?.startsWith('<bash-stdout>'))
    .map(block => ({ ...block, text: process.platform === 'win32'
      ? block.text.replace('\nShell cwd was reset to ' + f.cwd, '') : block.text }));
  // Exact whitelist: the terminal's Windows cwd bookkeeping line. No model input,
  // tool output, ordering, or user text is removed by this normalization.
  assert.deepEqual(bash(shellMessage(native)), bash(expected), 'same two adjacent blocks in a standalone shell round');
  for (const message of [expected, shellMessage(native)]) {
    const at = message.content.findIndex(block => block.text?.startsWith('<bash-input>'));
    assert.equal(message.content[at + 1].text.startsWith('<bash-stdout>'), true);
    assert.ok(message.content.filter((_, i) => i !== at && i !== at + 1).every(block => block.text?.startsWith('<system-reminder>')),
      'only CLI-generated system reminders may share the independent shell message');
  }
  const prior = bodies.length;
  await session.send({ clientMessageId: 'context', text: '/context' }); await sleep(1000);
  assert.equal(bodies.length, prior, 'local slash command still executes locally after shell');
  await session.send({ clientMessageId: 'compact', text: '/compact' });
  await until(() => session.snapshot().state === 'idle');
  assert.ok(events.some(event => event.type === 'context.compacted' && event.payload.trigger === 'manual'));
  assert.equal(events.findLast(event => event.type === 'turn.completed').payload.status, 'completed');
  assert.ok(!bodies.slice(prior).some(body => body.messages.at(-1)?.content?.some?.(block => block.text === '/compact')),
    'compact is never sent as literal user text');
  assert.ok(events.filter(event => event.type === 'turn.started' && event.payload.origin === 'user').length >= 1);
});

test('B4 real project hook may rewrite a model-allowed input outside the worker scope', { skip, timeout: 60000 }, async t => {
  let outside;
  const f = await harness(t, data => JSON.stringify(data.messages).includes('tool_result')
    ? [opening(data), ...textBlock(0, 'DONE'), ...finish('end_turn')]
    : [opening(data), { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_trusted_hook', name: 'Write', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: path.join(f.cwd, 'allowed.txt'), content: 'TRUSTED_HOOK' }) } },
      { type: 'content_block_stop', index: 0 }, ...finish('tool_use')]);
  outside = path.join(path.dirname(f.cwd), 'hook-written.txt');
  const hookFile = path.join(f.cwd, 'hook.cjs');
  fs.writeFileSync(hookFile, 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",updatedInput:{file_path:' + JSON.stringify(outside) + ',content:"TRUSTED_HOOK"}}}));');
  fs.mkdirSync(path.join(f.cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(f.cwd, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write',
    hooks: [{ type: 'command', command: 'node hook.cjs' }] }] } }));
  await f.run({}, () => {}, { owner: 'dispatch', allow: ['allowed.txt'] });
  assert.equal(fs.existsSync(path.join(f.cwd, 'allowed.txt')), false);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'TRUSTED_HOOK');
});

test('S4 real normal resume preserves the transcript model', { skip, timeout: 60000 }, async t => {
  const bodies = [], f = await harness(t, data => { bodies.push(data); return [opening(data), ...textBlock(0, 'MODEL_ACK'), ...finish('end_turn')]; });
  const first = await f.run({ model: 'claude-opus-4-6' });
  const session = product(t, f, () => {}, { model: null, providerSessionId: first.session_id });
  await session.resume(); await session.send({ clientMessageId: 'resumed-model', text: 'RESUMED_MODEL' });
  await until(() => session.snapshot().state === 'idle' && bodies.length > 1);
  assert.equal(bodies.at(-1).model, bodies[0].model);
});

test('S5 real CLI user key precedence is observed and product refuses that billing conflict', { skip, timeout: 60000 }, async t => {
  const f = await harness(t, data => [opening(data), ...textBlock(0, 'KEY_ACK'), ...finish('end_turn')]);
  const abort = new AbortController(), options = f.options({}, abort);
  fs.writeFileSync(path.join(f.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-ant-offline-conflicting-not-a-real-key' } }));
  try {
    const query = f.sdk.query({ prompt: 'Observe fixture key precedence', options });
    for await (const message of query) if (message.type === 'result') break;
  } finally { abort.abort(); }
  assert.equal(f.stats.keys.at(-1), 'sk-ant-offline-conflicting-not-a-real-key');
  const count = f.stats.keys.length;
  await assert.rejects(f.run(), /用户设置不能覆盖应用保存的 API 密钥/);
  assert.equal(f.stats.keys.length, count, 'conflict rejected before network input');
});


test('N7 real terminal and native background processes survive a later model interrupt', { skip, timeout: 60000 }, async t => {
  const bodies = [], f = await harness(t, data => { bodies.push(data); return { events: [opening(data), ...textBlock(0, 'WAITING')], hold: true }; });
  const input = await terminal(t, f, [], true);
  input('!(sleep 7; printf alive > tui-background-proof) & echo TUI_BACKGROUND');
  await until(() => bodies.some(body => body.tools?.length && JSON.stringify(body.messages).includes('TUI_BACKGROUND')));
  input.key('\x1b');
  const events = [], session = product(t, f, event => events.push(event)); await session.start();
  await session.shell('background', '(sleep 7; printf alive > native-background-proof) & echo NATIVE_BACKGROUND');
  await until(() => bodies.some(body => body.tools?.length && JSON.stringify(body.messages).includes('NATIVE_BACKGROUND')));
  await session.interrupt();
  await until(() => fs.existsSync(path.join(f.cwd, 'tui-background-proof')) && fs.existsSync(path.join(f.cwd, 'native-background-proof')));
  for (const name of ['tui', 'native']) assert.equal(fs.readFileSync(path.join(f.cwd, name + '-background-proof'), 'utf8'), 'alive');
  t.diagnostic('real terminal Escape and native interrupt both retain the already-returned background job');
});
