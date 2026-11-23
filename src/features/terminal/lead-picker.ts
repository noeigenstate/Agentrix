import { modelName } from '../../shared/model-name.ts';
import { sameModel, type LeadStep } from './lead-steps.ts';

const SESSION_ONLY = /\bs to use this session only\b/i;
const EFFORT_SESSION_ENTER = /(?:^|·)\s*Enter to use this session only\s*·\s*Esc to cancel\b/i;
const MODEL_HEADER = /^\s*Select model\s*$/i;
const EFFORT_HEADER = /^\s*Effort\s*$/i;
const UP = '\x1b[A', DOWN = '\x1b[B', LEFT = '\x1b[D', RIGHT = '\x1b[C';

function menuRows(rows: string[], title: RegExp) {
  for (let i = rows.length - 1; i >= 0; i--) if (title.test(rows[i])) return rows.slice(i);
  return null;
}

const pickerRows = (step: LeadStep, rows: string[]) => menuRows(rows, step.kind === 'model' ? MODEL_HEADER : EFFORT_HEADER);

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
  return { position: focus.number, down, key: choice ? choice === focus ? 's' : choice.number < focus.number ? UP : DOWN : down ? DOWN : UP };
}

function effortCursor(rows: string[], target: string, confirm: string) {
  const marker = rows.findIndex(row => /^[\s─]*▲[─\s]/.test(row));
  if (marker < 0) return null;
  const caret = rows[marker].indexOf('▲');
  const levels = [...(rows[marker + 1] ?? '').matchAll(/\b(?:auto|low|medium|high|xhigh|max)\b/gi)];
  const position = levels.findIndex(level => Math.abs(level.index + (level[0].length - 1) / 2 - caret) <= 2);
  const choice = levels.findIndex(level => level[0].toLowerCase() === target);
  if (position < 0 || choice < 0) return null;
  return { position, down: false, key: choice === position ? confirm : choice < position ? LEFT : RIGHT };
}

export function pickerAction(step: LeadStep, rows: string[], scanningDown = false) {
  const menu = pickerRows(step, rows);
  if (!menu) return null;
  const text = menu.map(row => row.trim()).join(' ');
  const sessionOnly = SESSION_ONLY.test(text);
  if (step.kind === 'model') return sessionOnly ? modelCursor(menu, step.target, scanningDown) : null;
  const confirm = sessionOnly ? 's' : EFFORT_SESSION_ENTER.test(text) ? '\r' : null;
  return confirm ? effortCursor(menu, step.target, confirm) : null;
}

function appliedSettings(step: LeadStep, rows: string[]) {
  return rows.flatMap(row => {
    if (step.kind === 'model') {
      const model = /Set model to `?(.+?)`? for this session only/i.exec(row)?.[1];
      return model && sameModel(step.target, model) ? [modelName(model)] : [];
    }
    const effort = /Set effort level to (\w+) \(this session only\)/i.exec(row)?.[1].toLowerCase();
    return effort === step.target ? [effort] : [];
  });
}

export function pickerResult(step: LeadStep, rows: string[]) {
  const menu = menuRows(rows, step.kind === 'model' ? /^\s*Switch model\?\s*$/ : /^\s*Change effort level\?\s*$/);
  if (menu) {
    const choice = menu.map(row => /^\s*[>❯]\s*1\.\s*Yes, switch to (.+?)\s*$/i.exec(row)?.[1]).find(Boolean);
    const matches = choice && (step.kind === 'model' ? sameModel(step.target, choice) : step.target === choice.toLowerCase());
    if (matches && menu.some(row => /Your next response will be slower and use more tokens/i.test(row))) return 'confirm';
    return null;
  }
  return appliedSettings(step, rows).length ? 'applied' : null;
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
  ready: () => boolean;
};

async function selectInPicker(step: LeadStep, { rows, write, active, ready }: PickerTerminal) {
  let previous: number | undefined, down = false;
  const visited = new Set<string>();
  while (visited.size < 40) {
    const action = () => pickerAction(step, rows(), down);
    if (!await until(() => { const next = action(); return !!next && next.position !== previous; }, active, previous === undefined ? 3000 : 1000)) break;
    const next = action();
    if (!active() || !next) return false;
    const move = `${next.position}:${next.key}`;
    if (visited.has(move)) break;
    visited.add(move);
    previous = next.position;
    down = next.down;
    write(next.key);
    if (next.key === 's' || next.key === '\r') return true;
  }
  if (active() && pickerRows(step, rows())) {
    write('\x1b');
    if (step.kind === 'effort') await until(() => !pickerRows(step, rows()) && ready(), active, 3000);
  }
  return false;
}

// Use the selected option's session-only action. Other options can advertise Enter to save a user default.
export async function applyLeadStep(step: LeadStep, terminal: PickerTerminal, hooks?: {
  submitted: (command: '/model' | '/effort') => void;
  confirmed: (setting: string) => void;
}) {
  const { rows, write, active, ready, inputMatches } = terminal;
  if (!await until(ready, active, 60_000) || !active()) return false;
  const command = `/${step.kind}` as const;
  const previous = appliedSettings(step, rows());
  write(command);
  if (!await until(() => inputMatches(command), active, 3000) || !active() || !inputMatches(command)) return false;
  hooks?.submitted(command);
  write('\r');
  if (!await selectInPicker(step, terminal)) return false;
  const result = () => pickerResult(step, rows());
  if (!await until(() => result() === 'confirm' || ready() && result() === 'applied', active, 5000) || !active()) return false;
  if (result() === 'confirm') {
    write('\r');
    if (!await until(() => ready() && result() === 'applied', active, 5000) || !active()) return false;
  }
  const settings = appliedSettings(step, rows());
  const fresh = settings.find(setting => settings.filter(item => item === setting).length > previous.filter(item => item === setting).length);
  if (fresh) hooks?.confirmed(fresh);
  return ready() && result() === 'applied';
}
