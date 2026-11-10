import { testRun } from './test-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright-core';
import { waitFor } from './wait.mjs';
import { terminalBootstrap, sendClaudeHook } from '../tests/helpers/desktop-task-fixture.mjs';
const require = createRequire(import.meta.url), exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { parseAgentScreen } = require('../src/features/agents/agent-screen.ts');
const { hasCliInput } = require('../src/features/reading/cli-panel.ts');
// The agent a terminal runs is Claude Code (Codex opens in native mode: native-session-smoke). Its stand-in is the shared
// restore fixture, which only logs keys. This smoke also needs a live composer, Claude Code's input box, without
// acknowledging images.
function completionFixtureSource(source) {
  const ready = 'Console.WriteLine("RESTORE_FIXTURE_READY");';
  if (!source.includes(ready)) throw new Error('The completion fixture is missing its ready marker');
  return source.replace(ready, String.raw`${ready}
        Console.WriteLine("\u2500\u2500\u2500\u2500\r\n\u276F \r\n\u2500\u2500\u2500\u2500\r\n  \u23F8 manual mode on");`);
}
const output = await testRun('completion'), dataDir = path.join(output, 'profile');
const home = path.join(output, 'codex-home'), claudeHome = path.join(output, 'claude-home'), bin = path.join(output, 'bin');
const project = { id: randomUUID(), name: 'Parent task status', path: path.join(output, 'project'), kind: 'local', restore: { terminal: false, codex: false } };
const session = randomUUID(), child = randomUUID();
const transcript = path.join(claudeHome, 'projects', 'completion', `${session}.jsonl`);
for (const directory of [dataDir, project.path, bin, home, path.dirname(transcript)]) await fs.mkdir(directory, { recursive: true });
const fixture = path.join(output, 'completion-claude.cs');
await fs.writeFile(fixture, completionFixtureSource(await fs.readFile(path.join(root, 'tests/fixtures/restore-codex.cs'), 'utf8')));
await exec(path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/reference:System.Web.Extensions.dll', `/out:${path.join(bin, 'claude.exe')}`, fixture], { windowsHide: true });
// Claude Code keeps its plan limits in its own state file, which Agentrix reads: this run's copy, written whole each time.
const usageFile = path.join(claudeHome, '.claude.json');
async function limits(fetchedAtMs, fiveHour, weekly, fiveHourReset = Date.now() + 3 * 86400000) {
  const window = (utilization, reset) => ({ utilization, resets_at: new Date(reset).toISOString() });
  await fs.writeFile(usageFile + '.tmp', JSON.stringify({ cachedUsageUtilization: { fetchedAtMs, utilization: { five_hour: window(fiveHour, fiveHourReset), seven_day: window(weekly, Date.now() + 3 * 86400000) } } }));
  await fs.rename(usageFile + '.tmp', usageFile);
}
await fs.writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify({ version: 2, projects: [project], settings: { language: 'zh', terminalRenderer: 'dom', notifications: true, restoreSessions: false, closeToTray: false } }));
const env = { ...process.env, AGENTRIX_DATA_DIR: dataDir, CODEX_HOME: home, CLAUDE_CONFIG_DIR: claudeHome }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path'); env[pathKey] = bin + path.delimiter + env[pathKey];
const packaged = process.argv.includes('--packaged');
let application, page, bootstrap;
const state = async () => (await page.evaluate(() => window.agentrix.getState())).value.projects[0];
const notices = () => application.evaluate(() => globalThis.completionNotices);
const input = data => page.evaluate(({ id, data }) => window.agentrix.writeTerminal(id, data), { id: project.id, data });
// Claude Code's own records of the conversation, and its hooks: the real hook script, started as Claude Code starts it.
const row = (record, at = Date.now()) => JSON.stringify({ timestamp: new Date(at).toISOString(), sessionId: session, cwd: project.path, uuid: randomUUID(), ...record }) + '\n';
const said = text => row({ type: 'user', message: { role: 'user', content: text } });
const model = 'claude-opus-5-5';
const replied = (content, usage, extra = {}, at) => row({ type: 'assistant', message: { id: `msg-${randomUUID()}`, role: 'assistant', model, content, ...(usage && { usage }), ...extra } }, at);
const ended = (text, at) => replied([{ type: 'text', text }], null, { stop_reason: 'end_turn' }, at);
const hook = (kind, payload = {}) => sendClaudeHook(bootstrap, kind, { session_id: session, transcript_path: transcript, ...payload });
// Codex's notify callback still reaches the pipe (an older Codex or one of its child agents may send it). It is never
// a round of this terminal's agent.
async function notify(id, turn) {
  await exec(bootstrap.powershellPath, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bootstrap.notifyPath, '-PipeName', bootstrap.pipeName, '-ProjectId', bootstrap.projectId, '-SessionKey', bootstrap.sessionKey, '-Payload', JSON.stringify({ type: 'agent-turn-complete', 'thread-id': id, 'turn-id': turn })], { windowsHide: true, timeout: 10000 });
}
// What reaches a terminal agent without new input: another conversation's Stop (a Claude Code this one started inherits
// the hooks), this one's Stop again, its idle notification and Codex's callback.
async function background(turn) {
  await notify(child, turn); await hook('stop', { session_id: child }); await hook('stop');
  await hook('notify', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
}
async function launch() {
  application = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Agentrix.exe') : require('electron'), args: packaged ? [] : [root], cwd: root, env, timeout: 30000 });
  page = await application.firstWindow();
  await application.evaluate(({ Notification, dialog }) => {
    globalThis.completionNotices = 0; Notification.isSupported = () => true;
    Notification.prototype.show = function () { globalThis.completionNotices++; };
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  await page.waitForSelector('.project-panel');
  // Record spoken completion notices instead of playing them aloud during the test.
  await page.evaluate(() => { window.spokenNotices = []; window.speechSynthesis.speak = utterance => { window.spokenNotices.push({ text: utterance.text, lang: utterance.lang, voice: utterance.voice?.name || null }); setTimeout(() => utterance.onend?.(), 0); }; });
  await page.getByRole('button', { name: '只打开终端', exact: true }).click();
  await waitFor(async () => (await state()).shellReady, 'shell ready');
  bootstrap = await terminalBootstrap(dataDir, (await state()).sessionId);
  // The agent is started by typing it at the prompt, as a user does: the wrapper runs the stand-in with Claude Code's hooks.
  await input('claude\r');
  await waitFor(async () => (await state()).codexActive && (await state()).agent === 'claude', 'offline Claude Code fixture');
  await hook('session', { source: 'startup' });
  await page.getByRole('button', { name: '返回总览', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
}
try {
  await limits(Date.now(), 34, 92);
  await fs.writeFile(transcript, '');
  await launch();
  await background('before-input'); assert.equal(await notices(), 0); assert.equal((await state()).unread, 0, 'lifecycle callbacks alone never arm completion');
  await input('first instruction\r');
  await fs.appendFile(transcript, said('first instruction')); await hook('start', { prompt: 'first instruction' });
  await notify(child, 'child-turn'); await hook('stop', { session_id: child });
  await waitFor(async () => (await state()).codexActivity === 'working', 'parent stays running');
  assert.equal(await notices(), 0); assert.equal((await state()).unread, 0);
  await waitFor(async () => page.locator('.status-badge').innerText().then(text => text.includes('正在处理')), 'visible running badge');
  // The step the agent is on shows in the card header: a command it runs, then a file it edits.
  const step = (id, name, input) => replied([{ type: 'tool_use', id, name, input }]);
  await fs.appendFile(transcript, step('call-1', 'Bash', { command: 'npm test' }));
  await waitFor(async () => (await state()).action?.kind === 'command' && (await state()).action.target === 'npm test', 'running command is reported');
  await fs.appendFile(transcript, row({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }] } })
    + step('call-2', 'Edit', { file_path: path.join(project.path, 'src', 'login.ts'), old_string: 'a', new_string: 'b' }));
  await waitFor(async () => (await state()).action?.kind === 'edit' && (await state()).action.target === 'src/login.ts', 'file edit is reported');
  assert.equal((await page.evaluate(id => window.agentrix.terminalActions(id), project.id)).value.length, 2, 'both steps are listed for the review card');
  // Expanded, the pane beside the terminal shows the prompts being worked on, then the model's route, the context it
  // fills and what it has used, as Claude Code's records give them.
  await page.getByRole('button', { name: '进入 Parent task status', exact: true }).click();
  const pane = page.locator('.activity-pane'); await pane.waitFor();
  const overview = pane.locator('.activity-main-tasks'); await overview.waitFor();
  assert.equal(await pane.locator('.api-agent .activity-figure').count(), 0, 'no context before Claude Code counts one');
  // One reply's count: what it read (new, written to the cache, read from the cache) and what it wrote.
  const used = (fresh, cached, output) => ({ input_tokens: fresh, cache_creation_input_tokens: 0, cache_read_input_tokens: cached, output_tokens: output });
  await fs.appendFile(transcript, replied([{ type: 'text', text: '先看登录页。' }], used(30000, 290000, 4200)));
  const text = selector => pane.locator(selector).evaluateAll(nodes => nodes.map(node => node.textContent.replace(/\s+/g, ' ').trim()));
  await waitFor(async () => (await text('.activity-main .activity-call-head p')).join() === 'Opus 5.5', 'the main model section names the model (the mark stands for the official service)');
  assert.equal(await pane.locator('.activity-main .activity-call-note').count(), 0);
  await waitFor(async () => (await text('.api-agent .activity-figure > small')).join() === '共 1M tokens · 还可容纳 676k', 'the context shows how full the window is');
  assert.deepEqual(await text('.api-agent .activity-figure > .activity-metric-label'), ['上下文长度'], 'the context title is the label of its meter line');
  assert.deepEqual(await text('.api-agent .activity-figure > b'), ['32%']);
  assert.deepEqual(await text('.activity-limit > .activity-metric-label'), ['5 小时额度', '每周额度'], 'the plan windows are named by their length');
  assert.deepEqual(await text('.activity-limit > b'), ['34%', '92%']);
  assert.deepEqual(await pane.locator('.activity-limit').evaluateAll(nodes => nodes.map(node => node.classList.contains('is-warn'))), [false, true], 'only the window from 90% takes the warning colour');
  const observed = Date.now();
  await limits(observed, 35, 93);
  await waitFor(async () => (await text('.activity-limit > b')).join() === '35%,93%', 'a limits-only update reaches the pane while the turn stays open', 4000);
  await limits(observed - 60000, 80, 93);
  await new Promise(resolve => setTimeout(resolve, 2300));
  assert.deepEqual([(await text('.activity-limit > b')).join(), (await state()).terminals[0].agentUsage.limitsAt], ['35%,93%', observed], 'older limits cannot replace the live snapshot');
  assert.equal((await state()).codexActivity, 'working'); assert.equal(await notices(), 0);
  await limits(Date.now(), 35, 93, Date.now() + 2000);
  await waitFor(async () => (await text('.activity-limit > small')).includes('已到重置时间，等待更新'), 'a passed reset expires without another agent record', 8000);
  await limits(Date.now(), 36, 93);
  await waitFor(async () => (await text('.activity-limit > b')).join() === '36%,93%', 'fresh limits replace the expired window', 4000);
  console.log('PASS: limits-only updates reach an open round; older snapshots lose; reset expiry waits for fresh data without completion notices');
  // Claude Code's records count each reply, so the figures are the round's (they hold no total for the conversation).
  assert.deepEqual(await text('.api-agent .activity-tokens[title] > .activity-metric-label'), ['本轮']);
  assert.deepEqual(await text('.api-agent .activity-tokens[title] > small'), ['输入 320k · 缓存命中 91% · 输出 4.2k']);
  // The overview lists the prompts: the one being worked on, then one sent while it works. The card's size is fixed:
  // more prompts never move the main model card.
  // Measured once the panel has finished opening: while it flies in it is still scaled a little, every top a pixel off.
  const routeTop = () => pane.locator('.activity-main').evaluate(node => Math.round(node.getBoundingClientRect().top));
  await page.waitForFunction(() => !document.querySelector('[data-focus-motion]'));
  const before = await routeTop();
  await input('给登录页加上验证码。然后跑一下测试\r');
  const prompts = () => overview.locator('li.is-working, li.is-queued').evaluateAll(items => items.map(item => `${item.classList.contains('is-working') ? 'working' : 'queued'}:${item.querySelector('p').lastChild.textContent}`));
  // Each prompt shows its first sentence; the hover retains the whole text before its state and clock.
  await waitFor(async () => JSON.stringify(await prompts()) === JSON.stringify(['working:first instruction', 'queued:给登录页加上验证码。']), 'prompt list shows the working and the waiting prompt');
  const queuedTitle = await overview.locator('li.is-queued').first().getAttribute('title');
  assert.equal(queuedTitle.slice(0, queuedTitle.lastIndexOf('\n')), '给登录页加上验证码。然后跑一下测试');
  assert.match(queuedTitle.slice(queuedTitle.lastIndexOf('\n') + 1), /^排队中 · \d+:\d{2}(?::\d{2})?$/);
  assert.equal(await overview.locator('.activity-progress').count(), 0, 'task rows show state without an invented progress bar');
  assert.equal(await overview.locator('li.is-working .activity-call-role').innerText(), '处理中');
  assert.equal(await routeTop(), before, 'a second prompt leaves the main model card where it was');
  await page.waitForFunction(() => !document.querySelector('[data-focus-motion]')); await page.screenshot({ path: path.join(output, 'activity-pane.png') });
  // While the agent runs, its conversation shows as a document by default; the title-bar switch shows the terminal.
  const reading = page.locator('.project-panel .reading-view');
  assert.ok(await reading.isVisible(), 'the reading view is the default while the agent runs');
  // Hidden xterm renderers may pause; inspect the visible terminal before returning to the composer.
  await page.getByRole('button', { name: '切换到终端', exact: true }).click();
  await waitFor(async () => !await reading.count(), 'show the terminal for fixture readiness');
  await waitFor(async () => {
    const rows = await page.locator('.project-panel .xterm-rows > div').allTextContents();
    return hasCliInput('claude', rows, parseAgentScreen('claude', rows));
  }, 'the stand-in Claude Code draws its live input before image paste');
  await page.getByRole('button', { name: '阅读视图：按文档排版显示对话', exact: true }).click(); await reading.waitFor();
  const receivedKeys = async () => { try { return (await fs.readFile(path.join(project.path, 'key-receipt.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  // Claude Code on Windows takes a picture from the clipboard on Alt+V.
  const pasteKeys = async () => (await receivedKeys()).filter(key => key.key === 'V' && key.modifiers === 'Alt').length;
  const pasteKeysBefore = await pasteKeys();
  // Even this undecodable thumbnail is announced as pending and forwarded as the paste key. The fixture never acknowledges
  // an image chip; reading-ui tests cover refusing Send until the CLI does, without touching the system clipboard.
  await reading.locator('textarea').evaluate(node => {
    const data = new DataTransfer(); data.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' }));
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await reading.locator('.reading-attachments').waitFor();
  assert.ok((await reading.locator('.reading-attachments').innerText()).includes('已附加 1 张图片'));
  await waitFor(async () => await pasteKeys() > pasteKeysBefore, 'the stand-in Claude Code receives the image paste key');
  await page.getByRole('button', { name: '切换到终端', exact: true }).click();
  await waitFor(async () => !await reading.count(), 'the toggle shows the terminal');
  await page.getByRole('button', { name: '阅读视图：按文档排版显示对话', exact: true }).click(); await reading.waitFor();
  // Each count Claude Code writes updates the figures.
  await fs.appendFile(transcript, replied([{ type: 'text', text: '再看验证码。' }], used(10000, 70000, 800)));
  await waitFor(async () => (await text('.api-agent .activity-tokens[title] > small')).join() === '输入 400k · 缓存命中 90% · 输出 5k', 'a later count updates the tokens');
  assert.deepEqual(await text('.api-agent .activity-figure > small'), ['共 1M tokens · 还可容纳 919k']);
  const overflow = await pane.evaluate(node => {
    const right = node.getBoundingClientRect().right + 1;
    return [...node.querySelectorAll('.activity-card, .activity-metric, .activity-call-rows li')].filter(item => item.getBoundingClientRect().right > right).map(item => item.className);
  });
  assert.deepEqual(overflow, [], 'nothing in the activity pane reaches past its edge');
  await page.getByRole('button', { name: '隐藏活动栏', exact: true }).click(); await waitFor(async () => !await pane.count(), 'activity pane can be hidden');
  await page.getByRole('button', { name: '显示活动栏：它正在做什么', exact: true }).click(); await pane.waitFor();
  await page.getByRole('button', { name: '返回总览', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  await page.screenshot({ path: path.join(output, 'parent-running.png') });
  // The agent's own record confirms it took up this prompt in the current round.
  await fs.appendFile(transcript, said('给登录页加上验证码。然后跑一下测试'));
  await waitFor(async () => (await state()).terminals[0].prompts.map(item => item.state).join() === 'working,working', 'the waiting prompt is taken up when Claude Code records it');
  await input('稍后补上文档\r');
  await waitFor(async () => (await state()).terminals[0].prompts.map(item => item.state).join() === 'working,working,queued', 'a prompt sent now waits for the next round');
  await fs.appendFile(transcript, ended('登录页已加上验证码。'));
  await hook('stop');
  const breathes = () => page.locator('.project-panel').evaluate(node => node.getAnimations({ subtree: true }).some(animation => animation.animationName === 'signal-breathe'));
  await waitFor(async () => (await state()).terminals[0].prompts.map(item => `${item.state}:${item.text}`).join() === 'queued:稍后补上文档', 'finished prompts leave the list; the waiting one stays');
  await background('while-queued');
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal((await state()).codexActivity, 'working', 'a queued prompt holds the project working after the first round ends');
  assert.equal((await state()).unread, 0); assert.equal(await notices(), 0);
  assert.equal(await breathes(), false, 'queued work cannot light a completion glow');
  // Delivery is the agent's user-message record, not the earlier terminal submission.
  // It keeps completion blocked until the round that takes it up ends.
  await fs.appendFile(transcript, said('稍后补上文档')); await hook('start', { prompt: '稍后补上文档' });
  await waitFor(async () => (await state()).terminals[0].prompts.map(item => `${item.state}:${item.text}`).join() === 'working:稍后补上文档', 'the queued prompt is delivered to its own round');
  assert.equal((await state()).codexActivity, 'working');
  assert.equal((await state()).unread, 0); assert.equal(await notices(), 0);
  await fs.appendFile(transcript, ended('文档已补上。'));
  await hook('stop');
  await waitFor(async () => (await state()).terminals[0].cliState?.state === 'idle', 'Stop publishes idle');
  await waitFor(async () => (await state()).unread === 1, 'the queued prompt round completes the project');
  assert.equal(await breathes(), true, 'a finished round not yet seen breathes a white glow');
  assert.deepEqual((await state()).terminals[0].prompts, [], 'all delivered work has finished');
  assert.equal(await notices(), 1);
  await page.evaluate(id => window.agentrix.acknowledge(id), project.id);
  await waitFor(async () => page.locator('.project-panel').evaluate(node => node.classList.contains('round-complete')), 'viewed automatic completion becomes a plain round-complete card');
  assert.equal(await page.locator('.status-badge').innerText(), '本轮已完成');
  assert.equal(await breathes(), false, 'a viewed card stops breathing');
  assert.equal(await page.locator('.project-panel .panel-signal').evaluate(node => getComputedStyle(node).boxShadow), 'none', 'a round-complete card draws no edge');
  const completed = (await state()).lastCompletedAt;
  await limits(Date.now(), 37, 93);
  await waitFor(async () => (await state()).terminals[0].agentUsage.limits[0].percent === 37, 'background limits refresh after acknowledging completion', 4000);
  await input('draft'); await background('new-id'); await notify(session, 'first'); await notify(session, 'queued');
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(await notices(), 1); assert.equal((await state()).codexActivity, 'complete');
  assert.equal((await state()).unread, 0); assert.equal((await state()).lastCompletedAt, completed);
  assert.equal(await breathes(), false, 'limits refreshes, drafts, idle notifications and duplicate callbacks do not rearm a viewed completion');
  await input('\x15'); await input('second instruction\r');
  const secondAt = Date.now();
  await fs.appendFile(transcript, said('second instruction')); await hook('start', { prompt: 'second instruction' });
  await notify(session, 'queued');
  await waitFor(async () => (await state()).codexActivity === 'working', 'the second round is working');
  assert.equal(await notices(), 1);
  // A record of the round before, written late, ends nothing of this one.
  await fs.appendFile(transcript, ended('文档已补上。', secondAt - 60000));
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal((await state()).codexActivity, 'working');
  await fs.appendFile(transcript, ended('第二条已完成。')); await hook('stop');
  await waitFor(async () => (await state()).unread === 1, 'second parent turn completes');
  assert.equal(await notices(), 2);
  await background('yet-another-turn');
  assert.equal(await notices(), 2);
  // A typed answer is never recorded as a new prompt. Its grace defers this round's completion.
  await input('finish the answer scenario\r');
  await fs.appendFile(transcript, said('finish the answer scenario')); await hook('start', { prompt: 'finish the answer scenario' });
  await waitFor(async () => (await state()).terminals[0].prompts.some(item => item.state === 'working' && item.text === 'finish the answer scenario'), 'answer scenario parent starts');
  await input('Use the suggested option\r');
  await fs.appendFile(transcript, ended('已按建议完成。')); await hook('stop');
  const answerState = async () => {
    const current = await state();
    assert.notEqual(current.codexActivity, 'interrupted', 'expiring an answer cannot interrupt completed work');
    assert.doesNotMatch(await page.locator('.status-badge').innerText(), /已中断/);
    return current;
  };
  await waitFor(async () => {
    const current = await answerState();
    return current.codexActivity === 'working' && current.terminals[0].prompts.map(item => `${item.state}:${item.text}`).join() === 'queued:Use the suggested option';
  }, 'an unrecorded answer holds completion during grace');
  assert.equal((await state()).unread, 0); assert.equal(await notices(), 2);
  await waitFor(async () => {
    const current = await answerState();
    return current.codexActivity === 'complete' && current.unread === 1 && await notices() === 3;
  }, 'the answer expires and the same round completes once', 35000);
  assert.deepEqual((await state()).terminals[0].prompts, []);
  assert.equal(await breathes(), true, 'the deferred completion lights the project');
  await page.evaluate(id => window.agentrix.acknowledge(id), project.id);
  await background('after-answer');
  assert.equal((await answerState()).unread, 0); assert.equal(await notices(), 3);
  await input('interrupt this one\r');
  await fs.appendFile(transcript, said('interrupt this one')); await hook('start', { prompt: 'interrupt this one' });
  await waitFor(async () => (await state()).codexActivity === 'working', 'the round to interrupt is working');
  await fs.appendFile(transcript, said('[Request interrupted by user]'));
  await waitFor(async () => (await state()).codexActivity === 'interrupted', 'interruption is distinct from completion');
  assert.equal(await notices(), 3);
  assert.equal(await page.evaluate(() => window.spokenNotices.length), 0, 'completions are not spoken (spoken notices are removed for now)');
  console.log('PASS: real parent lifecycle owns working/completed/interrupted status; other conversations\' and stale callbacks never finish the current task');
  await application.close(); application = null;
  await launch(); await background('after-restart');
  assert.equal(await notices(), 0);
  assert.notEqual((await state()).codexActivity, 'complete', 'old lastCompletedAt is not the current running state');
  console.log('PASS: completed history and restarting never generate a new completion notice');
  console.log(`Fixture: ${output}`);
} finally { if (application) await application.close(); }
