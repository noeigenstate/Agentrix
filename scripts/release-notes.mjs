import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { WHATS_NEW } from '../src/features/guide/guide.ts';

// The same pattern as the workflow's package version check.
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

// The GitHub release body: this release's update notes in English, in the order the guide lists them.
export function releaseNotes(notes, english, version) {
  if (!VERSION.test(version ?? '')) throw new Error(`Invalid version: ${version}`);
  if (!notes.length) throw new Error('WHATS_NEW is empty.');
  const translate = text => english[text] || (() => { throw new Error(`No English for: ${text}`); })();
  return [`## Changes in ${version}`, '', ...notes.map(({ title, text }) => `- **${translate(title)}** ${translate(text)}`)].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [flag, version, ...extra] = process.argv.slice(2);
  try {
    if (flag !== '--version' || extra.length) throw new Error('Usage: node scripts/release-notes.mjs --version <x.y.z>');
    const english = JSON.parse(readFileSync(new URL('../electron/locales/en.json', import.meta.url), 'utf8'));
    console.log(releaseNotes(WHATS_NEW, english, version));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
