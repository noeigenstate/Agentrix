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
function cliInputArea(agent: ScreenAgent, rows: string[]) {
  for (let index = rows.length - 1; index >= 0; index--) {
    const text = prompt(agent, rows[index]);
    if (text === null) continue;
    if (agent === 'claude') {
      if (!rule(rows[index - 1] ?? '')) continue;
      let end = index + 1;
      while (end < rows.length && !rule(rows[end]) && (/^ {2}\S/.test(rows[end]) || !rows[end].trim())) end++;
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

// Claude's live status line while it works: a cycling glyph and a verb ending in "…" ("✶ Osmosing… (running
// UserPromptSubmit hooks…)"). Claude 2.1 empties its input on Enter and shows this while hooks run, before a command
// draws anything, so an empty input beside it is not idle. A finished turn's "✻ Worked for 25s" has no ellipsis.
const claudeWorking = (rows: string[]) => rows.some(row => /^\s*[·✢✳✶✻✽*]\s+\S[^…]*…/.test(row));
export function isCliWorking(agent: ScreenAgent, rows: string[], _screen: AgentScreen): boolean {
  if (agent === 'codex') return rows.some(row => /^\s*[•◦].*\besc to interrupt\b/i.test(row));
  const input = cliInputArea(agent, rows);
  return claudeWorking(rows) || !!input && claudeShellRunning(rows, input.start);
}

// What is typed in the CLI's own input, without its placeholder ("Try …", "Ask Codex to do anything"). Claude puts an
// interrupted prompt back there, so it can hold text the reading view did not type. Claude Code 2.1.317 lists the
// messages it queued above its working line, over "ctrl+x ctrl+s to send now", and shows "Press up to edit queued
// messages" in the empty input; without that queue row the same words are typed ones.
const queueShown = (rows: string[]) => rows.some(row => /^\s*ctrl\+x ctrl\+s to send now\s*$/.test(row));
const placeholder = (agent: ScreenAgent, text: string, rows: string[]) => agent === 'claude'
  ? /^Try ["“].+["”]$/.test(text) || text === 'Press up to edit queued messages' && queueShown(rows)
  : text === 'Ask Codex to do anything';
export function cliInputDraft(agent: ScreenAgent, rows: string[], _screen: AgentScreen) {
  const text = cliInputArea(agent, rows)?.text ?? '';
  return placeholder(agent, text, rows) ? '' : commandInputText(text);
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

// A dialog (Claude's /usage, /status, /config) takes the input's place; its content is the command's result.
export function hasCliInput(agent: ScreenAgent, rows: string[], _screen: AgentScreen): boolean {
  return !!cliInputArea(agent, rows);
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
