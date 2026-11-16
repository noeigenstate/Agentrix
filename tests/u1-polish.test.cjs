// U1 polish: light text tiers, the Codex permission menu's descriptions, one button font size, the narrow composer hint.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');
const bare = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
const themes = read('src/shared/styles/themes.css'), styles = read('src/shared/styles/styles.css'), select = read('src/shared/Select.css');
const lum = hex => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
const block = (css, open) => { const at = css.indexOf(open); assert.ok(at >= 0, open); return css.slice(at, css.indexOf('}', at)); };
const token = (css, name) => new RegExp(name + ':\\s*(#[0-9a-f]{6})', 'i').exec(css)[1].toLowerCase();
const rules = (css, selector) => [...bare(css).matchAll(/(?<=^|\})\s*([^{}@]+)\{([^}]*)\}/g)].filter(m => m[1].split(',').some(s => s.trim() === selector)).map(m => m[2]);

test('light text-3 is lighter than text-2, both pass 4.5:1 where they are used, and the dark tiers are unchanged', () => {
  const light = block(themes, ':root[data-theme="light"] {'), dark = themes.slice(0, themes.indexOf(':root[data-theme="light"] {'));
  assert.equal(token(light, '--text-2'), '#5a626e');
  assert.equal(token(light, '--text-3'), '#69717d');
  assert.ok(lum(token(light, '--text-3')) > lum(token(light, '--text-2')), 'the tertiary tier is lighter than the secondary');
  for (const bg of ['#ffffff', '#f8f9fb', '#f7f8fa', '#fafafb', '#f3f5f7', '#e9ebef']) assert.ok(contrast(token(light, '--text-2'), bg) >= 4.5, `text-2 on ${bg}`);
  for (const bg of ['#ffffff', '#f8f9fb', '#f7f8fa', '#fafafb', '#f3f5f7']) assert.ok(contrast(token(light, '--text-3'), bg) >= 4.5, `text-3 on ${bg}`);
  assert.match(dark, /--text-2: #b5b5b5; --text-3: #999999/);
});

test('on a selected row light text-3 is the main text colour', () => {
  const rule = /:root\[data-theme="light"\] :is\(([^)]*(?:\([^)]*\)[^)]*)*)\)\s*\{\s*--text-3: var\(--text-1\);/.exec(themes);
  assert.ok(rule, 'a rule sets --text-3 to --text-1 on selected rows');
  for (const row of ['.select-menu li[aria-selected="true"]', '.inbox-row[aria-selected="true"]', '.tree-row.file-selected', '.settings-nav button[aria-current="page"]']) assert.ok(rule[1].includes(row), row);
});

test('the Codex permission menu gives every option a description of at most two lines, the selected one in the main text colour', () => {
  const settings = read('src/features/settings/AgentRuntimeSettings.tsx'), selectTsx = read('src/shared/Select.tsx');
  assert.match(selectTsx, /description\?: ReactNode/);
  assert.match(selectTsx, /select-option-description/);
  assert.match(settings, /options=\{permissionOptions\.map\(\(\{ value, label, hint \}\) => \(\{ value, label, description: hint \}\)\)\}/);
  for (const phrase of ['不询问，不使用沙箱：Codex 可以直接运行任何命令、修改任何文件。请用在你信任的项目上。', '沿用 Codex 自己 config.toml 里的设置。', '只能在工作目录里写文件；执行需要权限的操作前先问你。']) assert.ok(settings.includes(`t('${phrase}')`), phrase);
  const description = rules(select, '.select-option-description').join(' ');
  assert.match(description, /-webkit-line-clamp: 2/); assert.match(description, /font-size: 12px/); assert.match(description, /line-height: 16px/); assert.match(description, /color: var\(--text-3\)/);
  assert.match(rules(select, '.select-menu li[aria-selected="true"] .select-option-description').join(' '), /color: var\(--text-1\)/);
  assert.match(rules(select, '.select-menu li[data-described="true"]').join(' '), /height: auto/, 'a described row grows past the 32px of a plain one');
  const en = { ...require('../electron/locales/en.json'), ...JSON.parse(read('locale-additions-u1.json')) };
  assert.equal(typeof en['不询问，不使用沙箱：Codex 可以直接运行任何命令、修改任何文件。请用在你信任的项目上。'], 'string');
});

test('every small button is 14px/600 at 28px high, and the standard button stays 32', () => {
  const standard = rules(styles, '.button').join(' ');
  assert.match(standard, /height: 32px/); assert.match(standard, /font-size: 14px/); assert.match(standard, /font-weight: 600/);
  for (const selector of ['.button.small', '.titlebar-tools .button']) {
    const own = rules(styles, selector).join(' ');
    assert.match(own, /height: 28px/, `${selector} is 28 high`);
    assert.doesNotMatch(own, /font-size:/, `${selector} keeps the button's 14px`);
  }
  // No stylesheet outside the reading view sets another size on a .button.
  const found = [];
  for (const dir of ['src/features', 'src/shared']) for (const file of fs.readdirSync(path.join(__dirname, '..', dir), { recursive: true })) {
    if (!file.endsWith('.css') || /(^|[\/])reading[^\/]*\.css$/.test(file)) continue;
    for (const [, selector, body] of read(`${dir}/${file}`).matchAll(/([^{}@]*\.button[^{},]*)\{([^}]*)\}/g)) {
      const size = /(?:^|[;\s])font-size: (\d+)px/.exec(body); if (size && size[1] !== '14' && !/small|\.keybar/.test(selector)) found.push(`${file}: ${selector.trim()} ${size[1]}px`);
    }
  }
  assert.deepEqual(found, []);
});

test('the reading view keeps its own small buttons at 12px/32px', () => {
  assert.match(rules(read('src/features/reading/reading.css'), '.reading-view .button.small').join(' '), /height: 32px; font-size: 12px/);
});

test('every card hint list ends in 「输入消息…」, so a narrow composer is never blank', () => {
  const source = read('src/features/reading/ReadingView.tsx'), statement = /const hints = [\s\S]*?;\n/.exec(source)[0];
  assert.equal([...statement.matchAll(/t\('输入消息…'\)\]/g)].length, 3, 'the result, Codex and command lists');
  const { outputText } = ts.transpileModule(read('src/shared/useFittingHint.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS } });
  const exported = {}; new Function('exports', 'require', outputText)(exported, () => ({ useLayoutEffect() {}, useState() {} }));
  const width = text => [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 14 : 7), 0), shortest = '输入消息…';
  for (const list of [['继续修改，或描述下一步…', '继续修改…', shortest], ['给 Codex 发消息，/ 查看命令', '给 Codex 发消息', shortest], ['输入命令，Enter 发送', '输入命令', shortest]]) {
    assert.notEqual(exported.fittingIndex(list, 70, width), -1, `${list[0]} has a hint that fits 70px`);
  }
});
