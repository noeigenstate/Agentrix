// The model dashboard window, in the real app: opened once from the app menu, both pages showing seeded numbers, the project
// and range filters changing them, 采纳 changing a routing weight and 撤销 taking it back, keyboard focus visible, dark and light,
// 1180×820, 900×820 and the 820×600 minimum. Needs the main-process side (electron/features/dashboard) to be wired in main.cjs.
//
//   node scripts/dashboard-smoke.mjs          # both themes
//   node scripts/dashboard-smoke.mjs light    # one theme: mono (dark) or light
//
// The profile is isolated (AGENTRIX_DATA_DIR, CODEX_HOME and CLAUDE_CONFIG_DIR under .test-output) and seeded with fixture
// dashboard/*.jsonl records and two git projects with a team journal; the owner's real Agentrix is never touched. Screenshots and
// results.json land in the run's .test-output folder. The whole run holds the GUI lock.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { chooseFromAppMenu } from './app-menu-helper.mjs';
import { withGuiLock } from './gui-lock.mjs';
import { pick } from './select-helper.mjs';
import { testRun } from './test-output.mjs';
import { waitFor } from './wait.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url);
const packaged = process.argv.includes('--packaged');
const themes = process.argv.slice(2).filter(name => ['mono', 'light'].includes(name));
const DAY = 86_400_000, now = Date.now(), ago = days => now - days * DAY;

// ---- the fixture ---------------------------------------------------------------------------------------------------------------
// Execution runs per project and age: agentrix 4 in the last week, 3 more within 30 days, 2 older; site 2, 1 and 1. So the
// counts are: 7 days 6, 30 days 10, all 13; site alone in 30 days 3.
const PROJECTS = [{ id: 'p-agentrix', name: 'agentrix' }, { id: 'p-site', name: 'site' }];
const RUNS = [['p-agentrix', [1, 2, 3, 5, 12, 18, 25, 40, 60]], ['p-site', [2, 4, 15, 45]]];
const EXPECTED = { runs: { '7 天': 6, '30 天': 10, 全部: 13 }, siteRuns30: 3, rounds: { '7 天': 2, '30 天': 3, 全部: 4 }, siteRounds30: 1,
  modelTasks30: { 'gpt-6.1-sol': 6, 'gpt-6.1-terra': 4, 'claude-opus-5-5': 0 } };

const run = (project, days, index) => ({ v: 1, at: ago(days), id: `run-${project.id}-${index}`, projectId: project.id, project: project.name, agent: 'codex', model: index % 3 ? 'gpt-6.1-sol' : 'gpt-6.1-terra',
  effort: 'max', role: '执行', kind: index % 3 ? 'core' : 'ui-check', title: `fixture ${index}`, meeting: days <= 3 ? 'r-recent' : null, startedAt: ago(days) - 600000, endedAt: ago(days),
  activeMs: 480000 + index * 20000, outputTokens: 40000 + index * 1000, totalOutputTokens: 40000 + index * 1000, inputTokens: 90000, cachedTokens: 60000, reportedCostUsd: null,
  reason: 'exit', exitCode: 0, outOfScope: index === 2 ? 1 : 0, verdict: 'ok' });
const grade = (project, days) => ({ v: 1, at: ago(days), projectId: project.id, project: project.name, terminalId: 't1', agent: 'claude', model: 'claude-opus-5-5', effort: 'high', sessionId: null, outcome: days > 10 ? 'sent-back' : 'passed', submission: 1 });
// A model whose id is far wider than its button: the label must be cut with an ellipsis, not wrapped, and the button must still name it in full.
const LONG_MODEL = 'vendor-experimental-reasoning-model-2026-10-preview-with-a-very-long-identifier';
const quota = (days, percent) => ({ v: 1, at: ago(days), provider: 'codex', scope: 'fixture-scope', windows: [{ minutes: 300, percent: percent / 2, resetsAt: null }, { minutes: 10080, percent, resetsAt: null }] });

const meeting = (name, days, model) => [
  { type: 'meeting', id: `m-${name}`, meeting: name, session: `s-${name}`, agent: 'codex', model, role: '圆桌', title: `understand ${name}`, allow: ['src/**'], status: 'confirmed',
    understanding: { goal: 'g', files: 'f', provides: 'p', uses: 'u', doneWhen: 'd', questions: 'q' }, time: ago(days) - 3 * 3600000 },
  { type: 'end', id: `e-${name}`, title: `build ${name}`, session: `s-${name}`, meeting: name, role: '执行', kind: 'core', model, reason: 'exit', outputTokens: 40000, totalOutputTokens: 40000, activeMs: 900000, time: ago(days) - 2 * 3600000 },
  { type: 'finding', meeting: name, author: model, reviewer: 'claude-opus-5-5', category: 'correctness', severity: 'medium', fixed: true, title: `finding ${name}`, time: ago(days) - 3600000 },
  ...(name === 'r-recent' ? [{ type: 'incident', meeting: name, model, kind: 'test', cause: 'tests passed only on Windows', fix: 'cross-platform test skill', lead: 'missed', weight: { kind: 'test', from: 1, to: 0.7 }, time: ago(days) - 3000000 }] : []),
  { type: 'consolidate', meeting: name, time: ago(days) },
];
const JOURNALS = { 'p-agentrix': [...meeting('r-recent', 2, 'gpt-6.1-sol'), ...meeting('r-mid', 15, 'gpt-6.1-sol'), ...meeting('r-old', 45, 'gpt-6.1-terra')], 'p-site': meeting('r-site', 3, 'gpt-6.1-sol') };

const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
async function seed(output, theme) {
  const profile = path.join(output, 'profile'), projects = [];
  await fs.mkdir(path.join(profile, 'dashboard'), { recursive: true });
  for (const project of PROJECTS) {
    const directory = path.join(output, project.name);
    await fs.mkdir(directory, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: directory, windowsHide: true });
    await fs.mkdir(path.join(directory, '.git', 'agentrix'), { recursive: true });
    await fs.writeFile(path.join(directory, '.git', 'agentrix', 'journal.jsonl'), jsonl(JOURNALS[project.id]));
    projects.push({ id: project.id, name: project.name, path: directory, restore: { terminal: false, codex: false } });
  }
  const runs = RUNS.flatMap(([id, ages]) => ages.map((days, index) => run(PROJECTS.find(project => project.id === id), days, index)));
  await fs.writeFile(path.join(profile, 'dashboard', 'runs.jsonl'), jsonl(runs));
  await fs.writeFile(path.join(profile, 'dashboard', 'grades.jsonl'), jsonl([grade(PROJECTS[0], 2), grade(PROJECTS[0], 20), grade(PROJECTS[1], 4), { ...grade(PROJECTS[0], 3), model: LONG_MODEL }]));
  await fs.writeFile(path.join(profile, 'dashboard', 'quota.jsonl'), jsonl([quota(5, 40), quota(0.1, 68)]));
  await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects, settings: { language: 'zh', theme, terminalRenderer: 'dom', restoreSessions: false, closeToTray: false, notifications: false, sound: false, announce: false } }));
  return profile;
}

// ---- the narrow-layout probes, run inside the page -----------------------------------------------------------------------------
// Every model button: its height, whether its label sits on one line, whether the label is cut and the name a screen reader gets.
const measureModelButtons = () => [...document.querySelectorAll('.model-toggle')].map(button => {
  const label = button.querySelector('.model-name'), style = getComputedStyle(label);
  return { name: button.getAttribute('aria-label'), text: label.textContent, height: Math.round(button.getBoundingClientRect().height), lines: Math.round(label.getBoundingClientRect().height / parseFloat(style.lineHeight)), nowrap: style.whiteSpace === 'nowrap', cut: label.scrollWidth > label.clientWidth + 1 };
});

// What a scroll region shows at its current position, read in the page: every text cell, header cells included, whose box crosses the pinned first column's right edge is `covered`
// (a cell is beside the pinned column in full or under it, never half-covered); `headers` says which unpinned column headers are whole, between the pinned edge and the region's right edge.
const readPinned = node => {
  const view = node.getBoundingClientRect(), covered = [], headers = [];
  let count = 0;
  for (const row of node.querySelectorAll('tr')) {
    const all = [...row.children], pinned = all.filter(cell => getComputedStyle(cell).position === 'sticky' && getComputedStyle(cell).left !== 'auto');
    const edge = pinned.length ? Math.max(...pinned.map(cell => cell.getBoundingClientRect().right)) : view.left;
    for (const cell of all.filter(other => !pinned.includes(other) && other.textContent.trim())) {
      const box = cell.getBoundingClientRect(), text = cell.textContent.trim().slice(0, 24);
      count++;
      if (pinned.length && box.left < edge - 0.5 && box.right > edge + 0.5) covered.push({ text, underPin: Math.round(edge - box.left) });
      if (cell.tagName === 'TH') headers.push({ text, whole: box.left >= edge - 0.5 && box.right <= view.right + 0.5 });
    }
  }
  return { covered, headers, count, left: Math.round(node.scrollLeft), max: Math.round(node.scrollWidth - node.clientWidth) };
};

// Each scroll region set to its start, one viewport along (after it snaps) and its end. `cells` totals the text cells of every region at its start.
// `shoot(index, region, position)` is called at each position so the pictures show what the user lands on.
async function measureObscured(page, shoot) {
  const regions = await page.$$('.scroll'), covered = [], labels = [];
  let cells = 0;
  const settle = (region, move) => region.evaluate(async (node, move) => {
    if (move === 'start') node.scrollLeft = 0;
    else if (move === 'middle') node.scrollBy({ left: node.clientWidth, behavior: 'instant' });
    else node.scrollLeft = node.scrollWidth;
    for (let frame = 0; frame < 3; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
  }, move);
  for (const [index, region] of regions.entries()) {
    labels.push(await region.getAttribute('aria-label'));
    for (const position of ['start', 'middle', 'end']) {
      await settle(region, position);
      const read = await region.evaluate(readPinned);
      covered.push(...read.covered.map(cell => ({ region: index, position, ...cell })));
      if (position === 'start') cells += read.count;
      if (shoot) await shoot(index, region, position);
    }
    await settle(region, 'start');
  }
  return { covered, cells, labels };
}

// The way a keyboard user scrolls: focus each visible region and press ArrowRight until the scroll stops, then ArrowLeft back. At every position the pinned edge must cover no
// cell, and every column header must have been whole at some position (so the snap neither skips a column nor sticks). `shoot(index, region)` is called at the first position
// past the middle of the scroll.
async function measureArrowScroll(page, shoot) {
  const result = { covered: [], neverWhole: [], notAtEnd: [], notBack: [], regions: {} };
  for (const [index, region] of (await page.$$('.scroll')).entries()) {
    if (!await region.isVisible()) continue;
    await region.scrollIntoViewIfNeeded(); await region.focus();
    const label = (await region.getAttribute('aria-label')).split('，')[0], seen = new Map(), positions = [];
    // The key's scroll is animated: read once the position has stood still for a few frames.
    const read = async () => {
      await region.evaluate(async node => { let last = -1, still = 0; for (let frame = 0; frame < 120 && (frame < 3 || still < 6); frame++) { await new Promise(resolve => requestAnimationFrame(resolve)); still = node.scrollLeft === last ? still + 1 : 0; last = node.scrollLeft; } });
      const state = await region.evaluate(readPinned);
      result.covered.push(...state.covered.map(cell => ({ region: label, at: state.left, ...cell })));
      for (const { text, whole } of state.headers) seen.set(text, seen.get(text) || whole);
      return state;
    };
    const press = async key => { await page.keyboard.press(key); return read(); };
    let state = await read(), shot = false;
    positions.push(state.left);
    for (let step = 0; step < 60; step++) {
      let next = await press('ArrowRight');
      if (next.left === state.left) next = await press('ArrowRight');
      if (next.left === state.left) break;
      state = next; positions.push(state.left);
      if (shoot && !shot && state.left >= state.max / 2) { shot = true; await shoot(index, region); }
    }
    if (Math.abs(state.left - state.max) > 1) result.notAtEnd.push({ region: label, left: state.left, max: state.max });
    for (let step = 0; step < 60 && state.left > 0; step++) {
      let next = await press('ArrowLeft');
      if (next.left === state.left) next = await press('ArrowLeft');
      if (next.left === state.left) break;
      state = next;
    }
    if (state.left !== 0) result.notBack.push({ region: label, left: state.left });
    result.neverWhole.push(...[...seen].filter(([, whole]) => !whole).map(([text]) => ({ region: label, text })));
    result.regions[label] = { positions, headers: Object.fromEntries(seen) };
  }
  return result;
}

// The text in the selected (expanded) model row with the colour it is drawn in and the surface under it.
const measureSelectedRow = () => {
  const surface = node => { for (let at = node; at; at = at.parentElement) { const color = getComputedStyle(at).backgroundColor; if (!/, 0\)$|transparent/.test(color)) return color; } return 'rgb(0, 0, 0)'; };
  const row = document.querySelector('tr[data-expanded="true"]');
  return [...row.querySelectorAll('*')].filter(node => [...node.childNodes].some(child => child.nodeType === 3 && child.textContent.trim()))
    .map(node => ({ text: node.textContent.trim().slice(0, 24), size: getComputedStyle(node).fontSize, color: getComputedStyle(node).color, surface: surface(node) }));
};

// The shared Select's states (the dashboard has no disabled Select of its own) built from its classes: a disabled trigger and a menu with an enabled, an active,
// a selected, a disabled, a selected-and-disabled and an active-and-disabled item.
const OPTION_STATES = { enabled: '', active: 'data-active="true"', selected: 'aria-selected="true"', disabled: 'aria-disabled="true"', 'selected-disabled': 'aria-selected="true" aria-disabled="true"', 'active-disabled': 'data-active="true" aria-disabled="true"' };
// Select.tsx draws the selected option's check (Phosphor Check, bold, 14px) in .select-option-mark; the probe draws the same.
const CHECK = '<svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M232.49,80.49l-128,128a12,12,0,0,1-17,0l-56-56a12,12,0,1,1,17-17L96,183,215.51,63.51a12,12,0,0,1,17,17Z"/></svg>';
const SELECT_PROBE = `<div id="select-probe" style="position:fixed;z-index:900;top:96px;left:16px;display:flex;flex-direction:column;gap:8px;padding:16px;border:1px solid var(--border);border-radius:12px;background:var(--bg-app)">
  <button type="button" class="select-trigger" disabled style="width:240px"><span class="select-value">不可用的下拉</span></button>
  <ul class="select-menu" role="listbox" style="position:static;width:240px">${Object.entries(OPTION_STATES).map(([state, attributes]) => `<li role="option" data-state="${state}" ${attributes}><span class="select-option-label">${state}</span><span class="select-option-mark">${attributes.includes('aria-selected') ? CHECK : ''}</span></li>`).join('')}</ul></div>`;
const measureSelectProbe = markup => {
  document.body.insertAdjacentHTML('beforeend', markup);
  // The colour a node's text is drawn on: the first ancestor background that is not transparent.
  const surface = node => { for (let at = node; at; at = at.parentElement) { const color = getComputedStyle(at).backgroundColor; if (!/, 0\)$|transparent/.test(color)) return color; } return 'rgb(0, 0, 0)'; };
  const read = node => ({ color: getComputedStyle(node).color, surface: surface(node), opacity: getComputedStyle(node).opacity, cursor: getComputedStyle(node).cursor, weight: getComputedStyle(node).fontWeight });
  const probe = document.getElementById('select-probe');
  return { trigger: read(probe.querySelector('.select-trigger')), options: Object.fromEntries([...probe.querySelectorAll('li')].map(node => [node.dataset.state, read(node)])) };
};

// WCAG contrast of two computed rgb() colours.
function contrast(foreground, background) {
  const luminance = color => { const [r, g, b] = color.match(/[\d.]+/g).slice(0, 3).map(channel => { const value = Number(channel) / 255; return value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
  const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (high + .05) / (low + .05);
}

// ---- the checks ----------------------------------------------------------------------------------------------------------------
const isDashboard = page => page.url().includes('dashboard.html');
const dashboardWindows = app => app.windows().filter(isDashboard);

async function checkTheme(theme, output, results) {
  const profile = await seed(output, theme);
  const env = { ...process.env, AGENTRIX_DATA_DIR: profile, CODEX_HOME: path.join(output, 'codex-home'), CLAUDE_CONFIG_DIR: path.join(output, 'claude-home') }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
  const errors = [], shot = (page, name) => page.screenshot({ path: path.join(output, `${name}.png`) });
  let app;
  try {
    app = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Agentrix.exe') : require('electron'), args: packaged ? [] : [root], cwd: root, env });
    const main = await app.firstWindow(); main.on('pageerror', error => errors.push(error.message));

    // Opened once from the menu: a second click focuses the same window.
    const opened = app.waitForEvent('window', { predicate: isDashboard });
    await chooseFromAppMenu(main, '数据看板');
    const dash = await opened; dash.on('pageerror', error => errors.push(error.message));
    await dash.waitForSelector('.dash .kpi.hero');
    await chooseFromAppMenu(main, '数据看板'); await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal(dashboardWindows(app).length, 1, 'the menu entry opens the dashboard once');

    const kpi = label => dash.locator('.kpi', { has: dash.locator('.label', { hasText: label }) }).locator('.value').innerText();
    const read = (label, expected) => waitFor(async () => (await kpi(label)) === String(expected), `${label} reads ${expected}`);
    const tab = name => dash.getByRole('button', { name, exact: true }).click();
    const bounds = size => app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('dashboard.html')).setContentSize(width, height), size);
    const resize = async (width, height) => {
      await bounds([width, height]);
      await waitFor(() => dash.evaluate(([width, height]) => Math.abs(innerWidth - width) <= 1 && Math.abs(innerHeight - height) <= 1, [width, height]), `dashboard content size ${width}×${height}`);
      await new Promise(resolve => setTimeout(resolve, 250));
    };
    assert.deepEqual(await dash.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.lang]), [theme, 'zh-CN']);

    // The model page and its filters.
    for (const [range, runs] of Object.entries(EXPECTED.runs)) { await tab(range); await read('子任务', runs); }
    await tab('30 天'); await read('子任务', EXPECTED.runs['30 天']);
    await pick(dash, dash.getByRole('combobox', { name: '项目' }), 'p-site'); await read('子任务', EXPECTED.siteRuns30);
    await pick(dash, dash.getByRole('combobox', { name: '项目' }), ''); await read('子任务', EXPECTED.runs['30 天']);
    assert.match(await kpi('一次通过率'), /^\d+%$|^—$/);
    assert.ok(await dash.locator('.panel', { has: dash.getByRole('heading', { name: /模型对比/ }) }).locator('tbody tr').count() >= 2, 'the model table lists the seeded models');
    assert.equal(await dash.locator('.kpi.hero').count(), 1, 'one hero figure per page');

    // Model cells: mouse, Enter and Space open exactly that model's tasks; closing restores the owning control's focus.
    const modelControl = model => dash.locator('.model-toggle', { hasText: model === 'claude-opus-5-5' ? 'Opus 5.5' : model });
    const tasks = dash.locator('.model-tasks');
    for (const [index, [model, expected]] of Object.entries(EXPECTED.modelTasks30).entries()) {
      const control = modelControl(model);
      if (index === 0) await control.click();
      else { await control.focus(); await control.press(index === 1 ? 'Enter' : 'Space'); }
      await tasks.waitFor();
      assert.equal(await control.getAttribute('aria-expanded'), 'true');
      assert.equal(await dash.locator('.model-toggle[aria-expanded="true"]').count(), 1);
      if (expected) assert.equal(await tasks.locator('tbody tr').count(), expected, `${model}: fixture task count`);
      else assert.equal(await tasks.getByText('没有任务', { exact: true }).count(), 1, 'a grade-only model has no worker tasks');
      results.push({ theme, model, tasks: expected });
    }
    const lastControl = modelControl('claude-opus-5-5');
    await tasks.getByRole('button', { name: '收起任务列表', exact: true }).click();
    assert.equal(await lastControl.evaluate(node => node === document.activeElement), true, 'closing returns focus to the model');
    assert.equal(await tasks.count(), 0);

    // The collaboration page: rounds per range and project, then adopt a weight and take it back.
    await tab('协作报告');
    for (const [range, rounds] of Object.entries(EXPECTED.rounds)) { await tab(range); await read('轮次', rounds); }
    await tab('30 天'); await pick(dash, dash.getByRole('combobox', { name: '项目' }), 'p-site'); await read('轮次', EXPECTED.siteRounds30);
    await pick(dash, dash.getByRole('combobox', { name: '项目' }), ''); await read('轮次', EXPECTED.rounds['30 天']);
    assert.equal(await dash.locator('.panel', { has: dash.getByRole('heading', { name: /每轮经过/ }) }).locator('tbody tr').count(), EXPECTED.rounds['30 天']);
    // Only the model table: the incident table shows the incident's own suggested weight change as well.
    const modelWeight = () => dash.locator('.panel', { has: dash.getByRole('heading', { name: /模型对比/ }) }).locator('tr', { hasText: 'gpt-6.1-sol' }).locator('.weight', { hasText: '降权' });
    await tab('模型评估'); assert.equal(await modelWeight().count(), 0, 'no adopted weight before 采纳'); await tab('协作报告');
    const weightItem = dash.locator('.advice-item', { has: dash.locator('.tag', { hasText: '路由权重' }) }).first();
    await weightItem.waitFor();
    await weightItem.getByRole('button', { name: '采纳', exact: true }).click();
    await weightItem.getByText('已采纳 ✓').waitFor();
    await tab('模型评估');
    await modelWeight().first().waitFor();
    await tab('协作报告');
    await weightItem.getByRole('button', { name: '撤销', exact: true }).click();
    await weightItem.getByRole('button', { name: '采纳', exact: true }).waitFor();
    await tab('模型评估');
    await waitFor(async () => !(await modelWeight().count()), 'taking the suggestion back clears the weight');

    // Keyboard: every control reached by Tab shows a 2px focus ring; the title bar drags and its buttons do not.
    await dash.locator('.dash').click({ position: { x: 4, y: 100 } });
    const rings = [];
    for (let step = 0; step < 8; step++) {
      await dash.keyboard.press('Tab');
      rings.push(await dash.evaluate(() => { const style = getComputedStyle(document.activeElement); return { tag: document.activeElement.tagName, label: document.activeElement.getAttribute('aria-label') || document.activeElement.textContent.slice(0, 20), width: style.outlineWidth, style: style.outlineStyle }; }));
    }
    assert.ok(rings.every(ring => ring.width === '2px' && ring.style === 'solid'), JSON.stringify(rings));
    const region = await dash.evaluate(() => ({ bar: getComputedStyle(document.querySelector('.titlebar')).webkitAppRegion, button: getComputedStyle(document.querySelector('.window-actions button')).webkitAppRegion }));
    assert.deepEqual(region, process.platform === 'darwin' ? region : { bar: 'drag', button: 'no-drag' });
    const heights = await dash.evaluate(() => [...document.querySelectorAll('.toolbar .button, .toolbar .select-trigger, details.data summary, .model-toggle')].map(node => Math.round(node.getBoundingClientRect().height)));
    assert.ok(heights.length >= 6 && heights.every(height => height === 32), JSON.stringify(heights));

    // All three sizes and both pages, including 820×600: no sideways page scroll, with the model details open as well.
    for (const [width, height] of [[1180, 820], [900, 820], [820, 600]]) {
      await resize(width, height);
      for (const [page, name] of [['模型评估', 'models'], ['协作报告', 'team']]) {
        await tab(page); await new Promise(resolve => setTimeout(resolve, 250));
        if (name === 'models') {
          // The long id from the keyboard: Enter opens its task list, whose heading carries the whole name, wrapped if need be but never cut.
          // Measured as it stands right after Enter: the test scrolls nothing, so the page itself must bring the heading into view.
          const longControl = dash.getByRole('button', { name: LONG_MODEL, exact: true });
          await dash.locator('.dash-main').evaluate(node => { node.scrollTop = 0; });
          await longControl.focus(); await longControl.press('Enter');
          await tasks.waitFor();
          await dash.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const heading = await dash.locator('#dashboard-model-tasks-title').evaluate(node => {
            const box = node.getBoundingClientRect(), main = document.querySelector('.dash-main').getBoundingClientRect();
            return { text: node.textContent, cut: node.scrollWidth > node.clientWidth + 1, inside: box.left >= 0 && box.right <= innerWidth && box.top >= main.top && box.bottom <= main.bottom,
              lines: Math.round(box.height / parseFloat(getComputedStyle(node).lineHeight)), focusOnButton: document.activeElement.getAttribute('aria-expanded') === 'true' };
          });
          assert.ok(heading.text.includes(LONG_MODEL) && !heading.cut && heading.inside && heading.focusOnButton, `the long model's task heading right after Enter at ${width}×${height}: ${JSON.stringify(heading)}`);
          if (width !== 1180) await shot(dash, `${theme}-${width}x${height}-long-model-heading`);
          results.push({ theme, width, height, longHeading: heading });
          await modelControl('gpt-6.1-sol').click();
          assert.equal(await tasks.locator('tbody tr').count(), EXPECTED.modelTasks30['gpt-6.1-sol']);
        }
        await dash.locator('.dash-main').evaluate(node => { node.scrollTop = 0; });
        const layout = await dash.evaluate(() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: document.querySelector('.dash-main').scrollWidth - document.querySelector('.dash-main').clientWidth,
          columns: getComputedStyle(document.querySelector('.kpis')).gridTemplateColumns.split(' ').length, wide: !!document.querySelector('.wide-only') && getComputedStyle(document.querySelector('.wide-only')).display !== 'none',
          stacked: !!document.querySelector('.stack-only') && getComputedStyle(document.querySelector('.stack-only')).display !== 'none', unlabelled: [...document.querySelectorAll('.scroll')].filter(node => !node.getAttribute('aria-label') || node.tabIndex !== 0).length }));
        assert.equal(layout.overflow, 0, `no page-level horizontal scroll at ${width}×${height}`); assert.equal(layout.main, 0);
        assert.equal(layout.columns, width > 1000 ? 4 : 2, 'KPIs: four across, two by two below 1000'); assert.equal(layout.unlabelled, 0);
        if (name === 'models') { assert.equal(layout.wide, width > 1000); assert.equal(layout.stacked, width <= 1000); }
        // A control's text never wraps, and no text sits under a pinned last column at either end of the scroll.
        const buttons = name === 'models' ? await dash.evaluate(measureModelButtons) : [];
        assert.ok(name !== 'models' || buttons.length >= 4, 'the model table lists its buttons');
        // A label is cut only when it is the long id, never wrapped; the button names its model in full either way.
        assert.ok(buttons.every(button => button.height <= 32 && button.lines === 1 && button.nowrap && button.name === button.text && button.cut === (button.name === LONG_MODEL)), `model buttons at ${width}×${height}: ${JSON.stringify(buttons)}`);
        assert.ok(name !== 'models' || buttons.some(button => button.name === LONG_MODEL && button.cut), 'the long model id is cut with an ellipsis');
        // Every scroll region at its start, one viewport along and its end; the pictures of the visible ones are kept at 820×600.
        const obscured = await measureObscured(dash, width === 820 ? async (index, region, position) => { if (!await region.isVisible()) return; await region.scrollIntoViewIfNeeded(); await shot(dash, `${theme}-${width}x${height}-${name}-scroll${index}-${position}`); } : undefined);
        assert.deepEqual(obscured.covered, [], `half-covered cells beside the pinned column at ${width}×${height} on ${name}`);
        // And by keyboard, where overflow is the rule (at 1180 the tables fit).
        const arrows = width <= 900 ? await measureArrowScroll(dash, width === 820 ? async (index, region) => { await shot(dash, `${theme}-${width}x${height}-${name}-arrow${index}-mid`); } : undefined) : null;
        if (arrows) {
          assert.deepEqual([arrows.covered, arrows.neverWhole, arrows.notAtEnd, arrows.notBack], [[], [], [], []], `arrow-key scrolling at ${width}×${height} on ${name}: ${JSON.stringify(arrows)}`);
          const headersOf = prefix => Object.entries(arrows.regions).find(([label]) => label.startsWith(prefix))?.[1].headers ?? {};
          if (name === 'models') {
            for (const header of ['越界', '事故', '额度', '成本']) assert.equal(headersOf('模型对比表')[header], true, `the model table shows ${header} whole at some position`);
            assert.equal(headersOf('模型任务表')['结果'], true, 'the task table shows 结果 whole at some position');
          }
          results.push({ theme, width, height, page: name, arrowScroll: arrows.regions });
        }
        assert.ok(obscured.cells > 20, 'the tables have cells to check');
        if (name === 'models') {
          const selected = await dash.evaluate(measureSelectedRow), low = selected.map(({ text, color, surface }) => ({ text, ratio: contrast(color, surface) })).filter(({ ratio }) => ratio < 4.5);
          assert.ok(selected.length >= 4, 'the selected row has its text measured');
          assert.deepEqual(low, [], `text in the selected row under 4.5:1 at ${width}×${height} on ${theme}`);
          results.push({ theme, width, height, selectedRow: selected.map(({ text, color, surface }) => ({ text, ratio: +contrast(color, surface).toFixed(2) })) });
        }
        await shot(dash, `${theme}-${width}x${height}-${name}`); results.push({ theme, width, height, page: name, ...layout, buttons, cellsChecked: obscured.cells, regions: obscured.labels.map(label => label.slice(0, 6)), halfCovered: obscured.covered.length });
        if (name === 'models') {
          await tasks.scrollIntoViewIfNeeded();
          await shot(dash, `${theme}-${width}x${height}-model-tasks`);
        }
      }
    }

    // The shared Select's four states, and the disabled ones in combination, keep their text readable (4.5:1 on their own surface) without fading.
    for (const [width, height] of [[900, 820], [820, 600]]) {
      await resize(width, height);
      // The real Select, opened on the dashboard's own project filter: its selected item shows the check.
      const filter = dash.getByRole('combobox', { name: '项目' });
      await filter.click();
      await dash.locator('.select-menu [aria-selected="true"] .select-option-mark svg').waitFor();
      await shot(dash, `${theme}-${width}x${height}-select-open`);
      await dash.keyboard.press('Escape');
      await dash.locator('.select-menu').waitFor({ state: 'detached' });
      const probe = await dash.evaluate(measureSelectProbe, SELECT_PROBE);
      await shot(dash, `${theme}-${width}x${height}-select-disabled`);
      await dash.evaluate(() => document.getElementById('select-probe').remove());
      const ratios = { trigger: contrast(probe.trigger.color, probe.trigger.surface), ...Object.fromEntries(Object.entries(probe.options).map(([state, read]) => [state, contrast(read.color, read.surface)])) };
      const low = Object.entries(ratios).filter(([, ratio]) => ratio < 4.5);
      assert.deepEqual(low, [], `Select text under 4.5:1 on ${theme}: ${JSON.stringify(ratios)}`);
      const disabled = [probe.trigger, probe.options.disabled, probe.options['selected-disabled'], probe.options['active-disabled']];
      assert.ok(disabled.every(read => read.opacity === '1' && read.cursor === 'not-allowed'), JSON.stringify(probe));
      assert.ok(probe.options.disabled.color !== probe.options.enabled.color && probe.options['selected-disabled'].color !== probe.options.selected.color, 'a disabled option reads differently from an enabled one');
      assert.equal(probe.options['selected-disabled'].weight, probe.options.selected.weight, 'a selected disabled option keeps the selected weight');
      results.push({ theme, width, height, selectContrast: Object.fromEntries(Object.entries(ratios).map(([state, ratio]) => [state, +ratio.toFixed(2)])) });
    }

    // The window buttons close the dashboard only.
    await dash.getByRole('button', { name: '关闭窗口', exact: true }).click();
    await waitFor(() => dashboardWindows(app).length === 0, 'the dashboard window closes');
    assert.equal(app.windows().length, 1, 'the main window stays');
    assert.deepEqual(errors, []);
  } finally { if (app) await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); }
}

const output = await testRun('dashboard'), results = [];
await withGuiLock('dashboard-smoke', async () => {
  for (const theme of themes.length ? themes : ['mono', 'light']) await checkTheme(theme, path.join(output, theme), results);
});
await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
console.log(`PASS: dashboard window, both pages, model task lists, filters, adoption, focus rings, one-line model buttons, no text under a pinned last column, disabled Select contrast and layouts at 1180×820, 900×820 and 820×600: ${output}`);
