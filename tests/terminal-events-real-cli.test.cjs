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
const { toolThenDone } = require('./fixtures/claude-real.cjs');
const { hooked, normalize, plainAnswer, playTurn, submit } = require('./fixtures/claude-hooks-real.cjs');

const skip = !process.env.AGENTRIX_REAL_CLAUDE && 'set AGENTRIX_REAL_CLAUDE';
const answer = data => JSON.stringify(data.messages).includes('HOOK_TOOL') ? toolThenDone(data) : plainAnswer(data);
const hookEvents = session => session.observer.timeline.filter(entry => entry.type === 'hook').map(entry => entry.event);

test('UserPromptSubmit arrives before the screen shows working, PermissionRequest before the dialog, Stop before idle', { skip, timeout: 240000 }, async t => {
  await hooked(t, 'http', { respond: answer, drive: async session => {
    const { observer, input } = session;
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
    input.key('1');
    await observer.hook('Stop', second.n);
  } });
});

test('with HTTP_PROXY and no loopback NO_PROXY entry command hooks still report every turn and the proxy sees no hook, while http hooks go through it', { skip, timeout: 240000 }, async t => {
  const { startProxy } = require('./fixtures/claude-hooks-real.cjs');
  // Under a proxy the wrapper keeps command hooks (the channel rule, tested in terminal-hook-channel.test.cjs): they report directly, so the proxy carries no hook.
  const aside = await startProxy(t);
  const command = await hooked(t, 'command', { proxy: aside, respond: plainAnswer, drive: session => playTurn(session) });
  assert.deepEqual(hookEvents(command).filter(event => ['UserPromptSubmit', 'Stop'].includes(event)), ['UserPromptSubmit', 'Stop'], 'the turn is still reported');
  assert.ok(aside.requests.some(url => url.includes('/v1/messages')), 'the proxy is in use: it carried the model request');
  assert.deepEqual(aside.requests.filter(url => url.startsWith(command.receiver.hooks.url.replace(/\/h\/.*/, '/h/'))), [], 'no hook went through the proxy');
  // The same session over HTTP goes through the proxy, which is why the channel rule falls back: the control that shows the check can see a hook.
  const through = await startProxy(t);
  const control = await hooked(t, 'http', { proxy: through, respond: plainAnswer, drive: session => playTurn(session) });
  assert.ok(through.requests.some(url => url.startsWith(control.receiver.hooks.url.replace(/\/h\/.*/, '/h/'))), 'http hooks reach the proxy when HTTP_PROXY is set and NO_PROXY has no loopback entry');
});

test('with Agentrix gone the CLI keeps working and the model context is unchanged', { skip, timeout: 240000 }, async t => {
  const baseline = await hooked(t, 'none', { respond: plainAnswer, drive: session => playTurn(session) });
  // The http settings point at a server that has been shut down: every hook is refused, and the turn must still finish.
  const gone = await hooked(t, 'gone', { respond: plainAnswer, drive: session => playTurn(session) });
  assert.deepEqual(hookEvents(gone), [], 'nothing was there to hear a hook');
  assert.ok(baseline.body && gone.body, 'both sessions sent the prompt to the model');
  assert.equal(normalize(gone.body, gone.f), normalize(baseline.body, baseline.f), 'the model request is byte-identical to the one with no hooks');
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
          const prompt = await observer.hook('UserPromptSubmit', enter.n), stop = await observer.hook('Stop', enter.n), idle = await observer.screen('idle', stop.n);
          rows.enterToUserPromptSubmit.push(interval(enter, prompt)); rows.stopToIdle.push(interval(stop, idle)); rows.turn.push(interval(enter, stop));
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
  await hooked(t, 'http', { respond: data => toolThenDone(data), drive: async session => {
    const { observer, input } = session;
    for (let n = 0; n < samples; n++) {
      const enter = await submit(session, `HOOK_TOOL sample ${n}`);
      const request = await observer.hook('PermissionRequest', enter.n), dialog = await observer.screen('dialog', enter.n);
      permission.push(interval(dialog, request));
      input.key('1'); await observer.hook('Stop', enter.n);
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
