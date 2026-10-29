import type { AgentScreen, ScreenAgent } from '../agents/agent-screen-types.ts';
import { codexDialog } from '../agents/agent-screen.ts';

const rule = (row: string) => /^[─╌]{2,}$/.test(row.trim());
const commandInputText = (text: string) => {
  const trimmed = text.trim();
  return trimmed.startsWith('!') ? '!' + trimmed.slice(1).trimStart() : trimmed;
};
const prompt = (agent: ScreenAgent, row: string) => {
  const shell = /^\s*!(?:\s+(.*))?$/.exec(row.replace(/\r$/, ''));
  if (shell) return '!' + (shell[1] ?? '').trim();
  const match = (agent === 'claude' ? /^\s*❯(?:\s+(.*))?$/ : /^\s*›(?:\s+(.*))?$/).exec(row.replace(/\r$/, ''));
  if (!match || /^\d+\.\s/.test(match[1] ?? '')) return null;
  return (match[1] ?? '').trim();
};

// A historical prompt is not an input area. Claude needs both surrounding rules, a long draft wrapping over indented
// rows before the closing one (a dictated message left there unsent); Codex needs its footer right under it (a long
// draft wraps over a few rows first): the prompt Codex pins to its top row, over a view that took the input's place
// (/plugins), has none.
function cliInputArea(agent: ScreenAgent, rows: string[], screen: AgentScreen) {
  const status = screen.status;
  const hasFooter = !!(status.model || status.mode || status.context || status.effort || status.notes.length);
  for (let index = rows.length - 1; index >= 0; index--) {
    const text = prompt(agent, rows[index]);
    if (text === null) continue;
    if (agent === 'claude') {
      if (!rule(rows[index - 1] ?? '')) continue;
      let end = index + 1;
      while (end < rows.length && end - index <= 24 && !rule(rows[end]) && /^ {2}\S/.test(rows[end])) end++;
      if (!rule(rows[end] ?? '')) continue;
      // Claude Code 2.1.296 draws its effort right over the input box ("◉ xhigh · /effort"): part of it, never output.
      const start = /^\s*[●◉]\s+\S+\s+·\s+\/effort\b/.test(rows[index - 2] ?? '') ? index - 2 : index - 1;
      const draft = [text, ...rows.slice(index + 1, end).map(row => row.trim())].join(' ').trim();
      return { row: index, start, footer: end + 1, text: draft, hasFooter };
    }
    const following = rows.slice(index + 1, index + 14), footer = following.findIndex(codexModelRow);
    if (footer !== -1) {
      const draft = [text, ...following.slice(0, footer).filter(row => /^ {2}\S/.test(row)).map(row => row.trim())].join(' ').trim();
      return { row: index, start: index, footer: index + 1, text: draft, hasFooter: true };
    }
  }
  return null;
}

// Claude's live status line while it works: a cycling glyph and a verb ending in "…" ("✶ Osmosing… (running
// UserPromptSubmit hooks…)"). Claude 2.1 empties its input on Enter and shows this while hooks run, before a command
// draws anything, so an empty input beside it is not idle. A finished turn's "✻ Worked for 25s" has no ellipsis.
const claudeWorking = (rows: string[]) => rows.some(row => /^\s*[·✢✳✶✻✽*]\s+\S[^…]*…/.test(row));

// What is typed in the CLI's own input, without its placeholder ("Try …", "Ask Codex to do anything"). Claude puts an
// interrupted prompt back there, so it can hold text the reading view did not type.
const placeholder = (agent: ScreenAgent, text: string) => agent === 'claude' ? /^Try ["“].+["”]$/.test(text) : text === 'Ask Codex to do anything';
export function cliInputDraft(agent: ScreenAgent, rows: string[], screen: AgentScreen) {
  const text = cliInputArea(agent, rows, screen)?.text ?? '';
  return placeholder(agent, text) ? '' : commandInputText(text);
}

// Busy agents can take queued messages; dialogs and pickers own the keys even when the input stays visible.
export function cliDialogShown(agent: ScreenAgent, rows: string[], screen: AgentScreen): boolean {
  if (screen.choice || screen.overlay !== 'none') return true;
  if (agent !== 'codex') return false;
  const input = cliInputArea(agent, rows, screen);
  return !!codexDialog(rows) || !!input && codexPickerBelow(rows, input.row);
}

// The agent waits at its own input: no question or popup, no working line, and its input box with the footer drawn.
export function isAtPrompt(agent: ScreenAgent, rows: string[], screen: AgentScreen): boolean {
  if (cliDialogShown(agent, rows, screen) || (agent === 'claude' && claudeWorking(rows))) return false;
  const input = cliInputArea(agent, rows, screen);
  if (agent === 'claude' && input && claudeShellRunning(rows, input.start)) return false;
  return !!input?.hasFooter;
}

// A dialog (Claude's /usage, /status, /config) takes the input's place; its content is the command's result.
export function hasCliInput(agent: ScreenAgent, rows: string[], screen: AgentScreen): boolean {
  return !!cliInputArea(agent, rows, screen);
}

// At its prompt with nothing typed, as the offline reading fixture expects.
export function isCliIdle(agent: ScreenAgent, rows: string[], screen: AgentScreen): boolean {
  return isAtPrompt(agent, rows, screen) && !cliInputDraft(agent, rows, screen);
}

const codexModelRow = (row: string) => /^\s*(?:GPT|gpt|o\d|codex)[^·]*\s+·\s+.+$/.test(row.replace(/\r$/, ''));
const codexFooterRow = (row: string) => codexModelRow(row) || /^\s*(?:\? for shortcuts|⚠)/.test(row);
function codexPickerBelow(rows: string[], inputRow: number) {
  return rows.slice(inputRow + 1).some(row => !codexFooterRow(row) && /\besc\b|\benter\b/i.test(row));
}

function claudeShellRunning(rows: string[], end: number) {
  for (let index = end - 1; index >= 0; index--) {
    if (/^\s*!\s+\S/.test(rows[index])) return /^\s*⎿[ \u00a0]+Running…\s*$/.test(rows[index + 1] ?? '');
  }
  return false;
}
