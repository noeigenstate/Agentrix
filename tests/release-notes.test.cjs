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
