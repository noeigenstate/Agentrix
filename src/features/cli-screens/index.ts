import { adapterOf, adapters } from '../../../electron/features/cli-adapters/registry.mjs';
import { support, UNVERIFIED_VERSION } from '../../../electron/features/cli-adapters/capabilities.mjs';
import { claude } from './claude.ts';
import { codex } from './codex.ts';
import { emptyStatus, normalizeRows } from './rows.ts';
import type { AgentScreen, CliScreen, LeadStep, LiveControl, ScreenAgent } from './types.ts';

export type { AgentScreen, CliScreen, LeadStep, PickerAction, PickerStep, ScreenAgent, ScreenBanner, ScreenChoice,
  ScreenOption, ScreenPicker, ScreenQuestion, ScreenStatus } from './types.ts';

const facets: Readonly<Partial<Record<ScreenAgent, CliScreen>>> = { claude, codex };
export const screenOf = (agent: ScreenAgent | null | undefined) => agent && Object.hasOwn(facets, agent) ? facets[agent] : undefined;
export const screenAgents = adapters().map(({ manifest }) => manifest.id).filter(id => screenOf(id));
const defaultScreenAgent = 'codex';
export const screenAgent = (agent: ScreenAgent | null | undefined) => agent && screenOf(agent) ? agent : defaultScreenAgent;
export const screenLabel = (agent: ScreenAgent) => adapterOf(agent)?.manifest.label ?? agent;
const signInTitles = adapters().map(({ manifest }) => 'Sign in to ' + manifest.label);

export function parseAgentScreen(agent: ScreenAgent, rows: string[]): AgentScreen {
  const normalized = normalizeRows(rows), facet = screenOf(agent);
  const status = facet?.status?.(normalized) ?? { banner: null, status: emptyStatus(), overlay: 'none' as const };
  const screen: AgentScreen = { ...status, choice: null };
  const dialog = facet?.dialog?.(normalized, status);
  return { ...screen, choice: dialog?.choice ?? null, overlay: dialog?.overlay ?? screen.overlay, ...(dialog?.waiting ? { waiting: dialog.waiting } : {}) };
}

// Busy agents can take queued messages. Live panels take the keys even when their input stays visible.
export function cliDialogShown(agent: ScreenAgent, rows: string[], screen: AgentScreen): boolean {
  if (screen.choice || screen.waiting || screen.overlay !== 'none') return true;
  const tail = rows.filter(row => row.trim()).at(-1)?.trim() ?? '';
  if (/^(?:press )?esc to (?:cancel|close|go back|dismiss)$/i.test(tail)
    || /^(?:Type to filter|[←→/]+ tabs|enter select)\b.*\besc\b/i.test(tail)) return true;
  const facet = screenOf(agent);
  if (!facet?.input(rows) && rows.some(row => signInTitles.includes(row.trim()))
    && rows.some(row => /^Paste the authorization code below:/.test(row))) return true;
  return facet?.otherDialog?.(rows) ?? false;
}

export function createScreenSelectors<Agent extends string>(
  lookup: (agent: Agent) => CliScreen | undefined,
  dialogShown: (agent: Agent, rows: string[], screen: AgentScreen) => boolean,
) {
  const cliInputAvailable = (agent: Agent, rows: string[]) => !!lookup(agent)?.input(rows);
  const cliInputDraft = (agent: Agent, rows: string[], screen: AgentScreen) => lookup(agent)?.input(rows, screen.inputHint)?.text ?? '';
  const isCliWorking = (agent: Agent, rows: string[], _screen: AgentScreen) => lookup(agent)?.working(rows) ?? false;
  const hasCliInput = (agent: Agent, rows: string[], screen: AgentScreen) => {
    const input = lookup(agent)?.input(rows, screen.inputHint);
    return !!input && !input.hint;
  };
  const isAtPrompt = (agent: Agent, rows: string[], screen: AgentScreen) =>
    !dialogShown(agent, rows, screen) && !isCliWorking(agent, rows, screen) && !!lookup(agent)?.atPrompt(rows);
  const isCliIdle = (agent: Agent, rows: string[], screen: AgentScreen) => isAtPrompt(agent, rows, screen) && !cliInputDraft(agent, rows, screen);
  return { cliInputAvailable, cliInputDraft, isCliWorking, hasCliInput, isAtPrompt, isCliIdle };
}

export const { cliInputAvailable, cliInputDraft, isCliWorking, hasCliInput, isAtPrompt, isCliIdle } =
  createScreenSelectors<ScreenAgent>(screenOf, cliDialogShown);

export function unverifiedScreenSwitch(agent: ScreenAgent | null, control: LiveControl, version: string | null | undefined) {
  const manifest = agent && adapterOf(agent)?.manifest;
  if (!manifest || support(manifest, control).via !== 'screen') return undefined;
  const result = support(manifest, control, version);
  if (result.reason === UNVERIFIED_VERSION) return result.params?.cli;
}

export function unverifiedScreenCommand(agent: ScreenAgent, text: string, version: () => string | undefined) {
  const control = screenOf(agent)?.switchControl?.(text);
  return control ? unverifiedScreenSwitch(agent, control, version()) : undefined;
}

export function unverifiedScreenStep(agent: ScreenAgent, step: LeadStep, version: string | undefined) {
  if (step.kind === 'model') return unverifiedScreenSwitch(agent, 'liveModel', version);
  if (step.kind === 'fast') return unverifiedScreenSwitch(agent, 'fast', version);
  return (step.target ? unverifiedScreenSwitch(agent, 'liveEffort', version) : undefined)
    ?? (step.ultracode !== undefined ? unverifiedScreenSwitch(agent, 'ultracode', version) : undefined);
}
