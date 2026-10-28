// How smooth each interaction is: the frame times while it plays, with the window maximised under a theme with its
// wallpaper and glass (Catalina) and the terminals drawn by the GPU, as a person runs Agentrix. It covers
// the decision inbox's selection, the page switches, hovering, opening and closing a project, the
// reading view (scrolling, the activity pane, terminal and reading), and the settings. For each it prints the frames,
// the 95th percentile and the worst, and how many took over 33 ms (a stutter a person sees).
//   --trace=<name>        record that interaction and print, for each frame over 33 ms, what every thread spent 4 ms
//                         or more on inside it
//   --only=<a,b>          just these interactions
// Isolated profile; fixtures play the CLIs, so nothing reaches a model. Run after a build.
import { testRun } from './test-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright-core';
import { openSettings } from './app-menu-helper.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=')[1];
const theme = 'catalina', traced = option('trace'), only = option('only')?.split(',');
// --css="…": a style change to try, compared against a run without it.
const css = process.argv.find(arg => arg.startsWith('--css='))?.slice(6);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const output = await testRun('smooth'), profile = path.join(output, 'profile'), claude = path.join(output, 'claude');
const projects = ['支付服务', '登录页', '订单服务', '阅读'].map(name => ({ id: randomUUID(), name, path: path.join(output, 'p', name), restore: { terminal: false, codex: false } }));
for (const directory of [profile, path.join(claude, 'projects'), path.join(output, 'codex-home'), ...projects.map(project => project.path)]) await fs.mkdir(directory, { recursive: true });
await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects, settings: { surface: 'glass', terminalRenderer: 'gpu', activityPane: true, startView: 'decisions',
  language: 'zh', restoreSessions: false, closeToTray: false, notifications: false, sound: false, announce: false, guideVersion: '9.9.9' } }));
// Three agents waiting on a decision, drawn the way Claude Code draws them.
const fixture = async (name, lines) => {
  const script = path.join(output, `${name}.ps1`);
  await fs.writeFile(script, String.fromCharCode(0xfeff) + ['Clear-Host', ...lines.map(line => `Write-Host '${line.replaceAll("'", "''")}'`), 'Start-Sleep -Seconds 3600'].join('\n'), 'utf8');
  return script;
};
const approval = command => ['● I will run it.', '', ' Bash command', '', `   ${command}`, '   Run it', '', ' Do you want to proceed?', ' ❯ 1. Yes', "   2. Yes, and don't ask again", '   3. No, and tell Claude what to do differently (esc)'];
const scripts = [await fixture('a', approval('npm run migrate')), await fixture('b', approval('git push origin main')), await fixture('c', approval('rm -rf dist && npm run build'))];
// A long conversation for the reading view: questions, laid-out answers with lists, code and tables, and steps.
const at = Date.now() - 3600 * 1000, stamp = offset => new Date(at + offset * 1000).toISOString();
const records = [];
for (let i = 0; i < 40; i++) {
  records.push({ type: 'user', uuid: `u${i}`, timestamp: stamp(i * 60), message: { role: 'user', content: `第 ${i} 个需求：给结算页加功能 ${i}` } });
  records.push({ type: 'assistant', uuid: `t${i}`, timestamp: stamp(i * 60 + 5), message: { role: 'assistant', model: 'claude-opus-5-5', usage: { speed: 'standard' }, content: [{ type: 'tool_use', id: `c${i}`, name: 'Bash', input: { command: `npm test -- checkout-${i}` } }] }, effort: 'high' });
  records.push({ type: 'user', uuid: `r${i}`, timestamp: stamp(i * 60 + 9), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `c${i}`, content: 'ok' }] } });
  records.push({ type: 'assistant', uuid: `a${i}`, timestamp: stamp(i * 60 + 20), message: { role: 'assistant', model: 'claude-opus-5-5', usage: { speed: 'standard' }, content: [{ type: 'text', text:
    `## 第 ${i} 步\n\n这一步改了 **结算页**，并补了测试。\n\n- 新增 \`applyCoupon\`\n- 更新 \`Checkout.tsx\`\n\n\`\`\`ts\nexport function applyCoupon(total: number, rate: number) {\n  return Math.round(total * (1 - rate));\n}\n\`\`\`\n\n| 文件 | 改动 |\n| --- | --- |\n| Checkout.tsx | +24 −3 |\n| coupon.ts | +12 |` }] }, effort: 'high' });
}
const transcript = path.join(claude, 'projects', 's1.jsonl');
await fs.writeFile(transcript, records.map(item => JSON.stringify(item)).join('\n') + '\n');
const hook = (kind, payload) => `'${JSON.stringify(payload)}' | & $global:AgentrixSession.powershellPath -NoProfile -ExecutionPolicy Bypass -File $global:AgentrixSession.claudeHookPath -PipeName $global:AgentrixSession.pipeName -ProjectId $global:AgentrixSession.projectId -SessionKey $global:AgentrixSession.sessionKey -Kind ${kind}\r`;

const env = { ...process.env, AGENTRIX_DATA_DIR: profile, AGENTRIX_TEST_HOME: '1', CLAUDE_CONFIG_DIR: claude, CODEX_HOME: path.join(output, 'codex-home') }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
const app = await electron.launch({ executablePath: require('electron'), args: [root], cwd: root, env, timeout: 30000 });
const page = await app.firstWindow(); const errors = [];
page.on('pageerror', error => errors.push(error.message));
const waitFor = async (check, what, tries = 150) => { for (let i = 0; i < tries; i++) { if (await check().catch(() => false)) return; await sleep(200); } throw new Error('timed out: ' + what); };
const state = async index => (await page.evaluate(() => window.agentrix.getState())).value.projects[index];
const results = [];
try {
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.maximize(); w.webContents.setBackgroundThrottling(false); });
  const home = page.locator('.decision-home'); await home.waitFor({ timeout: 20000 });
  for (const index of [0, 1, 2, 3]) {
    await page.evaluate(id => window.agentrix.startTerminal(id), projects[index].id);
    await waitFor(async () => (await state(index)).terminals[0].shellReady, 'shell');
    const data = index < 3 ? `Send-AgentrixEvent 'codex-started' -Agent 'claude'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; & '${scripts[index]}'\r`
      : "function global:prompt { 'reading> ' }; Send-AgentrixEvent 'codex-started' -Agent 'claude'\r";
    await page.evaluate(({ id, data }) => window.agentrix.writeTerminal(id, data), { id: projects[index].id, data });
  }
  await waitFor(async () => (await state(3)).terminals[0].codexActive, 'the reading project');
  await page.evaluate(({ id, data }) => window.agentrix.writeTerminal(id, data), { id: projects[3].id, data: hook('start', { session_id: 's1', transcript_path: transcript, prompt: '第 39 个需求' }) });
  await sleep(1200);
  await page.evaluate(({ id, data }) => window.agentrix.writeTerminal(id, data), { id: projects[3].id, data: hook('stop', { session_id: 's1' }) });
  await waitFor(async () => (await home.locator('.inbox-row').count()) >= 3, 'three inbox rows');
  await sleep(1500);

  if (css) await page.addStyleTag({ content: css });
  const client = await page.context().newCDPSession(page);
  // The display's own frame interval, measured at rest.
  const refresh = await page.evaluate(() => new Promise(resolve => { const times = []; let last = performance.now();
    const tick = now => { times.push(now - last); last = now; if (times.length < 90) requestAnimationFrame(tick); else resolve(times.slice(10).sort((a, b) => a - b)[40]); }; requestAnimationFrame(tick); }));
  // Frame times from requestAnimationFrame while an interaction plays; with --trace, what the threads did in each long one.
  async function measure(name, act, settle = 500) {
    if (only && !only.includes(name)) return;
    const tracing = traced === name, events = [];
    if (tracing) {
      client.on('Tracing.dataCollected', ({ value }) => events.push(...value));
      await client.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,viz,cc,gpu,blink,toplevel,benchmark,input', transferMode: 'ReportEvents' });
      await sleep(200);
    }
    await page.evaluate(() => { console.timeStamp('smooth-start'); window.__t0 = performance.now(); window.__frames = []; window.__stop = false;
      let last = performance.now(); const tick = now => { window.__frames.push([last, now - last]); last = now; if (!window.__stop) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
    try { await act(); } catch (error) { console.log(`  ${name}: ${error.message.split('\n')[0]}`); }
    await sleep(settle);
    const { frames, t0 } = await page.evaluate(() => { window.__stop = true; return { frames: window.__frames.slice(1), t0: window.__t0 }; });
    const times = frames.map(([, ms]) => ms), sorted = [...times].sort((a, b) => a - b), pick = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] || 0;
    // A frame is dropped when it takes half again the display's own interval or more (a refresh missed): 4 ms on a
    // 240 Hz screen, 31 ms over Remote Desktop.
    const interval = refresh || pick(.5);
    const result = { name, frames: times.length, p50: +pick(.5).toFixed(1), p95: +pick(.95).toFixed(1), worst: Math.round(sorted.at(-1) || 0), dropped: times.filter(ms => ms > interval * 1.5).length, over50: times.filter(ms => ms > 50).length };
    results.push(result); console.log(JSON.stringify(result));
    if (tracing) {
      const done = new Promise(resolve => client.once('Tracing.tracingComplete', resolve));
      await client.send('Tracing.end'); await done;
      const threads = new Map(events.filter(e => e.name === 'thread_name').map(e => [`${e.pid}:${e.tid}`, e.args.name]));
      const origin = events.find(e => e.name === 'TimeStamp' && e.args?.data?.message === 'smooth-start')?.ts;
      // Where the work went in the whole interaction, by kind.
      const kinds = { script: /^FunctionCall$/, style: /^UpdateLayoutTree$/, layout: /^Layout$/, paint: /^Paint$/, raster: /^RendererRasterWorker$/, decode: /^Decode Image$/, draw: /^Display::DrawAndSwap$/ };
      const totals = Object.fromEntries(Object.entries(kinds).map(([kind, pattern]) => [kind, Math.round(events.filter(e => e.ph === 'X' && e.ts >= origin && pattern.test(e.name)).reduce((sum, e) => sum + e.dur, 0) / 1000)]));
      console.log('  work (ms):', JSON.stringify(totals));
      for (const [start, ms] of frames.filter(([, ms]) => ms > 33)) {
        const from = origin + (start - t0) * 1000, to = from + ms * 1000;
        console.log(`  frame of ${Math.round(ms)} ms at +${Math.round(start - t0)} ms:`);
        const seen = new Set();
        for (const e of events.filter(e => e.ph === 'X' && e.dur >= 4000 && e.ts < to && e.ts + e.dur > from).sort((a, b) => a.ts - b.ts)) {
          const thread = threads.get(`${e.pid}:${e.tid}`) || e.tid, key = `${thread}|${e.name}`;
          if (seen.has(key) || /^(RunTask|ThreadControllerImpl::RunTask|Scheduler::RunTask|ThreadPool_RunTask)$/.test(e.name)) continue; seen.add(key);
          console.log(`    +${Math.round((e.ts - from) / 1000).toString().padStart(4)} ${Math.round(e.dur / 1000).toString().padStart(4)} ms  ${thread} · ${e.name}${e.args?.data?.functionName ? ' ' + e.args.data.functionName : ''}`);
        }
      }
    }
  }
  await home.locator('.inbox-list').focus();
  await measure('inbox-select', () => page.keyboard.press('ArrowDown'), 600);
  await measure('inbox-click', () => home.locator('.inbox-row').nth(2).click(), 600);
  const nav = name => page.locator('.home-nav button', { hasText: name });
  await measure('to-workbench', () => nav('工作台').click(), 900);
  const panels = page.locator('.project-panel');
  await measure('hover-cards', async () => {
    for (let index = 0; index < 4; index++) { const card = await panels.nth(index).boundingBox(); await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2, { steps: 10 }); await sleep(200); }
  }, 400);
  await measure('expand', () => page.locator(`[data-project-id="${projects[3].id}"]`).getByRole('button', { name: `全屏查看 ${projects[3].name}`, exact: true }).click(), 1100);
  const focused = page.locator(`[data-project-id="${projects[3].id}"]`);
  if (!await focused.locator('.reading-view').count()) await page.locator('.titlebar-tools').getByRole('button', { name: '阅读视图：按文档排版显示对话', exact: true }).click().catch(() => {});
  await sleep(800);
  await measure('reading-scroll', async () => {
    const view = await focused.locator('.reading-scroll').boundingBox();
    await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2);
    for (let i = 0; i < 24; i++) { await page.mouse.wheel(0, -240); await sleep(30); }
    for (let i = 0; i < 24; i++) { await page.mouse.wheel(0, 240); await sleep(30); }
  }, 500);
  await measure('activity-toggle', async () => { await page.getByRole('button', { name: '隐藏活动栏', exact: true }).click(); await sleep(700); await page.getByRole('button', { name: /显示活动栏/ }).click(); }, 700);
  await measure('terminal-toggle', async () => { await page.locator('.titlebar-tools').getByRole('button', { name: '切换到终端', exact: true }).click(); await sleep(700); await page.locator('.titlebar-tools').getByRole('button', { name: '阅读视图：按文档排版显示对话', exact: true }).click(); }, 700);
  // Nothing done: what keeps repainting by itself (a light breathing, a spinner) shows here.
  await measure('idle', () => sleep(1400), 0);
  await measure('settings', async () => { await openSettings(page); await sleep(700); await page.keyboard.press('Escape'); }, 700);
  await measure('restore', () => page.locator('.focus-sidebar').getByRole('button', { name: /总览/ }).first().click({ timeout: 3000 }), 1000);
  await measure('to-decisions', () => nav('决策').click(), 900);
  const janky = results.filter(result => result.dropped);
  console.log(`theme ${theme}, display ${refresh.toFixed(1)} ms a frame: ${results.length} interactions, ${janky.length} dropped frames: ${janky.map(result => `${result.name} ${result.dropped}×, worst ${result.worst} ms`).join('; ') || 'none'}; ${results.reduce((sum, result) => sum + result.dropped, 0)} in all`);
  if (errors.length) console.log('page errors:', errors.slice(0, 5));
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
}
