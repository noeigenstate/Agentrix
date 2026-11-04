const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { WHATS_NEW } = require('../src/features/guide/guide.ts');
const en = require('../electron/locales/en.json');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('each release note is a short title and a detail line, both translated, and the title is not repeated in the detail', () => {
  assert.ok(WHATS_NEW.length >= 1);
  assert.equal(new Set(WHATS_NEW.map(note => note.title)).size, WHATS_NEW.length, 'titles are distinct');
  for (const { title, text } of WHATS_NEW) {
    assert.ok([...title].length >= 2 && [...title].length <= 12, `${title}: a short title`);
    assert.ok(text.length > 8 && !text.startsWith(title), `${title}: the detail does not lead with the title`);
    assert.ok(en[title], `${title}: translated`); assert.ok(en[text], `${text}: translated`);
  }
});

test('the guide and the About page share one list: left-aligned, one marker colour, strong title over secondary detail, scrolling only when it overflows', () => {
  const component = read('src/features/guide/ReleaseNotes.tsx'), css = read('src/features/guide/release-notes.css'), guide = read('src/features/guide/guide.css');
  assert.match(component, /<li key=\{title\}><b>\{t\(title\)\}<\/b>\{t\(text\)\}<\/li>/);
  assert.match(read('src/features/guide/UsageGuide.tsx'), /<ReleaseNotes \/>/); assert.match(read('src/features/settings/AboutSettings.tsx'), /<ReleaseNotes \/>/);
  assert.match(css, /\.release-notes \{[^}]*list-style: none; text-align: left;[^}]*color: var\(--text-2\)/);
  assert.match(css, /\.release-notes li::before \{[^}]*background: var\(--usage\)/, 'the marker takes the list colour, not a literal');
  assert.match(css, /\.release-notes b \{[^}]*font-weight: 600; color: var\(--text-1\)/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'tokens only');
  assert.match(css, /\.release-notes \{[^}]*gap: 12px/);
  assert.match(guide, /\.guide-notes \{[^}]*min-height: 0; max-height: min\(440px, 52vh\); padding-right: 8px; overflow-y: auto;/, 'the list scrolls, shrinks and keeps the scrollbar off the text');
  assert.doesNotMatch(read('src/features/settings/settings.css'), /about-notes/);
});

test('the guide card never outgrows the window: it clips, the buttons never shrink, and only the notes scroll', () => {
  const guide = read('src/features/guide/guide.css');
  assert.match(guide, /\.settings-dialog\.guide-dialog \{[^}]*overflow: hidden;/, 'the card itself has no scrollbar');
  assert.match(guide, /\.settings-dialog\.guide-dialog\[open\] \{ display: flex; flex-direction: column; \}/);
  assert.match(guide, /\.guide-content \{ flex: 1; min-height: 0;/);
  for (const part of ['guide-logo', 'guide-dots', 'guide-footer', 'guide-links']) assert.match(guide, new RegExp(`\\.${part} \\{ flex: none;`), `${part} keeps its size`);
  assert.match(guide, /\.guide-content h2 \{ flex: none;/);
  assert.match(guide, /\.guide-body \{ display: flex; flex-direction: column;/, 'the body passes the room on to the notes');
  assert.equal((guide.match(/overflow-y: auto/g) || []).length, 1, 'one scrolling region in the card');
  assert.match(read('src/features/settings/settings.css'), /\.about-page \.release-groups, \.about-page \.release-notes \{ max-width: \d+px; \}/, 'the About change log has a comfortable line length');
});

test('this beta\'s notes come first as a group the list shows under its own heading, with the rest of the release under another', () => {
  const marked = WHATS_NEW.map(note => note.group === 'new');
  assert.ok(marked.some(Boolean) && marked.some(flag => !flag), 'both groups are present');
  assert.deepEqual(marked, [...marked].sort((a, b) => Number(b) - Number(a)), 'the new notes are a prefix, so the release body keeps its order');
  assert.ok(WHATS_NEW.every(note => note.group === undefined || note.group === 'new'));
  const component = read('src/features/guide/ReleaseNotes.tsx'), css = read('src/features/guide/release-notes.css');
  for (const heading of ['本次测试版新增', '1.3.26 的其他更新']) {
    assert.match(component, new RegExp(`<h4>\\{t\\('${heading}'\\)\\}</h4>`));
    assert.ok(en[heading], `${heading}: translated`);
  }
  assert.equal(en['本次测试版新增'], 'New in this beta'); assert.equal(en['1.3.26 的其他更新'], 'Also in 1.3.26');
  assert.match(component, /!added\.length \|\| !earlier\.length\) return <NoteList notes=\{WHATS_NEW\} \/>/, 'with one kind of note there are no headings');
  assert.match(css, /\.release-groups h4 \{[^}]*font-size: 12px;[^}]*color: var\(--text-2\)/);
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
