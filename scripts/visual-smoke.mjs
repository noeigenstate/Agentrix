import { testRun } from './test-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright-core';
import { waitFor } from './wait.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const output = await testRun('visual');
const profile = path.join(output, 'profile'), home = path.join(output, 'codex-home');
const names = ['界面开发', '文档整理', '本地工具', '服务接口', '数据处理', '工具项目'];
const projects = names.map((name, index) => ({ id: randomUUID(), name, path: path.join(output, name), unread: index === 1 ? 1 : 0, lastCompletedAt: index === 1 ? Date.now() - 60000 : null, restore: { terminal: false, codex: false } }));
const doneFile = path.join(projects[0].path, 'task.done');
for (const directory of [profile, path.join(home, 'sessions'), ...projects.map(project => project.path)]) await fs.mkdir(directory, { recursive: true });
await fs.writeFile(path.join(projects[0].path, 'README.md'), '# 清晰的工作区\n\n保留文字、代码和状态的层次。\n');
// These checks read the terminal's rows as HTML, so the compatible (DOM) renderer draws them; gpu-terminal-smoke covers the GPU one.
await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects, settings: { language: 'zh', terminalRenderer: 'dom', notifications: false, sound: false, closeToTray: false, restoreSessions: false, fontSize: 14 } }));
const env = { ...process.env, AGENTRIX_DATA_DIR: profile, CODEX_HOME: home }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
const packaged = process.argv.includes('--packaged');
let app, page;
const state = async () => (await page.evaluate(() => window.agentrix.getState())).value;
const panel = index => page.locator(`[data-project-id="${projects[index].id}"]`);
const write = (index, data) => page.evaluate(({ id, data }) => window.agentrix.writeTerminal(id, data), { id: projects[index].id, data });
const breathing = index => panel(index).evaluate(node => node.getAnimations({ subtree: true }).filter(animation => animation.animationName === 'signal-breathe').length);
async function checkContrast() {
  // Hide only body content in this isolated profile so the screenshot measures the actual
  // composited ground without glyphs or the cursor.
  const selector = '.project-panel:not(.has-unread, .round-complete, .has-error) .panel-terminal-area';
  const mask = await page.addStyleTag({ content: `${selector} > * { visibility: hidden !important; }` });
  try {
    const areas = await page.locator(selector).evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }));
    assert.ok(areas.length >= 2, 'contrast covers working and resting cards');
    const screenshot = await page.screenshot({ path: path.join(output, 'grey-body-contrast.png') });
    const contrasts = await page.evaluate(async ({ png, areas }) => {
      const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      const scaleX = image.width / innerWidth, scaleY = image.height / innerHeight;
      const linear = channel => { const value = channel / 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; };
      return areas.map(box => {
        let brightest = 0;
        // Exclude the status edge and rounded corners; this is the terminal reading surface.
        for (let y = Math.ceil((box.y + 12) * scaleY); y < Math.floor((box.y + box.height - 12) * scaleY); y++) {
          for (let x = Math.ceil((box.x + 12) * scaleX); x < Math.floor((box.x + box.width - 12) * scaleX); x++) {
            const p = (y * image.width + x) * 4;
            brightest = Math.max(brightest, .2126 * linear(pixels[p]) + .7152 * linear(pixels[p + 1]) + .0722 * linear(pixels[p + 2]));
          }
        }
        // The terminal foreground is #f0f0f0: light ink, so its worst ground is the brightest one.
        const ink = .2126 * linear(240) + .7152 * linear(240) + .0722 * linear(240);
        return (Math.max(ink, brightest) + .05) / (Math.min(ink, brightest) + .05);
      });
    }, { png: screenshot.toString('base64'), areas });
    // The ground behind the text is the card's own #242424, so the ink clears 3:1 by a wide margin.
    console.log(`Grey ink contrast with the brightest ground per card: ${contrasts.map(value => value.toFixed(2)).join(', ')}`);
    assert.ok(contrasts.every(value => value >= 3), `white ink stays legible over the brightest ground: ${contrasts.map(value => value.toFixed(2)).join(', ')}`);
    await fs.writeFile(path.join(output, 'grey-contrast.json'), JSON.stringify(contrasts, null, 2));
  } finally { await mask.evaluate(node => node.remove()); }
}
const errors = [];
try {
  app = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Agentrix.exe') : require('electron'), args: packaged ? [] : [root], cwd: root, env });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 900));
  await page.waitForSelector('.project-panel');
  assert.equal((await state()).settings.theme, 'mono');
  for (let index = 0; index < 4; index++) {
    await panel(index).getByRole('button', { name: '只打开终端', exact: true }).click();
    await waitFor(async () => (await state()).projects[index].shellReady, 'native terminal ready');
    await write(index, `Clear-Host; Write-Host 'Agentrix / ${names[index]}'; Write-Host ''; Write-Host '  项目、终端和输入草稿各自独立。'; Write-Host '  Ctrl + 鼠标左键打开文件与链接'; Write-Host ''; Write-Host '  PASS  ANSI colors and readable text' -ForegroundColor Green; Write-Host '  INFO  状态变更后继续工作' -ForegroundColor Cyan\r`);
    await waitFor(async () => panel(index).locator('.xterm-rows').innerText().then(text => text.includes('ANSI colors and readable text')), 'readable terminal output');
  }
  const thread = randomUUID(), transcript = path.join(home, 'sessions', `rollout-${thread}.jsonl`);
  const record = (type, turn) => JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type, turn_id: turn } }) + '\n';
  const submitted = message => JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'user_message', message } }) + '\n';
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  await write(0, `Clear-Host; Write-Host 'Agentrix / 界面开发'; Write-Host ''; Write-Host '  正在处理：验证独立项目的任务状态' -ForegroundColor Cyan; Write-Host '  背景任务运行中，可操作其他窗口。'; Write-Host ''; Send-AgentrixEvent 'codex-started'; for ($pgVisual=0; $pgVisual -lt 2400 -and -not (Test-Path -LiteralPath ${quote(doneFile)}); $pgVisual++) { Start-Sleep -Milliseconds 100 }; Send-AgentrixEvent 'codex-exited'\r`);
  await waitFor(async () => (await state()).projects[0].codexActive, 'offline task active');
  // The running agent's conversation shows as a document by default; these checks are about the terminal surface.
  await panel(0).locator('button[title="切换到终端"]').click();
  await fs.writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id: thread, cwd: projects[0].path, source: 'cli' } }) + '\n' + record('task_started', 'visual-turn') + submitted('验证独立项目的任务状态'));
  await waitFor(async () => panel(0).getAttribute('data-status').then(status => status === 'working'), 'working lifecycle reaches UI');
  await page.evaluate(() => document.activeElement?.blur()); await page.mouse.move(2, 2);
  assert.equal(await page.locator('.panel-edge-light').count(), 0, 'old decorative strips are removed');
  assert.equal(await panel(0).evaluate(node => getComputedStyle(node).animationName), 'none', 'the text surface is not animated');
  // A working turn has a steady hairline-grey 2px edge. Nothing flashes until completion.
  const liveSamples = [];
  for (const mode of ['normal', 'hover', 'input-focus']) {
    if (mode === 'hover') await panel(0).locator('.panel-header').hover();
    if (mode === 'input-focus') { await panel(0).locator('textarea.xterm-helper-textarea').focus(); await page.mouse.move(2, 2); }
    const samples = await panel(0).evaluate(async node => {
      const edge = node.querySelector('.panel-signal'), text = node.querySelector('.xterm-rows');
      const values = [];
      for (let index = 0; index < 12; index++) {
        values.push({ edgeShadow: getComputedStyle(edge).boxShadow, text: { opacity: getComputedStyle(text).opacity, color: getComputedStyle(text).color, animation: getComputedStyle(text).animationName } });
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return values;
    });
    for (const sample of samples) {
      assert.deepEqual(sample, samples[0], `${mode}: working lights and reading surface stay steady`);
      assert.equal(sample.edgeShadow, 'rgb(64, 64, 64) 0px 0px 0px 2px inset', `${mode}: the working edge is the 2px hairline grey`);
      assert.equal(sample.text.opacity, '1'); assert.equal(sample.text.animation, 'none');
    }
    liveSamples.push({ mode, samples });
  }
  assert.equal(await breathing(0), 0, 'a working turn does not flash');
  await page.evaluate(() => document.activeElement?.blur()); await page.mouse.move(2, 2);
  assert.equal(await breathing(1), 0, 'old unread completion stays quiet');
  assert.equal(await breathing(2), 0, 'ready shell stays quiet');
  await page.screenshot({ path: path.join(output, 'grey-working.png') });
  // Every card is one flat #242424 pane with radius 16 (workspace.css): no blur, no shadow, no gradient, and the header band is no fill of its own.
  const pane = await panel(0).evaluate(node => { const style = getComputedStyle(node); return { filter: style.backdropFilter, color: style.backgroundColor, image: style.backgroundImage, shadow: style.boxShadow, radius: style.borderRadius }; });
  assert.deepEqual(pane, { filter: 'none', color: 'rgb(36, 36, 36)', image: 'none', shadow: 'none', radius: '16px' }, `a card is one flat grey pane: ${JSON.stringify(pane)}`);
  const inner = await panel(0).evaluate(node => [node.querySelector('.panel-header')].map(part => {
    const style = getComputedStyle(part);
    return { backdrop: style.backdropFilter, fill: style.backgroundColor, image: style.backgroundImage, shadow: style.boxShadow, margin: style.margin };
  }));
  for (const part of inner) assert.deepEqual([part.backdrop, part.fill, part.image, part.shadow, part.margin], ['none', 'rgba(0, 0, 0, 0)', 'none', 'none', '0px'], `the header is no band of its own: ${JSON.stringify(inner)}`);
  await page.screenshot({ path: path.join(output, `grey.png`) });
  assert.equal(await panel(0).locator('.status-badge').innerText(), '正在处理');
  const chips = await page.locator('.panel-index').evaluateAll(nodes => nodes.map(node => ({ background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color, weight: getComputedStyle(node).fontWeight })));
  assert.ok(chips.every(chip => chip.background === 'rgb(64, 64, 64)' && chip.color === 'rgb(240, 240, 240)' && chip.weight === '600'), `the number chips are one grey tag: ${JSON.stringify(chips)}`);
  assert.equal(await breathing(2), 0, `Catalina: ready shell stays quiet`);
  await checkContrast();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 2, mobile: false });
  await page.screenshot({ path: path.join(output, 'grey-3840x2160.png') });
  await cdp.send('Emulation.clearDeviceMetricsOverride'); await cdp.detach();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(820, 560));
  await page.waitForFunction(() => Math.abs(innerWidth - 820) <= 1); // Windows DPI can round the client width by one CSS pixel.
  const compact = await page.locator('.panel-header').evaluateAll(headers => headers.map(header => {
    const bounds = header.getBoundingClientRect(), name = header.querySelector('.panel-name').getBoundingClientRect();
    return { titleWidth: name.width, inside: [...header.children].filter(child => getComputedStyle(child).display !== 'none').every(child => { const box = child.getBoundingClientRect(); return box.left >= bounds.left && box.right <= bounds.right + 1; }), metaSize: getComputedStyle(header.querySelector('.status-badge')).fontSize };
  }));
  await page.screenshot({ path: path.join(output, 'compact-820x560.png') });
  assert.ok(compact.every(card => card.inside && card.titleWidth >= 70 && parseFloat(card.metaSize) >= 11), JSON.stringify(compact));
  const compactEdges = await page.evaluate(() => {
    const top = document.querySelector('.titlebar').getBoundingClientRect();
    return { top: top.top, left: top.left, right: top.right, width: innerWidth, height: innerHeight };
  });
  assert.ok([compactEdges.top, compactEdges.left, compactEdges.right - compactEdges.width].every(gap => Math.abs(gap) < 1), `compact bars meet viewport edges within DPI rounding: ${JSON.stringify(compactEdges)}`);
  await panel(3).locator('.panel-terminal-area').click({ position: { x: 40, y: 50 } });
  await page.keyboard.type('DRAFT_STAYS_SMALL'); assert.equal(await page.locator('.focus-mode').count(), 0);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 900));
  await panel(0).getByRole('button', { name: `全屏查看 ${names[0]}`, exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  await page.screenshot({ path: path.join(output, 'focused-explorer.png') });
  await page.getByRole('button', { name: '返回总览', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  await fs.appendFile(transcript, record('task_complete', 'visual-turn'));
  await waitFor(async () => panel(0).evaluate(node => node.classList.contains('attention-active')), 'a new completion lights its card');
  // A fresh finished round breathes the white needs-you edge (the ring's opacity only) for its first 9 s, then it stays steady until viewed.
  assert.equal(await breathing(0), 1, 'a fresh finished round breathes its ring');
  const lit = await panel(0).evaluate(node => ({ edge: getComputedStyle(node.querySelector('.panel-signal')).boxShadow, dot: node.querySelector('.status-dot').getAnimations().length }));
  assert.deepEqual(lit, { edge: 'rgb(255, 255, 255) 0px 0px 0px 2px inset', dot: 0 }, `a steady white edge and a still dot: ${JSON.stringify(lit)}`);
  const text = await panel(0).locator('.xterm-rows').evaluate(node => ({ opacity: getComputedStyle(node).opacity, animation: getComputedStyle(node).animationName }));
  assert.deepEqual(text, { opacity: '1', animation: 'none' }, 'terminal text itself never pulses');
  const completed = (await state()).projects[0].lastCompletedAt;
  await page.screenshot({ path: path.join(output, 'fresh-completion.png') });
  // Rerender via settings changes and repeated lifecycle callbacks must not restart an old alert.
  await fs.appendFile(transcript, record('task_complete', 'visual-turn'));
  await page.evaluate(() => window.agentrix.settings({ fontSize: 16 }));
  assert.equal(await breathing(0), 1); assert.equal((await state()).projects[0].lastCompletedAt, completed);
  await page.evaluate(id => window.agentrix.acknowledge(id), projects[0].id);
  await waitFor(async () => panel(0).evaluate(node => node.classList.contains('round-complete')), 'viewed automatic round becomes the steady grey edge');
  assert.equal(await breathing(0), 0);
  assert.equal(await panel(0).locator('.status-badge').innerText(), '本轮已完成');
  assert.equal(await panel(0).locator('.panel-signal').evaluate(node => getComputedStyle(node).boxShadow), 'rgb(163, 163, 163) 0px 0px 0px 2px inset');
  await page.screenshot({ path: path.join(output, 'automatic-completion.png') });
  await panel(0).locator('.panel-terminal-area').click({ position: { x: 40, y: 50 } });
  assert.equal(await page.locator('.focus-mode').count(), 0, 'automatic green does not expand on terminal clicks');
  await fs.appendFile(transcript, record('task_started', 'next-turn') + submitted('继续验证下一轮任务完成后的提醒'));
  await waitFor(async () => panel(0).getAttribute('data-status').then(status => status === 'working'), 'a new submitted turn is working');
  assert.equal(await breathing(0), 0, 'working again stays steady');
  await fs.appendFile(transcript, record('task_complete', 'next-turn'));
  await waitFor(async () => panel(0).evaluate(node => node.classList.contains('attention-active')), 'the next finished turn lights its card');
  // A fresh finished card breathes its ring only with motion on; "off" and "system" under reduced motion keep it a steady white ring.
  const setMotion = async mode => { await page.evaluate(mode => window.agentrix.settings({ focusAnimation: mode }), mode); await page.waitForFunction(mode => document.documentElement.dataset.motion === mode, mode); };
  for (const [preference, mode] of [['no-preference', 'smooth'], ['reduce', 'smooth'], ['reduce', 'system'], ['no-preference', 'off'], ['no-preference', 'smooth']]) {
    await page.emulateMedia({ reducedMotion: preference });
    await setMotion(mode);
    const still = mode === 'off' || mode === 'system' && preference === 'reduce';
    assert.equal(await breathing(0), still ? 0 : 1, `${still ? 'no breathing' : 'breathing'} with ${mode} motion and ${preference}`);
  }
  await page.screenshot({ path: path.join(output, 'finished-steady.png') });
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ packaged, liveSamples, compact, compactEdges, errors }, null, 2));
  console.log(`PASS: steady grey working edge, ink contrast on the card grey, a steady white edge on completion, quiet idle, flat grey cards, high DPI, compact controls, explorer and preserved small-card input. Screenshots: ${output}`);
} catch (error) {
  console.error(error);
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    console.error('Visual test viewport:', await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio })).catch(() => null));
  }
  throw error;
} finally {
  // Release our simulated task and exit only this isolated profile's shells
  // before Electron tears down ConPTY handles.
  await fs.writeFile(doneFile, 'done');
  if (app) {
    try {
      if (page && !page.isClosed()) {
        const active = (await state()).projects.filter(project => project.sessionId && project.status !== 'exited');
        if (active.some(project => project.id === projects[0].id)) await waitFor(async () => {
          const project = (await state()).projects.find(project => project.id === projects[0].id);
          return project.shellReady || project.status === 'exited';
        }, 'visual task returned to its shell');
        for (const project of active) await page.evaluate(id => window.agentrix.writeTerminal(id, '\x03exit\r'), project.id);
        await waitFor(async () => (await state()).projects.every(project => !project.sessionId || project.status === 'exited'), 'visual fixture shells exited');
        console.log('PASS: isolated visual task and terminal processes exited before closing the app');
      }
    } finally { await app.close(); }
  }
}
