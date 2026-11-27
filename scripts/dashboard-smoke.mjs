// The model dashboard window, in the real app: opened once from the app menu, one page of three charts (reliability overview,
// reliability trend, model × task kind) built from seeded run records of Claude Code, Codex and Antigravity models, the project
// and range filters changing them, small samples ranked last, keyboard focus visible, dark and light, 1180×820, 900×820 and the
// 820×600 minimum.
//
//   node scripts/dashboard-smoke.mjs          # both themes
//   node scripts/dashboard-smoke.mjs light    # one theme: mono (dark) or light
//
// The profile is isolated (AGENTRIX_DATA_DIR, CODEX_HOME and CLAUDE_CONFIG_DIR under .test-output) and seeded with fixture
// dashboard/runs.jsonl records; the owner's real Agentrix is never touched. Screenshots and results.json land in the run's
// .test-output folder. The whole run holds the GUI lock.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
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
// Dispatched role runs: [project, days ago, agent, model, kind, outcome]. A model whose id is far wider than its row must be cut with
// an ellipsis, and its row must still name it in full.
const PROJECTS = [{ id: 'p-agentrix', name: 'agentrix' }, { id: 'p-site', name: 'site' }, { id: 'p-empty', name: 'empty' }];
const LONG_MODEL = 'vendor-experimental-reasoning-model-2026-10-preview-with-a-very-long-identifier';
const OPUS = 'claude-opus-5-5', SOL = 'gpt-6.1-sol', GEMINI = 'gemini-3.8-flash';
const RUNS = [
  ...[[1, 'pass'], [2, 'pass'], [3, 'pass'], [10, 'fail'], [15, 'untested'], [20, 'pass']].map(([days, outcome], index) => ['p-agentrix', days, 'claude', OPUS, index % 2 ? 'frontend' : 'core', outcome]),
  ...[[1, 'pass'], [4, 'fail'], [8, 'unfinished'], [12, 'pass'], [25, 'untested']].map(([days, outcome]) => ['p-agentrix', days, 'codex', SOL, 'core', outcome]),
  ['p-site', 2, 'codex', SOL, 'frontend', 'pass'], ['p-site', 40, 'codex', SOL, 'frontend', 'pass'],
  ['p-site', 3, 'agy', GEMINI, 'docs', 'pass'], ['p-site', 5, 'agy', GEMINI, 'docs', 'pass'],
  ['p-agentrix', 6, 'claude', LONG_MODEL, 'small', 'untested'],
];
// Task counts per model name as the overview writes them, per range and for site alone over 30 days.
const EXPECTED = { '7 天': { 'Opus 5.5': 3, 'GPT-6.1-Sol': 3, [GEMINI]: 2, [LONG_MODEL]: 1 }, '30 天': { 'Opus 5.5': 6, 'GPT-6.1-Sol': 6, [GEMINI]: 2, [LONG_MODEL]: 1 },
  全部: { 'Opus 5.5': 6, 'GPT-6.1-Sol': 7, [GEMINI]: 2, [LONG_MODEL]: 1 }, site30: { 'GPT-6.1-Sol': 1, [GEMINI]: 2 } };

const end = outcome => outcome === 'unfinished' ? { reason: 'error', exitCode: 1 }
  : { reason: 'exit', exitCode: 0, ...(outcome === 'untested' ? {} : { checks: { passed: outcome === 'pass' ? 2 : 1, failed: outcome === 'fail' ? 1 : 0, skipped: 0 } }) };
const run = ([projectId, days, agent, model, kind, outcome], index) => ({ v: 1, at: ago(days), id: `run-${index}`, projectId, project: PROJECTS.find(project => project.id === projectId).name,
  agent, source: 'dispatch', model, effort: 'high', role: '执行', kind, title: `fixture ${index}`, startedAt: ago(days) - 600000, endedAt: ago(days),
  activeMs: 480000, outputTokens: 40000, totalOutputTokens: 40000, inputTokens: 90000, cachedTokens: 60000, outOfScope: 0, verdict: 'ok', ...end(outcome) });

const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
async function seed(output, theme) {
  const profile = path.join(output, 'profile'), projects = [];
  await fs.mkdir(path.join(profile, 'dashboard'), { recursive: true });
  for (const project of PROJECTS) {
    const directory = path.join(output, project.name);
    await fs.mkdir(directory, { recursive: true });
    projects.push({ id: project.id, name: project.name, path: directory, restore: { terminal: false, codex: false } });
  }
  await fs.writeFile(path.join(profile, 'dashboard', 'runs.jsonl'), jsonl(RUNS.map(run)));
  await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects, settings: { language: 'zh', theme, terminalRenderer: 'dom', restoreSessions: false, closeToTray: false, notifications: false, sound: false, announce: false } }));
  return profile;
}

// ---- probes run inside the page ------------------------------------------------------------------------------------------------
// Every overview row: its model name, whether the name is cut, its task count and whether it reads as a small sample.
const readRows = () => [...document.querySelectorAll('.rel-row')].map(row => {
  const name = row.querySelector('.name');
  return { title: name.title, text: name.textContent, cut: name.scrollWidth > name.clientWidth + 1, oneLine: getComputedStyle(name).whiteSpace === 'nowrap',
    tasks: Number(row.querySelector('.tasks').textContent.match(/\d+/)[0]), small: row.classList.contains('is-small') };
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
    await dash.waitForSelector('.dash .rel-row');
    await chooseFromAppMenu(main, '数据看板'); await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal(dashboardWindows(app).length, 1, 'the menu entry opens the dashboard once');

    const range = name => dash.getByRole('button', { name, exact: true }).click();
    const counts = async () => Object.fromEntries((await dash.evaluate(readRows)).map(row => [row.title, row.tasks]));
    const reads = (expected, label) => waitFor(async () => JSON.stringify(await counts()) === JSON.stringify(expected), `${label} reads ${JSON.stringify(expected)}`);
    const bounds = size => app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('dashboard.html')).setContentSize(width, height), size);
    const resize = async (width, height) => {
      await bounds([width, height]);
      await waitFor(() => dash.evaluate(([width, height]) => Math.abs(innerWidth - width) <= 1 && Math.abs(innerHeight - height) <= 1, [width, height]), `dashboard content size ${width}×${height}`);
      await new Promise(resolve => setTimeout(resolve, 250));
    };
    assert.deepEqual(await dash.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.lang]), [theme, 'zh-CN']);

    // One page, three charts, two filters.
    assert.deepEqual(await dash.locator('.panel > h2').evaluateAll(nodes => nodes.map(node => node.firstChild.textContent)), ['可靠性总览', '可靠性走势', '模型 × 任务类型']);
    assert.equal(await dash.locator('.dash [role="group"]').count(), 1, 'the time range is the only button group: no tabs');
    for (const name of ['7 天', '30 天', '全部']) { await range(name); await reads(EXPECTED[name], name); }
    await range('30 天'); await reads(EXPECTED['30 天'], '30 天');
    await pick(dash, dash.getByRole('combobox', { name: '项目' }), 'p-site'); await reads(EXPECTED.site30, 'site over 30 days');
    await pick(dash, dash.getByRole('combobox', { name: '项目' }), ''); await reads(EXPECTED['30 天'], '30 天');
    // Two tasks at 100% sit under the small-sample caption, after the models with enough tasks; the long id is cut, never wrapped.
    const rows = await dash.evaluate(readRows);
    assert.deepEqual(rows.map(row => [row.title, row.small]), [['Opus 5.5', false], ['GPT-6.1-Sol', false], [GEMINI, true], [LONG_MODEL, true]]);
    assert.equal(await dash.locator('.rel-caption').count(), 1);
    assert.ok(rows.every(row => row.oneLine && row.text === row.title && row.cut === (row.title === LONG_MODEL)), JSON.stringify(rows));
    assert.ok(await dash.locator('svg.chart polyline.line').count() >= 1, 'the trend draws its lines');
    assert.ok(await dash.locator('.kinds tbody tr').count() >= 3, 'the kind table lists the seeded kinds');

    // Keyboard: every control reached by Tab shows a 2px focus ring; the title bar drags and its buttons do not.
    await dash.locator('.dash').click({ position: { x: 4, y: 100 } });
    const rings = [];
    for (let step = 0; step < 7; step++) {
      await dash.keyboard.press('Tab');
      rings.push(await dash.evaluate(() => { const style = getComputedStyle(document.activeElement); return { tag: document.activeElement.tagName, label: document.activeElement.getAttribute('aria-label') || document.activeElement.textContent.slice(0, 20), width: style.outlineWidth, style: style.outlineStyle }; }));
    }
    assert.ok(rings.every(ring => ring.width === '2px' && ring.style === 'solid'), JSON.stringify(rings));
    const region = await dash.evaluate(() => ({ bar: getComputedStyle(document.querySelector('.titlebar')).webkitAppRegion, button: getComputedStyle(document.querySelector('.window-actions button')).webkitAppRegion }));
    assert.deepEqual(region, process.platform === 'darwin' ? region : { bar: 'drag', button: 'no-drag' });
    const heights = await dash.evaluate(() => [...document.querySelectorAll('.toolbar .button, .toolbar .select-trigger, details.data summary')].map(node => Math.round(node.getBoundingClientRect().height)));
    assert.ok(heights.length >= 5 && heights.every(height => height === 32), JSON.stringify(heights));

    // All three sizes, including 820×600: no sideways page scroll, every scroll region labelled, no cell half under the pinned kind column.
    for (const [width, height] of [[1180, 820], [900, 820], [820, 600]]) {
      await resize(width, height);
      await dash.locator('details.data summary').click();
      await dash.locator('.dash-main').evaluate(node => { node.scrollTop = 0; });
      const layout = await dash.evaluate(() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: document.querySelector('.dash-main').scrollWidth - document.querySelector('.dash-main').clientWidth,
        unlabelled: [...document.querySelectorAll('.scroll')].filter(node => !node.getAttribute('aria-label') || node.tabIndex !== 0).length }));
      assert.deepEqual([layout.overflow, layout.main, layout.unlabelled], [0, 0, 0], `layout at ${width}×${height}: ${JSON.stringify(layout)}`);
      const obscured = await measureObscured(dash, width === 820 ? async (index, scroll, position) => { if (!await scroll.isVisible()) return; await scroll.scrollIntoViewIfNeeded(); await shot(dash, `${theme}-${width}x${height}-scroll${index}-${position}`); } : undefined);
      assert.deepEqual(obscured.covered, [], `half-covered cells beside the pinned column at ${width}×${height}`);
      const arrows = width <= 900 ? await measureArrowScroll(dash) : null;
      if (arrows) assert.deepEqual([arrows.covered, arrows.neverWhole, arrows.notAtEnd, arrows.notBack], [[], [], [], []], `arrow-key scrolling at ${width}×${height}: ${JSON.stringify(arrows)}`);
      await dash.locator('details.data summary').click();
      await dash.locator('.dash-main').evaluate(node => { node.scrollTop = 0; });
      await shot(dash, `${theme}-${width}x${height}`); results.push({ theme, width, height, ...layout, cellsChecked: obscured.cells, regions: obscured.labels.map(label => label.slice(0, 6)) });
    }

    // A project without tasks: every chart says so in one sentence, with no axes or tables.
    await pick(dash, dash.getByRole('combobox', { name: '项目' }), 'p-empty');
    await waitFor(async () => await dash.locator('.panel > .empty').count() === 3, 'three one-sentence empty states');
    assert.equal(await dash.locator('.dash svg.chart, .dash table').count(), 0, 'no axes or tables without tasks');
    await shot(dash, `${theme}-empty`);
    await pick(dash, dash.getByRole('combobox', { name: '项目' }), ''); await reads(EXPECTED['30 天'], '30 天');

    // The shared Select's four states, and the disabled ones in combination, keep their text readable (4.5:1 on their own surface) without fading.
    for (const [width, height] of [[900, 820], [820, 600]]) {
      await resize(width, height);
      const filter = dash.getByRole('combobox', { name: '项目' });
      await filter.click();
      await dash.locator('.select-menu [aria-selected="true"] .select-option-mark svg').waitFor();
      await shot(dash, `${theme}-${width}x${height}-select-open`);
      await dash.keyboard.press('Escape');
      await dash.locator('.select-menu').waitFor({ state: 'detached' });
      const probe = await dash.evaluate(measureSelectProbe, SELECT_PROBE);
      await dash.evaluate(() => document.getElementById('select-probe').remove());
      const ratios = { trigger: contrast(probe.trigger.color, probe.trigger.surface), ...Object.fromEntries(Object.entries(probe.options).map(([state, read]) => [state, contrast(read.color, read.surface)])) };
      assert.deepEqual(Object.entries(ratios).filter(([, ratio]) => ratio < 4.5), [], `Select text under 4.5:1 on ${theme}: ${JSON.stringify(ratios)}`);
      const disabled = [probe.trigger, probe.options.disabled, probe.options['selected-disabled'], probe.options['active-disabled']];
      assert.ok(disabled.every(read => read.opacity === '1' && read.cursor === 'not-allowed'), JSON.stringify(probe));
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
console.log(`PASS: dashboard window, three reliability charts, filters, small samples last, focus rings, Select contrast and layouts at 1180×820, 900×820 and 820×600: ${output}`);
