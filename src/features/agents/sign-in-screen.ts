import type { ScreenAgent } from './agent-screen-types.ts';

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

const MARKERS: Record<ScreenAgent, RegExp> = {
  claude: /Paste code here if prompted|Browser didn't open\?|Opening browser to sign in|Login successful|Login interrupted|OAuth error|Invalid code|Security notes:/i,
  codex: /Finish signing in via your browser|Paste or type your API key|Preparing device code login|Signed in with your ChatGPT account|Sign-in (?:failed|was cancelled)/i,
};
// Art (Claude's logo, Codex's braille mark) has no letters; a box drawn around an input field is not art.
const art = (row: string) => !!row.trim() && !/\p{L}/u.test(row) && !/^[\s╭╮╰╯─│]+$/.test(row);
const box = (row: string) => /^\s*[╭╰│]/.test(row);
const hint = (row: string) => /^\s*Press (?:enter|esc)\b/i.test(row) || /^\s*(?:Esc|Enter) to (?:cancel|go back|continue|confirm)\b/i.test(row);
const urlChars = /^[A-Za-z0-9%\-._~:/?#[\]@!$&'()*+,;=]+$/;

// The footer the CLI draws under its input while it works (Claude's mode line, "? for shortcuts", Codex's model line):
// with it on screen nothing is signing in, and a sign-in line above it ("Login successful" after /login) is only what
// it printed. Neither CLI draws it on its sign-in pages.
const FOOTER: Record<ScreenAgent, RegExp> = {
  claude: /^\s*(?:(?:⏵⏵|⏸|⏵)\s.*(?:mode on|shift\+tab|for agents?|\d+ agents?)|\?\s+for shortcuts\b|.*·\s*←\s*(?:for agents|\d+ agents?))/,
  codex: /^\s*(?:\?\s+for shortcuts\b|\S.*·\s*\d+%\s+(?:left|context left)\b|\S.*·\s*\d+[KM]?\s+window\b)/,
};

export function signInScreen(agent: ScreenAgent, rows: readonly string[]): SignInScreen | null {
  const text = rows.join('\n');
  if (!MARKERS[agent].test(text)) return null;
  if (rows.filter(row => row.trim()).slice(-6).some(row => FOOTER[agent].test(row))) return null;
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
      while (index + 1 < body.length && urlChars.test(body[index + 1].trim())) url += body[++index].trim();
      const before = trimmed.slice(0, found.index).trim();
      if (before) lines.push(before);
      continue;
    }
    if (!code && /^[A-Z0-9]{4,5}-[A-Z0-9]{4,6}$/.test(trimmed)) { code = trimmed; continue; }
    // Claude's spinner glyph heads a line while it waits ("* Opening browser to sign in…").
    lines.push(trimmed.replace(/^[·✢✳✶✻✽*]\s+/, '').replace(/\s*\((?:c|press c) to copy\)/i, '').replace(/\s{2,}/g, ' '));
  }
  const input = /Paste code here if prompted/i.test(text) ? 'code' : agent === 'codex' && /Paste or type your API key/i.test(text) ? 'key' : null;
  return { lines, url, code, input, enter: !input && /\bpress enter\b|\benter to (?:continue|confirm)\b/i.test(text), cancel: /\besc\b/i.test(text) };
}
