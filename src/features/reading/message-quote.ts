// A quoted message travels as Markdown "> " lines before the words of the next message, so the CLI receives plain text.
// The quote is a gist of the message, never all of it: bounded in lines and characters, cut with "…".
export const QUOTE_LINES = 6;
export const QUOTE_CHARS = 400;

export type MessageQuote = { who: string; excerpt: string };

// The leading "> " block of a message and the words after it. A message that does not begin with one has no quote.
export function splitQuote(text: string): { quote: string | null; rest: string } {
  const lines = text.split(/\r?\n/);
  let count = 0;
  while (count < lines.length && /^>(?: |$)/.test(lines[count])) count++;
  if (!count) return { quote: null, rest: text };
  return { quote: lines.slice(0, count).map(line => line.slice(2)).join('\n'), rest: lines.slice(count).join('\n').replace(/^\s*\n/, '') };
}

// What of a message is quoted: its own words (a quote it carries is dropped, so quotes never nest), without blank lines.
export function quoteExcerpt(text: string): string {
  const lines = splitQuote(text).rest.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line.trim());
  let excerpt = lines.slice(0, QUOTE_LINES).join('\n'), cut = lines.length > QUOTE_LINES;
  if (excerpt.length > QUOTE_CHARS) { excerpt = excerpt.slice(0, QUOTE_CHARS).replace(/[\ud800-\udbff]$/, '').trimEnd(); cut = true; }
  return cut ? `${excerpt}…` : excerpt;
}

// The excerpt as one plain line for the chip: block markers (heading, list, quote), code ticks, emphasis and link syntax
// dropped, the lines joined with a space. The chip's own ellipsis cuts what does not fit.
export function plainExcerpt(excerpt: string): string {
  return excerpt.split('\n')
    .map(line => line.replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)+/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/(\*\*|__|~~|[`*])/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean).join(' ');
}

// Only an ordinary message carries a quote: a slash command or shell line is typed as it is and keeps the quote for the next one.
export const withQuote = (excerpt: string | undefined, text: string) =>
  excerpt ? `${excerpt.split('\n').map(line => `> ${line}`).join('\n')}\n\n${text}` : text;
