// Ctrl+F in the file editor: every place the words occur (as typed, or ignoring case), and which one comes next from
// the caret, going round at either end.
export type Match = { start: number; end: number };
const LIMIT = 10000;

export function findMatches(text: string, query: string, matchCase: boolean): Match[] {
  if (!query) return [];
  // Ignoring case compares lower-case copies; a text whose lower case changes its length (a dotted İ) keeps its case.
  const lower = matchCase ? text : text.toLowerCase();
  const fold = !matchCase && lower.length === text.length;
  const haystack = fold ? lower : text, needle = fold ? query.toLowerCase() : query;
  const found: Match[] = [];
  for (let at = haystack.indexOf(needle); at !== -1 && found.length < LIMIT; at = haystack.indexOf(needle, at + needle.length)) found.push({ start: at, end: at + needle.length });
  return found;
}

// The first match at or after a place (the caret), or the first of all after the last one.
export function matchFrom(matches: readonly Match[], position: number): number {
  if (!matches.length) return -1;
  const index = matches.findIndex(match => match.start >= position);
  return index < 0 ? 0 : index;
}

export const stepMatch = (index: number, count: number, direction: 1 | -1) => count ? (index + direction + count) % count : -1;
