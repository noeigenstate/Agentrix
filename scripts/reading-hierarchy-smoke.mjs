// A real reading view with fixture conversations, isolated from the owner's sessions and clipboard.
import { testRun } from './test-output.mjs';
import { waitFor } from './wait.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executableOption = process.argv.indexOf('--executable');
const executable = executableOption >= 0 ? process.argv[executableOption + 1] : null;
if (executableOption >= 0 && !executable) throw new Error('--executable needs an application path');
const packaged = process.argv.includes('--packaged') || !!executable;
const output = await testRun('reading-hierarchy'), profile = path.join(output, 'profile'), home = path.join(output, 'codex-home');
const claudeHome = path.join(output, 'claude-home');
const project = { id: randomUUID(), name: '对话分层预览', path: path.join(output, 'project'), restore: { terminal: false, codex: false } };
for (const directory of [profile, home, claudeHome, project.path]) await fs.mkdir(directory, { recursive: true });
await fs.writeFile(path.join(project.path, 'large.txt'), 'A'.repeat(256 * 1024) + '\nPAGE_TWO_MARKER\n');
await fs.writeFile(path.join(project.path, 'slow-save.txt'), 'original');
await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects: [project], settings: { language: 'zh', startView: 'workspace', focusAnimation: 'off', terminalRenderer: 'dom', restoreSessions: false, notifications: false, sound: false, announce: false, closeToTray: false, activityPane: false, guideVersion: '9.9.9' } }));
const env = { ...process.env, AGENTRIX_DATA_DIR: profile, CODEX_HOME: home, CLAUDE_CONFIG_DIR: claudeHome };
delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
const at = new Date(2026, 9, 17, 22, 10).getTime();
const message = (id, role, text, offset = 0) => ({ id, role, text, at: at + offset });
const tool = (id, kind, target, done = true, failed = false, offset = 60000) => ({ id, role: 'tool', at: at + offset, tool: { kind, tool: kind === 'skill' ? 'Skill' : 'exec_command', target, detail: '', done, failed } });
const entries = [
  message('u1', 'user', '先核对项目进度，再运行相关检查。'),
  tool('s1', 'skill', 'model-routing'),
  message('a1', 'assistant', '我先核对项目记录、当前代码和发布状态。', 60000),
  tool('c1', 'command', 'git status --short'), tool('c2', 'command', 'git log -6 --oneline'),
  message('a2', 'assistant', '已确认发布状态，接下来检查当前改动。', 120000),
  tool('c3', 'command', 'npm run build', true, false, 120000),
  message('a3', 'assistant', '**核对完成。** 技能和运行命令现在都属于这轮机器人回复。', 180000),
];
let app, page;
const errors = [];
try {
  app = await electron.launch({ executablePath: executable ? path.resolve(executable) : packaged ? path.join(root, 'release/win-unpacked/Agentrix.exe') : require('electron'), args: packaged ? [] : [root], cwd: root, env });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow, ipcMain }, entries) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1366, 900);
    globalThis.hierarchyEntries = entries;
    ipcMain.removeHandler('terminal:conversation');
    ipcMain.handle('terminal:conversation', () => ({ ok: true, value: globalThis.hierarchyEntries }));
  }, entries);
  await page.waitForSelector('.project-panel');
  const card = page.locator(`[data-project-id="${project.id}"]`);
  await card.getByRole('button', { name: '只打开终端', exact: true }).click();
  const state = async () => (await page.evaluate(() => window.agentrix.getState())).value.projects[0].terminals[0];
  await waitFor(async () => (await state()).shellReady, 'isolated shell ready');
  await page.evaluate(id => window.agentrix.writeTerminal(id, "function global:prompt { 'hierarchy-fixture> ' }; Send-AgentrixEvent 'codex-started'\r"), project.id);
  await waitFor(async () => (await state()).codexActive, 'fixture agent active');
  if (!await page.locator('.focus-mode').count()) await card.getByRole('button', { name: `进入 ${project.name}`, exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  if (!await card.locator('.reading-view').count()) await page.locator('.titlebar-tools').getByRole('button', { name: '阅读视图：按文档排版显示对话', exact: true }).click();
  await card.locator('.reading-tools-head').first().waitFor();
  const reader = card.locator('.reading-scroll');
  const geometry = async () => reader.evaluate(node => {
    const tools = [...node.querySelectorAll('.reading-tools')];
    return {
      parents: tools.every(tool => !!tool.closest('.reading-step.is-agent')),
      peerTools: node.querySelectorAll('.reading-content > .reading-step.is-tools').length,
      agentCount: node.querySelectorAll('.reading-content > .reading-step.is-agent').length,
      inset: tools.map(tool => Math.round(tool.getBoundingClientRect().left - tool.closest('.reading-step.is-agent').querySelector('.reading-node').getBoundingClientRect().right)),
      overflow: node.scrollWidth - node.clientWidth,
    };
  });
  const checkGeometry = async label => {
    const result = await geometry();
    assert.equal(result.parents, true, `${label}: tools belong to the agent`);
    assert.equal(result.peerTools, 0, `${label}: no tools on the main rail`);
    assert.equal(result.agentCount, 1, `${label}: one parent agent per turn`);
    assert.ok(result.inset.every(value => value >= 10), `${label}: tool groups are visibly inset`);
    assert.ok(result.overflow <= 1, `${label}: no horizontal overflow`);
    console.log(label, JSON.stringify(result));
  };
  await checkGeometry('catalina focused');
  await reader.evaluate(node => { node.scrollTop = 0; });
  await page.mouse.move(5, 5);
  await reader.screenshot({ path: path.join(output, 'catalina-focused.png') });
  const command = card.locator('.reading-tools-head').filter({ hasText: '运行 2 条命令' });
  await command.click();
  assert.equal(await command.getAttribute('aria-expanded'), 'true');
  await card.locator('.reading-tools-tree').getByText('git status --short', { exact: true }).waitFor();
  await reader.screenshot({ path: path.join(output, 'catalina-expanded.png') });
  await command.click(); assert.equal(await command.getAttribute('aria-expanded'), 'false');
  // Refreshing a stream must preserve the expanded tool component and its parent.
  await command.click();
  const publish = async next => app.evaluate(({ BrowserWindow }, { id, entries }) => {
    globalThis.hierarchyEntries = entries;
    BrowserWindow.getAllWindows()[0].webContents.send('terminal:conversation', { id, list: entries });
  }, { id: project.id, entries: next });
  await publish([...entries, tool('running', 'command', 'npm test', false)]);
  await card.locator('.reading-tool-command.is-running').waitFor();
  assert.equal(await command.getAttribute('aria-expanded'), 'true', 'a stream update preserves expanded commands');
  await checkGeometry('streaming');
  await publish(entries);
  await waitFor(async () => await card.locator('.reading-tool-command.is-running').count() === 0, 'running fixture removed');
  await command.click();
  await page.keyboard.press('Control+Shift+g');
  await page.waitForFunction(() => !document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(650, 800));
  await checkGeometry('compact');
  await reader.evaluate(node => { node.scrollTop = 0; });
  await reader.screenshot({ path: path.join(output, 'compact.png') });
  assert.equal(await page.locator('.focus-mode').count(), 0, 'tool interaction preserves compact mode');
  // The intercepted conversation endpoint must model the new agent's empty transcript too.
  // Otherwise its first refresh immediately reloads the previous provider's fixture.
  await app.evaluate(() => { globalThis.hierarchyEntries = []; });
  await page.evaluate(id => window.agentrix.writeTerminal(id, "Send-AgentrixEvent 'codex-started' -Agent 'claude'\r"), project.id);
  await waitFor(async () => (await state()).agent === 'claude', 'Claude fixture active');
  // The main log is empty in this injected fixture, so its no-op reset emits no packet. Model the
  // new provider's reset explicitly and await the real renderer buffer before publishing its entries.
  await publish([]);
  await waitFor(async () => await reader.locator('.reading-assistant').count() === 0, 'new provider fixture reset reaches the reader');
  await publish(entries);
  await reader.getByText('核对完成。', { exact: true }).waitFor();
  await reader.locator('.reading-content > .reading-step.is-agent.is-claude').waitFor();
  await checkGeometry('Claude');
  await reader.screenshot({ path: path.join(output, 'claude-compact.png') });
  // A fresh turn starts a fresh parent, including a turn containing tools only.
  await publish([...entries, message('u2', 'user', '再运行一次检查。', 240000), tool('only', 'command', 'npm test')]);
  await waitFor(async () => await reader.locator('.reading-content > .reading-step.is-agent').count() === 2, 'tool-only turn has its own parent');
  await reader.locator('.reading-content > .reading-step.is-agent').last().locator('.reading-tools').waitFor();
  assert.equal(await reader.locator('.reading-content > .reading-step.is-user').count(), 2);
  const longTurn = [message('long-user', 'user', '验证长回合的展开状态。'), ...Array.from({ length: 399 }, (_, index) => index === 380
    ? tool('long-tool', 'command', 'keep-open-marker')
    : message(`long-${index}`, 'assistant', `步骤 ${index}`))];
  await publish(longTurn);
  await reader.getByText('步骤 398', { exact: true }).waitFor();
  const held = reader.locator('.reading-tools-head');
  await held.waitFor();
  assert.equal(await held.count(), 1, 'the rolling fixture has one tool group');
  // Establish expansion before capturing identity: click toggles React state, and a locator re-resolves.
  if (await held.getAttribute('aria-expanded') !== 'true') await held.click();
  await waitFor(async () => await held.getAttribute('aria-expanded') === 'true', 'rolling fixture commands expanded');
  assert.equal(await held.getAttribute('aria-expanded'), 'true');
  await reader.locator('.reading-tools-tree').getByText('keep-open-marker', { exact: true }).waitFor();
  const headingTime = await reader.locator('.reading-step.is-agent > .reading-step-body > .reading-step-head time').innerText();
  await held.evaluate(node => { globalThis.hierarchyHeldButton = node; });
  for (let index = 399; index < 403; index++) {
    longTurn.push(message(`long-${index}`, 'assistant', `步骤 ${index}`));
    await publish(longTurn.slice(-400));
    await reader.getByText(`步骤 ${index}`, { exact: true }).waitFor();
    assert.equal(await held.getAttribute('aria-expanded'), 'true', 'rolling eviction preserves tool expansion');
    assert.equal(await reader.evaluate(node => globalThis.hierarchyHeldButton === node.querySelector('.reading-tools-head')), true, 'the expanded tool DOM survives rolling snapshots');
    assert.equal(await reader.locator('.reading-step.is-agent > .reading-step-body > .reading-step-head time').innerText(), headingTime, 'turn timestamp survives eviction');
  }
  const queuedPrompt = { ...message('queued-from-cli', 'user', '终端排队消息可见。', 300000), queued: true };
  await publish([...entries, queuedPrompt]);
  await reader.getByText(queuedPrompt.text, { exact: true }).waitFor();
  assert.equal(await reader.getByText(queuedPrompt.text, { exact: true }).count(), 1, 'transcript-only queue is visible once');
  await publish([...entries, { ...queuedPrompt, queued: false }, message('queue-answer', 'assistant', '已接收排队消息。', 360000)]);
  await reader.getByText('已接收排队消息。', { exact: true }).waitFor();
  assert.equal(await reader.getByText(queuedPrompt.text, { exact: true }).count(), 1, 'accepted queue has one user card');
  await publish([...entries, message('file-link', 'assistant', '[打开大文件](large.txt)', 360000)]);
  await reader.getByRole('link', { name: '打开大文件', exact: true }).click();
  const popup = page.getByRole('dialog', { name: 'large.txt', exact: true });
  await popup.waitFor();
  await popup.getByRole('button', { name: '下一页', exact: true }).click();
  await popup.getByText('PAGE_TWO_MARKER', { exact: false }).waitFor();
  await popup.screenshot({ path: path.join(output, 'popup-second-page.png') });
  await popup.getByRole('button', { name: '关闭', exact: true }).click();
  await popup.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.focus-mode').count(), 0, 'popup page navigation keeps the card small');
  await card.getByRole('button', { name: `进入 ${project.name}`, exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  await page.evaluate(() => window.agentrix.settings({ autoSave: true }));
  await page.getByRole('treeitem', { name: 'slow-save.txt', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '文件编辑器', exact: true });
  await editor.waitFor();
  const baseline = await page.evaluate(id => window.agentrix.readFile(id, 'slow-save.txt'), project.id);
  assert.equal(baseline.ok, true);
  await app.evaluate(({ ipcMain }, baseline) => {
    globalThis.hierarchySaveCalls = []; globalThis.hierarchySavedPreview = baseline;
    ipcMain.removeHandler('project:save-file');
    ipcMain.handle('project:save-file', async (_event, id, filename, page, revision, content) => {
      const index = globalThis.hierarchySaveCalls.length;
      globalThis.hierarchySaveCalls.push({ id, filename, page, revision, content });
      if (index === 0) await new Promise(resolve => { globalThis.hierarchyReleaseSave = resolve; });
      if (index && revision !== globalThis.hierarchySavedPreview.revision) return { ok: false, error: 'stale fixture revision' };
      globalThis.hierarchySavedPreview = { ...globalThis.hierarchySavedPreview, content, revision: `saved-${index}`, size: Buffer.byteLength(content) };
      return { ok: true, value: globalThis.hierarchySavedPreview };
    });
  }, baseline.value);
  await editor.fill('edit A');
  await waitFor(() => app.evaluate(() => globalThis.hierarchySaveCalls.length === 1), 'first autosave begins');
  await editor.fill('edit B during a slow save');
  await page.waitForTimeout(1200);
  assert.equal(await app.evaluate(() => globalThis.hierarchySaveCalls.length), 1, 'autosaves do not write concurrently');
  await app.evaluate(() => globalThis.hierarchyReleaseSave());
  await waitFor(() => app.evaluate(() => globalThis.hierarchySavedPreview.content === 'edit B during a slow save'), 'latest edit saved after the slow write');
  assert.equal(await editor.inputValue(), 'edit B during a slow save');
  await page.locator('.file-preview').screenshot({ path: path.join(output, 'autosave-latest.png') });
  assert.deepEqual(errors, []);
  console.log(`PASS reading hierarchy and file regressions: leading skills, command branches, expansion across 400-entry eviction, queued transcript messages, popup pagination, latest autosave, both agents, Catalina and compact cards. Screenshots: ${output}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
}
