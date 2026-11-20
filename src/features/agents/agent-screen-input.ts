import type { AgentScreen, ScreenAgent } from './agent-screen-types.ts';
import { codexDialog } from './agent-screen.ts';

const rule = (row: string) => /^(?:[─╌] *){2,}$/.test(row.trim());
const commandInputText = (text: string) => {
  const trimmed = text.trim();
  return trimmed.startsWith('!') ? '!' + trimmed.slice(1).trimStart() : trimmed;
};
const prompt = (agent: ScreenAgent, row: string) => {
  const shell = /^\s*!(?:\s+(.*))?$/.exec(row.replace(/\r$/, ''));
  if (shell) return '!' + (shell[1] ?? '').trim();
  const match = (agent === 'claude' ? /^\s*❯(?:\s+(.*))?$/ : /^\s*›(?:\s+(.*))?$/).exec(row.replace(/\r$/, ''));
  if (!match) return null;
  return (match[1] ?? '').trim();
};

// A historical prompt is not an input area. Claude needs both surrounding rules, a long draft wrapping over indented
// rows before the closing one (a dictated message left there unsent); Codex needs its footer right under it (a long
// draft wraps over a few rows first): the prompt Codex pins to its top row, over a view that took the input's place
// (/plugins), has none.
function cliInputArea(agent: ScreenAgent, rows: string[], wrapped?: (row: number) => boolean) {
  for (let index = rows.length - 1; index >= 0; index--) {
    const text = prompt(agent, rows[index]);
    if (text === null) continue;
    if (agent === 'claude') {
      if (!rule(rows[index - 1] ?? '')) continue;
      let end = index + 1;
      while (end < rows.length && (wrapped?.(end) || !rule(rows[end]) && (/^[ \u00a0]{2}\S/.test(rows[end]) || !rows[end].trim()))) end++;
      if (!rule(rows[end] ?? '')) continue;
      // Claude Code 2.1.296 draws its effort right over the input box ("◉ xhigh · /effort"): part of it, never output.
      const start = /^\s*[●◉]\s+\S+\s+·\s+\/effort\b/.test(rows[index - 2] ?? '') ? index - 2 : index - 1;
      const draft = [text, ...rows.slice(index + 1, end).map(row => row.trim())].join(' ').trim();
      return { row: index, start, footer: end + 1, text: draft };
    }
    const following = rows.slice(index + 1), footer = following.findIndex(codexFooterRow);
    if (footer !== -1) {
      const draft = [text, ...following.slice(0, footer).filter(row => /^ {2}\S/.test(row)).map(row => row.trim())].join(' ').trim();
      return { row: index, start: index, footer: index + 1 + footer, text: draft };
    }
  }
  return null;
}

// Limit styled hint detection to Claude's boxed message input, which uses ❯ rather than the shell's ! marker.
export function claudePromptRange(rows: string[], wrapped: (row: number) => boolean) {
  const input = cliInputArea('claude', rows, wrapped);
  if (!input) return null;
  const marker = /^[ \u00a0]*❯(?:[ \u00a0]+|$)/.exec(rows[input.row]);
  return marker ? { first: input.row, end: input.footer - 1, prefix: marker[0].length } : null;
}

// Claude's live status line while it works: a cycling glyph and a verb ending in "…" ("✶ Osmosing… (running
// UserPromptSubmit hooks…)"). Claude 2.1 empties its input on Enter and shows this while hooks run, before a command
// draws anything, so an empty input beside it is not idle. A finished turn's "✻ Worked for 25s" has no ellipsis.
export const claudeWorking = (rows: string[]) => rows.some(row => /^\s*[·✢✳✶✻✽*]\s+\S[^…]*…/.test(row));
export function isCliWorking(agent: ScreenAgent, rows: string[], _screen: AgentScreen): boolean {
  if (agent === 'codex') return rows.some(row => /^\s*[•◦].*\besc to interrupt\b/i.test(row));
  const input = cliInputArea(agent, rows);
  return claudeWorking(rows) || !!input && claudeShellRunning(rows, input.start);
}

export const queueShown = (rows: string[]) => rows.some((row, index) => {
  const first = row.trim();
  return first.startsWith('ctrl+x') && [first, first + ' ' + (rows[index + 1] ?? '').trim()].includes('ctrl+x ctrl+s to send now');
});
// The registry reads Claude's cell attributes first. For plain rows, match the entire placeholder independently of
// queue state: a redraw can show the hint without its shortcut, and the CLI's queue can precede main's report.
const claudeQueueHint = /^(?:press up|↑) to edit queued messages[.。]?$|^(?:按(?:向上键|上方向键|上箭头|↑)|↑) *(?:编辑|可编辑)(?:已排队(?:的)?消息|队列中的消息)[.。]?$/i;
const claudeTryHint = /^(?:Try|试试) *["“][^"”]*["”]$/i;
export const withoutClaudeCursor = (text: string) => text.replace(/[█▉▊▋▌▍▎▏▮]\s*$/, '').trimEnd();
const claudeHintText = (text: string) => claudeQueueHint.test(text) || claudeTryHint.test(text);
const claudePieces = (rows: string[], area: NonNullable<ReturnType<typeof cliInputArea>>) =>
  [prompt('claude', rows[area.row]) ?? '', ...rows.slice(area.row + 1, area.footer - 1)].map(row => row.trim());

export function claudeInputHint(rows: string[], area = cliInputArea('claude', rows)): boolean {
  if (!area || !/^\s*❯/.test(rows[area.row])) return false;
  const text = withoutClaudeCursor(area.text).replace(/\s+/g, ' ');
  if (claudeHintText(text)) return true;
  // Hard wraps can bisect a word. Preserve spaces within each row and only make row boundaries optional.
  if (area.footer - area.row <= 2) return false;
  const pieces = claudePieces(rows, area).filter(Boolean).map(piece => piece.replace(/\s+/g, ' ').toLowerCase());
  if (pieces.length) pieces[pieces.length - 1] = withoutClaudeCursor(pieces[pieces.length - 1]);
  const suffix = /[.。]$/.exec(text)?.[0] ?? '';
  const joined = pieces.join('');
  return claudeHintText(joined) || ['press up', '↑'].some(key => matchesPieces(pieces, `${key} to edit queued messages${suffix}`));
}

export function cliInputDraft(agent: ScreenAgent, rows: string[], screen: AgentScreen) {
  const area = cliInputArea(agent, rows);
  if (!area || (agent === 'claude' ? screen.inputHint || claudeInputHint(rows, area) : area.text === 'Ask Codex to do anything')) return '';
  return commandInputText(area.text);
}

// A visual line break can split a word. Compare the visible pieces without inventing spaces at their boundaries.
export function claudeInputMatches(rows: string[], expected: string) {
  const area = cliInputArea('claude', rows);
  return !!area && !!expected.trim() && !claudeInputHint(rows, area) && matchesPieces(claudePieces(rows, area), expected.trim());
}

function matchesPieces(pieces: string[], remaining: string) {
  for (const text of pieces) {
    if (!remaining.startsWith(text)) return false;
    remaining = remaining.slice(text.length).trimStart();
  }
  return !remaining;
}

// Busy agents can take queued messages; dialogs and pickers own the keys even when the input stays visible.
export function cliDialogShown(agent: ScreenAgent, rows: string[], screen: AgentScreen): boolean {
  if (screen.choice || screen.waiting || screen.overlay !== 'none') return true;
  // A live panel's key strip, not an arbitrary missing input or a paragraph mentioning Enter.
  const tail = rows.filter(row => row.trim()).at(-1)?.trim() ?? '';
  if (/^(?:press )?esc to (?:cancel|close|go back|dismiss)$/i.test(tail)
    || /^(?:Type to filter|[←→/]+ tabs|enter select)\b.*\besc\b/i.test(tail)) return true;
  if (!cliInputArea(agent, rows) && rows.some(row => /^\s*Sign in to (?:Claude Code|Codex)\s*$/.test(row))
    && rows.some(row => /^Paste the authorization code below:/.test(row))) return true;
  if (agent !== 'codex') return false;
  const input = cliInputArea(agent, rows);
  return !!codexDialog(rows) || !!input && codexPickerBelow(rows, input.footer);
}

// The agent waits at its own input: no question or popup and no working line. Status footer wording is optional.
export function isAtPrompt(agent: ScreenAgent, rows: string[], screen: AgentScreen): boolean {
  return !cliDialogShown(agent, rows, screen) && !isCliWorking(agent, rows, screen) && !!cliInputArea(agent, rows);
}

// An empty editor can accept a paste even when its placeholder occupies the box.
export function cliInputAvailable(agent: ScreenAgent, rows: string[]): boolean {
  return !!cliInputArea(agent, rows);
}

export function hasCliInput(agent: ScreenAgent, rows: string[], screen: AgentScreen): boolean {
  const area = cliInputArea(agent, rows);
  return !!area && (agent !== 'claude' || !screen.inputHint && !claudeInputHint(rows, area));
}

// At its prompt with nothing typed, as the offline reading fixture expects.
export function isCliIdle(agent: ScreenAgent, rows: string[], screen: AgentScreen): boolean {
  return isAtPrompt(agent, rows, screen) && !cliInputDraft(agent, rows, screen);
}

const codexModelRow = (row: string) => /^\s*(?:GPT|gpt|o\d|codex)[^·]*\s+·\s+.+$/.test(row.replace(/\r$/, ''));
const codexFooterRow = (row: string) => codexModelRow(row) || /^\s*\? for shortcuts\b/.test(row)
  || /^\s*\d+% context left(?:\s|$)/.test(row);
function codexPickerBelow(rows: string[], footerRow: number) {
  return rows.slice(footerRow + 1).some(row => !codexFooterRow(row) && /\b(?:esc|enter)(?:\/tab)?\s+(?:to\s+)?(?:cancel|close|confirm|select|submit|back|continue|details|exit|insert)\b/i.test(row));
}

function claudeShellRunning(rows: string[], end: number) {
  for (let index = end - 1; index >= 0; index--) {
    if (/^\s*!\s+\S/.test(rows[index])) return /^\s*⎿[ \u00a0]+Running…\s*$/.test(rows[index + 1] ?? '');
  }
  return false;
}
