// Screenshots for the README, from an isolated demo profile. Session records and authenticated shell events
// drive the real UI: working tags, completed rounds and the white inward glow of work awaiting review.
// No model is called. Run with `node scripts/readme-shots.mjs`;
// images are written to docs/images. With --video and an ffmpeg path in FFMPEG, it also records a short demo
// (docs/images/demo.gif for the README, demo.mp4 to upload to GitHub for an inline video).
// The demo projects live in C:\AgentrixDemo while it runs, so no personal path shows in the pictures.
import { testRun } from './test-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright-core';
import { waitFor, terminalsSettled } from './wait.mjs';
import { setMode } from './mode-switch.mjs';
import { withGuiLock } from './gui-lock.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const images = path.join(root, 'docs', 'images');
const names = ['商城前端', '支付服务', '数据看板', '文档站点', '移动端 App', '运维脚本'];
const demoRoot = 'C:\\AgentrixDemo';
const video = process.argv.includes('--video');
if (process.platform !== 'win32') throw new Error('The README fixtures require Windows PowerShell and C:\\AgentrixDemo.');
if (video && !process.env.FFMPEG) throw new Error('Set FFMPEG to an ffmpeg executable to record the demo.');

await withGuiLock('readme-shots', async () => {
  const work = await testRun('readme'), dataDir = path.join(work, 'profile'), home = path.join(work, 'codex-home'), claudeHome = path.join(work, 'claude-home');
  const projects = names.map(name => ({ id: randomUUID(), name, path: path.join(demoRoot, name), kind: 'local', restore: { terminal: false, codex: false } }));
  let application, page, demoIdentity;
  const errors = [];
  try {
    // An exclusive mkdir refuses an existing directory, including a stale demo someone may have kept.
    await fs.mkdir(demoRoot);
    demoIdentity = await fs.lstat(demoRoot, { bigint: true });
    for (const directory of [dataDir, path.join(home, 'sessions'), claudeHome, images, ...projects.map(project => project.path)]) await fs.mkdir(directory, { recursive: true });
    const env = { ...process.env, AGENTRIX_DATA_DIR: dataDir, CODEX_HOME: home, CLAUDE_CONFIG_DIR: claudeHome,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.invalid', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.invalid' };
    // The session homes and inherited routing are isolated even when this runs inside a live agent's shell.
    for (const key of Object.keys(env)) {
      if (/^(?:OPENAI_|ANTHROPIC_|CODEX_|CLAUDE_)/i.test(key) && !['CODEX_HOME', 'CLAUDE_CONFIG_DIR'].includes(key)) delete env[key];
    }
    delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;

    // The storefront is a real Git repository with an uncommitted change, for the hunk review.
    const shop = projects[0].path;
    await fs.mkdir(path.join(shop, 'src', 'pages'), { recursive: true });
    await fs.mkdir(path.join(shop, 'src', 'lib'), { recursive: true });
    const checkout = lines => lines.join('\n') + '\n';
    const price = "export const totalOf = (cart: CartItem[]) => cart.reduce((sum, item) => sum + item.price * item.quantity, 0);\nexport const formatPrice = (total: number) => `¥ ${(total / 100).toFixed(2)}`;\n";
    await fs.writeFile(path.join(shop, 'src', 'lib', 'price.ts'), price);
    await fs.writeFile(path.join(shop, 'src', 'pages', 'Checkout.tsx'), checkout([
      "import { useState } from 'react';", "import { formatPrice, totalOf } from '../lib/price';", '',
      'export function Checkout({ cart }: { cart: CartItem[] }) {', '  const total = totalOf(cart);', '  return <section className="checkout">',
      '    <h2>订单结算</h2>', '    <CartList items={cart} />', '    <p className="total">合计 {formatPrice(total)}</p>', '    <PayButton amount={total} />', '  </section>;', '}']));
    await fs.writeFile(path.join(shop, 'README.md'), '# 商城前端\n');
    const git = (...args) => execFileSync('git', ['-C', shop, ...args], { windowsHide: true, env });
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Demo'); git('config', 'user.email', 'demo@example.invalid'); git('config', 'core.autocrlf', 'false');
    git('add', '.'); git('commit', '-q', '-m', '结算页初版');
    await fs.writeFile(path.join(shop, 'src', 'pages', 'Checkout.tsx'), checkout([
      "import { useState } from 'react';", "import { applyCoupon, formatPrice, totalOf } from '../lib/price';", '',
      'export function Checkout({ cart }: { cart: CartItem[] }) {', "  const [coupon, setCoupon] = useState('');", '  const total = applyCoupon(totalOf(cart), coupon);', '  return <section className="checkout">',
      '    <h2>订单结算</h2>', '    <CartList items={cart} />', '    <CouponInput value={coupon} onChange={setCoupon} />', '    <p className="total">合计 {formatPrice(total)}</p>', '    <PayButton amount={total} />', '  </section>;', '}']));
    await fs.writeFile(path.join(shop, 'src', 'pages', 'CouponInput.tsx'), "export function CouponInput({ value, onChange }: Props) {\n  return <input placeholder=\"优惠券\" value={value} onChange={event => onChange(event.target.value)} />;\n}\n");
    await fs.writeFile(path.join(shop, 'src', 'lib', 'price.ts'), price + "\nconst COUPONS: Record<string, number> = { SPRING20: 0.8 };\nexport function applyCoupon(total: number, code: string) {\n  const rate = COUPONS[code.trim().toUpperCase()] ?? 1;\n  return Math.round(total * rate);\n}\n");

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

    await fs.writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify({ version: 2, projects, settings: { startView: 'workspace', language: 'zh', theme: 'mono', activityPane: true, explorerCollapsed: false, terminalRenderer: 'dom', shell: 'powershell', notifications: false, sound: false, closeToTray: false, restoreSessions: false, fontSize: 13, guideVersion: '9.9.9' } }));
    application = await electron.launch({ executablePath: require('electron'), args: [root, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], cwd: root, env, timeout: 30000 });
    assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), dataDir, 'the app must use only the demo profile');
    page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(25000);
    await page.waitForSelector('.project-panel');
    await application.evaluate(({ BrowserWindow, dialog, ipcMain }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(1600, 900);
      window.webContents.setBackgroundThrottling(false);
      dialog.showMessageBox = async () => ({ response: 1 });
      // Keep the real recorder and overlay, but never download, warm or invoke a speech model.
      const ready = { phase: 'ready', ready: true, percent: 100, model: 'demo', choice: 'demo', active: null, models: [], error: null, downloadBytes: 0 };
      for (const channel of ['voice:state', 'voice:prepare', 'voice:warm']) {
        ipcMain.removeHandler(channel); ipcMain.handle(channel, () => ({ ok: true, value: ready }));
      }
      ipcMain.removeHandler('voice:transcribe'); ipcMain.handle('voice:transcribe', () => { throw new Error('The README demo must not transcribe audio.'); });
      window.webContents.send('voice:state', ready);
    });
    const shot = async name => {
      await terminalsSettled(page);
      await page.evaluate(() => document.fonts.ready.then(() => document.activeElement?.blur()));
      await page.mouse.move(800, 2);
      assert.deepEqual(errors, [], 'renderer errors');
      assert.equal(await page.evaluate(() => window.scrollY), 0, 'the title bar stays fully in frame');
      await page.screenshot({ path: path.join(images, name), type: 'jpeg', quality: 90 });
    };
    // The picture the storefront's answer names, rendered off screen from a small design mock: the reading view shows it
    // under the answer.
    const mock = await application.evaluate(async ({ BrowserWindow }, html) => {
      const window = new BrowserWindow({ show: false, width: 960, height: 560, webPreferences: { offscreen: true } });
      try {
        await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        await window.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
        return (await window.webContents.capturePage()).toPNG().toString('base64');
      } finally { window.destroy(); }
    }, COUPON_MOCK);
    await fs.mkdir(path.join(shop, 'design'), { recursive: true });
    await fs.writeFile(path.join(shop, 'design', 'coupon-preview.png'), Buffer.from(mock, 'base64'));
    const state = async index => (await page.evaluate(() => window.agentrix.getState())).value.projects.find(project => project.id === projects[index].id);
    const panel = index => page.locator(`[data-project-id="${projects[index].id}"]`);
    const write = (index, data) => page.evaluate(({ id, data }) => window.agentrix.writeTerminal(id, data), { id: projects[index].id, data });
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    // What each card's terminal shows, as the agent would print it, then the shell stays busy so no prompt shows.
    const say = lines => lines.map(([text, colour]) => `Write-Host ${quote(text)}${colour ? ` -ForegroundColor ${colour}` : ''}`).join('; ');
    const screens = [
      [['› 结算页接入优惠券，并补上测试', 'White'], [''], ['• 先看一下结算页的组件和价格计算。', 'Gray'], [''], ['• Explored', 'Magenta'], ['  └ Read src/pages/Checkout.tsx, src/lib/price.ts', 'DarkGray'], [''], ['• Edited src/pages/Checkout.tsx (+4 -1)', 'Magenta'], ['• Added src/pages/CouponInput.tsx (+3)', 'Magenta'], ['• Running npm test -- checkout', 'Cyan']],
      [['› 退款接口加幂等校验', 'White'], [''], ['• 已完成：退款请求按 idempotency_key 去重，', 'Gray'], ['  重复请求直接返回第一次的结果。', 'Gray'], [''], ['  - 新增 refund_requests 唯一索引', 'Gray'], ['  - 补了 6 个测试，go test ./... 全部通过', 'Gray'], [''], ['• Worked for 6m 12s', 'DarkGray']],
      [['› 把日活图表改成按周汇总', 'White'], [''], ['• 已完成：图表按 ISO 周聚合，悬停显示每日明细。', 'Gray'], ['  - 修改 charts/active-users.ts', 'Gray'], ['  - 快照测试已更新', 'Gray'], [''], ['• Worked for 3m 40s', 'DarkGray']],
      [['> 给部署文档补一节回滚步骤', 'White'], [''], ['● 我先读一下现有的部署文档结构。', 'Gray'], [''], ['● Read(docs/deploy.md)', 'Green'], ['  ⎿  Read 186 lines', 'DarkGray'], [''], ['● Update(docs/deploy.md)', 'Green'], ['  ⎿  Updated with 24 additions', 'DarkGray']],
      [['› 登录页适配深色模式，并检查返回键行为', 'White'], [''], ['• 已完成：登录页跟随系统主题。', 'Gray'], ['  - 修复安卓返回键意外退出', 'Gray'], ['  - 8 个界面测试全部通过', 'Gray'], [''], ['• Worked for 4m 18s', 'DarkGray']],
      [['› 清理演示目录 30 天前的归档日志', 'White'], [''], ['  Would you like to run the following command?', 'White'], [''], ['  $ ./cleanup-archive.ps1 -Days 30', 'Cyan'], [''],
        ['› 1. Yes, proceed (y)', 'Cyan'], ["  2. Yes, and don't ask again for this command (p)", 'Gray'], ['  3. No, and tell Codex what to do differently (esc)', 'Gray'], [''],
        ['  Press enter to confirm or esc to cancel', 'DarkGray']],
    ];
    const sessions = projects.map(() => ({ thread: randomUUID() }));
    const stamp = () => new Date().toISOString();
    const event = (type, extra = {}) => ({ type: 'event_msg', timestamp: stamp(), payload: { type, ...extra } });
    const message = (role, id, text) => event('item_completed', { item: { type: role === 'user' ? 'UserMessage' : 'AgentMessage', id, content: [{ type: 'text', text }] } });
    const call = (id, cmd) => ({ type: 'response_item', timestamp: stamp(), payload: { type: 'custom_tool_call', call_id: id, name: 'exec', input: `text(await tools.exec_command({cmd:${JSON.stringify(cmd)}}))` } });
    const done = (id, output = '') => ({ type: 'response_item', timestamp: stamp(), payload: { type: 'custom_tool_call_output', call_id: id, output: JSON.stringify({ output, metadata: { exit_code: 0 } }) } });
    const sessionFile = index => path.join(home, 'sessions', `rollout-${sessions[index].thread}.jsonl`);
    const recordsText = records => records.map(item => JSON.stringify(item)).join('\n') + '\n';
    const rollout = (index, records) => fs.writeFile(sessionFile(index), recordsText(records));
    const append = (index, records) => fs.appendFile(sessionFile(index), recordsText(records));
    const meta = index => ({ type: 'session_meta', timestamp: stamp(), payload: { id: sessions[index].thread, cwd: projects[index].path, source: 'cli', model_provider: 'openai' } });
    const tokens = (input, cached, output, last) => event('token_count', { info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output }, last_token_usage: { input_tokens: last, cached_input_tokens: 0, output_tokens: 0, total_tokens: last }, model_context_window: 258400 },
      rate_limits: { primary: { used_percent: 23, window_minutes: 300, resets_at: Math.round(Date.now() / 1000) + 7200 }, secondary: { used_percent: 41, window_minutes: 10080, resets_at: Math.round(Date.now() / 1000) + 3 * 86400 } } });

    const claudeFolder = path.join(claudeHome, 'projects', projects[3].path.replace(/[^A-Za-z0-9]/gu, '-'));
    const claudeFile = path.join(claudeFolder, `${sessions[3].thread}.jsonl`);
    const docsPrompt = '给部署文档补一节回滚步骤';
    await fs.mkdir(claudeFolder, { recursive: true });
    await fs.writeFile(claudeFile, recordsText([
      { type: 'user', uuid: randomUUID(), parentUuid: null, timestamp: stamp(), cwd: projects[3].path, sessionId: sessions[3].thread, message: { role: 'user', content: docsPrompt } },
      { type: 'assistant', uuid: randomUUID(), timestamp: stamp(), cwd: projects[3].path, sessionId: sessions[3].thread, effort: 'high', message: { id: 'docs-reply', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: '我先读一下现有的部署文档结构，再补齐回滚前检查、执行和验证步骤。' }], usage: { input_tokens: 1200, cache_read_input_tokens: 42000, output_tokens: 340, speed: 'standard' } } },
    ]));
    const hook = `${quote(JSON.stringify({ session_id: sessions[3].thread, transcript_path: claudeFile, prompt: docsPrompt }))} | & $global:AgentrixSession.powershellPath -NoProfile -ExecutionPolicy Bypass -File $global:AgentrixSession.claudeHookPath -PipeName $global:AgentrixSession.pipeName -ProjectId $global:AgentrixSession.projectId -SessionKey $global:AgentrixSession.sessionKey -Kind start`;
    for (let index = 0; index < projects.length; index++) {
      // A plain shell is hidden on a small card; start it through the API, then authenticate its fixture agent.
      const started = await page.evaluate(id => window.agentrix.startTerminal(id), projects[index].id);
      assert.ok(started.ok, `start ${projects[index].name}`);
      await waitFor(async () => (await state(index)).shellReady, `${projects[index].name}: shell ready`);
      const agent = index === 3 ? 'claude' : 'codex';
      const title = agent === 'codex' ? `[Console]::Write(([string][char]27) + ']0;' + ${quote(sessions[index].thread)} + ([string][char]7)); ` : '';
      await write(index, `Clear-Host; Send-AgentrixEvent 'codex-started' -Agent '${agent}'; ${title}${index === 3 ? hook + '; ' : ''}${say(screens[index])}; Start-Sleep -Seconds 3600\r`);
      await waitFor(async () => {
        const current = await state(index);
        return current.codexActive && current.terminals[0].agent === agent;
      }, `${projects[index].name}: fixture agent active`);
      // Mode switches live only in the expanded title bar. Seed them before any completions can be acknowledged.
      await setMode(page, projects[index].name, 'terminal');
      await waitFor(() => panel(index).locator('.xterm-rows').innerText().then(text => text.replaceAll('\u00a0', ' ').includes(screens[index].at(-1)[0])), `${projects[index].name}: terminal frame`);
    }
    await waitFor(async () => (await state(3)).codexActivity === 'working' && (await state(3)).terminals[0].agentSettings?.model === 'claude-sonnet-5-5', 'Claude hook and transcript');

    // The storefront: a round in progress, with an answer in Markdown, edits and a running test.
    await rollout(0, [meta(0), tokens(186400, 151200, 3900, 61800), event('task_started', { turn_id: 't1' }),
      { type: 'turn_context', timestamp: stamp(), payload: { cwd: projects[0].path, model: 'gpt-6.1-sol', effort: 'high' } },
      event('thread_settings_applied', { thread_settings: { model: 'gpt-6.1-sol', reasoning_effort: 'high', service_tier: 'priority' } }),
      message('user', 'u1', '结算页接入优惠券，并补上测试'),
      message('agent', 'a1', '先看一下结算页的组件结构和现有的价格计算。'),
      call('c1', 'Get-Content src/pages/Checkout.tsx'), done('c1'), call('c2', 'rg -n "totalOf" src'), done('c2'),
      message('agent', 'a2', '## 方案\n\n- 新增受控组件 `CouponInput`，输入后实时重算合计\n- `applyCoupon(total, code)` 对未知券码保持原价'),
      call('c3', `apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: src/pages/Checkout.tsx\n*** Add File: src/pages/CouponInput.tsx\n*** Update File: src/lib/price.ts\n*** End Patch\nEOF`), done('c3'),
      message('agent', 'a3', '改好了，这是结算页加上优惠券后的效果图：\n\n![优惠券输入框](design/coupon-preview.png)\n\n接下来跑结算相关的测试。'),
      tokens(412300, 356900, 9100, 84600), call('c4', 'npm test -- checkout')]);
    await waitFor(async () => (await state(0)).codexActivity === 'working', 'storefront working');
    // Finished sessions stay active. Payments and mobile await review; the dashboard will be acknowledged.
    const finished = {
      1: ['退款接口加幂等校验', '已完成：退款请求按 `idempotency_key` 去重，重复请求直接返回第一次的结果。\n\n- 新增 `refund_requests` 唯一索引\n- 并发重复请求的测试已补上'],
      2: ['把日活图表改成按周汇总', '已完成：图表按 ISO 周聚合，悬停显示每日明细。\n\n- 修改 `charts/active-users.ts`\n- 快照测试已更新'],
      4: ['登录页适配深色模式，并检查返回键行为', '已完成：登录页跟随系统主题，安卓返回键不再意外退出。\n\n- 登录页深色模式已适配\n- 8 个界面测试全部通过'],
    };
    for (const index of [1, 2, 4]) {
      const turn = `finished-${index}`, test = index === 1 ? 'go test ./...' : index === 2 ? 'npm test -- active-users' : 'npm test -- login';
      await rollout(index, [meta(index), event('task_started', { turn_id: turn }), message('user', `u${index}`, finished[index][0]),
        call(`test-${index}`, test), done(`test-${index}`, 'All tests passed.'), message('agent', `a${index}`, finished[index][1])]);
      await waitFor(async () => (await state(index)).codexActivity === 'working', 'round started');
      await append(index, [event('task_complete', { turn_id: turn })]);
      await waitFor(async () => (await state(index)).codexActivity === 'complete' && (await state(index)).unread > 0, 'round awaiting review');
    }
    // The ops scripts: a round under way, waiting for the cleanup to be approved.
    await rollout(5, [meta(5), event('task_started', { turn_id: 't5' }), message('user', 'u5', '清理演示目录 30 天前的归档日志'), message('agent', 'a5', '先确认演示归档目录的大小，再清理 30 天前的文件。')]);
    await waitFor(async () => (await state(5)).codexActivity === 'working', 'ops round working');
    const acknowledged = await page.evaluate(id => window.agentrix.acknowledge(id), projects[2].id);
    assert.ok(acknowledged.ok);
    await waitFor(() => panel(2).locator('.status-badge.is-complete').isVisible(), 'dashboard acknowledged');
    assert.equal(await page.locator('.focus-mode').count(), 0);
    assert.equal(await page.locator('.project-panel .agent-launcher:visible').count(), 0);
    assert.equal(await page.locator('.project-panel .terminal-split[data-codex-active="true"]:visible').count(), projects.length);
    for (const index of [0, 3, 5]) assert.ok(await panel(index).locator('.status-badge.is-working').isVisible());
    for (const index of [1, 4]) assert.ok(await panel(index).locator('.status-badge.is-review').isVisible());
    await waitFor(() => panel(1).locator('.panel-signal').evaluate(node => {
      const style = getComputedStyle(node);
      return style.display !== 'none' && style.boxShadow.includes('inset') && Number(style.opacity) >= .9;
    }), 'the real awaiting-review glow is visible');
    await shot('overview.jpg');

    // The decision page: the cleanup waiting for approval, the finished round to review, every session beside them.
    await page.locator('.home-nav button', { hasText: '决策' }).click();
    const inbox = page.getByRole('listbox', { name: '待决定的事', exact: true });
    await waitFor(async () => await inbox.getByRole('option').count() === projects.length, 'all fixture sessions reach the decision inbox');
    await inbox.getByRole('option').filter({ hasText: projects[5].name }).click();
    const approval = page.locator('.decision-card.is-approval[data-approval-mode="terminal-only"]');
    await approval.getByRole('heading', { name: '运行命令：./cleanup-archive.ps1 -Days 30', exact: true }).waitFor();
    await approval.locator('.decision-options-readonly li').nth(2).waitFor();
    await approval.locator('[data-approval-open-terminal]').waitFor();
    assert.equal(await inbox.locator('.inbox-tag.is-review').count(), 2, 'both unread completions remain available for review');
    await shot('decisions.jpg');
    await page.locator('.home-nav button', { hasText: '工作台' }).click();
    await page.locator('.project-panel').first().waitFor();

    // The storefront, expanded: reading view with the activity pane.
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1040));
    await panel(0).getByRole('button', { name: '全屏查看 商城前端', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
    await setMode(page, projects[0].name, 'reading');
    const reader = panel(0).locator('.reading-view'), activity = page.locator('.activity-pane');
    await reader.getByRole('heading', { name: '方案', exact: true }).waitFor();
    await reader.getByText('接下来跑结算相关的测试。', { exact: false }).waitFor();
    // Reply images are lazy file cards; their accessible name is the filename, not the Markdown alt text.
    const preview = reader.getByRole('button', { name: '打开 coupon-preview.png', exact: true });
    await preview.scrollIntoViewIfNeeded();
    await preview.getByRole('img', { name: 'coupon-preview.png', exact: true }).waitFor();
    await waitFor(() => preview.locator('img').evaluate(image => image.complete && image.naturalWidth > 0), 'the fixture preview image loads from the demo repository');
    const modes = page.locator('.titlebar-tools').getByRole('group', { name: '显示方式', exact: true });
    assert.deepEqual(await modes.locator('button span').allTextContents(), ['终端', '阅读']);
    assert.equal(await modes.getByRole('button', { name: '阅读视图：按文档排版显示对话', exact: true }).getAttribute('aria-pressed'), 'true');
    await activity.getByRole('region', { name: '模型路由', exact: true }).waitFor();
    await waitFor(() => activity.locator('.activity-route-steps').innerText().then(text => text.includes('Codex') && text.includes('OpenAI') && text.includes('GPT-6.1-Sol')), 'Codex model route');
    await activity.locator('.activity-prompts li.is-working').waitFor();
    assert.ok((await activity.locator('.activity-prompts').innerText()).includes('结算页接入优惠券'));
    await waitFor(() => activity.locator('.activity-limit > b').allTextContents().then(values => values.join() === '23%,41%'), '5-hour and weekly limits from token_count');
    assert.deepEqual(await activity.locator('.activity-limit > .activity-metric-label').allTextContents(), ['5 小时额度', '每周额度']);
    assert.deepEqual(await activity.locator('.activity-tokens > .activity-metric-label').allTextContents(), ['本轮', '本次对话']);
    assert.equal(await activity.locator('.activity-context [role="meter"]').getAttribute('aria-valuenow'), '33');
    // Codex records currently expose no called-model group; only Claude transcripts feed AgentCalls.
    await activity.getByRole('button', { name: /重置额度/ }).waitFor();
    assert.ok(await activity.evaluate(node => {
      const pane = node.getBoundingClientRect(), last = node.querySelector('.activity-reset-row').getBoundingClientRect();
      return last.bottom <= pane.bottom && last.bottom <= innerHeight;
    }), 'the reset row and the activity metrics fit in the screenshot');
    await reader.locator('.reading-scroll').hover();
    await page.mouse.wheel(0, -2000);
    await waitFor(() => reader.locator('.reading-scroll').evaluate(node => node.scrollTop === 0), 'the conversation starts at its first message');
    assert.ok(await reader.locator('.reading-scroll').evaluate(node => node.scrollHeight <= node.clientHeight + 1), 'the demo conversation fits without clipping');
    await shot('reading-view.jpg');

    // Git: the change, hunk by hunk.
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 900));
    await page.locator('.focus-sidebar .explorer-tabs').getByRole('button', { name: 'Git 历史', exact: true }).click();
    await page.locator('.git-panel').getByRole('button', { name: '已修改 src/pages/Checkout.tsx', exact: true }).click();
    const diff = page.locator('.git-diff-view');
    await diff.getByRole('listitem', { name: '第 1 处更改', exact: true }).waitFor();
    await diff.getByRole('button', { name: '保留 第 1 处', exact: true }).waitFor();
    assert.ok(await diff.getByRole('button', { name: '还原 第 1 处', exact: true }).isEnabled());
    assert.ok(await diff.locator('.git-line-added').filter({ hasText: '<CouponInput' }).isVisible());
    assert.ok(await diff.locator('.git-line-removed').filter({ hasText: 'const total = totalOf(cart)' }).isVisible());
    await page.locator('.git-history .git-commit-row').filter({ hasText: '结算页初版' }).waitFor();
    await shot('git-review.jpg');
    await diff.getByRole('button', { name: '关闭更改视图', exact: true }).click();
    await setMode(page, projects[0].name, 'terminal');
    await page.getByRole('button', { name: '返回总览', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));

    // Dictation over the payments card.
    await panel(1).locator('.terminal-split-body').click({ position: { x: 40, y: 60 } });
    assert.equal(await page.locator('.focus-mode').count(), 0, 'terminal interaction keeps the small card');
    await page.keyboard.press('Control+t');
    await page.locator('.voice-overlay .voice-title').filter({ hasText: '正在聆听…' }).waitFor();
    await page.locator('.voice-overlay .voice-stage.is-recording').waitFor();
    await waitFor(() => page.locator('.voice-overlay-anchor').evaluate((node, id) => {
      const overlay = node.getBoundingClientRect(), card = document.querySelector(`[data-project-id="${id}"]`).getBoundingClientRect();
      return Math.abs(overlay.left - card.left) < 1 && Math.abs(overlay.top - card.top) < 1 && Math.abs(overlay.width - card.width) < 1;
    }, projects[1].id), 'voice overlay follows the payments card');
    // The recorder opens asynchronously; let its meter and the overlay's entry settle.
    await page.waitForTimeout(1200);
    await shot('voice.jpg');
    await page.keyboard.press('Escape');
    await page.locator('.voice-overlay').waitFor({ state: 'detached' });
    console.log(`README screenshots written to ${images}`);

    if (video) {
      const ffmpeg = process.env.FFMPEG;
      const frames = path.join(work, 'frames'); await fs.mkdir(frames, { recursive: true });
      // Chromium's screencast: every painted frame, with its time, so motion plays back at its real speed.
      const client = await page.context().newCDPSession(page);
      const captured = [], frameWrites = [];
      let frameError;
      const captureFrame = ({ data, metadata, sessionId }) => {
        const file = path.join(frames, `f${String(captured.length).padStart(5, '0')}.jpg`);
        captured.push({ file, time: metadata.timestamp });
        frameWrites.push(fs.writeFile(file, Buffer.from(data, 'base64')).catch(error => { frameError ??= error; })
          .then(() => client.send('Page.screencastFrameAck', { sessionId })).catch(error => { frameError ??= error; }));
      };
      client.on('Page.screencastFrame', captureFrame);
      await page.evaluate(() => document.activeElement?.blur()); await page.mouse.move(800, 2);
      try {
        await client.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1600, maxHeight: 900, everyNthFrame: 1 });
        await page.waitForTimeout(1500);
        // A new recorded request starts work; completion brings back the white awaiting-review glow.
        await append(2, [event('task_started', { turn_id: 't4' }), message('user', 'u-video', '给周活跃图表补上空数据状态')]);
        await waitFor(async () => (await state(2)).codexActivity === 'working', 'dashboard working');
        await page.waitForTimeout(2200);
        await append(2, [message('agent', 'a-video', '已补上空数据提示，图表没有数据时显示下一步操作。'), event('task_complete', { turn_id: 't4' })]);
        await waitFor(async () => (await state(2)).unread > 0, 'dashboard finished');
        await page.waitForTimeout(4200);
        // The storefront opens; its conversation is read as a document while the test run finishes.
        await panel(0).getByRole('button', { name: `全屏查看 ${projects[0].name}`, exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
        await page.waitForTimeout(700);
        await setMode(page, projects[0].name, 'reading');
        await page.locator('.reading-view .reading-markdown h2').waitFor();
        await page.mouse.move(800, 2);
        await page.waitForTimeout(2000);
        await append(0, [done('c4', '18 tests passed.'), message('agent', 'a4', '**18 个测试全部通过。** 优惠券输入框已接入结算页：输入后合计实时更新，未知券码不改价格。'), event('task_complete', { turn_id: 't1' })]);
        await waitFor(async () => (await state(0)).codexActivity === 'complete', 'storefront finished');
        await page.waitForTimeout(3000);
        await page.getByRole('button', { name: '返回总览', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
        await page.waitForTimeout(3500);
      } finally {
        await client.send('Page.stopScreencast').catch(error => { frameError ??= error; });
        client.off('Page.screencastFrame', captureFrame);
        await Promise.all(frameWrites);
        await client.detach();
      }
      assert.ifError(frameError);
      assert.ok(captured.length > 1, 'the video contains painted frames');
      // Each frame lasts until the next one arrived; the concat list carries those durations to ffmpeg.
      const list = captured.map((frame, index) => `file '${frame.file.replaceAll('\\', '/')}'\nduration ${Math.max(1 / 60, (captured[index + 1]?.time ?? frame.time + 1 / 30) - frame.time).toFixed(4)}`).join('\n') + `\nfile '${captured.at(-1).file.replaceAll('\\', '/')}'\n`;
      await fs.writeFile(path.join(work, 'frames.txt'), list);
      const run = args => execFileSync(ffmpeg, ['-y', '-loglevel', 'error', ...args], { windowsHide: true });
      run(['-f', 'concat', '-safe', '0', '-i', path.join(work, 'frames.txt'), '-vf', 'fps=30,scale=1600:-2:flags=lanczos,format=yuv420p', '-c:v', 'libx264', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart', path.join(images, 'demo.mp4')]);
      run(['-i', path.join(images, 'demo.mp4'), '-vf', 'fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=200:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', path.join(images, 'demo.gif')]);
      console.log(`Demo recorded: ${captured.length} frames`);
    }
    assert.deepEqual(errors, [], 'renderer errors');
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(work, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    const child = application?.process();
    try {
      if (application) {
        // Close the owned PTYs through their lifecycle API; app.close also runs before-quit disposal on failure.
        if (page && !page.isClosed()) for (const project of projects) await page.evaluate(id => window.agentrix.closeTerminal(id), project.id).catch(() => {});
        await application.close();
      }
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'the owned Electron process exits', 5000);
      }
      if (demoIdentity) {
        const current = await fs.lstat(demoRoot, { bigint: true });
        assert.equal(path.resolve(demoRoot), 'C:\\AgentrixDemo');
        assert.equal((await fs.realpath(demoRoot)).toLowerCase(), demoRoot.toLowerCase());
        assert.ok(current.isDirectory() && !current.isSymbolicLink() && current.dev === demoIdentity.dev && current.ino === demoIdentity.ino, 'cleanup must own the original demo directory');
        await fs.rm(demoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
        assert.equal(await fs.lstat(demoRoot).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), false, 'demo directory removed');
      }
    }
  }
});
