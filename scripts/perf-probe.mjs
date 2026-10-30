// Measures how smoothly the window runs with a full workspace: six projects, three of them streaming terminal
// output, the window maximised. It reports frame times (idle with output, hovering across cards, expanding and
// restoring a project), how busy the window's main thread is, and the CPU each process uses. Run with
// `node scripts/perf-probe.mjs` after a build; it uses its own profile, so it never touches a real workspace.
//   --tui              four terminals redraw like a working agent instead (the load that matters most)
//   --surface=solid    the solid material instead of glass
//   --css="…"          try a style change and compare
//   --profile-idle     the window's JavaScript time by function while the terminals stream
//   --profile, --trace where the time goes while a project opens and closes (JavaScript; rendering by kind)
//   --gap              a trace of the first open after launch, every event of 20 ms or more
import { testRun } from './test-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright-core';
import { waitFor } from './wait.mjs';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = await testRun('perf'), dataDir = path.join(output, 'profile');
const surface = process.argv.find(arg => arg.startsWith('--surface='))?.split('=')[1] || 'glass';
const projects = ['商城前端', '支付服务', '数据看板', '文档站点', '移动端 App', '运维脚本'].map(name => ({ id: randomUUID(), name, path: path.join(output, 'p', name), kind: 'local', restore: { terminal: false, codex: false } }));
for (const project of projects) await fs.mkdir(project.path, { recursive: true });
await fs.mkdir(dataDir, { recursive: true });
await fs.writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify({ version: 2, projects, settings: { language: 'zh', notifications: false, sound: false, announce: false, closeToTray: false, restoreSessions: true, guideVersion: '9.9.9', surface } }));
const env = { ...process.env, AGENTRIX_DATA_DIR: dataDir, CODEX_HOME: await fs.mkdtemp(path.join(path.dirname(dataDir), 'codex-home-')) }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;

const application = await electron.launch({ executablePath: require('electron'), args: [root], cwd: root, env, timeout: 30000 });
try {
  const page = await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
  await page.waitForSelector('.project-panel');
  const css = process.argv.find(arg => arg.startsWith('--css='))?.slice(6); if (css) await page.addStyleTag({ content: css });
  const state = async () => (await page.evaluate(() => window.agentrix.getState())).value.projects;
  const start = page.getByRole('button', { name: '只打开终端', exact: true });
  while (await start.count()) { await start.first().click(); await page.waitForTimeout(300); }
  await waitFor(async () => (await state()).every(project => project.shellReady), 'all shells ready', 60000);
  // Three terminals print a line every 40 ms, like a build streaming its log; with --tui four of them redraw an
  // agent's interface instead (tests/fixtures/tui-redraw.cjs), which is what a working Codex or Claude Code does.
  const tui = process.argv.includes('--tui'), streaming = projects.slice(0, tui ? 4 : 3);
  const command = tui ? `node "${path.join(root, 'tests/fixtures/tui-redraw.cjs')}"\r` : '1..100000 | % { "step $_ — compiling module $_ of the project, writing output to the terminal"; Start-Sleep -Milliseconds 40 }\r';
  for (const project of streaming) await page.evaluate(({ id, command }) => window.agentrix.writeTerminal(id, command), { id: project.id, command });
  await page.mouse.move(5, 300);
  await page.waitForTimeout(3000);

  const client = await page.context().newCDPSession(page);
  await client.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await client.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
  // Frame times from requestAnimationFrame while something happens; long gaps are what a person sees as stutter.
  async function measure(label, during) {
    // Each process's CPU use is reported since the last time it was asked; asking now starts the count.
    await application.evaluate(({ app }) => { app.getAppMetrics(); });
    const before = await metrics();
    await page.evaluate(() => { window.frames_ = []; window.frameEnds_ = []; window.marks_ = []; let last = performance.now(); const tick = now => { window.frames_.push(now - last); window.frameEnds_.push(now); last = now; if (!window.stopFrames_) requestAnimationFrame(tick); }; window.stopFrames_ = false; requestAnimationFrame(tick); });
    const started = Date.now(); await during(); const seconds = (Date.now() - started) / 1000;
    const frames = await page.evaluate(() => { window.stopFrames_ = true; return window.frames_.slice(1); });
    const timeline = await page.evaluate(() => ({ ends: window.frameEnds_.slice(1), marks: window.marks_ }));
    const long = timeline.ends.map((end, index) => ({ end, ms: frames[index] })).filter(frame => frame.ms > 50);
    for (const frame of long) { const mark = [...timeline.marks].reverse().find(item => item.at <= frame.end - frame.ms + 1) || { name: 'start', at: timeline.ends[0] }; console.log(`  long frame ${Math.round(frame.ms)} ms, ${Math.round(frame.end - frame.ms - mark.at)} ms after "${mark.name}"`); }
    const after = await metrics();
    const cpu = await application.evaluate(({ app }) => app.getAppMetrics().map(item => ({ type: item.type, cpu: item.cpu.percentCPUUsage })));
    const sorted = [...frames].sort((a, b) => a - b), pick = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] || 0;
    const byType = {}; for (const item of cpu) byType[item.type] = Math.round(((byType[item.type] || 0) + item.cpu) * 10) / 10;
    const share = key => Math.round(((after[key] - before[key]) / seconds) * 1000) / 10;
    const result = { label, fps: Math.round(frames.length / seconds), p50: Math.round(pick(.5)), p95: Math.round(pick(.95)), worst: Math.round(sorted.at(-1) || 0), janky: frames.filter(ms => ms > 50).length,
      'renderer script %': share('ScriptDuration'), 'style %': share('RecalcStyleDuration'), 'layout %': share('LayoutDuration'), 'task %': share('TaskDuration'), cpu: byType };
    console.log(JSON.stringify(result));
    return result;
  }
  const panels = page.locator('.project-panel');
  // --gap: one open, traced; every event of 20 ms or more on any thread, in time order, to find a stall.
  // It runs first, so it sees the first open after launch, the one that stalls.
  if (process.argv.includes('--gap')) {
    const events = [];
    client.on('Tracing.dataCollected', ({ value }) => events.push(...value));
    const done = new Promise(resolve => client.once('Tracing.tracingComplete', resolve));
    await client.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,viz,cc,gpu,blink,toplevel,benchmark,input,ipc,mojom', transferMode: 'ReportEvents' });
    await page.waitForTimeout(300);
    await page.evaluate(() => { window.gapFrames_ = []; let last = performance.now(); const tick = now => { if (now - last > 40) window.gapFrames_.push([Math.round(last - window.openAt_), Math.round(now - last)]); last = now; if (window.gapFrames_.length < 50) requestAnimationFrame(tick); }; requestAnimationFrame(tick); window.openAt_ = performance.now(); console.timeStamp('probe-open'); });
    await panels.nth(3).locator('.panel-header').click({ position: { x: 200, y: 16 } });
    await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]')); await page.waitForTimeout(400);
    await client.send('Tracing.end'); await done;
    const threads = new Map(events.filter(e => e.name === 'thread_name').map(e => [`${e.pid}:${e.tid}`, e.args.name]));
    const origin = events.find(e => e.name === 'TimeStamp' && e.args?.data?.message === 'probe-open')?.ts ?? Math.min(...events.filter(e => e.ts).map(e => e.ts));
    const big = events.filter(e => e.ph === 'X' && e.dur >= 20000 && e.ts >= origin - 50000).sort((a, b) => a.ts - b.ts);
    const seen = new Set();
    for (const e of big) { const thread = threads.get(`${e.pid}:${e.tid}`) || e.tid; const key = `${thread}:${Math.round(e.ts / 5000)}:${e.name}`; if (seen.has(key)) continue; seen.add(key); console.log(`  +${Math.round((e.ts - origin) / 1000).toString().padStart(5)} ms  ${Math.round(e.dur / 1000).toString().padStart(4)} ms  ${thread} · ${e.name}${e.args?.data?.functionName ? ' ' + e.args.data.functionName : ''}${e.args?.data?.url ? ' ' + String(e.args.data.url).split('/').pop() : ''}`); }
    const frames = events.filter(e => ['BeginFrame', 'DrawFrame', 'Commit', 'ActivateLayerTree'].includes(e.name) && e.ts >= origin).map(e => `${e.name[0]}${Math.round((e.ts - origin) / 1000)}`);
    console.log('  frames:', frames.slice(0, 120).join(' '));
    console.log('  rAF gaps over 40 ms [start after open, length]:', JSON.stringify(await page.evaluate(() => window.gapFrames_)));
  }
  await measure(tui ? 'idle, 4 agents redrawing' : 'idle, 3 terminals streaming', () => page.waitForTimeout(6000));
  await page.screenshot({ path: path.join(output, 'overview.png') }); console.log(`Screenshot: ${path.join(output, 'overview.png')}`);
  // --profile-idle: where the window's time goes while the terminals stream, by function, own time only.
  if (process.argv.includes('--profile-idle')) {
    await client.send('Profiler.enable'); await client.send('Profiler.setSamplingInterval', { interval: 200 }); await client.send('Profiler.start');
    await page.waitForTimeout(5000);
    const { profile } = await client.send('Profiler.stop');
    const self = new Map(), byId = new Map(profile.nodes.map(node => [node.id, node]));
    profile.samples.forEach((id, index) => { const frame = byId.get(id).callFrame; const key = `${frame.functionName || '(anonymous)'} ${frame.url.split('/').pop()}:${frame.lineNumber}:${frame.columnNumber}`; self.set(key, (self.get(key) || 0) + (profile.timeDeltas[index] || 0)); });
    console.log('Profile while streaming, own time (ms over 5 s):'); for (const [key, value] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${(value / 1000).toFixed(1).padStart(7)}  ${key}`);
  }
  await measure('hover across cards', async () => {
    for (let round = 0; round < 2; round++) for (let index = 0; index < 6; index++) {
      const box = await panels.nth(index).boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 }); await page.waitForTimeout(250);
    }
  });
  await measure('expand and restore', async () => {
    for (let round = 0; round < 2; round++) {
      await page.evaluate(() => window.marks_.push({ name: 'open', at: performance.now() }));
      await panels.nth(1).locator('.panel-header').click({ position: { x: 200, y: 16 } });
      await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]')); await page.waitForTimeout(800);
      await page.evaluate(() => window.marks_.push({ name: 'close', at: performance.now() }));
      await page.keyboard.press('Control+Shift+g');
      await page.waitForFunction(() => !document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]')); await page.waitForTimeout(800);
    }
  });
  // --profile: where the renderer's time goes while a project opens and closes, by function, own time only.
  if (process.argv.includes('--profile')) {
    await client.send('Profiler.enable'); await client.send('Profiler.setSamplingInterval', { interval: 200 }); await client.send('Profiler.start');
    for (let round = 0; round < 2; round++) {
      await panels.nth(2).locator('.panel-header').click({ position: { x: 200, y: 16 } });
      await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]')); await page.waitForTimeout(600);
      await page.keyboard.press('Control+Shift+g');
      await page.waitForFunction(() => !document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]')); await page.waitForTimeout(600);
    }
    const { profile } = await client.send('Profiler.stop');
    const self = new Map(), total = profile.timeDeltas.reduce((sum, value) => sum + value, 0), byId = new Map(profile.nodes.map(node => [node.id, node]));
    profile.samples.forEach((id, index) => { const node = byId.get(id), frame = node.callFrame; const key = `${frame.functionName || '(anonymous)'} ${frame.url.split('/').pop()}:${frame.lineNumber}`; self.set(key, (self.get(key) || 0) + (profile.timeDeltas[index] || 0)); });
    console.log('Profile, own time (ms):'); for (const [key, value] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${(value / 1000).toFixed(1).padStart(7)}  ${key}`);
    console.log(`  total ${(total / 1000).toFixed(0)} ms`);
  }
  // --trace: the renderer's and GPU's work by kind (style, layout, paint, raster, compositing) while a project
  // opens and closes, and the longest single tasks.
  if (process.argv.includes('--trace')) {
    const events = [];
    client.on('Tracing.dataCollected', ({ value }) => events.push(...value));
    const done = new Promise(resolve => client.once('Tracing.tracingComplete', resolve));
    await client.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,viz,cc,gpu,blink', transferMode: 'ReportEvents' });
    for (let round = 0; round < 2; round++) {
      await panels.nth(2).locator('.panel-header').click({ position: { x: 200, y: 16 } });
      await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]')); await page.waitForTimeout(600);
      await page.keyboard.press('Control+Shift+g');
      await page.waitForFunction(() => !document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]')); await page.waitForTimeout(600);
    }
    await client.send('Tracing.end'); await done;
    const threads = new Map(events.filter(e => e.name === 'thread_name').map(e => [`${e.pid}:${e.tid}`, e.args.name]));
    const sums = new Map();
    for (const e of events) if (e.ph === 'X' && e.dur) { const key = `${threads.get(`${e.pid}:${e.tid}`) || e.tid} · ${e.name}`; sums.set(key, (sums.get(key) || 0) + e.dur); }
    console.log('Trace, total time by thread and event (ms):'); for (const [key, value] of [...sums].sort((a, b) => b[1] - a[1]).slice(0, 35)) console.log(`  ${(value / 1000).toFixed(1).padStart(8)}  ${key}`);
    const tasks = events.filter(e => e.ph === 'X' && e.name === 'RunTask' && threads.get(`${e.pid}:${e.tid}`) === 'CrRendererMain').sort((a, b) => b.dur - a.dur).slice(0, 6);
    for (const task of tasks) {
      const inside = new Map(); for (const e of events) if (e.ph === 'X' && e.pid === task.pid && e.tid === task.tid && e.ts >= task.ts && e.ts + (e.dur || 0) <= task.ts + task.dur && e !== task) inside.set(e.name, (inside.get(e.name) || 0) + (e.dur || 0));
      console.log(`Long task ${(task.dur / 1000).toFixed(0)} ms: ${[...inside].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, dur]) => `${name} ${(dur / 1000).toFixed(0)}`).join(', ')}`);
    }
  }
  await page.keyboard.press('Escape');
  await measure('quiet (output stopped)', async () => {
    for (const project of streaming) await page.evaluate(id => window.agentrix.writeTerminal(id, '\x03'), project.id);
    await page.mouse.move(5, 300); await page.waitForTimeout(6000);
  });
  const memory = await application.evaluate(({ app }) => app.getAppMetrics().reduce((sum, item) => sum + item.memory.workingSetSize, 0));
  console.log(`Memory (working set, all processes): ${Math.round(memory / 1024)} MB`);
} finally {
  await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
}
