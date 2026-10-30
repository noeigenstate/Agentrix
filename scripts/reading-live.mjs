// The reading view against the real Claude Code and Codex on this machine, scenario by scenario: Markdown answers,
// tool calls, a permission request, a question, an interrupted turn, a follow-up sent while the agent works, a
// multi-line prompt, reading back while an answer streams, leaving the project mid-answer, /clear and switching views. After every turn it compares the reading
// view with what the agent did (its own terminal screen and the window's state) and records how long the answer
// took to reach the reading view after the terminal showed it. It spends a few tokens.
// Run: node scripts/reading-live.mjs [claude|codex]
import { testRun } from './test-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = await testRun('reading-live');
const agents = process.argv[2] ? [process.argv[2]] : ['claude', 'codex'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
const check = (agent, scenario, name, ok, detail = '') => { results.push({ agent, scenario, name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${agent} · ${scenario} · ${name}${detail ? ` — ${detail}` : ''}`); };
// Text as words, so Markdown rendering and terminal wrapping compare equal.
const words = text => text.replace(/[`*#>|_\-─│•●⏺⎿]+/g, ' ').replace(/\s+/g, ' ').trim();

for (const agent of agents) {
  const profile = path.join(output, agent, 'profile');
  const project = { id: randomUUID(), name: '阅读实测', path: path.join(root, '.test-output', 'slash-live-project'), restore: { terminal: false, codex: false } };
  await fs.mkdir(profile, { recursive: true }); await fs.mkdir(project.path, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', project.path, ...args], { encoding: 'utf8', windowsHide: true });
  try { git('rev-parse', '--git-dir'); } catch { git('init', '-b', 'main'); git('config', 'user.name', 'Reading Test'); git('config', 'user.email', 'reading@example.invalid'); await fs.writeFile(path.join(project.path, 'README.md'), '# Reading test\n'); git('add', '.'); git('commit', '-m', 'base'); }
  await fs.writeFile(path.join(project.path, 'notes.txt'), 'alpha\nbeta\ngamma\n');
  await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects: [project], settings: { terminalRenderer: 'dom', restoreSessions: false, closeToTray: false, notifications: false, sound: false, announce: false, language: 'zh' } }));
  // codex-home: real login on purpose (live scenario, run by hand)
  const env = { ...process.env, AGENTRIX_DATA_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
  for (const name of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_EFFORT$|CLAUDE_PID$)/.test(name)) delete env[name];
  const app = await electron.launch({ executablePath: require('electron'), args: [root], cwd: root, env });
  const page = await app.firstWindow();
  let crashed = false; page.on('crash', () => { crashed = true; console.log('renderer crashed'); });
  try {
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1500, 950); window.webContents.setBackgroundThrottling(false); window.setFocusable(false); });
    await page.waitForSelector('.project-panel');
    const card = page.locator(`[data-project-id="${project.id}"]`), terminal = page.locator(`[data-terminal-id="${project.id}"]`), composer = terminal.locator('.reading-composer textarea');
    const state = async () => (await page.evaluate(() => window.agentrix.getState())).value.projects[0].terminals[0];
    const screenText = async () => (await terminal.locator('.xterm-rows > div').allTextContents()).join('\n');
    const readingText = async () => (await terminal.locator('.reading-content').innerText().catch(() => ''));
    const shot = async name => page.screenshot({ path: path.join(output, agent, `${name}.png`) }).catch(() => {});
    await card.getByRole('button', { name: `进入 ${project.name}`, exact: true }).click();
    await card.getByRole('button', { name: '只打开终端', exact: true }).click();
    for (let i = 0; i < 150 && !(await state()).shellReady; i++) await sleep(200);
    await page.evaluate(({ id, agent }) => window.agentrix.writeTerminal(id, agent + '\r'), { id: project.id, agent });
    for (let i = 0; i < 150 && !(await state()).codexActive; i++) await sleep(300);
    await composer.waitFor({ state: 'visible' }); await sleep(4000);

    // Sends a prompt and waits for the round to end. While it runs, notes when the marker first shows in the terminal
    // and in the reading view, and whether the view says it is working.
    const turn = async (scenario, prompt, marker, { interruptAfter, during } = {}) => {
      const sent = Date.now();
      await composer.fill(prompt); await composer.press('Enter');
      let inTerminal = null, inReading = null, sawWorking = false, interrupted = false;
      for (let i = 0; i < 600; i++) {
        await sleep(200);
        const s = await state();
        if (await terminal.locator('.reading-status.is-working').count()) sawWorking = true;
        if (during) await during({ elapsed: Date.now() - sent, text: await readingText() });
        if (marker && inTerminal === null && (await screenText()).includes(marker)) inTerminal = Date.now();
        if (marker && inReading === null && (await readingText()).includes(marker)) inReading = Date.now();
        if (interruptAfter && !interrupted && Date.now() - sent > interruptAfter) { interrupted = true; await composer.press('Escape').catch(() => {}); await page.evaluate(id => window.agentrix.writeTerminal(id, '\x1b'), project.id); }
        if (Date.now() - sent > 5000 && s.codexActivity !== 'working' && (!marker || inReading !== null || interrupted)) break;
      }
      await sleep(1500);
      const after = await state(), text = await readingText();
      check(agent, scenario, 'showed it was working', sawWorking);
      check(agent, scenario, 'not stuck working afterwards', !(await terminal.locator('.reading-status.is-working').count()), `activity ${after.codexActivity}`);
      check(agent, scenario, 'message box usable afterwards', await composer.isEnabled().catch(() => false));
      check(agent, scenario, 'card no longer working', after.codexActivity !== 'working', after.codexActivity);
      const firstLine = prompt.split('\n')[0].slice(0, 18);
      check(agent, scenario, 'prompt shown once', text.split(firstLine).length - 1 === 1, `${text.split(firstLine).length - 1} times`);
      check(agent, scenario, 'no prompt left pending', !(await terminal.locator('.reading-pending').count()));
      if (marker && !interrupted) {
        check(agent, scenario, 'answer reached the reading view', inReading !== null);
        if (inTerminal && inReading) check(agent, scenario, 'answer delay after the terminal', inReading - inTerminal < 2500, `${inReading - inTerminal} ms`);
      }
      // No answer block repeated back to back.
      const blocks = await terminal.locator('.reading-assistant').allInnerTexts();
      const repeated = blocks.findIndex((block, index) => index && words(block) && words(block) === words(blocks[index - 1]));
      check(agent, scenario, 'no repeated answer blocks', repeated < 0, repeated < 0 ? '' : words(blocks[repeated]).slice(0, 60));
      await shot(scenario);
      await fs.writeFile(path.join(output, agent, `${scenario}.screen.txt`), await screenText());
      return { text, blocks };
    };

    const answerCard = async (scenario, prompt, marker, answer) => {
      const sent = Date.now(), host = terminal.locator('.reading-choice');
      await composer.fill(prompt); await composer.press('Enter');
      while (Date.now() - sent < 120000 && !(await host.count()) && (Date.now() - sent < 8000 || (await state()).codexActivity === 'working')) await sleep(300);
      if (!(await host.count())) { console.log(`INFO ${agent} · ${scenario} · no card appeared (the agent did not ask)`); return null; }
      await shot(`${scenario}-card`);
      const options = await host.locator('.reading-choice-option').allInnerTexts();
      check(agent, scenario, 'card lists the choices', options.length >= 2, options.map(words).join(' / ').slice(0, 120));
      check(agent, scenario, 'message box steps aside for the card', !(await composer.isVisible().catch(() => false)) || !(await composer.isEnabled().catch(() => true)));
      await answer(host);
      const answered = Date.now();
      while (Date.now() - answered < 8000 && await host.count()) await sleep(200);
      check(agent, scenario, 'card closes after answering', !(await host.count()), `${Date.now() - answered} ms`);
      let reached = false;
      for (let i = 0; i < 600 && !(reached && (await state()).codexActivity !== 'working'); i++) {
        await sleep(200);
        if (await host.count()) await answer(host);  // a follow-up page (Claude's review, a second request)
        reached ||= (await readingText()).includes(marker);
      }
      await sleep(1500);
      check(agent, scenario, 'answer reached the reading view', (await readingText()).includes(marker));
      check(agent, scenario, 'not stuck working afterwards', !(await terminal.locator('.reading-status.is-working').count()), `activity ${(await state()).codexActivity}`);
      check(agent, scenario, 'message box usable afterwards', await composer.isEnabled().catch(() => false));
      await shot(scenario);
      await fs.writeFile(path.join(output, agent, `${scenario}.screen.txt`), await screenText());
      return true;
    };
    const firstOption = async host => { await host.locator('.reading-choice-option').first().click().catch(() => {}); await sleep(800); };
    const pickLabel = label => async host => {
      const option = host.locator('.reading-choice-option').filter({ hasText: label });
      await ((await option.count()) ? option.first() : host.locator('.reading-choice-option').first()).click().catch(() => {});
      await sleep(800);
    };

    const markdown = await turn('markdown', '用 Markdown 写一段很短的说明：一个二级标题“示例”，一个三项列表，一个 2 列 2 行的表格，一个 PowerShell 代码块。最后单独一行写 MARK-1。不要调用任何工具。', 'MARK-1');
    check(agent, 'markdown', 'heading, list, table and code rendered', await terminal.locator('.reading-markdown h2').count() > 0 && await terminal.locator('.reading-markdown li').count() >= 3 && await terminal.locator('.reading-markdown table').count() > 0 && await terminal.locator('.reading-code').count() > 0);
    check(agent, 'markdown', 'no raw Markdown left', !/^\s*(##|\|---|```)/m.test(markdown.blocks.join('\n')));

    await turn('tools', '读取 notes.txt 的内容，再运行一个列出当前目录文件的命令，然后用一句话总结。最后单独一行写 MARK-2。', 'MARK-2');
    check(agent, 'tools', 'tool calls grouped', await terminal.locator('.reading-tools').count() > 0);

    // A command that changes the folder: in the default permission mode the agent asks first.
    if (await answerCard('permission', '用命令行在当前目录创建文件 perm-test.txt，内容为 ok（必须执行命令，不要只描述）。完成后单独一行写 MARK-P。', 'MARK-P', firstOption))
      check(agent, 'permission', 'the approved command ran', await fs.readFile(path.join(project.path, 'perm-test.txt'), 'utf8').then(() => true, () => false));
    await fs.rm(path.join(project.path, 'perm-test.txt'), { force: true });

    if (agent === 'claude') await answerCard('question', '请调用 AskUserQuestion 工具问我一个单选问题：“选哪种颜色？”，选项为“红色”和“蓝色”。我回答后，只回复我选的颜色，并单独一行写 MARK-Q。', 'MARK-Q', pickLabel('蓝色'));
    if (agent === 'claude') check(agent, 'question', 'the chosen answer reached the agent', /蓝/.test((await terminal.locator('.reading-assistant').allInnerTexts()).at(-1) ?? ''));

    await turn('interrupt', '写一篇 1500 字的文章，介绍终端模拟器从电传打字机到现代 GPU 渲染的历史。最后单独一行写 MARK-3。', null, { interruptAfter: 6000 });
    await turn('follow-up', '只回复：MARK-4', 'MARK-4');

    // A second prompt sent while the first is still being answered: both show once and both get answered.
    let queued = false;
    await turn('queued', '从 1 数到 40，每行一个数字。最后单独一行写 MARK-6A。', 'MARK-6B', { during: async ({ elapsed }) => {
      if (queued || elapsed < 2500) return;
      queued = true; await composer.fill('再只回复：MARK-6B'); await composer.press('Enter');
      const popup = terminal.locator('.reading-terminal-popup');
      if (await popup.count()) {
        check(agent, 'queued', 'busy CLI kept the composer draft', await composer.inputValue() === '再只回复：MARK-6B');
        await popup.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('再只回复：MARK-6B'); await page.keyboard.press('Enter');
        await popup.getByRole('button', { name: '关闭', exact: true }).click(); await composer.fill('');
      }
    } });
    const queuedText = await readingText();
    check(agent, 'queued', 'first answer kept', queuedText.includes('MARK-6A'));
    check(agent, 'queued', 'second prompt shown once', queuedText.split('再只回复：MARK-6B').length - 1 === 1, `${queuedText.split('再只回复：MARK-6B').length - 1} times`);

    await turn('multi-line', '第一行：这是一条两行的消息。\n第二行：只回复 MARK-7。', 'MARK-7');
    const lastUser = (await terminal.locator('.reading-user').allInnerTexts()).at(-1) ?? '';
    check(agent, 'multi-line', 'both lines kept in the message', lastUser.includes('第一行') && lastUser.includes('第二行'), words(lastUser).slice(0, 80));

    // Reading back while a long answer streams: the view stays where the reader put it and offers a way back down.
    const scroller = terminal.locator('.reading-scroll');
    let held = null, drift = 0;
    await turn('read back', '列出 1 到 80，每行格式为“第 N 行：一句关于终端的短句”。最后单独一行写 MARK-8。', 'MARK-8', { during: async ({ elapsed }) => {
      // Earlier turns give room to scroll back even before this answer shows.
      if (held === null && elapsed > 2500) { await scroller.hover(); for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -4000); await sleep(300); held = await scroller.evaluate(node => node.scrollTop); return; }
      if (held !== null) drift = Math.max(drift, await scroller.evaluate(node => node.scrollTop));
    } });
    if (held === null) console.log(`INFO ${agent} · read back · the answer arrived too quickly to scroll during it`);
    else {
      check(agent, 'read back', 'view stayed where the reader scrolled', drift < 80, `moved ${drift} px`);
      const jump = terminal.locator('.reading-jump');
      check(agent, 'read back', 'a way back to the latest message', await jump.isVisible().catch(() => false));
      await jump.click().catch(() => {}); await sleep(1200);
      check(agent, 'read back', 'jump lands on the latest message', await scroller.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight < 40));
    }

    // Leaving the project while it answers and coming back: nothing lost, nothing doubled.
    let left = false;
    await turn('leave and return', '用三段话介绍 xterm.js，每段两句。最后单独一行写 MARK-9。', 'MARK-9', { during: async ({ elapsed }) => {
      if (left || elapsed < 3000) return;
      left = true;
      await page.getByRole('button', { name: '返回总览', exact: true }).first().click().catch(() => {});
      await sleep(2500);
      await card.getByRole('button', { name: `进入 ${project.name}`, exact: true }).click().catch(() => {});
      await composer.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    } });
    check(agent, 'leave and return', 'returned to the reading view', await composer.isVisible().catch(() => false));

    await terminal.locator('.reading-scroll').evaluate(node => { node.scrollTop = 0; });
    await page.locator('.titlebar-tools').getByRole('button', { name: '切换到终端', exact: true }).click();
    await sleep(1500);
    await page.locator('.titlebar-tools').getByRole('button', { name: '阅读视图：按文档排版显示对话', exact: true }).click();
    await composer.waitFor({ state: 'visible' }); await sleep(1500);
    check(agent, 'switch views', 'conversation kept after switching', (await readingText()).includes('MARK-4'));
    check(agent, 'switch views', 'back on the latest message', await terminal.locator('.reading-scroll').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight < 40));

    await composer.fill('/clear'); await composer.press('Enter');
    const clearPopup = terminal.locator('.reading-terminal-popup');
    await clearPopup.waitFor();
    check(agent, 'clear', 'real terminal opened', await clearPopup.locator('.xterm').count() === 1);
    const cleared = Date.now();
    await sleep(1500);
    check(agent, 'clear', 'old conversation gone after /clear', !(await readingText()).includes('MARK-4'));
    while (Date.now() - cleared < 15000 && !(await composer.isEnabled().catch(() => false))) await sleep(200);
    check(agent, 'clear', 'message box usable soon after /clear', Date.now() - cleared < 4000, `${Date.now() - cleared} ms`);
    await fs.writeFile(path.join(output, agent, 'clear.screen.txt'), await screenText());
    await shot('clear');
    await clearPopup.getByRole('button', { name: '关闭', exact: true }).click();
    await clearPopup.waitFor({ state: 'detached' });
    await turn('after clear', '只回复：MARK-5', 'MARK-5');
    if (agent === 'codex') {
      await composer.focus(); await composer.press('Shift+Tab'); await sleep(1500);
      await answerCard('question', '请调用 request_user_input 问我一个单选问题：“选哪种颜色？”，选项为“红色”和“蓝色”。我回答后，只回复我选的颜色，并单独一行写 MARK-Q。', 'MARK-Q', pickLabel('蓝色'));
    }
    check(agent, 'whole run', 'renderer never crashed', !crashed);
  } catch (error) {
    check(agent, 'harness', 'scenario ran to the end', false, error.message.split('\n')[0]);
    await page.screenshot({ path: path.join(output, agent, 'failure.png') }).catch(() => {});
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  }
}
await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
const failed = results.filter(result => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Evidence: ${output}`);
process.exitCode = failed.length ? 1 : 0;
