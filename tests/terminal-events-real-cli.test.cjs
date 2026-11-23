// The hook channel against the real Claude Code terminal UI, offline (skill real-cli-verification): a throwaway profile, a fake key, a
// local stub for the model and a local hook receiver. A fake CLI only proves what we assumed, so what the plan claims about
// order, proxies and a missing Agentrix is shown here with the CLI that ships. Order is judged by the sequence the test process
// sees (hook, screen, model request, key), never by a time bound; the times go to terminal-events-latency.json for the lab.
// Runs in CI only: AGENTRIX_REAL_CLAUDE=<path to claude> node --test tests/terminal-events-real-cli.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { allow, hooked, normalize, plainAnswer, playTurn, startMcpProbe, submit, opening, textBlock, finish } = require('./fixtures/claude-hooks-real.cjs');
const { commandPhrase } = require('../electron/command-phrase.cjs');
const { READ_TOOLS, EDIT_TOOLS } = require('../electron/features/claude-runtime/decide.cjs');

const skip = !process.env.AGENTRIX_REAL_CLAUDE && 'set AGENTRIX_REAL_CLAUDE';
// A turn whose Bash command the CLI must ask about: it writes a file (a bare `echo` runs without asking, so no dialog and no
// PermissionRequest would come). Each prompt asks once, so only the newest message tells whether its tool has run.
const callTool = (data, name, input, id = `toolu_${randomUUID().replaceAll('-', '')}`) =>
  [opening(data), { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 0 }, ...finish('tool_use')];
const askingTool = data => JSON.stringify(data.messages.at(-1)?.content).includes('tool_result')
  ? [opening(data), ...textBlock(0, 'DONE'), ...finish('end_turn')]
  : callTool(data, 'Bash', { command: 'echo probe > hook-probe.txt', description: 'Write a probe file' });
const answer = data => JSON.stringify(data.messages.at(-1)?.content).includes('HOOK_TOOL') || JSON.stringify(data.messages.at(-1)?.content).includes('tool_result')
  ? askingTool(data) : plainAnswer(data);
const hookEvents = session => session.observer.timeline.filter(entry => entry.type === 'hook').map(entry => entry.event);

test('UserPromptSubmit arrives before the screen shows working, PermissionRequest before the dialog, Stop before idle', { skip, timeout: 240000 }, async t => {
  await hooked(t, 'http', { respond: answer, drive: async session => {
    const { observer } = session;
    // A plain turn: the prompt is reported before the screen says the CLI is working, and the end of the turn before it is idle again.
    const first = await submit(session, 'HOOK_PROMPT first');
    const prompt = await observer.hook('UserPromptSubmit', first.n), working = await observer.screen('working', first.n);
    assert.ok(prompt.n < working.n, 'UserPromptSubmit reaches Agentrix before the screen shows working');
    const stop = await observer.hook('Stop', first.n), idle = await observer.screen('idle', working.n);
    assert.ok(stop.n < idle.n, 'Stop reaches Agentrix before the screen is idle again');
    // A turn that asks for permission: the request is reported before the dialog is on the screen. The owner answers it here, as the CLI asks.
    const second = await submit(session, 'HOOK_TOOL second');
    const request = await observer.hook('PermissionRequest', second.n), dialog = await observer.screen('dialog', second.n);
    assert.ok(request.n < dialog.n, 'PermissionRequest reaches Agentrix before the dialog is on the screen');
    await allow(session, dialog.n);
    await observer.hook('Stop', second.n);
  } });
});

test('with HTTP_PROXY and no loopback NO_PROXY entry command hooks still report every turn and the proxy sees no hook, while http hooks go through it', { skip, timeout: 240000 }, async t => {
  const { startProxy, toReceiver } = require('./fixtures/claude-hooks-real.cjs');
  // Under a proxy the wrapper keeps command hooks (the channel rule, tested in terminal-hook-channel.test.cjs): they report directly, so the proxy carries no hook.
  const aside = await startProxy(t);
  const command = await hooked(t, 'command', { proxy: aside, respond: plainAnswer, drive: session => playTurn(session) });
  assert.deepEqual(hookEvents(command).filter(event => ['UserPromptSubmit', 'Stop'].includes(event)), ['UserPromptSubmit', 'Stop'], 'the turn is still reported');
  assert.ok(aside.requests.some(url => url.includes('/v1/messages')), 'the proxy is in use: it carried the model request');
  assert.deepEqual(aside.requests.filter(entry => toReceiver(entry, command.receiver)), [], 'no hook went through the proxy');
  // The same session over HTTP goes through the proxy, which is why the channel rule falls back: the control that shows the check can see a hook.
  const through = await startProxy(t);
  const control = await hooked(t, 'http', { proxy: through, respond: plainAnswer, drive: session => playTurn(session) });
  assert.ok(through.requests.some(entry => toReceiver(entry, control.receiver)), 'http hooks reach the proxy when HTTP_PROXY is set and NO_PROXY has no loopback entry');
});

test('with Agentrix gone the CLI keeps working and the model context is unchanged', { skip, timeout: 240000 }, async t => {
  const baseline = await hooked(t, 'none', { respond: plainAnswer, drive: session => playTurn(session) });
  // The http settings point at a server that has been shut down: every hook is refused, and the turn must still finish.
  const gone = await hooked(t, 'gone', { respond: plainAnswer, drive: session => playTurn(session) });
  assert.deepEqual(hookEvents(gone), [], 'nothing was there to hear a hook');
  assert.ok(baseline.body && gone.body, 'both sessions sent the prompt to the model');
  assert.equal(normalize(gone.body, gone.f), normalize(baseline.body, baseline.f), 'the model request is byte-identical to the one with no hooks');
});

const toolId = name => `toolu_${name.toLowerCase()}`;
const toolResult = (body, name) => {
  const message = body.messages.findLast(message => message.role === 'user');
  return Array.isArray(message?.content) && message.content.find(block => block.type === 'tool_result' && block.tool_use_id === toolId(name));
};
const toolNames = body => (body.tools || []).map(tool => tool.name).filter(Boolean).sort();
const requestsFor = (session, prompt) => session.bodies.filter(body => JSON.stringify(body.messages).includes(prompt));
const dialogShown = entry => entry.type === 'screen' && ['dialog', 'plan'].includes(entry.name);
const ownerWait = entry => entry.type === 'hook' && entry.event === 'Notification' && entry.payload?.notification_type === 'permission_prompt';

async function roleTurn(t, session, prompt, inspect) {
  const { observer } = session;
  try {
    const enter = await submit(session, prompt);
    // Claude can draw the writable Bash menu while its synchronous command hook runs.
    const blocked = entry => ownerWait(entry) || session.role.readOnly && dialogShown(entry);
    const end = await observer.when(entry => blocked(entry) || entry.type === 'hook' && ['Stop', 'StopFailure'].includes(entry.event),
      enter.n, 'role Stop or an owner dialog');
    assert.equal(end.event, 'Stop', observer.seen());
    const drawn = await observer.when(entry => blocked(entry) || entry.type === 'screen' && entry.name === 'answer', enter.n, 'role answer');
    assert.equal(drawn.name, 'answer', observer.seen());
    const turn = observer.timeline.filter(entry => entry.n > enter.n && entry.n <= Math.max(end.n, drawn.n));
    assert.ok(!turn.some(blocked), observer.seen());
    assert.equal(turn.filter(entry => entry.type === 'hook' && entry.event === 'UserPromptSubmit').length, 1, 'one submitted turn');
    inspect(requestsFor(session, prompt), turn);
  } catch (error) {
    t.diagnostic(observer.seen());
    t.diagnostic(JSON.stringify(requestsFor(session, prompt).map(body => ({
      tools: toolNames(body),
      results: ['Bash', 'Write', 'ExitPlanMode'].map(name => toolResult(body, name)).filter(Boolean),
    }))));
    throw error;
  }
}

test('a real writable role continues the same turn after the worker permission hook denies Bash', { skip, timeout: 240000 }, async t => {
  const prompt = 'HOOK_PROMPT writable role', command = 'node --test tests/x.test.cjs';
  await hooked(t, 'worker', { role: { readOnly: false },
    respond: data => toolResult(data, 'Bash') ? plainAnswer(data)
      : callTool(data, 'Bash', { command, description: 'Run the probe test' }, toolId('Bash')),
    drive: session => roleTurn(t, session, prompt, (requests, turn) => {
      const result = requests[1] && toolResult(requests[1], 'Bash');
      const refusal = turn.find(entry => entry.event === 'PermissionRequest' && entry.payload?.workerRefused);
      t.diagnostic(JSON.stringify({ requests: requests.length, result, workerRefused: refusal?.payload.workerRefused,
        dialogDrawn: turn.some(dialogShown), screen: 'HOOK_ACK', stop: true }));
      assert.equal(requests.length, 2);
      assert.equal(result?.is_error, true);
      assert.match(JSON.stringify(result.content), /This action is not allowed in this role/);
      assert.equal(refusal?.payload.workerRefused, `Bash: ${commandPhrase(command).phrase}`);
    }),
  });
});

test('a real read-only role rejects Write and ExitPlanMode without an owner dialog', { skip, timeout: 240000 }, async t => {
  const mcp = await startMcpProbe(t), prompt = 'HOOK_PROMPT read-only role';
  const forbidden = [...EDIT_TOOLS, 'EnterPlanMode', 'ExitPlanMode'];
  let probeFile;
  const readOnly = await hooked(t, 'worker', { role: { readOnly: true, args: mcp.args },
    respond: data => toolResult(data, 'ExitPlanMode') ? plainAnswer(data)
      : toolResult(data, 'Write') ? callTool(data, 'ExitPlanMode', {}, toolId('ExitPlanMode'))
        : callTool(data, 'Write', { file_path: probeFile, content: 'must not be written' }, toolId('Write')),
    drive: session => {
      probeFile = path.join(session.f.cwd, 'role-probe.txt');
      return roleTurn(t, session, prompt, requests => {
        const names = requests.map(toolNames);
        const write = requests[1] && toolResult(requests[1], 'Write');
        const plan = requests[2] && toolResult(requests[2], 'ExitPlanMode');
        const absentReadTools = READ_TOOLS.filter(name => !names[0]?.includes(name));
        t.diagnostic(JSON.stringify({ tools: names, absentReadTools, write, plan, screen: 'HOOK_ACK', stop: true }));
        assert.equal(requests.length, 3);
        assert.ok(['Glob', 'Grep', 'Read'].every(name => names[0].includes(name)));
        assert.ok(names.every(tools => tools.every(name => !forbidden.includes(name) || name === 'Write' || name === 'ExitPlanMode')),
          'writing and plan tools must be absent unless the test exercises their refusal');
        assert.equal(write?.is_error, true);
        assert.equal(plan?.is_error, true);
      });
    },
  });
  assert.equal(fs.existsSync(probeFile), false);
  assert.ok(mcp.requests.includes('tools/list'), 'the restricted CLI discovered the MCP probe tool');
  const control = await hooked(t, 'worker', { role: { readOnly: true, args: mcp.args, allowMcp: true }, respond: plainAnswer,
    drive: session => roleTurn(t, session, 'HOOK_PROMPT MCP control', () => {}),
  });
  const restrictedTools = toolNames(readOnly.body), controlTools = toolNames(control.body);
  t.diagnostic(JSON.stringify({ mcpTool: mcp.tool, restrictedTools, controlTools, mcpRequests: mcp.requests }));
  assert.ok(controlTools.includes(mcp.tool), 'the MCP probe must be visible when only the wildcard is removed');
  assert.ok(!restrictedTools.includes(mcp.tool), 'the read-only wildcard must hide the MCP probe');
});

// The numbers the plan asks for (acceptance 3), recorded for the lab and the release notes and never asserted: each interval of a plain turn
// in the no-hook, http, command and command-async configurations, and the permission hook against the dialog. Samples come from AGENTRIX_LATENCY_SAMPLES.
test('the intervals of a turn are recorded in terminal-events-latency.json for every channel', { skip, timeout: 1800000 }, async t => {
  const samples = Number(process.env.AGENTRIX_LATENCY_SAMPLES) || 10;
  const version = spawnSync(process.env.AGENTRIX_REAL_CLAUDE, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
  const interval = (from, to) => Math.round((to.at - from.at) * 10) / 10;
  const result = { claudeVersion: version, platform: `${process.platform}-${process.arch}`, samples, intervalsMs: {} };
  for (const mode of ['none', 'http', 'command', 'command-async']) {
    const rows = { enterToUserPromptSubmit: [], enterToModelRequest: [], stopToIdle: [], turn: [] };
    await hooked(t, mode, { respond: plainAnswer, drive: async session => {
      const { observer } = session;
      for (let n = 0; n < samples; n++) {
        const enter = await submit(session, `HOOK_PROMPT sample ${n}`);
        const request = await observer.when(entry => entry.type === 'api' && entry.tools, enter.n);
        if (mode !== 'none') {
          // Async hooks keep no order against the screen: their Stop can come after the idle screen, so only the order-bound
          // channels give a Stop-to-idle interval.
          const ordered = mode !== 'command-async';
          const prompt = await observer.hook('UserPromptSubmit', enter.n), stop = await observer.hook('Stop', enter.n), idle = await observer.screen('idle', ordered ? stop.n : request.n);
          rows.enterToUserPromptSubmit.push(interval(enter, prompt)); rows.turn.push(interval(enter, stop));
          if (ordered) rows.stopToIdle.push(interval(stop, idle));
        } else {
          const idle = await observer.screen('idle', request.n);
          rows.turn.push(interval(enter, idle));
        }
        rows.enterToModelRequest.push(interval(enter, request));
      }
    } });
    result.intervalsMs[mode] = rows;
  }
  // The permission hook against the dialog, over http: negative means the hook came first, which is the order the plan requires.
  const permission = [];
  await hooked(t, 'http', { respond: askingTool, drive: async session => {
    const { observer } = session;
    for (let n = 0; n < samples; n++) {
      const enter = await submit(session, `HOOK_TOOL sample ${n}`);
      const request = await observer.hook('PermissionRequest', enter.n), dialog = await observer.screen('dialog', enter.n);
      permission.push(interval(dialog, request));
      await allow(session, dialog.n); await observer.hook('Stop', enter.n);
    }
  } });
  result.intervalsMs.permissionHookMinusDialog = permission;
  for (const mode of ['none', 'http', 'command', 'command-async']) for (const name of ['enterToModelRequest', 'turn']) assert.equal(result.intervalsMs[mode][name].length, samples, `${mode} ${name}`);
  assert.equal(permission.length, samples);
  const file = process.env.AGENTRIX_LATENCY_FILE || path.join(__dirname, '..', '.test-output', 'terminal-events-latency.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result, null, 1));
  t.diagnostic(`written to ${file}`);
});
