// What a CLI shows while it signs in, before its input exists: the page to open in a browser (Claude's link to sign in,
// Codex's device page), a one-time code to enter there, a field for what the browser gave back (Claude's code, an
// OpenAI API key), and the keys it waits for. The reading view turns it into a sign-in popup; nothing here is
// answered on the reader's behalf.
export type SignInScreen = {
  lines: string[]; url: string | null; code: string | null;
  // code: Claude's "Paste code here"; key: Codex's API key field. Either is typed into the CLI followed by Enter.
  input: 'code' | 'key' | null;
  // Enter goes on (a success or a notice); Escape cancels or goes back.
  enter: boolean; cancel: boolean;
};

// Art (Claude's logo, Codex's braille mark) has no letters; a box drawn around an input field is not art.
const art = (row: string) => !!row.trim() && !/\p{L}/u.test(row) && !/^[\s╭╮╰╯─│]+$/.test(row);
const box = (row: string) => /^\s*[╭╰│]/.test(row);
const hint = (row: string) => /^\s*Press (?:enter|esc)\b/i.test(row) || /^\s*(?:Esc|Enter) to (?:cancel|go back|continue|confirm)\b/i.test(row);
const urlChars = /^[A-Za-z0-9%\-._~:/?#[\]@!$&'()*+,;=]+$/;

export function parseSignIn(rows: string[], width: number | undefined, layout: {
  marker: RegExp; footer: RegExp; field: RegExp; input: 'code' | 'key';
}): SignInScreen | null {
  const text = rows.join('\n');
  if (!rows.some(row => layout.marker.test(row.trim())) || rows.filter(row => row.trim()).slice(-6).some(row => layout.footer.test(row))) return null;
  // What is under the CLI's own art (and the shell line it was started from) belongs to the sign-in.
  let start = 0;
  for (let index = rows.length - 1; index >= 0; index--) if (art(rows[index])) { start = index + 1; break; }
  const body = rows.slice(start).map(row => row.trimEnd());
  let url: string | null = null, code: string | null = null;
  const lines: string[] = [];
  for (let index = 0; index < body.length; index++) {
    const row = body[index], trimmed = row.trim();
    if (!trimmed || box(row) || hint(row) || /^Welcome to (?:Codex|Claude Code)\b/.test(trimmed) || /^Paste code here if prompted/i.test(trimmed)) continue;
    const found = /https?:\/\/\S+$/.exec(trimmed);
    if (found && !url) {
      // A long link wraps onto the rows under it: they hold nothing but link characters.
      url = found[0];
      while (body[index].length === width && index + 1 < body.length && urlChars.test(body[index + 1].trim())) url += body[++index].trim();
      const before = trimmed.slice(0, found.index).trim();
      if (before) lines.push(before);
      continue;
    }
    if (!code && /^[A-Z0-9]{4,5}-[A-Z0-9]{4,6}$/.test(trimmed)) { code = trimmed; continue; }
    // Claude's spinner glyph heads a line while it waits ("* Opening browser to sign in…").
    lines.push(trimmed.replace(/^[·✢✳✶✻✽*]\s+/, '').replace(/\s*\((?:c|press c) to copy\)/i, '').replace(/\s{2,}/g, ' '));
  }
  const input = layout.field.test(text) ? layout.input : null;
  return { lines, url, code, input, enter: !input && /\bpress enter\b|\benter to (?:continue|confirm)\b/i.test(text), cancel: /\besc\b/i.test(text) };
}
