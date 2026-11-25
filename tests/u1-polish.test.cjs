// U1 polish: light text tiers, the Codex permission menu's descriptions, one button font size, the narrow composer hint.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readCss, assertRule } = require('./helpers/css-rules.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { createElement } = require('react');
const { hookHarness, rendererLoader } = require('./helpers/hook-harness.cjs');
const { elements, stubGlobals } = require('./helpers/renderer-fixtures.cjs');
const { selectRows } = require('./helpers/select-view.cjs');

const themes = readCss('src/shared/styles/themes.css'), styles = readCss('src/shared/styles/styles.css'), select = readCss('src/shared/Select.css');
const lum = hex => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
const light = themes.rule(':root[data-theme="light"]');
const selectedRows = themes.blocks.filter(({ selector, properties }) =>
  selector.startsWith(':root[data-theme="light"] :is(') && properties['--text-3'] === 'var(--text-1)');

test('light text-3 is lighter than text-2, both pass 4.5:1 where they are used, and the dark tiers are unchanged', () => {
  const secondary = light['--text-2'], tertiary = light['--text-3'];
  assert.equal(secondary, '#5a626e');
  assert.equal(tertiary, '#69717d');
  assert.ok(lum(tertiary) > lum(secondary), 'the tertiary tier is lighter than the secondary');
  for (const bg of ['#ffffff', '#f8f9fb', '#f7f8fa', '#fafafb', '#f3f5f7', '#e9ebef']) assert.ok(contrast(secondary, bg) >= 4.5, `text-2 on ${bg}`);
  for (const bg of ['#ffffff', '#f8f9fb', '#f7f8fa', '#fafafb', '#f3f5f7']) assert.ok(contrast(tertiary, bg) >= 4.5, `text-3 on ${bg}`);
  assertRule(themes, ':root', { '--text-2': '#b5b5b5', '--text-3': '#999999' });
});

test('on a selected row light text-3 is the main text colour', () => {
  const rows = ['.select-menu li[aria-selected="true"]', '.inbox-row[aria-selected="true"]', '.tree-row.file-selected', '.settings-nav button[aria-current="page"]'];
  assert.ok(selectedRows.some(({ selector }) => rows.every(row => selector.includes(row))), 'a rule sets --text-3 to --text-1 on all selected rows');
});

test('the Codex permission menu gives every option a description of at most two lines, the selected one in the main text colour', () => {
  assertRule(select, '.select-option-description', { '-webkit-line-clamp': '2', 'font-size': '12px', 'line-height': '16px', color: 'var(--text-3)' });
  assertRule(select, '.select-menu li[aria-selected="true"] .select-option-description', { color: 'var(--text-1)' });
  assertRule(select, '.select-menu li[data-described="true"]', { height: 'auto' }, 'a described row grows past the 32px of a plain one');
  const en = require('../electron/locales/en.json');
  assert.equal(typeof en['不询问，不使用沙箱：Codex 可以直接运行任何命令、修改任何文件。请用在你信任的项目上。'], 'string');
});

test('every small button is 14px/600 at 28px high, and the standard button stays 32', () => {
  assertRule(styles, '.button', { height: '32px', 'font-size': '14px', 'font-weight': '600' });
  for (const selector of ['.button.small', '.titlebar-tools .button']) {
    const own = styles.rule(selector);
    assert.equal(own.height, '28px', `${selector} is 28 high`);
    assert.equal(own['font-size'], undefined, `${selector} keeps the button's 14px`);
  }
  // No stylesheet outside the reading view sets another size on a .button.
  const found = [];
  for (const dir of ['src/features', 'src/shared']) for (const file of fs.readdirSync(path.join(__dirname, '..', dir), { recursive: true })) {
    if (!file.endsWith('.css') || /(^|[\\/])reading[^\\/]*\.css$/.test(file)) continue;
    for (const { selectors, property, value } of readCss(path.join(dir, file)).declarations) {
      if (property !== 'font-size' || !/^\d+px$/.test(value) || value === '14px') continue;
      for (const selector of selectors) if (/\.button\b/.test(selector) && !/small|\.keybar/.test(selector)) found.push(`${file}: ${selector} ${value}`);
    }
  }
  assert.deepEqual(found, []);
});

test('the reading view keeps its own small buttons at 12px/32px', () => {
  const css = readCss('src/features/reading/reading.css');
  assertRule(css, '.reading-view .button.small', { height: '32px', 'font-size': '12px' });
});

test('every card hint ladder gets strictly shorter, in Chinese and in English, and the agent ladder ends in the 240px fallback', () => {
  const load = rendererLoader({ './i18n': { t: text => text } });
  const { composerHints } = load('src/features/reading/composer-hints.ts');
  const en = require('../electron/locales/en.json');
  const width = text => [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 14 : 7), 0);
  const ladders = [
    { locked: true }, { preview: true }, { live: false }, { hasChoice: true },
    { shownBlocked: true }, { result: true }, { cliActive: true }, {},
  ].map(state => composerHints({ live: true, ...state }));
  assert.equal(ladders.length, 8, 'the result, agent and command ladders, the two busy ones (a dialog open, input not ready), and the switching, history-preview and not-running ones');
  for (const first of ['正在切换运行方式，稍后继续', '历史预览，等待会话输入就绪', '会话未启动或已退出']) assert.ok(ladders.some(list => list[0] === first && list.length >= 3), `${first} steps down to a short hint, so a narrow card is never blank`);
  for (const list of ladders) for (const [name, words] of [['zh', list.map(key => key.replace('{agent}', 'Codex'))], ['en', list.map(key => (en[key] ?? key).replace('{agent}', 'Codex'))]]) {
    words.forEach((word, index) => { if (index) assert.ok(width(word) < width(words[index - 1]), `${name}: "${word}" is shorter than "${words[index - 1]}"`); });
  }
  assert.equal(ladders.filter(list => list.includes('输入消息…')).length, 1, 'only the agent ladder has the fallback');
  assert.equal(ladders.find(list => list.includes('输入消息…')).at(-1), '输入消息…');
  assert.equal(en['输入消息…'], 'Message…');
  for (const list of ladders.filter(list => list[0] === '等终端处理完后发送' || list[0] === '等待终端输入就绪后发送')) {
    assert.ok(width(list.at(-1)) <= 200 && width(en[list.at(-1)]) <= 200, 'a busy ladder ends in a phrase that fits a 240px box');
  }
});

test('Settings small buttons are 28px and the standard ones stay 36px', () => {
  const css = readCss('src/features/settings/settings.css');
  assertRule(css, '.settings-paned .button', { height: '36px' });
  assertRule(css, '.settings-paned .button.small', { height: '28px' });
});

test('a Select option\'s description is its own element, not part of the option\'s name, and the title carries both', t => {
  const richDescription = createElement('em', null, 'Detail');
  const { rows: [row, rich, plain] } = selectRows(t, [
    { value: 'a', label: 'Name', description: 'Detail' },
    { value: 'b', label: 'Rich', description: richDescription },
    { value: 'c', label: 'Plain' },
  ], 'a');
  const children = elements(row.props.children);
  const label = children.find(node => node.props.className === 'select-option-label');
  const description = children.find(node => node.props.className === 'select-option-description');
  assert.deepEqual([label.props.children, description.props.children], ['Name', 'Detail']);
  assert.equal(row.props['aria-labelledby'], label.props.id);
  assert.equal(row.props['aria-describedby'], description.props.id);
  assert.notEqual(label.props.id, description.props.id);
  assert.equal(elements(rich.props.children).find(node => node.props.className === 'select-option-description').props.children, richDescription);
  assert.equal(rich.props.title, 'Rich');
  assert.equal(plain.props['aria-describedby'], undefined);
  assert.equal(row.props.title, 'Name\nDetail');
});

test('no selected-row override touches the reading view or the Agent tab rows, and the launcher no longer calls text-3 the darker', () => {
  assert.ok(selectedRows.length > 0);
  assert.deepEqual(selectedRows.filter(({ selector }) => /\.reading-command|\.activity-call-rows/.test(selector)), []);
  const css = readCss('src/features/terminal/agent-launcher.css');
  assert.deepEqual(css.declarations.filter(({ selector, property, value }) =>
    selector.endsWith('.agent-launcher-agent small') && property === 'color' && value === 'var(--text-3)'), []);
});

test('the busy card composer: the hint fits from the row, not from the textarea own (content-sized) width, and a short rung shows at card widths', t => {
  const view = hookHarness('src/shared/useFittingHint.ts');
  t.after(() => view.dispose());
  const { rowRoom, fittingIndex } = view.load('src/shared/useFittingHint.ts');
  // A 317px card: the box is 317 - 2*30 margin - 26 padding/border, less three 32px buttons and their gaps; at 237px there is next to nothing.
  const room317 = rowRoom(317 - 60 - 26, 8, [32, 32, 32]), room237 = rowRoom(237 - 60 - 26, 8, [32, 32, 32]);
  assert.ok(room317 > 60 && room237 >= 0 && room237 < room317);
  const width = text => [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 14 : 7), 0);
  const { composerHints } = rendererLoader({ './i18n': { t: text => text } })('src/features/reading/composer-hints.ts');
  const ladder = composerHints({ live: true, shownBlocked: true });
  const observed = [], row = { clientWidth: room317, children: [] };
  const box = { current: { clientWidth: 0, parentElement: row } };
  stubGlobals(t, {
    document: { createElement: () => ({ getContext: () => ({ measureText: text => ({ width: width(text) }) }) }) },
    getComputedStyle: () => ({ paddingLeft: '0px', paddingRight: '0px', columnGap: '8px' }),
    ResizeObserver: class { observe(node) { observed.push(node); } disconnect() {} },
  });
  assert.equal(view.render('useFittingHint', box, ladder).result, ladder[fittingIndex(ladder, room317, width)]);
  assert.deepEqual(observed, [box.current, row]);
  assert.equal(ladder[0], '等待终端输入就绪后发送');
  assert.ok(fittingIndex(ladder, room317, width) > 0, 'at 317px a shorter rung of the blocked ladder shows');
  assert.equal(fittingIndex(ladder, 0, width), -1, 'the old zero-width measure showed nothing');
  assert.equal(rowRoom(100, 8, [32, 32, 32]), 0);
});
