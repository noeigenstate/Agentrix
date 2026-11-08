// The local pictures, pages and videos a reply names, to show under it: a Markdown image or link
// ("![dog](C:/out/dog.png)"), a path in backticks (spaces allowed), or a bare path in the text ("保存到 C:\out\dog.png
// （1536×1024）"). Web addresses are left alone (an answer has no business loading anything), and so are pictures
// Codex generated itself, which show as their own entry. Documents and code are named all the time and get no card.
const EXTENSIONS = 'png|jpe?g|gif|webp|bmp|html?|mp4|webm|mov|m4v';
const SHOWN = new RegExp(String.raw`\.(?:${EXTENSIONS})$`, 'i'), MENTIONED = new RegExp(String.raw`\.(?:${EXTENSIONS})`, 'i');
const MAX = 8;
// A bare path stops at spaces, quotes, brackets and Chinese punctuation; only a drive letter may carry a colon.
const segment = String.raw`[^\s\x60'"<>|*?()（）\[\]{}，。；：、！？“”:\\/]`;
const BARE = new RegExp(String.raw`(?<![\w.\\/:-])((?:[A-Za-z]:[\\/]|~?/|\.{1,2}[\\/])?(?:${segment}+[\\/])*${segment}+\.(?:${EXTENSIONS}))(?!\w|\.\w)`, 'gi');

export function replyFiles(text: string): string[] {
  if (!MENTIONED.test(text)) return [];
  // Where each was named, so the cards come in the reply's order.
  const named: [number, string][] = [];
  const link = /!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^)\s]+)/g, code = /`([^`\n]+)`/g, url = /(file:\/\/[^\s<>"'`()（）]+)/gi;
  for (const pattern of [link, code, url]) for (const match of text.matchAll(pattern)) named.push([match.index, match[1]]);
  // What is left once those are blanked out: part of a path with a space in it is no path of its own.
  const blank = (match: string) => ' '.repeat(match.length);
  for (const match of text.replace(link, blank).replace(code, blank).replace(url, blank).matchAll(BARE)) named.push([match.index, match[1]]);
  const found = new Map<string, string>();
  for (const [, raw] of named.sort((a, b) => a[0] - b[0])) {
    let file = raw.trim().replace(/^<(.*)>$/, '$1').replace(/^file:\/\/(?:localhost)?\/?(?=[A-Za-z]:|\/)/i, '');
    if (/%[0-9a-f]{2}/i.test(file)) { try { file = decodeURI(file); } catch { /* kept as written */ } }
    if (!SHOWN.test(file) || /^[a-z][\w+.-]+:/i.test(file) || /[\\/]generated_images[\\/]/i.test(file)) continue;
    const key = /^(?:[a-z]:[\\/]|\\\\)/i.test(file) ? file.replace(/\\/g, '/').toLowerCase() : file;
    if (!found.has(key) && found.size < MAX) found.set(key, file);
  }
  return [...found.values()];
}
