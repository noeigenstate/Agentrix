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

// For each scroll region at its first and last scroll position: the text of every cell that a pinned (sticky) cell of the same row sits over. `shoot(index)` is called
// at the last position, where the pinned column is over the cells that scrolled under it.
async function measureObscured(page, shoot) {
  const found = [], regions = await page.$$('.scroll');
  const settle = (region, at) => region.evaluate(async (node, at) => {
    node.scrollLeft = at === 'start' ? 0 : node.scrollWidth;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, at);
  for (const [index, region] of regions.entries()) for (const at of ['start', 'end']) {
    await settle(region, at);
    found.push(...await region.evaluate((node, at) => {
      const view = node.getBoundingClientRect(), range = document.createRange(), hidden = [];
      for (const row of node.querySelectorAll('tr')) {
        const cells = [...row.children], pinned = cells.filter(cell => getComputedStyle(cell).position === 'sticky');
        for (const pin of pinned) for (const cell of cells.filter(other => !pinned.includes(other))) {
          const over = pin.getBoundingClientRect();
          range.selectNodeContents(cell);
          const text = range.getBoundingClientRect(), width = Math.min(text.right, view.right, over.right) - Math.max(text.left, view.left, over.left);
          if (cell.textContent.trim() && width > 0.5 && Math.min(text.bottom, over.bottom) - Math.max(text.top, over.top) > 0.5) hidden.push({ region: node.getAttribute('aria-label').slice(0, 8), at, text: cell.textContent.trim().slice(0, 24), overlap: Math.round(width) });
        }
      }
      return hidden;
    }, at));
    if (at === 'end' && shoot) await shoot(index);
    await settle(region, 'start');
  }
  return found;
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
const SELECT_PROBE = `<div id="select-probe" style="position:fixed;z-index:900;top:96px;left:16px;display:flex;flex-direction:column;gap:8px;padding:16px;border:1px solid var(--border);border-radius:12px;background:var(--bg-app)">
  <button type="button" class="select-trigger" disabled style="width:240px"><span class="select-value">不可用的下拉</span></button>
  <ul class="select-menu" role="listbox" style="position:static;width:240px">${Object.entries(OPTION_STATES).map(([state, attributes]) => `<li role="option" data-state="${state}" ${attributes}><span class="select-option-label">${state}</span><span class="select-option-mark"></span></li>`).join('')}</ul></div>`;
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
        // The picture of each overflowing table at its end: its first column is pinned there, over the cells that scrolled under it.
        const obscured = await measureObscured(dash, width === 820 ? index => shot(dash, `${theme}-${width}x${height}-${name}-scroll${index}-end`) : undefined);
        assert.deepEqual(obscured, [], `text under a pinned column at ${width}×${height} on ${name}`);
        if (name === 'models') {
          const selected = await dash.evaluate(measureSelectedRow), low = selected.map(({ text, color, surface }) => ({ text, ratio: contrast(color, surface) })).filter(({ ratio }) => ratio < 4.5);
          assert.ok(selected.length >= 4, 'the selected row has its text measured');
          assert.deepEqual(low, [], `text in the selected row under 4.5:1 at ${width}×${height} on ${theme}`);
          results.push({ theme, width, height, selectedRow: selected.map(({ text, color, surface }) => ({ text, ratio: +contrast(color, surface).toFixed(2) })) });
        }
        await shot(dash, `${theme}-${width}x${height}-${name}`); results.push({ theme, width, height, page: name, ...layout, buttons, obscured: obscured.length });
        if (name === 'models') {
          await tasks.scrollIntoViewIfNeeded();
          await shot(dash, `${theme}-${width}x${height}-model-tasks`);
        }
      }
    }

    // The shared Select's four states, and the disabled ones in combination, keep their text readable (4.5:1 on their own surface) without fading.
    for (const [width, height] of [[900, 820], [820, 600]]) {
      await resize(width, height);
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
