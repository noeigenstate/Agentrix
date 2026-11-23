import type { AgentSettings } from '../../shared/types';
import type { LeadRoutingCommand } from '../../shared/lead-routing-notices.ts';
import { modelName } from '../../shared/model-name.ts';
import { sameModel, type LeadStep } from './lead-steps.ts';

const SESSION_ONLY = /\bs to use this session only\b/i;
const EFFORT_SESSION_ENTER = /\bEnter to use this session only\s*·\s*Esc to cancel\b/i;
const MODEL_HEADER = /^\s*Select model\s*$/i;
const EFFORT_HEADER = /^\s*Effort\s*$/i;
const UP = '\x1b[A', DOWN = '\x1b[B', LEFT = '\x1b[D', RIGHT = '\x1b[C';

function menuRows(rows: string[], title: RegExp) {
  for (let i = rows.length - 1; i >= 0; i--) if (title.test(rows[i])) return rows.slice(i);
  return null;
}

type PickerStep = Exclude<LeadStep, { kind: 'fast' }>;
const pickerRows = (step: PickerStep, rows: string[]) => menuRows(rows, step.kind === 'model' ? MODEL_HEADER : EFFORT_HEADER);

function modelChoice(target: string, label: string, description: string) {
  if (/^default\b/i.test(label)) return false;
  const context = /(?:\[1m\]|\(1m(?: context)?\))$/i;
  if (context.test(target) !== context.test(label)) return false;
  const name = label.replace(context, '').trim();
  const chosen = target.replace(context, '');
  if (/^(opus|sonnet|haiku|fable)$/i.test(chosen)) return chosen.toLowerCase() === name.toLowerCase();
  const release = /^(?:opus|sonnet|haiku|fable) \d+(?:\.\d+)?\b/i.exec(description)?.[0];
  const shown = /^(opus|sonnet|haiku|fable)$/i.test(name) ? release : name;
  return !!shown && modelName(chosen).toLowerCase() === shown.toLowerCase();
}

function modelCursor(rows: string[], target: string, scanningDown: boolean) {
  const options = rows.flatMap(row => {
    const match = /^\s*([>❯])?\s*(\d+)\.\s+(.+)$/.exec(row);
    if (!match) return [];
    const [label, description = ''] = match[3].split(/\s{2,}/, 2);
    return [{ active: !!match[1], number: Number(match[2]), matches: modelChoice(target, label.replace(/\s*√$/, ''), description) }];
  });
  const focus = options.find(option => option.active);
  if (!focus) return null;
  const choice = options.find(option => option.matches);
  const down = scanningDown || focus.number === 1;
  return { position: focus.number, down, ultracode: null, key: choice ? choice === focus ? 's' : choice.number < focus.number ? UP : DOWN : down ? DOWN : UP };
}

function effortCursor(rows: string[], step: Extract<LeadStep, { kind: 'effort' }>, confirm: string, text: string) {
  const marker = rows.findIndex(row => /^[\s─]*▲[─\s]/.test(row));
  if (marker < 0) return null;
  const caret = rows[marker].indexOf('▲');
  const levels = [...(rows[marker + 1] ?? '').matchAll(/\b(?:auto|low|medium|high|xhigh|max)\b/gi)];
  const position = levels.findIndex(level => Math.abs(level.index + (level[0].length - 1) / 2 - caret) <= 2);
  if (position < 0) return null;
  const choice = step.target ? levels.findIndex(level => level[0].toLowerCase() === step.target) : position;
  if (choice < 0) return null;
  const toggle = /\bTab to toggle\b/i.test(text) ? /\bUltracode\s+(on|off)\b/i.exec(text)?.[1] : undefined;
  const ultracode = toggle ? toggle.toLowerCase() === 'on' : null;
  const key = choice < position ? LEFT : choice > position ? RIGHT : ultracode !== null && ultracode !== (step.ultracode === true) ? '\t' : confirm;
  return { position, down: false, key, ultracode };
}

export function pickerAction(step: PickerStep, rows: string[], scanningDown = false) {
  const menu = pickerRows(step, rows);
  if (!menu) return null;
  const text = menu.map(row => row.trim()).join(' ');
  const sessionOnly = SESSION_ONLY.test(text);
  if (step.kind === 'model') return sessionOnly ? modelCursor(menu, step.target, scanningDown) : null;
  const confirm = sessionOnly ? 's' : EFFORT_SESSION_ENTER.test(text) ? '\r' : null;
  return confirm ? effortCursor(menu, step, confirm, text) : null;
}

const MODEL_ECHO = /\bSet model to `?(.+?)`? for this session only/i;
const EFFORT_ECHO = /\bSet effort level to (\w+) \(this session only\)/i;
const ULTRACODE_ECHO = /\bUltracode (?:on|off) \(this session only\)|\bUltracode off\. Effort stays \w+\./i;
const FAST_ON = /\bFast mode (ON|OFF)\b/i;
const FAST_UNAVAILABLE = /\bFast mode unavailable:\s*(.+)/i;

function echoes(rows: string[]) {
  return rows.flatMap((row, index) => {
    if (!/^\s*(?:[⎿↯]\s*)*(?:Set (?:model|effort level) to|Ultracode (?:on|off)|Fast mode)\b/i.test(row)) return [];
    const lines = [row.trim()];
    for (const line of rows.slice(index + 1)) {
      if (!/^\s+\S/.test(line) || /^\s*[⎿↯❯>─│╭╰]/.test(line)) break;
      lines.push(line.trim());
    }
    return [lines.join(' ')];
  });
}

function appliedSettings(step: PickerStep, echo: string): Partial<AgentSettings> | null {
  if (step.kind === 'model') {
    const model = MODEL_ECHO.exec(echo)?.[1];
    return model && sameModel(step.target, model) ? { model: modelName(model) } : null;
  }
  const effort = EFFORT_ECHO.exec(echo)?.[1].toLowerCase();
  const ultra = (effort || ULTRACODE_ECHO.test(echo)) ? /\bUltracode (on|off)\b/i.exec(echo)?.[1] : undefined;
  if (!effort && !ultra) return null;
  return { ...(effort ? { effort } : {}), ...(ultra ? { ultracode: ultra.toLowerCase() === 'on' } : {}) };
}

function confirmationMenu(step: PickerStep, rows: string[]) {
  return menuRows(rows, step.kind === 'model' ? /^\s*Switch model\?\s*$/ : /^\s*Change effort level\?\s*$/);
}

export function pickerResult(step: PickerStep, rows: string[]) {
  const menu = confirmationMenu(step, rows);
  if (menu) {
    const choice = menu.map(row => /^\s*[>❯]\s*1\.\s*Yes, switch to (.+?)\s*$/i.exec(row)?.[1]).find(Boolean);
    const matches = choice && (step.kind === 'model' ? sameModel(step.target, choice) : step.target === choice.toLowerCase());
    if (matches && menu.some(row => /Your next response will be slower and use more tokens/i.test(row))) return 'confirm';
    return null;
  }
  return echoes(rows).some(echo => appliedSettings(step, echo)) ? 'applied' : null;
}

function freshEcho<T>(rows: string[], before: string[], parse: (echo: string) => T | null) {
  const after = echoes(rows);
  return after.reduceRight<T | null>((found, echo, index) => found ?? (
    after.slice(0, index + 1).filter(line => line === echo).length > before.filter(line => line === echo).length ? parse(echo) : null
  ), null);
}

async function until(check: () => boolean, active: () => boolean, ms: number) {
  for (const end = Date.now() + ms; active() && Date.now() < end;) {
    if (check()) return true;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return false;
}

type PickerTerminal = {
  rows: () => string[];
  inputMatches: (command: string) => boolean;
  write: (value: string) => void;
  active: () => boolean;
  bound?: () => boolean;
  ready: () => boolean;
};

type Hooks = {
  typed?: () => void;
  submitted: (command: LeadRoutingCommand) => void;
  observed?: (settings: Partial<AgentSettings>, changed: Partial<AgentSettings>) => void;
  failure?: (reason: string) => void;
};

async function selectInPicker(step: PickerStep, { rows, write, active }: PickerTerminal) {
  let previous = '', down = false, effortChanged = false, ultraChanged = false;
  const visited = new Set<string>();
  const actionKey = (action: NonNullable<ReturnType<typeof pickerAction>>) => `${action.position}:${action.key}:${action.ultracode}`;
  while (visited.size < 40) {
    const action = () => pickerAction(step, rows(), down);
    if (!await until(() => { const next = action(); return !!next && actionKey(next) !== previous; }, active, previous ? 1000 : 3000)) break;
    const next = action();
    if (!active() || !next) return null;
    previous = actionKey(next);
    if (visited.has(previous)) break;
    visited.add(previous);
    down = next.down;
    if (next.key === 's' || next.key === '\r') {
      const noop = step.kind === 'effort' && !effortChanged && !ultraChanged;
      if (!noop) write(next.key);
      return { noop, effortChanged, ultraChanged, ultracode: next.ultracode };
    }
    write(next.key);
    effortChanged ||= next.key === LEFT || next.key === RIGHT;
    ultraChanged ||= next.key === '\t';
  }
  return null;
}

async function applyPicker(step: PickerStep, terminal: PickerTerminal, before: string[], hooks?: Hooks) {
  const { rows, active, ready, write } = terminal;
  const choice = await selectInPicker(step, terminal);
  if (!choice) return false;
  const unsupported = step.kind === 'effort' && step.ultracode !== undefined && choice.ultracode === null;
  const selected = step.kind === 'effort' ? {
    ...(step.target ? { effort: step.target } : {}),
    ...(choice.ultracode !== null ? { ultracode: choice.ultracode } : {}),
  } : {};
  if (choice.noop) {
    hooks?.observed?.(selected, {});
    return !unsupported;
  }
  const result = () => freshEcho(rows(), before, echo => appliedSettings(step, echo));
  const confirmed = () => ready() && !!result();
  if (!await until(() => pickerResult(step, rows()) === 'confirm' || confirmed(), active, 5000) || !active()) return false;
  if (pickerResult(step, rows()) === 'confirm') {
    write('\r');
    if (!await until(confirmed, active, 5000) || !active()) return false;
  }
  const echo = result();
  if (!echo) return false;
  if (choice.effortChanged) delete selected.effort;
  if (choice.ultraChanged) delete selected.ultracode;
  hooks?.observed?.({ ...selected, ...echo }, echo);
  return !unsupported && (step.kind === 'model' || (!choice.effortChanged || echo.effort === step.target)
    && (!choice.ultraChanged || echo.ultracode === step.ultracode || step.ultracode === undefined && echo.ultracode === false));
}

async function finishPicker(step: PickerStep, terminal: PickerTerminal, before: string[], hooks?: Hooks) {
  const { rows, active, bound = active, ready, write } = terminal;
  let applied = false;
  const open = () => !!(pickerRows(step, rows()) || confirmationMenu(step, rows()));
  try { applied = await applyPicker(step, terminal, before, hooks); }
  finally {
    if (bound() && open()) {
      write('\x1b');
      const closed = await until(() => !open() && ready(), bound, 3000);
      applied &&= closed;
    }
  }
  return applied;
}

type FastEcho = { reason: string } | { fast: boolean; model: string | null };

function fastEcho(echo: string): FastEcho | null {
  const reason = FAST_UNAVAILABLE.exec(echo)?.[1];
  if (reason) return { reason };
  const fast = FAST_ON.exec(echo)?.[1];
  if (!fast) return null;
  const model = /\bmodel set to\s+`?([^`·]+?)`?(?:\s*·|$)/i.exec(echo)?.[1] ?? null;
  return { fast: fast.toLowerCase() === 'on', model };
}

export async function applyLeadStep(step: LeadStep, terminal: PickerTerminal, hooks?: Hooks) {
  const { rows, write, active, bound = active, ready, inputMatches } = terminal;
  if (!await until(ready, active, 60_000) || !active() || !ready()) return false;
  const command = step.kind === 'fast' ? step.target ? '/fast on' : '/fast off' : `/${step.kind}` as const;
  const before = echoes(rows());
  try {
    hooks?.typed?.();
    write(command);
    if (!await until(() => inputMatches(command), active, 3000) || !active() || !inputMatches(command)) return false;
    hooks?.submitted(command);
    write('\r');
    if (step.kind !== 'fast') return await finishPicker(step, terminal, before, hooks);
    const read = () => freshEcho(rows(), before, fastEcho);
    // The owner can start a draft as soon as the command returns. The fresh echo still owns the settings write.
    if (!await until(() => !!read(), bound, 5000) || !bound()) return false;
    const result = read();
    if (!result) return false;
    if ('reason' in result) { hooks?.failure?.(result.reason); return false; }
    const { fast, model } = result;
    const patch = { fast, ...(model ? { model } : {}) };
    hooks?.observed?.(patch, { fast });
    if (model && !sameModel(step.model, model)) {
      hooks?.failure?.(`model set to ${model}`);
      return false;
    }
    return fast === step.target;
  } finally {
    if (bound() && inputMatches(command)) write('\x15');
  }
}
