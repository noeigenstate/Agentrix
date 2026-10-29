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
const require = createRequire(import.meta.url), exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = await testRun('completion'), dataDir = path.join(output, 'profile');
const home = path.join(output, 'codex-home'), bin = path.join(output, 'bin');
const project = { id: randomUUID(), name: 'Parent task status', path: path.join(output, 'project'), kind: 'local', restore: { terminal: false, codex: false } };
for (const directory of [dataDir, project.path, bin, path.join(home, 'sessions')]) await fs.mkdir(directory, { recursive: true });
await exec(path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/reference:System.Web.Extensions.dll', `/out:${path.join(bin, 'codex.exe')}`, path.join(root, 'tests/fixtures/restore-codex.cs')], { windowsHide: true });
await fs.writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify({ version: 2, projects: [project], settings: { language: 'zh', notifications: true, restoreSessions: false, closeToTray: false } }));
const env = { ...process.env, AGENTRIX_DATA_DIR: dataDir, CODEX_HOME: home }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path'); env[pathKey] = bin + path.delimiter + env[pathKey];
const packaged = process.argv.includes('--packaged');
let application, page, bootstrap;
const state = async () => (await page.evaluate(() => window.agentrix.getState())).value.projects[0];
const notices = () => application.evaluate(() => globalThis.completionNotices);
const input = data => page.evaluate(({ id, data }) => window.agentrix.writeTerminal(id, data), { id: project.id, data });
const thread = randomUUID(), child = randomUUID();
const transcript = path.join(home, 'sessions', `rollout-${thread}.jsonl`);
const record = (type, turn) => JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type, turn_id: turn } }) + '\n';
async function notify(id, turn) {
  await exec(bootstrap.powershellPath, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bootstrap.notifyPath, '-PipeName', bootstrap.pipeName, '-ProjectId', bootstrap.projectId, '-SessionKey', bootstrap.sessionKey, '-Payload', JSON.stringify({ type: 'agent-turn-complete', 'thread-id': id, 'turn-id': turn })], { windowsHide: true, timeout: 10000 });
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
  const runtime = (await fs.readdir(dataDir)).find(name => name.startsWith('runtime-'));
  bootstrap = JSON.parse(await fs.readFile(path.join(dataDir, runtime, `${(await state()).sessionId}.json`), 'utf8'));
  // Codex is started by typing it at the prompt, as a user does; there is no launch button.
  await input('codex\r');
  await waitFor(async () => (await state()).codexActive, 'offline Codex fixture');
  await page.getByRole('button', { name: '返回总览', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
}
try {
  await launch();
  await notify(child, 'before-input'); assert.equal(await notices(), 0);
  await input('first instruction\r');
  const said = message => JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'user_message', message } }) + '\n';
  await fs.writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id: thread, cwd: project.path, source: 'cli', model_provider: 'openai' } }) + '\n' + record('task_started', 'first') + said('first instruction'));
  await fs.writeFile(path.join(home, 'sessions', `rollout-${child}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: child, cwd: project.path, source: { subagent: thread } } }) + '\n' + record('task_started', 'child-turn') + record('task_complete', 'child-turn'));
  await notify(child, 'child-turn');
  await waitFor(async () => (await state()).codexActivity === 'working', 'parent stays running');
  assert.equal(await notices(), 0); assert.equal((await state()).unread, 0);
  await waitFor(async () => page.locator('.status-badge').innerText().then(text => text.includes('正在处理')), 'visible running badge');
  // The step the agent is on shows in the card header: a command it runs, then a file it patches.
  const step = (id, cmd) => JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'custom_tool_call', call_id: id, name: 'exec', input: 'text(await tools.exec_command({cmd:' + JSON.stringify(cmd) + '}))' } }) + '\n';
  await fs.appendFile(transcript, step('call-1', 'npm test'));
  await waitFor(async () => (await state()).action?.kind === 'command' && (await state()).action.target === 'npm test', 'running command is reported');
  await fs.appendFile(transcript, JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: [] } }) + '\n' + step('call-2', 'apply_patch\n*** Begin Patch\n*** Update File: src/login.ts\n*** End Patch'));
  await waitFor(async () => (await state()).action?.kind === 'edit' && (await state()).action.target === 'src/login.ts', 'file edit is reported');
  assert.equal((await page.evaluate(id => window.agentrix.terminalActions(id), project.id)).value.length, 2, 'both steps are listed for the review card');
  // Expanded, the pane beside the terminal shows the prompts being worked on, then the model's route, the context it
  // fills and what it has used, as Codex's records give them.
  await page.getByRole('button', { name: '进入 Parent task status', exact: true }).click();
  const pane = page.locator('.activity-pane'); await pane.waitFor();
  const overview = pane.locator('.activity-main-tasks'); await overview.waitFor();
  assert.equal(await pane.locator('.activity-context .activity-figure').count(), 0, 'no context before Codex counts one');
  const tokens = (total, last, limits) => JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last, model_context_window: 828400 }, rate_limits: limits } }) + '\n';
  const used = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
  const resets = Math.round(Date.now() / 1000) + 3 * 86400;
  await fs.appendFile(transcript, JSON.stringify({ type: 'turn_context', timestamp: new Date().toISOString(), payload: { cwd: project.path, model: 'gpt-6.1-sol', effort: 'high' } }) + '\n'
    + tokens(used(320000, 290000, 4200), used(310000, 300000, 4200), { primary: { used_percent: 34, window_minutes: 300, resets_at: resets }, secondary: { used_percent: 92, window_minutes: 10080, resets_at: resets } }));
  const text = selector => pane.locator(selector).evaluateAll(nodes => nodes.map(node => node.textContent.replace(/\s+/g, ' ').trim()));
  await waitFor(async () => (await text('.activity-main .activity-call-head p')).join() === 'GPT-6.1-Solhigh', 'the main model section names the model and its effort (the mark stands for the official service)');
  assert.deepEqual(await text('.activity-main .activity-call-settings'), ['high'], 'the main model head says how the model runs, with no separate note line');
  assert.equal(await pane.locator('.activity-main .activity-call-note').count(), 0);
  await waitFor(async () => (await text('.activity-context .activity-metric > small')).join() === '共 828k tokens · 还可容纳 514k', 'the context shows how full the window is');
  assert.deepEqual(await text('.activity-context .activity-metric-label'), ['上下文长度'], 'the context title is the label of its meter line');
  assert.deepEqual(await text('.activity-context .activity-metric > b'), ['38%']);
  assert.deepEqual(await text('.activity-limit > .activity-metric-label'), ['5 小时额度', '每周额度'], 'the plan windows are named by their length');
  assert.deepEqual(await text('.activity-limit > b'), ['34%', '92%']);
  assert.deepEqual(await pane.locator('.activity-limit').evaluateAll(nodes => nodes.map(node => node.classList.contains('is-warn'))), [false, true], 'only the window from 90% takes the warning colour');
  const limitsOnly = (at, percent, reset = resets) => JSON.stringify({ type: 'event_msg', timestamp: new Date(at).toISOString(), payload: {
    type: 'token_count', info: null, rate_limits: {
      primary: { used_percent: percent, window_minutes: 300, resets_at: reset },
      secondary: { used_percent: 93, window_minutes: 10080, resets_at: resets },
    },
  } }) + '\n';
  const observed = Date.now();
  await fs.appendFile(transcript, limitsOnly(observed, 35));
  await waitFor(async () => (await text('.activity-limit > b')).join() === '35%,93%', 'limits-only append reaches the pane while the turn stays open', 4000);
  await fs.appendFile(transcript, limitsOnly(observed - 60000, 80));
  await waitFor(async () => (await state()).terminals[0].agentUsage.limitsAt === observed, 'older limits cannot replace the live snapshot');
  assert.equal((await state()).codexActivity, 'working'); assert.equal(await notices(), 0);
  await fs.appendFile(transcript, limitsOnly(Date.now(), 35, Math.floor(Date.now() / 1000) + 2));
  await waitFor(async () => (await text('.activity-limit > small')).includes('已重置，等待更新'), 'a passed reset expires without another agent record', 8000);
  await fs.appendFile(transcript, limitsOnly(Date.now(), 36));
  await waitFor(async () => (await text('.activity-limit > b')).join() === '36%,93%', 'fresh limits replace the expired window', 4000);
  console.log('PASS: open rollout pushes limits-only updates; older records lose; reset expiry waits for fresh data without completion notices');
  assert.deepEqual(await text('.activity-usage .activity-tokens > .activity-metric-label'), ['本轮', '本次对话']);
  assert.deepEqual(await text('.activity-usage .activity-tokens > small'), ['输入 320k · 缓存命中 91% · 输出 4.2k', '输入 320k · 缓存命中 91% · 输出 4.2k']);
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
  // While Codex runs, its conversation shows as a document by default; the title-bar switch shows the terminal.
  const reading = page.locator('.project-panel .reading-view');
  assert.ok(await reading.isVisible(), 'the reading view is the default while the agent runs');
  // An image pasted into the message box goes to Codex on its own paste key and is announced above the box.
  await reading.locator('textarea').evaluate(node => {
    const data = new DataTransfer(); data.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' }));
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await reading.locator('.reading-attachments').waitFor();
  await page.getByRole('button', { name: '切换到终端', exact: true }).click();
  await waitFor(async () => !await reading.count(), 'the toggle shows the terminal');
  await page.getByRole('button', { name: '阅读视图：按文档排版显示对话', exact: true }).click(); await reading.waitFor();
  // Each count Codex writes updates the figures.
  await fs.appendFile(transcript, tokens(used(400000, 360000, 5000), used(80000, 70000, 800)));
  await waitFor(async () => (await text('.activity-usage .activity-tokens > small')).join() === '输入 400k · 缓存命中 90% · 输出 5k,输入 400k · 缓存命中 90% · 输出 5k', 'a later count updates the tokens');
  assert.deepEqual(await text('.activity-context .activity-metric > small'), ['共 828k tokens · 还可容纳 748k']);
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
  await waitFor(async () => (await state()).terminals[0].prompts.map(item => item.state).join() === 'working,working', 'the waiting prompt is taken up when Codex records it');
  await input('稍后补上文档\r');
  await waitFor(async () => (await state()).terminals[0].prompts.map(item => item.state).join() === 'working,working,queued', 'a prompt sent now waits for the next round');
  await fs.appendFile(transcript, record('task_complete', 'first')); await notify(thread, 'first');
  const breathes = () => page.locator('.project-panel').evaluate(node => node.getAnimations({ subtree: true }).some(animation => animation.animationName === 'signal-breathe'));
  await waitFor(async () => (await state()).terminals[0].prompts.map(item => `${item.state}:${item.text}`).join() === 'queued:稍后补上文档', 'finished prompts leave the list; the waiting one stays');
  await notify(child, 'while-queued'); await notify(thread, 'first');
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal((await state()).codexActivity, 'working', 'a queued prompt holds the project working after the first round ends');
  assert.equal((await state()).unread, 0); assert.equal(await notices(), 0);
  assert.equal(await breathes(), false, 'queued work cannot light a completion glow');
  // Delivery is the agent's user-message record, not the earlier terminal submission.
  // It keeps completion blocked until the round that takes it up ends.
  await fs.appendFile(transcript, record('task_started', 'queued') + said('稍后补上文档'));
  await waitFor(async () => (await state()).terminals[0].prompts.map(item => `${item.state}:${item.text}`).join() === 'working:稍后补上文档', 'the queued prompt is delivered to its own round');
  assert.equal((await state()).codexActivity, 'working');
  assert.equal((await state()).unread, 0); assert.equal(await notices(), 0);
  await fs.appendFile(transcript, record('task_complete', 'queued')); await notify(thread, 'queued');
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
  await fs.appendFile(transcript, limitsOnly(Date.now(), 37));
  await waitFor(async () => (await state()).terminals[0].agentUsage.limits[0].percent === 37, 'background limits refresh after acknowledging completion', 4000);
  await input('draft'); await notify(child, 'new-id'); await notify(thread, 'first'); await notify(thread, 'queued');
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(await notices(), 1); assert.equal((await state()).codexActivity, 'complete');
  assert.equal((await state()).unread, 0); assert.equal((await state()).lastCompletedAt, completed);
  assert.equal(await breathes(), false, 'limits refreshes, drafts, idle polls and duplicate callbacks do not rearm a viewed completion');
  await input('\x15'); await input('second instruction\r');
  await fs.appendFile(transcript, record('task_started', 'second') + said('second instruction'));
  await notify(thread, 'queued');
  assert.equal((await state()).codexActivity, 'working'); assert.equal(await notices(), 1);
  await fs.appendFile(transcript, record('task_complete', 'queued'));
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal((await state()).codexActivity, 'working');
  await fs.appendFile(transcript, record('task_complete', 'second')); await notify(thread, 'second');
  await waitFor(async () => (await state()).unread === 1, 'second parent turn completes');
  assert.equal(await notices(), 2);
  await notify(child, 'yet-another-turn'); await notify(thread, 'second');
  assert.equal(await notices(), 2);
  // A typed answer is never recorded as a new prompt. Its grace defers this round's completion.
  await input('finish the answer scenario\r');
  await fs.appendFile(transcript, record('task_started', 'answer') + said('finish the answer scenario'));
  await waitFor(async () => (await state()).terminals[0].prompts.some(item => item.state === 'working' && item.text === 'finish the answer scenario'), 'answer scenario parent starts');
  await input('Use the suggested option\r');
  await fs.appendFile(transcript, record('task_complete', 'answer')); await notify(thread, 'answer');
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
  await notify(child, 'after-answer'); await notify(thread, 'answer');
  assert.equal((await answerState()).unread, 0); assert.equal(await notices(), 3);
  await fs.appendFile(transcript, record('task_started', 'interrupted') + record('turn_aborted', 'interrupted'));
  await waitFor(async () => (await state()).codexActivity === 'interrupted', 'interruption is distinct from completion');
  assert.equal(await notices(), 3);
  assert.equal(await page.evaluate(() => window.spokenNotices.length), 0, 'completions are not spoken (spoken notices are removed for now)');
  console.log('PASS: real parent lifecycle owns working/completed/interrupted status; child and stale callbacks never finish the current task');
  await application.close(); application = null;
  await launch(); await notify(child, 'after-restart');
  assert.equal(await notices(), 0);
  assert.notEqual((await state()).codexActivity, 'complete', 'old lastCompletedAt is not the current running state');
  console.log('PASS: completed history and restarting never generate a new completion notice');
  console.log(`Fixture: ${output}`);
} finally { if (application) await application.close(); }
