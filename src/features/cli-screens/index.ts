import { adapterOf, adapters } from '../../../electron/features/cli-adapters/registry.mjs';
import { support, UNVERIFIED_VERSION } from '../../../electron/features/cli-adapters/capabilities.mjs';
import { claude } from './claude.ts';
import { codex } from './codex.ts';
import { emptyStatus, normalizeRows } from './rows.ts';
import { withoutImageLabels } from './image-input.ts';
import type { SignInScreen } from './sign-in.ts';
import type { AgentScreen, CliScreen, LeadStep, LiveControl, ScreenAgent } from './types.ts';

export { hasImageLabel, inputImageLabels, withoutImageLabels } from './image-input.ts';
export type { SignInScreen } from './sign-in.ts';

export type { AgentScreen, CliScreen, LeadStep, PickerAction, PickerStep, ScreenAgent, ScreenBanner, ScreenChoice,
  ScreenOption, ScreenPicker, ScreenQuestion, ScreenStatus } from './types.ts';

const facets: Readonly<Partial<Record<ScreenAgent, CliScreen>>> = { claude, codex };
export const screenOf = (agent: ScreenAgent | null | undefined) => agent && Object.hasOwn(facets, agent) ? facets[agent] : undefined;
export const screenAgents = adapters().map(({ manifest }) => manifest.id).filter(id => screenOf(id));
const defaultScreenAgent = 'codex';
export const screenAgent = (agent: ScreenAgent | null | undefined) => agent && screenOf(agent) ? agent : defaultScreenAgent;
export const screenLabel = (agent: ScreenAgent) => adapterOf(agent)?.manifest.label ?? agent;

export function screenSupported(agent: ScreenAgent, rows: string[], version?: string) {
  const manifest = adapterOf(agent)?.manifest;
  return !!manifest && support(manifest, 'screenReading', version ?? screenOf(agent)?.version?.(rows)).ok;
}

export function parseAgentScreen(agent: ScreenAgent, rows: string[], version?: string): AgentScreen {
  const normalized = normalizeRows(rows);
  const unsupported = !screenSupported(agent, normalized, version), facet = unsupported ? undefined : screenOf(agent);
  const status = facet?.status?.(normalized) ?? { banner: null, status: emptyStatus(), overlay: 'none' as const };
  const screen: AgentScreen = { ...status, choice: null, ...(unsupported ? { unsupported: true } : {}) };
  const dialog = facet?.dialog?.(normalized, status);
  return { ...screen, choice: dialog?.choice ?? null, overlay: dialog?.overlay ?? screen.overlay,
    ...(dialog?.waiting ? { waiting: dialog.waiting } : {}), ...(dialog?.waitingHeadingClipped ? { waitingHeadingClipped: true } : {}) };
}

// Busy agents can take queued messages. Live panels take the keys even when their input stays visible.
export function cliDialogShown(agent: ScreenAgent, rows: string[], screen: AgentScreen): boolean {
  if (screen.unsupported) return false;
  if (screen.choice || screen.waiting || screen.overlay !== 'none') return true;
  return screenOf(agent)?.otherDialog?.(rows) ?? false;
}

export function canRemoveScreenImage(agent: ScreenAgent, version?: string) {
  const manifest = adapterOf(agent)?.manifest;
  if (!manifest || !version) return false;
  const result = support(manifest, 'screenImageRemoval', version);
  return result.ok && !('unverified' in result && result.unverified);
}

export function imageRemoval(agent: ScreenAgent, text: string, index: number, rows: number, version?: string) {
  return canRemoveScreenImage(agent, version) ? screenOf(agent)?.removeImage?.(text, index, rows) ?? null : null;
}

export function isPasteSummary(text: string, agent?: ScreenAgent) {
  const summary = withoutImageLabels(text).trim();
  return agent ? !!screenOf(agent)?.pasteSummary?.(summary) : screenAgents.some(kind => screenOf(kind)?.pasteSummary?.(summary));
}

export function signInScreen(agent: ScreenAgent, rows: string[], version?: string, width?: number): SignInScreen | null {
  return screenSupported(agent, rows, version) ? screenOf(agent)?.signIn?.(rows, width) ?? null : null;
}

export function createScreenSelectors<Agent extends string>(
  lookup: (agent: Agent) => CliScreen | undefined,
  dialogShown: (agent: Agent, rows: string[], screen: AgentScreen) => boolean,
  supported: (agent: Agent, rows: string[], version?: string) => boolean = () => true,
) {
  const cliInputAvailable = (agent: Agent, rows: string[], version?: string) => supported(agent, rows, version) && !!lookup(agent)?.input(rows);
  const cliInputDraft = (agent: Agent, rows: string[], screen: AgentScreen) => screen.unsupported ? '' : lookup(agent)?.input(rows, screen.inputHint)?.text ?? '';
  const isCliWorking = (agent: Agent, rows: string[], screen: AgentScreen) => !screen.unsupported && (lookup(agent)?.working(rows) ?? false);
  const hasCliInput = (agent: Agent, rows: string[], screen: AgentScreen) => {
    const input = !screen.unsupported && lookup(agent)?.input(rows, screen.inputHint);
    return !!input && !input.hint;
  };
  const isAtPrompt = (agent: Agent, rows: string[], screen: AgentScreen) =>
    !screen.unsupported && !dialogShown(agent, rows, screen) && !isCliWorking(agent, rows, screen) && !!lookup(agent)?.atPrompt(rows);
  const isCliIdle = (agent: Agent, rows: string[], screen: AgentScreen) => isAtPrompt(agent, rows, screen) && !cliInputDraft(agent, rows, screen);
  return { cliInputAvailable, cliInputDraft, isCliWorking, hasCliInput, isAtPrompt, isCliIdle };
}

export const { cliInputAvailable, cliInputDraft, isCliWorking, hasCliInput, isAtPrompt, isCliIdle } =
  createScreenSelectors<ScreenAgent>(screenOf, cliDialogShown, screenSupported);

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
