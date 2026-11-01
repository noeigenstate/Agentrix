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
  assert.match(guide, /\.guide-notes \{ max-height: min\(440px, 52vh\); overflow-y: auto; \}/);
  assert.doesNotMatch(read('src/features/settings/settings.css'), /about-notes/);
});

const script = path.join(__dirname, '..', 'scripts', 'release-notes.mjs');
const load = () => import(require('node:url').pathToFileURL(script).href);
const run = (...args) => require('node:child_process').spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('the release body lists every update note in English, in the guide order, under the version', async () => {
  const { releaseNotes } = await load();
  const notes = [{ title: '甲', text: '一句话' }, { title: '乙', text: '另一句话' }];
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
