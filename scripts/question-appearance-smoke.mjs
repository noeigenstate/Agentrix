// The choice, question, review and waiting cards, the reading composer and the file cards in both themes (mono, light):
// real PTY fixtures drive the cards, getComputedStyle measures every text level, the composer and the file cards' spacing.
// Run: node scripts/question-appearance-smoke.mjs (after npm run build). The measurements go to results.json.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { testRun } from './test-output.mjs';
import { withGuiLock } from './gui-lock.mjs';
import { waitFor } from './wait.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url);
const output = await testRun('question-appearance');
const THEMES = ['mono', 'light'];
// Every card kind: Codex and Claude questions (single, multi, review, typed), a terminal-only choice with details and one with key hints, the review page with its warning, the waiting card.
const FIXTURES = [
  { agent: 'codex', dir: 'questions', file: 'codex-question', card: '.reading-question-title' },
  { agent: 'claude', dir: 'questions', file: 'claude-question-multi', card: '.reading-question-title' },
  { agent: 'claude', dir: 'questions', file: 'claude-question-review', card: '.reading-question-review' },
  { agent: 'claude', dir: 'questions', file: 'claude-question-typed', card: '.reading-question-title' },
  { agent: 'codex', dir: 'screens', file: 'codex-investigation-plan-complete', card: '.reading-choice.is-permission' },
  { agent: 'claude', dir: 'screens', file: 'claude-investigation-bash', card: '.reading-choice.is-permission' },
  { agent: 'claude', dir: 'screens', file: 'claude-investigation-review', card: '.reading-question-warning' },
  { agent: 'codex', dir: 'screens', file: 'codex-investigation-command', card: '.reading-choice.is-permission' },
  { agent: 'claude', dir: 'screens', file: 'claude-investigation-mcp-form', card: '.reading-waiting' },
];
// The product scale (design-acceptance, ui-standard): text sizes 14/13/12 and weights 400/600 inside a card, spacing steps.
const SIZES = [14, 13, 12], WEIGHTS = [400, 600], SPACING = [0, 2, 4, 8, 12, 16, 24, 32];
// A card's levels: the title 14/600, the body 13/400, the rest 12/400; marks, key caps and action buttons 600.
const LEVELS = [
  ['.reading-choice-head strong', 14, 600], ['.reading-question-title', 14, 600],
  ['.reading-choice-label b', 13, 400], ['.reading-question-review dd', 13, 400], ['.reading-question-warning', 13, 400], ['.reading-question-input input', 13, 400],
  ['.reading-choice-label small', 12, 400], ['.reading-choice-context', 12, 400], ['.reading-choice-hint', 12, 400], ['.reading-question-review dt', 12, 400],
  ['.reading-question-tab', 12, 400], ['.reading-choice-head button', 12, 400], ['.reading-choice-option kbd', 12, 600],
  ['.reading-question-mark', 12, 600], ['.reading-choice-number', 12, 600], ['.reading-waiting .result-button', 13, 600],
];

// The text levels of a card: every element that owns a text node, with its class, computed size, weight and family.
const measureCard = () => [...document.querySelectorAll('.reading-choice *')].filter(node => [...node.childNodes].some(child => child.nodeType === 3 && child.textContent.trim()))
  .map(node => { const style = getComputedStyle(node); return { selector: node.tagName.toLowerCase() + (node.classList[0] ? '.' + node.classList[0] : ''), size: parseFloat(style.fontSize), weight: Number(style.fontWeight), color: style.color }; });

// The named levels: the computed size and weight of each element a LEVELS selector matches.
const measureLevels = selectors => selectors.flatMap(selector => [...document.querySelectorAll(selector)].map(node => ({ selector, size: parseFloat(getComputedStyle(node).fontSize), weight: Number(getComputedStyle(node).fontWeight) })));

// File cards in the three places they stand: the reading page, an opened tool group, the home review card.
const FILE_CARDS = `<div class="file-cards"><div class="file-card is-markdown"><button class="file-card-view"><span class="file-card-empty"><span>doc</span>没有可显示的画面</span></button><button class="file-card-name">notes.md</button></div><div class="file-card is-html"><button class="file-card-view"><div class="file-card-doc">text</div></button><button class="file-card-name">page.html</button></div></div>`;
const measureFileCards = markup => {
  const host = document.querySelector('.reading-scroll'), box = document.createElement('div');
  box.id = 'file-card-probe'; box.innerHTML = `<div class="probe-page">${markup}</div><div class="reading-tools is-open probe-tools">${markup}</div><section class="review-block probe-review"><h4>产出物</h4>${markup}</section>`;
  host.append(box);
  const spacing = style => ['gap', 'rowGap', 'columnGap', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].map(name => [name, parseFloat(style[name]) || 0]);
  const rows = [];
  for (const where of ['.probe-page', '.probe-tools', '.probe-review']) {
    const parent = box.querySelector(where), cards = parent.querySelector('.file-cards'), empty = parent.querySelector('.file-card-empty'), name = parent.querySelector('.file-card-name'), doc = parent.querySelector('.file-card-doc');
    rows.push({ where, cards: spacing(getComputedStyle(cards)), empty: spacing(getComputedStyle(empty)), emptySize: parseFloat(getComputedStyle(empty).fontSize), name: spacing(getComputedStyle(name)), nameSize: parseFloat(getComputedStyle(name).fontSize), nameWeight: Number(getComputedStyle(name).fontWeight), doc: spacing(getComputedStyle(doc)) });
  }
  return rows;
};

async function runTheme(theme) {
  const dir = path.join(output, theme), profile = path.join(dir, 'profile'), project = path.join(dir, 'project');
  await fs.mkdir(profile, { recursive: true }); await fs.mkdir(project);
  await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects: [{ id: 'questions', name: '问题主题对照', path: project, restore: { terminal: false, codex: false } }], settings: { language: 'zh', theme, terminalRenderer: 'dom', fontSize: 10, restoreSessions: false, closeToTray: false, notifications: false, sound: false, announce: false } }));
  const env = { ...process.env, AGENTRIX_DATA_DIR: profile, CODEX_HOME: await fs.mkdtemp(path.join(dir, 'codex-home-')) }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
  const errors = [], results = { theme, cards: [], composer: null, fileCards: null }; let app, page;
  const state = async () => (await page.evaluate(() => window.agentrix.getState())).value;
  const write = data => page.evaluate(data => window.agentrix.writeTerminal('questions', data), data);
  try {
    app = await electron.launch({ executablePath: require('electron'), args: [root], cwd: root, env }); page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1800, 1200));
    await waitFor(async () => (await page.evaluate(() => document.documentElement.dataset.theme ?? 'mono')) === theme, 'the profile theme ' + theme);
    await page.getByRole('button', { name: '只打开终端', exact: true }).click(); await waitFor(async () => (await state()).projects[0].shellReady, 'question fixture shell');
    const session = (await state()).projects[0].sessionId;
    // The composer with one line in it and the file cards in their three places, measured on the shell the last cards left.
    const shellChecks = async () => {
      const input = page.locator('.reading-composer textarea');
      // Set directly: an agent session that waits for a choice disables the field, but the field sizes itself from its value all the same.
      results.composerTyped = await input.evaluate(node => { node.value = '一行'; const height = node.getBoundingClientRect().height; node.value = ''; return height; });
      results.fileCards = await page.evaluate(measureFileCards, FILE_CARDS);
      await page.screenshot({ path: path.join(dir, 'file-cards.png') });
      await page.evaluate(() => document.getElementById('file-card-probe').remove());
    };
    for (const [at, { agent, dir: fixtures, file, card }] of FIXTURES.entries()) {
      await write("function global:prompt { 'question-fixture> ' }; Send-AgentrixEvent 'codex-started' -Agent '" + agent + "'\r");
      await waitFor(async () => (await state()).projects[0].codexActive && (await state()).projects[0].agent === agent, 'authenticated question fixture');
      const raw = page.locator('.titlebar-tools').getByRole('button', { name: '切换到终端', exact: true }); if (await raw.isVisible()) await raw.click();
      const content = (await fs.readFile(path.join(root, 'tests/fixtures', fixtures, file + '.txt'), 'utf8')).replace(/\r?\n/g, '\r\n'), encoded = Buffer.from(content).toString('base64');
      const release = path.join(dir, file + '.done').replaceAll("'", "''");
      await write("Clear-Host; [Console]::Write([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encoded + "'))); while (-not (Test-Path -LiteralPath '" + release + "')) { Start-Sleep -Milliseconds 50 }\r");
      await waitFor(async () => (await page.evaluate(() => window.agentrix.attachTerminal('questions'))).value.data.includes(content.trim().split(/[\r\n]/)[0].trim()), 'fixture reaches real PTY');
      const show = page.getByRole('button', { name: '阅读视图：按文档排版显示对话', exact: true }); if (await show.isVisible()) await show.click();
      await page.locator(card).first().waitFor();
      const levels = await page.evaluate(measureCard), named = await page.evaluate(measureLevels, LEVELS.map(([selector]) => selector));
      const ink = await page.evaluate(() => { const probe = document.createElement('span'); probe.style.color = 'var(--text-1)'; document.querySelector('.reading-choice').append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; });
      const colors = await page.locator('.reading-question-title, .reading-question-review dd, .reading-question-input input').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).color));
      assert.ok(colors.every(color => color === ink), JSON.stringify({ file, theme, colors, ink }));
      assert.equal((await state()).projects[0].sessionId, session);
      if (!results.composer) results.composer = await page.locator('.reading-composer textarea').evaluate(node => ({ height: node.getBoundingClientRect().height, line: getComputedStyle(node).lineHeight, padding: getComputedStyle(node).padding }));
      await page.screenshot({ path: path.join(dir, file + '.png') }); results.cards.push({ file, levels, named });
      await fs.writeFile(path.join(dir, file + '.done'), 'done');
      // The waiting card stays until the next screen replaces it, so the last fixture ends the run instead.
      if (card !== '.reading-waiting') await waitFor(() => page.locator(card).count().then(count => count === 0), 'fixture returns to shell');
      if (FIXTURES[at + 1]?.card === '.reading-waiting') await shellChecks();
    }
    assert.deepEqual(errors, []);
  } finally {
    await fs.writeFile(path.join(dir, 'results.json'), JSON.stringify(results, null, 2));
    if (app) await Promise.race([app.close(), new Promise(resolve => setTimeout(resolve, 15000))]);
  }
  return results;
}

// What the measurements must show; every violation is collected, so one run lists them all.
function violations({ theme, cards, composer, composerTyped, fileCards }) {
  const bad = [], seen = new Set();
  for (const { file, levels, named } of cards) {
    for (const level of levels) {
      if (!SIZES.includes(level.size)) bad.push(`${theme} ${file} ${level.selector}: ${level.size}px is off the 14/13/12 scale`);
      if (!WEIGHTS.includes(level.weight)) bad.push(`${theme} ${file} ${level.selector}: weight ${level.weight} is not 400/600`);
    }
    for (const { selector, size, weight } of named) {
      const [, expectedSize, expectedWeight] = LEVELS.find(level => level[0] === selector);
      seen.add(selector);
      if (size !== expectedSize || weight !== expectedWeight) bad.push(`${theme} ${file} ${selector}: ${size}px/${weight}, expected ${expectedSize}px/${expectedWeight}`);
    }
  }
  for (const [selector] of LEVELS) if (!seen.has(selector)) bad.push(`${theme}: no fixture showed ${selector}`);
  if (composer.height !== 32) bad.push(`${theme} composer textarea is ${composer.height}px, expected 32`);
  if (composerTyped !== 32) bad.push(`${theme} composer textarea with one line is ${composerTyped}px, expected 32`);
  for (const row of fileCards) {
    for (const part of ['cards', 'empty', 'name', 'doc']) for (const [name, value] of row[part]) if (!SPACING.includes(value)) bad.push(`${theme} file card ${row.where} ${part}.${name}: ${value}px is off the spacing scale`);
    if (row.emptySize < 12) bad.push(`${theme} file card ${row.where} empty text ${row.emptySize}px is under 12`);
    if (row.nameWeight !== 600) bad.push(`${theme} file card ${row.where} name weight ${row.nameWeight}, expected 600`);
  }
  return bad;
}

await withGuiLock('question-appearance', async () => {
  const all = [];
  for (const theme of THEMES) all.push(await runTheme(theme));
  const bad = all.flatMap(violations);
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ all, violations: bad }, null, 2));
  assert.deepEqual(bad, []);
  console.log('PASS: question, choice, waiting and file cards in the mono and light themes: ' + output);
});
