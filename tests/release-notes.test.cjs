const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readCss, assertRule } = require('./helpers/css-rules.cjs');
const path = require('node:path');
const { WHATS_NEW } = require('../src/features/guide/guide.ts');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { hookHarness, rendererLoader } = require('./helpers/hook-harness.cjs');
const { elements, stubGlobals } = require('./helpers/renderer-fixtures.cjs');
const en = require('../electron/locales/en.json');

test('each release note is a short title and a detail line, both translated, and the title is not repeated in the detail', () => {
  assert.ok(WHATS_NEW.length >= 1);
  assert.equal(new Set(WHATS_NEW.map(note => note.title)).size, WHATS_NEW.length, 'titles are distinct');
  for (const { title, text } of WHATS_NEW) {
    assert.ok([...title].length >= 2 && [...title].length <= 12, `${title}: a short title`);
    assert.ok(text.length > 8 && !text.startsWith(title), `${title}: the detail does not lead with the title`);
    assert.ok(en[title], `${title}: translated`); assert.ok(en[text], `${text}: translated`);
  }
});

const i18n = { t: text => text };
const icons = new Proxy({}, { get: () => () => null });

function releaseNotes(notes, t) {
  return rendererLoader({ './guide': { WHATS_NEW: notes }, './i18n': { t } })('src/features/guide/ReleaseNotes.tsx').ReleaseNotes;
}

test('the guide and the About page share one list: left-aligned, one marker colour, strong title over secondary detail, scrolling only when it overflows', t => {
  const css = readCss('src/features/guide/release-notes.css'), guide = readCss('src/features/guide/guide.css');
  const ReleaseNotes = releaseNotes([{ title: 'Title', text: 'Detail' }], text => 'Translated ' + text);
  assert.equal(renderToStaticMarkup(React.createElement(ReleaseNotes)), '<ul class="release-notes"><li><b>Translated Title</b>Translated Detail</li></ul>');
  const noop = () => {};
  const common = { './ReleaseNotes': { ReleaseNotes }, './i18n': i18n, '@phosphor-icons/react': icons };
  const usage = hookHarness('src/features/guide/UsageGuide.tsx', { ...common, './shortcuts': { SHORTCUT_ACTIONS: [] } });
  const about = hookHarness('src/features/settings/AboutSettings.tsx', { ...common, './Select': {}, './BetaAgreementDialog': {}, './beta-agreement': {} });
  t.after(() => { usage.dispose(); about.dispose(); });
  stubGlobals(t, { window: { addEventListener: noop, removeEventListener: noop } });
  assert.ok(elements(usage.render('UsageGuide', { start: 'news', version: '1.0.0' }).result).some(node => node.type === ReleaseNotes));
  const aboutView = () => elements(about.render('AboutSettings', { updates: null }).result);
  aboutView().find(node => node.props.title === '更新日志').props.onClick();
  assert.ok(aboutView().some(node => node.type === ReleaseNotes));
  assertRule(css, '.release-notes', { 'list-style': 'none', 'text-align': 'left', color: 'var(--text-2)', gap: '12px' });
  assertRule(css, '.release-notes li::before', { background: 'var(--usage)' }, 'the marker takes the list colour, not a literal');
  assertRule(css, '.release-notes b', { 'font-weight': '600', color: 'var(--text-1)' });
  assert.deepEqual(css.declarations.filter(({ value }) => /#[0-9a-f]{3,8}\b/i.test(value)), [], 'tokens only');
  assertRule(guide, '.guide-notes', {
    'min-height': '0', 'max-height': 'min(440px, 52vh)', 'padding-right': '8px', 'overflow-y': 'auto',
  }, 'the list scrolls, shrinks and keeps the scrollbar off the text');
  const settings = readCss('src/features/settings/settings.css');
  assert.deepEqual(settings.blocks.filter(({ selector }) => selector.includes('about-notes')), []);
});

test('the guide card never outgrows the window: it clips, the buttons never shrink, and only the notes scroll', () => {
  const guide = readCss('src/features/guide/guide.css');
  assertRule(guide, '.settings-dialog.guide-dialog', { overflow: 'hidden' }, 'the card itself has no scrollbar');
  assertRule(guide, '.settings-dialog.guide-dialog[open]', { display: 'flex', 'flex-direction': 'column' });
  assertRule(guide, '.guide-content', { flex: '1', 'min-height': '0' });
  for (const part of ['guide-logo', 'guide-dots', 'guide-footer', 'guide-links']) assertRule(guide, `.${part}`, { flex: 'none' }, `${part} keeps its size`);
  assertRule(guide, '.guide-content h2', { flex: 'none' });
  assertRule(guide, '.guide-body', { display: 'flex', 'flex-direction': 'column' }, 'the body passes the room on to the notes');
  assert.equal(guide.declarations.filter(({ property, value }) => property === 'overflow-y' && value === 'auto').length, 1, 'one scrolling region in the card');
  const settings = readCss('src/features/settings/settings.css');
  assert.match(settings.rule('.about-page .release-groups, .about-page .release-notes')['max-width'], /^\d+px$/, 'the About change log has a comfortable line length');
});

test('a stable release lists every note ungrouped; a beta lists them ungrouped too, or splits new notes ahead of earlier ones under two headings', () => {
  const marked = WHATS_NEW.map(note => note.group === 'new');
  if (!require('../package.json').version.includes('-beta.')) assert.ok(!marked.some(Boolean), 'a stable release shows one list, so no note carries a group');
  else if (marked.some(Boolean)) {
    assert.ok(marked.some(flag => !flag), 'both groups are present');
    assert.deepEqual(marked, [...marked].sort((a, b) => Number(b) - Number(a)), 'the new notes are a prefix, so the release body keeps its order');
  } // else: the first beta of a version has no earlier betas, so it shows a single list
  assert.ok(WHATS_NEW.every(note => note.group === undefined || note.group === 'new'));
  const css = readCss('src/features/guide/release-notes.css');
  const draw = notes => renderToStaticMarkup(React.createElement(releaseNotes(notes, text => en[text] ?? text)));
  const added = { title: 'New', text: 'Details', group: 'new' }, earlier = { title: 'Old', text: 'Earlier' };
  assert.equal(draw([added]), '<ul class="release-notes"><li><b>New</b>Details</li></ul>');
  assert.equal(draw([earlier]), '<ul class="release-notes"><li><b>Old</b>Earlier</li></ul>');
  const grouped = draw([added, earlier]);
  assert.ok(grouped.includes('<section><h4>New in this beta</h4><ul class="release-notes"><li><b>New</b>Details</li></ul></section>'));
  assert.ok(grouped.includes('<section><h4>Earlier betas of this version</h4><ul class="release-notes"><li><b>Old</b>Earlier</li></ul></section>'));
  assert.ok(grouped.indexOf('New in this beta') < grouped.indexOf('Earlier betas of this version'));
  assert.equal(en['本次测试版新增'], 'New in this beta'); assert.equal(en['此前测试版的更新'], 'Earlier betas of this version');
  assertRule(css, '.release-groups h4', { 'font-size': '12px', color: 'var(--text-2)' });
});

const script = path.join(__dirname, '..', 'scripts', 'release-notes.mjs');
const load = () => import(require('node:url').pathToFileURL(script).href);
const run = (...args) => require('node:child_process').spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('the release body lists every update note in English, in the guide order, under the version', async () => {
  const { releaseNotes } = await load();
  // A note's display group is not part of the release body: it stays one flat list, in order.
  const notes = [{ title: '甲', text: '一句话', group: 'new' }, { title: '乙', text: '另一句话' }];
  const english = { 甲: 'Alpha', 一句话: 'Does a thing.', 乙: 'Beta', 另一句话: 'Does another thing.' };
  assert.equal(releaseNotes(notes, english, '2.0.1-rc.1'), '## Changes in 2.0.1-rc.1\n\n- **Alpha** Does a thing.\n- **Beta** Does another thing.');
});

test('the release body refuses a missing translation, an empty list and a malformed version', async () => {
  const { releaseNotes } = await load();
  const notes = [{ title: '甲', text: '一句话' }], english = { 甲: 'Alpha', 一句话: 'Does a thing.' };
  assert.throws(() => releaseNotes(notes, { 甲: 'Alpha' }, '1.0.0'), /No English for: 一句话/);
  assert.throws(() => releaseNotes(notes, { 一句话: 'Does a thing.' }, '1.0.0'), /No English for: 甲/);
  assert.throws(() => releaseNotes([], english, '1.0.0'), /empty/);
  for (const version of [undefined, '', '1.3', 'v1.3.24', '1.3.24 ', '1.3.24\n- x']) assert.throws(() => releaseNotes(notes, english, version), /Invalid version/);
});

test('beta notes identify a Windows test build without adding other platform installation instructions', async () => {
  const { releaseNotes } = await load();
  const notes = [{ title: '甲', text: '一句话' }], english = { 甲: 'Alpha', 一句话: 'Does a thing.' };
  const beta = releaseNotes(notes, english, '8.2.7-beta.12');
  assert.match(beta, /^\*\*Windows test build:\*\* This prerelease is for Windows only/);
  assert.match(beta, /Choose Beta in Settings > About/);
  assert.match(beta, /## Changes in 8\.2\.7-beta\.12\n\n- \*\*Alpha\*\* Does a thing\.$/);
  assert.doesNotMatch(beta, /macOS|Linux|install-macos/);
  for (const version of ['8.2.7', '8.2.7-rc.1']) {
    assert.equal(releaseNotes(notes, english, version), `## Changes in ${version}\n\n- **Alpha** Does a thing.`);
  }
  const result = run('--version', '8.2.7-beta.12');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\*\*Windows test build:\*\*/);
});

test('the script prints the real English notes for the version and fails on bad arguments', () => {
  const result = run('--version', '1.3.24');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `## Changes in 1.3.24\n\n${WHATS_NEW.map(({ title, text }) => `- **${en[title]}** ${en[text]}`).join('\n')}\n`);
  for (const args of [[], ['--version'], ['--version', 'x'], ['--version', '1.3.24', 'extra'], ['1.3.24']]) {
    const failed = run(...args);
    assert.notEqual(failed.status, 0, args.join(' '));
    assert.equal(failed.stdout, ''); assert.notEqual(failed.stderr, '');
  }
});
