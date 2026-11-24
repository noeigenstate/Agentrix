import type { AgentSettings } from '../../shared/types';
import type { LeadRoutingCommand } from '../../shared/lead-routing-notices.ts';
import type { CliScreen, LeadStep, PickerAction, PickerStep, ScreenPicker } from '../cli-screens/index.ts';

function freshEcho<T>(after: string[], before: string[], parse: (echo: string) => T | null) {
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
  picker: ScreenPicker;
  echo: NonNullable<CliScreen['echo']>;
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

async function selectInPicker(step: PickerStep, { rows, write, active, picker }: PickerTerminal) {
  let previous = '', down = false, effortChanged = false, ultraChanged = false;
  const visited = new Set<string>();
  const actionKey = (action: PickerAction) => `${action.position}:${action.key}:${action.ultracode}`;
  while (visited.size < 40) {
    const action = () => picker.action(step, rows(), down);
    if (!await until(() => { const next = action(); return !!next && actionKey(next) !== previous; }, active, previous ? 1000 : 3000)) break;
    const next = action();
    if (!active() || !next) return null;
    previous = actionKey(next);
    if (visited.has(previous)) break;
    visited.add(previous);
    down = next.down;
    if (next.accept) {
      const noop = step.kind === 'effort' && !effortChanged && !ultraChanged;
      if (!noop) write(next.key);
      return { noop, effortChanged, ultraChanged, ultracode: next.ultracode };
    }
    write(next.key);
    effortChanged ||= next.changed === 'effort';
    ultraChanged ||= next.changed === 'ultracode';
  }
  return null;
}

async function applyPicker(step: PickerStep, terminal: PickerTerminal, before: string[], hooks?: Hooks) {
  const { rows, active, ready, write, picker, echo } = terminal;
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
  const result = () => freshEcho(echo(rows()), before, line => {
    const parsed = picker.readEcho(step, line);
    return parsed && 'settings' in parsed ? parsed.settings : null;
  });
  const confirmed = () => ready() && !!result();
  if (!await until(() => picker.result(step, rows()) === 'confirm' || confirmed(), active, 5000) || !active()) return false;
  if (picker.result(step, rows()) === 'confirm') {
    write('\r');
    if (!await until(confirmed, active, 5000) || !active()) return false;
  }
  const applied = result();
  if (!applied) return false;
  if (choice.effortChanged) delete selected.effort;
  if (choice.ultraChanged) delete selected.ultracode;
  hooks?.observed?.({ ...selected, ...applied }, applied);
  return !unsupported && (step.kind === 'model' || (!choice.effortChanged || applied.effort === step.target)
    && (!choice.ultraChanged || applied.ultracode === step.ultracode || step.ultracode === undefined && applied.ultracode === false));
}

async function finishPicker(step: PickerStep, terminal: PickerTerminal, before: string[], hooks?: Hooks) {
  const { rows, active, bound = active, ready, write, picker } = terminal;
  let applied = false;
  const open = () => picker.open(step, rows());
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

export async function applyLeadStep(step: LeadStep, terminal: PickerTerminal, hooks?: Hooks) {
  const { rows, write, active, bound = active, ready, inputMatches, picker, echo } = terminal;
  if (!await until(ready, active, 60_000) || !active() || !ready()) return false;
  const command = picker.command(step);
  const before = echo(rows());
  try {
    hooks?.typed?.();
    write(command);
    if (!await until(() => inputMatches(command), active, 3000) || !active() || !inputMatches(command)) return false;
    hooks?.submitted(command);
    write('\r');
    if (step.kind !== 'fast') return await finishPicker(step, terminal, before, hooks);
    const read = () => freshEcho(echo(rows()), before, line => picker.readEcho(step, line));
    // The owner can start a draft as soon as the command returns. The fresh echo still owns the settings write.
    if (!await until(() => !!read(), bound, 5000) || !bound()) return false;
    const result = read();
    if (!result) return false;
    if ('reason' in result) { hooks?.failure?.(result.reason); return false; }
    const { fast, model } = result.settings;
    hooks?.observed?.(result.settings, { fast });
    if (model && !picker.matchModel(step.model, model)) {
      hooks?.failure?.(`model set to ${model}`);
      return false;
    }
    return fast === step.target;
  } finally {
    if (bound() && inputMatches(command)) write('\x15');
  }
}
