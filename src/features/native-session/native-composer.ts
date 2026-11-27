import { t } from '../../shared/i18n';
import type { AgentCommand, NativeRunOptions } from '../../shared/types';
import type { AgentProvider } from '../../shared/agent-events';
import { isRoutingCommand } from '../../shared/routing-command.ts';
import type { PanelCommand } from './native-panel.ts';
import { CODEX_PERMISSIONS, isCodexPermissions, type CodexPermissions } from '../../shared/codex-permissions.ts';
import { adapterOf } from '../../../electron/features/cli-adapters/registry.mjs';
import { support } from '../../../electron/features/cli-adapters/capabilities.mjs';

export type ComposerAction = { kind: 'new' } | { kind: 'shell'; command: string } | { kind: 'option'; option: 'permissions'; value: string } | { kind: 'routing' } | { kind: 'panel'; command: PanelCommand };
// One line the "/" list draws (the list's own `AgentCommand` without a view); `current` marks the value that is set now in a choice menu.
export type ListLine = Pick<AgentCommand, 'name' | 'description' | 'source'> & { current?: boolean };
export type Choice = ListLine & { source: 'builtin'; current: boolean };

const NEW = /^\/(?:clear|new|reset)$/, OPTION = /^\/(permissions)(?:\s+([\s\S]*))?$/;
const LOCAL_COMMANDS: Partial<Record<AgentProvider, { shell: boolean; panels: RegExp }>> = {
  claude: { shell: true, panels: /^\/(context|cost|status|usage)$/ },
  codex: { shell: true, panels: /^\/(status|usage)$/ },
};

// The action the (trimmed) words ask for; null when they are an ordinary message. `value` is '' when the option is named without one (a menu); a "!" with
// no command gives an empty command, which does nothing.
export function composerAction(words: string, agent: AgentProvider = 'claude'): ComposerAction | null {
  if ((agent === 'claude' ? NEW : /^\/(?:clear|new)$/).test(words)) return { kind: 'new' };
  const manifest = adapterOf(agent)?.manifest;
  const commands = LOCAL_COMMANDS[agent];
  if (words.startsWith('!') && commands?.shell) return { kind: 'shell', command: words.slice(1).trim() };
  // The information commands open a window (Codex has two, Claude four); they are no message and take no turn.
  const panel = commands?.panels.exec(words);
  if (panel) return { kind: 'panel', command: panel[1] as PanelCommand };
  if (isRoutingCommand(words) && (!/^\/fast(?:\s|$)/.test(words) || manifest && support(manifest, 'fast').ok)) return { kind: 'routing' };
  const option = OPTION.exec(words);
  // /permissions is Codex's: a Claude session runs without asking, and the words stay a message there.
  if (!option || !manifest || !support(manifest, 'permissionChoice').ok) return null;
  return { kind: 'option', option: 'permissions', value: option[2]?.trim() ?? '' };
}

export const optionPatch = (option: 'permissions', value: string) => option === 'permissions' && isCodexPermissions(value) ? { permissions: value } : null;

const choice = (name: string, description: string, current: boolean): Choice => ({ name, description, source: 'builtin', current });
// The three permissions a Codex session can run with, each named and said what it lets the agent do.
const PERMISSIONS: Record<CodexPermissions, { name: () => string; detail: () => string }> = {
  full: { name: () => t('全部放开'), detail: () => t('不询问，不限制沙箱') },
  config: { name: () => t('按 Codex 配置'), detail: () => t('由 Codex 自己的配置决定') },
  ask: { name: () => t('先询问'), detail: () => t('工作区内可写，其余先询问') },
};
export const permissionName = (value: CodexPermissions) => PERMISSIONS[value].name();
export const permissionChoices = (now: NativeRunOptions['permissions']) =>
  CODEX_PERMISSIONS.map(value => choice(value, `${PERMISSIONS[value].name()} · ${PERMISSIONS[value].detail()}`, value === now));
export const optionUsage = () => t('用法：/permissions full、config 或 ask');

export const optionTold = (_option: 'permissions', now: NativeRunOptions, value: string) =>
  t('本会话权限已设为{value}，从下一轮起生效', { value: permissionName(now.permissions ?? value as CodexPermissions) });
