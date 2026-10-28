// Screenshots for the README, from a clean demo profile. Every state is real: cards turn blue, pink and green
// because Codex session files say a round started or finished, and the reading view and activity pane render
// a demo Codex session from the same file. No model is called. Run with `node scripts/readme-shots.mjs`;
// images are written to docs/images. With --video and an ffmpeg path in FFMPEG, it also records a short demo
// (docs/images/demo.gif for the README, demo.mp4 to upload to GitHub for an inline video).
// The demo projects live in C:\AgentrixDemo while it runs, so no personal path shows in the pictures.
import { testRun } from './test-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { _electron as electron } from 'playwright-core';
import { waitFor } from './wait.mjs';
import { setMode } from './mode-switch.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = await testRun('readme'), dataDir = path.join(work, 'profile'), home = path.join(work, 'codex-home');
const images = path.join(root, 'docs', 'images');
const names = ['商城前端', '支付服务', '数据看板', '文档站点', '移动端 App', '运维脚本'];
const demoRoot = process.platform === 'win32' ? 'C:\\AgentrixDemo' : path.join(os.tmpdir(), 'AgentrixDemo');
await fs.rm(demoRoot, { recursive: true, force: true });
const projects = names.map(name => ({ id: randomUUID(), name, path: path.join(demoRoot, name), kind: 'local', restore: { terminal: false, codex: false } }));
for (const directory of [dataDir, path.join(home, 'sessions'), images, ...projects.map(project => project.path)]) await fs.mkdir(directory, { recursive: true });

// The storefront is a real Git repository with an uncommitted change, for the hunk review.
const shop = projects[0].path;
await fs.mkdir(path.join(shop, 'src', 'pages'), { recursive: true });
const checkout = lines => lines.join('\n') + '\n';
await fs.writeFile(path.join(shop, 'src', 'pages', 'Checkout.tsx'), checkout([
  "import { useState } from 'react';", "import { formatPrice, totalOf } from '../lib/price';", '',
  'export function Checkout({ cart }: { cart: CartItem[] }) {', '  const total = totalOf(cart);', '  return <section className="checkout">',
  '    <h2>订单结算</h2>', '    <CartList items={cart} />', '    <p className="total">合计 {formatPrice(total)}</p>', '    <PayButton amount={total} />', '  </section>;', '}']));
await fs.writeFile(path.join(shop, 'README.md'), '# 商城前端\n');
const git = (...args) => execFileSync('git', ['-C', shop, ...args], { windowsHide: true });
git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Demo'); git('config', 'user.email', 'demo@example.invalid'); git('config', 'core.autocrlf', 'false');
git('add', '.'); git('commit', '-q', '-m', '结算页初版');
await fs.writeFile(path.join(shop, 'src', 'pages', 'Checkout.tsx'), checkout([
  "import { useState } from 'react';", "import { applyCoupon, formatPrice, totalOf } from '../lib/price';", '',
  'export function Checkout({ cart }: { cart: CartItem[] }) {', "  const [coupon, setCoupon] = useState('');", '  const total = applyCoupon(totalOf(cart), coupon);', '  return <section className="checkout">',
  '    <h2>订单结算</h2>', '    <CartList items={cart} />', '    <CouponInput value={coupon} onChange={setCoupon} />', '    <p className="total">合计 {formatPrice(total)}</p>', '    <PayButton amount={total} />', '  </section>;', '}']));
await fs.writeFile(path.join(shop, 'src', 'pages', 'CouponInput.tsx'), "export function CouponInput({ value, onChange }: Props) {\n  return <input placeholder=\"优惠券\" value={value} onChange={event => onChange(event.target.value)} />;\n}\n");

// A design mock of the checkout with its coupon field, drawn as the storefront's picture.
const COUPON_MOCK = `<!doctype html><meta charset="utf-8"><body style="margin:0;height:560px;display:grid;place-items:center;font-family:'Segoe UI','Microsoft YaHei',sans-serif;
background:radial-gradient(circle at 20% 15%,#ff7ab6 0,transparent 42%),radial-gradient(circle at 85% 80%,#5b8cff 0,transparent 45%),linear-gradient(135deg,#1d1236,#0d1b2e)">
<div style="width:520px;padding:30px 34px;border-radius:22px;background:rgba(255,255,255,.94);box-shadow:0 30px 70px -20px rgba(0,0,0,.6)">
<div style="font-size:13px;color:#8a7fa8;letter-spacing:.12em">CHECKOUT</div><div style="font-size:26px;font-weight:700;color:#1b1630;margin:4px 0 18px">订单结算</div>
<div style="display:flex;justify-content:space-between;color:#4a4560;font-size:15px;margin:8px 0">降噪耳机 × 1<b>¥ 899</b></div>
<div style="display:flex;justify-content:space-between;color:#4a4560;font-size:15px;margin:8px 0">数据线 × 2<b>¥ 98</b></div>
<div style="display:flex;gap:10px;margin:20px 0 14px"><div style="flex:1;padding:12px 14px;border-radius:12px;border:2px solid #7b5cff;color:#1b1630;font-size:15px;font-weight:600;letter-spacing:.06em">SPRING20</div>
<div style="padding:12px 18px;border-radius:12px;background:#7b5cff;color:#fff;font-size:15px;font-weight:600">已使用</div></div>
<div style="color:#2f9e6b;font-size:14px;margin-bottom:12px">✓ 优惠券已生效，立减 ¥ 199</div>
<div style="display:flex;justify-content:space-between;align-items:baseline;border-top:1px solid #ece8f5;padding-top:16px"><span style="color:#4a4560">合计</span>
<span style="font-size:30px;font-weight:800;color:#1b1630">¥ 798</span></div>
<div style="margin-top:18px;padding:14px;border-radius:14px;text-align:center;color:#fff;font-weight:700;font-size:16px;background:linear-gradient(90deg,#ff5fa2,#7b5cff)">立即支付</div></div></body>`;

await fs.writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify({ version: 2, projects, settings: { language: 'zh', notifications: false, sound: false, announce: false, closeToTray: false, restoreSessions: false, fontSize: 13, guideVersion: '9.9.9' } }));
const env = { ...process.env, AGENTRIX_DATA_DIR: dataDir, CODEX_HOME: home }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
const application = await electron.launch({ executablePath: require('electron'), args: [root, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], cwd: root, env, timeout: 30000 });
const shot = name => page.screenshot({ path: path.join(images, name), type: 'jpeg', quality: 90 });
let page;
try {
  page = await application.firstWindow();
  await application.evaluate(({ BrowserWindow, dialog, ipcMain }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1600, 900);
    dialog.showMessageBox = async () => ({ response: 1 });
    // The dictation window needs a ready model; the screenshot shows it listening, nothing is transcribed.
    ipcMain.removeHandler('voice:state'); ipcMain.handle('voice:state', () => ({ ok: true, value: { phase: 'ready', ready: true, percent: 100, model: 'demo', error: null, downloadBytes: 0 } }));
  });
  await page.waitForSelector('.project-panel');
  // The picture the storefront's answer names, rendered off screen from a small design mock: the reading view shows it
  // under the answer.
  const mock = await application.evaluate(async ({ BrowserWindow }, html) => {
    const window = new BrowserWindow({ show: false, width: 960, height: 560, webPreferences: { offscreen: true } });
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise(resolve => setTimeout(resolve, 400));
    const png = (await window.webContents.capturePage()).toPNG().toString('base64');
    window.destroy();
    return png;
  }, COUPON_MOCK);
  await fs.mkdir(path.join(shop, 'design'), { recursive: true });
  await fs.writeFile(path.join(shop, 'design', 'coupon-preview.png'), Buffer.from(mock, 'base64'));
  const state = async index => (await page.evaluate(() => window.agentrix.getState())).value.projects[index];
  const panel = index => page.locator(`[data-project-id="${projects[index].id}"]`);
  const write = (index, data) => page.evaluate(({ id, data }) => window.agentrix.writeTerminal(id, data), { id: projects[index].id, data });
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  // What each card's terminal shows, as the agent would print it, then the shell stays busy so no prompt shows.
  const say = lines => lines.map(([text, colour]) => `Write-Host ${quote(text)}${colour ? ` -ForegroundColor ${colour}` : ''}`).join('; ');
  const screens = [
    [['› 给结算页加上优惠券输入框，并补上测试', 'White'], [''], ['• 先看一下结算页的组件和价格计算。', 'Gray'], [''], ['• Explored', 'Magenta'], ['  └ Read src/pages/Checkout.tsx, src/lib/price.ts', 'DarkGray'], [''], ['• Edited src/pages/Checkout.tsx (+4 -1)', 'Magenta'], ['• Added src/pages/CouponInput.tsx (+3)', 'Magenta'], ['• Running npm test -- checkout', 'Cyan']],
    [['› 退款接口加幂等校验', 'White'], [''], ['• 已完成：退款请求按 idempotency_key 去重，', 'Gray'], ['  重复请求直接返回第一次的结果。', 'Gray'], [''], ['  - 新增 refund_requests 唯一索引', 'Gray'], ['  - 补了 6 个测试，go test ./... 全部通过', 'Gray'], [''], ['• Worked for 6m 12s', 'DarkGray']],
    [['› 把日活图表改成按周汇总', 'White'], [''], ['• 已完成：图表按 ISO 周聚合，悬停显示每日明细。', 'Gray'], ['  - 修改 charts/active-users.ts', 'Gray'], ['  - 快照测试已更新', 'Gray'], [''], ['• Worked for 3m 40s', 'DarkGray']],
    [['> 给部署文档补一节回滚步骤', 'White'], [''], ['● 我先读一下现有的部署文档结构。', 'Gray'], [''], ['● Read(docs/deploy.md)', 'Green'], ['  ⎿  Read 186 lines', 'DarkGray'], [''], ['● Update(docs/deploy.md)', 'Green'], ['  ⎿  Updated with 24 additions', 'DarkGray']],
    [['PS> git log --oneline -4', 'DarkGray'], ['a41c2e9 登录页适配深色模式', 'Gray'], ['7be03d1 修复安卓返回键退出', 'Gray'], ['3f2a8c4 首页骨架屏', 'Gray'], ['e91b6d0 升级 React Native 0.76', 'Gray']],
    [['› 清理 db-01 30 天前的归档日志', 'White'], [''], ['  Would you like to run the following command?', 'White'], [''], ['  $ ./cleanup-archive.ps1 -Host db-01 -Days 30', 'Cyan'], [''],
      ['› 1. Yes, proceed (y)', 'Cyan'], ["  2. Yes, and don't ask again for this command (p)", 'Gray'], ['  3. No, and tell Codex what to do differently (esc)', 'Gray'], [''],
      ['  Press enter to confirm or esc to cancel', 'DarkGray']],
  ];
  for (let index = 0; index < projects.length; index++) {
    await panel(index).getByRole('button', { name: '只打开终端', exact: true }).click();
    await waitFor(async () => (await state(index)).shellReady, 'shell ready');
  }
  // Agents: a Codex round in the storefront, payments and dashboard, Claude Code in the docs site.
  const sessions = [];
  for (const index of [0, 1, 2]) {
    await write(index, `$env:CODEX_HOME=${quote(home)}; Clear-Host; Send-AgentrixEvent 'codex-started'; ${say(screens[index])}; Start-Sleep -Seconds 3600\r`);
    await waitFor(async () => (await state(index)).codexActive, 'agent session');
    sessions[index] = { thread: randomUUID() };
  }
  await write(3, `Clear-Host; Send-AgentrixEvent 'codex-started' -Agent 'claude'; ${say(screens[3])}; Start-Sleep -Seconds 3600\r`);
  await write(4, `Clear-Host; ${say(screens[4])}; Start-Sleep -Seconds 3600\r`);
  await write(5, `$env:CODEX_HOME=${quote(home)}; Clear-Host; Send-AgentrixEvent 'codex-started'; ${say(screens[5])}; Start-Sleep -Seconds 3600\r`);
  const stamp = () => new Date().toISOString();
  const event = (type, extra = {}) => ({ type: 'event_msg', timestamp: stamp(), payload: { type, ...extra } });
  const message = (role, id, text) => event('item_completed', { item: { type: role === 'user' ? 'UserMessage' : 'AgentMessage', id, content: [{ type: 'text', text }] } });
  const call = (id, cmd) => ({ type: 'response_item', timestamp: stamp(), payload: { type: 'custom_tool_call', call_id: id, name: 'exec', input: `text(await tools.exec_command({cmd:${JSON.stringify(cmd)}}))` } });
  const done = id => ({ type: 'response_item', timestamp: stamp(), payload: { type: 'custom_tool_call_output', call_id: id, output: [] } });
  const rollout = async (index, records) => fs.writeFile(path.join(home, 'sessions', `rollout-${sessions[index].thread}.jsonl`), records.map(item => JSON.stringify(item)).join('\n') + '\n');
  const meta = index => ({ type: 'session_meta', payload: { id: sessions[index].thread, cwd: projects[index].path, source: 'cli', model_provider: 'openai' } });
  const tokens = (input, cached, output, last) => event('token_count', { info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output }, last_token_usage: { input_tokens: last, cached_input_tokens: 0, output_tokens: 0, total_tokens: last }, model_context_window: 258400 },
    rate_limits: { primary: { used_percent: 23, window_minutes: 300, resets_at: Math.round(Date.now() / 1000) + 7200 }, secondary: { used_percent: 41, window_minutes: 10080, resets_at: Math.round(Date.now() / 1000) + 3 * 86400 } } });
  // The storefront: a round in progress, with an answer in Markdown, edits and a running test.
  await rollout(0, [meta(0), event('task_started', { turn_id: 't1' }), { type: 'turn_context', timestamp: stamp(), payload: { cwd: projects[0].path, model: 'gpt-6.1-sol', effort: 'high' } },
    message('user', 'u1', '给结算页加上优惠券输入框，输入后实时重算合计，并补上测试'),
    message('agent', 'a1', '先看一下结算页的组件结构和现有的价格计算。'),
    call('c1', 'Get-Content src/pages/Checkout.tsx'), done('c1'), call('c2', 'rg -n "totalOf" src'), done('c2'), tokens(186400, 151200, 3900, 61800),
    message('agent', 'a2', '## 方案\n\n- 新增 `CouponInput` 组件，受控输入\n- 在 `lib/price.ts` 里加 `applyCoupon(total, code)`，未知券码不改价格\n- `Checkout` 用 `applyCoupon(totalOf(cart), coupon)` 计算合计\n\n```ts\nexport function applyCoupon(total: number, code: string) {\n  const rate = COUPONS[code.trim().toUpperCase()] ?? 1;\n  return Math.round(total * rate);\n}\n```'),
    call('c3', `apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: src/pages/Checkout.tsx\n*** Add File: src/pages/CouponInput.tsx\n*** Update File: src/lib/price.ts\n*** End Patch\nEOF`), done('c3'),
    message('agent', 'a3', '改好了，这是结算页加上优惠券后的效果图：\n\n![优惠券输入框](design/coupon-preview.png)\n\n接下来跑结算相关的测试。'),
    tokens(412300, 356900, 9100, 84600), call('c4', 'npm test -- checkout')]);
  await waitFor(async () => (await state(0)).codexActivity === 'working', 'storefront working');
  // Payments and dashboard: finished rounds; the dashboard has been looked at (green), payments waits (pink).
  const finished = {
    1: ['退款接口加幂等校验', '已完成：退款请求按 `idempotency_key` 去重，重复请求直接返回第一次的结果。\n\n- 新增 `refund_requests` 唯一索引\n- 并发重复请求的测试已补上'],
    2: ['把日活图表改成按周汇总', '已完成：图表按 ISO 周聚合，悬停显示每日明细。\n\n- 修改 `charts/active-users.ts`\n- 快照测试已更新'],
  };
  for (const [index, turn] of [[1, 't2'], [2, 't3']]) {
    await rollout(index, [meta(index), event('task_started', { turn_id: turn }), message('user', `u${index}`, finished[index][0]), message('agent', `a${index}`, finished[index][1])]);
    await waitFor(async () => (await state(index)).codexActivity === 'working', 'round started');
    await fs.appendFile(path.join(home, 'sessions', `rollout-${sessions[index].thread}.jsonl`), JSON.stringify(event('task_complete', { turn_id: turn })) + '\n');
    await waitFor(async () => (await state(index)).codexActivity === 'complete', 'round finished');
  }
  // The ops scripts: a round under way, waiting for the cleanup to be approved.
  sessions[5] = { thread: randomUUID() };
  await rollout(5, [meta(5), event('task_started', { turn_id: 't5' }), message('user', 'u5', '清理 db-01 30 天前的归档日志'), message('agent', 'a5', '先确认归档目录的大小，再删掉 30 天前的文件。')]);
  await waitFor(async () => (await state(5)).terminals?.[0]?.sessionId || (await state(5)).codexActivity === 'working', 'ops session');
  // The docs site's Claude Code has no transcript in this demo: its card shows the terminal.
  await setMode(page, projects[3].name, 'terminal');
  await page.evaluate(id => window.agentrix.acknowledge(id), projects[2].id);
  await waitFor(async () => (await state(2)).unread === 0, 'dashboard viewed');
  await page.evaluate(() => document.activeElement?.blur()); await page.mouse.move(800, 2);
  // Let the completion settle into its quiet glow.
  await page.waitForTimeout(10000);
  await shot('overview.jpg');

  // The decision page: the cleanup waiting for approval, the finished round to review, every session beside them.
  await page.locator('.home-nav button', { hasText: '决策' }).click();
  await page.locator('.decision-card .decision-title').first().waitFor();
  await page.mouse.move(800, 2); await page.waitForTimeout(1200);
  await shot('decisions.jpg');
  await page.locator('.home-nav button', { hasText: '工作台' }).click();
  await page.locator('.project-panel').first().waitFor();

  // The storefront, expanded: reading view with the activity pane.
  await panel(0).getByRole('button', { name: '全屏查看 商城前端', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  // An agent's terminal opens in the reading view by default; switch only if it shows the terminal.
  if (!await page.locator('.project-panel.is-focused .reading-view').count()) await page.getByRole('button', { name: '阅读视图：按文档排版显示对话', exact: true }).click();
  await page.locator('.reading-view .reading-markdown h2').waitFor();
  await page.locator('.activity-pane .activity-context .activity-figure').waitFor();
  await page.mouse.move(800, 2); await page.waitForTimeout(600);
  await shot('reading-view.jpg');

  // Git: the change, hunk by hunk.
  await page.getByRole('button', { name: 'Git 历史', exact: true }).first().click();
  await page.getByRole('button', { name: '已修改 src/pages/Checkout.tsx', exact: true }).click();
  await page.locator('.git-diff-view .git-hunk').first().waitFor();
  await page.mouse.move(800, 2); await page.waitForTimeout(600);
  await shot('git-review.jpg');
  await page.locator('.git-diff-view').getByRole('button', { name: '返回终端', exact: true }).first().click();
  await page.getByRole('button', { name: '切换到终端', exact: true }).first().click();
  await page.keyboard.press('Control+Shift+g');
  await page.waitForFunction(() => !document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));

  // Dictation over the payments card.
  await panel(1).locator('.panel-terminal-area').click({ position: { x: 40, y: 60 } });
  await page.keyboard.press('Control+t');
  await page.locator('.voice-overlay .voice-title').waitFor();
  await page.mouse.move(800, 2); await page.waitForTimeout(1200);
  await shot('voice.jpg');
  await page.keyboard.press('Escape');
  console.log(`README screenshots written to ${images}`);

  if (process.argv.includes('--video')) {
    const ffmpeg = process.env.FFMPEG;
    if (!ffmpeg) throw new Error('Set FFMPEG to an ffmpeg executable to record the demo.');
    const frames = path.join(work, 'frames'); await fs.mkdir(frames, { recursive: true });
    // Chromium's screencast: every painted frame, with its time, so motion plays back at its real speed.
    const client = await page.context().newCDPSession(page);
    const captured = [];
    client.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
      const file = path.join(frames, `f${String(captured.length).padStart(5, '0')}.jpg`);
      captured.push({ file, time: metadata.timestamp });
      await fs.writeFile(file, Buffer.from(data, 'base64'));
      await client.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    const append = (index, records) => fs.appendFile(path.join(home, 'sessions', `rollout-${sessions[index].thread}.jsonl`), records.map(item => JSON.stringify(item)).join('\n') + '\n');
    await page.evaluate(() => document.activeElement?.blur()); await page.mouse.move(800, 2);
    await client.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1600, maxHeight: 900, everyNthFrame: 1 });
    await page.waitForTimeout(1500);
    // The dashboard starts a round (blue), then finishes it: the card lights pink.
    await append(2, [event('task_started', { turn_id: 't4' })]);
    await waitFor(async () => (await state(2)).codexActivity === 'working', 'dashboard working');
    await page.waitForTimeout(2200);
    await append(2, [event('task_complete', { turn_id: 't4' })]);
    await waitFor(async () => (await state(2)).unread > 0, 'dashboard finished');
    await page.waitForTimeout(4200);
    // The storefront opens; its conversation is read as a document while the test run finishes.
    await panel(0).locator('.panel-header').click({ position: { x: 300, y: 18 } });
    await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
    await page.waitForTimeout(700);
    await page.getByRole('button', { name: '阅读视图：按文档排版显示对话', exact: true }).click();
    await page.locator('.reading-view .reading-markdown h2').waitFor();
    await page.mouse.move(800, 2);
    await page.waitForTimeout(2000);
    await append(0, [done('c4'), message('agent', 'a4', '**18 个测试全部通过。** 优惠券输入框已接入结算页：输入后合计实时更新，未知券码不改价格。'), event('task_complete', { turn_id: 't1' })]);
    await waitFor(async () => (await state(0)).codexActivity === 'complete', 'storefront finished');
    await page.waitForTimeout(3000);
    await page.keyboard.press('Control+Shift+g');
    await page.waitForFunction(() => !document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
    await page.waitForTimeout(3500);
    await client.send('Page.stopScreencast');
    await page.waitForTimeout(300);
    // Each frame lasts until the next one arrived; the concat list carries those durations to ffmpeg.
    const list = captured.map((frame, index) => `file '${frame.file.replaceAll('\\', '/')}'\nduration ${Math.max(1 / 60, (captured[index + 1]?.time ?? frame.time + 1 / 30) - frame.time).toFixed(4)}`).join('\n') + `\nfile '${captured.at(-1).file.replaceAll('\\', '/')}'\n`;
    await fs.writeFile(path.join(work, 'frames.txt'), list);
    const run = args => execFileSync(ffmpeg, ['-y', '-loglevel', 'error', ...args], { windowsHide: true });
    run(['-f', 'concat', '-safe', '0', '-i', path.join(work, 'frames.txt'), '-vf', 'fps=30,scale=1600:-2:flags=lanczos,format=yuv420p', '-c:v', 'libx264', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart', path.join(images, 'demo.mp4')]);
    run(['-i', path.join(images, 'demo.mp4'), '-vf', 'fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=200:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', path.join(images, 'demo.gif')]);
    console.log(`Demo recorded: ${captured.length} frames`);
  }
} finally {
  for (const project of projects) await page?.evaluate(id => window.agentrix.writeTerminal(id, '\x03exit\r'), project.id).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 1500));
  await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await fs.rm(demoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }).catch(() => {});
}
