// What a Claude session's message box does with words that are not a message, as the terminal's does: /clear, /new and /reset begin a new conversation,
// /model, /effort and /fast (and Codex's /permissions) change or pick what the session runs with, a line that starts with "!" is a shell command, and
// /status, /usage (and Claude's /context and /cost) open a result window. Pure: the words in, the action out.
import { t } from '../../shared/i18n';
import type { AgentCommand, NativeModelOption, NativeRunOptions, NativeRunOptionsPatch } from '../../shared/types';
import type { PanelCommand } from './native-panel.ts';
import { CODEX_PERMISSIONS, isCodexPermissions, type CodexPermissions } from '../../shared/codex-permissions.ts';

export type ComposerOption = 'model' | 'effort' | 'fast' | 'permissions';
export type ComposerAction = { kind: 'new' } | { kind: 'shell'; command: string } | { kind: 'option'; option: ComposerOption; value: string } | { kind: 'panel'; command: PanelCommand };
// One line the "/" list draws (the list's own `AgentCommand` without a view); `current` marks the value that is set now in a choice menu.
export type ListLine = Pick<AgentCommand, 'name' | 'description' | 'source'> & { current?: boolean };
export type Choice = ListLine & { source: 'builtin'; current: boolean };

const NEW = /^\/(?:clear|new|reset)$/, OPTION = /^\/(model|effort|fast|permissions)(?:\s+([\s\S]*))?$/, PANELS = { claude: /^\/(context|cost|status|usage)$/, codex: /^\/(status|usage)$/ };

// The action the (trimmed) words ask for; null when they are an ordinary message. `value` is '' when the option is named without one (a menu); a "!" with
// no command gives an empty command, which does nothing.
export function composerAction(words: string, agent: 'claude' | 'codex' = 'claude'): ComposerAction | null {
  if ((agent === 'claude' ? NEW : /^\/(?:clear|new)$/).test(words)) return { kind: 'new' };
  if (words.startsWith('!')) return { kind: 'shell', command: words.slice(1).trim() };
  // The information commands open a window (Codex has two, Claude four); they are no message and take no turn.
  const panel = PANELS[agent].exec(words);
  if (panel) return { kind: 'panel', command: panel[1] as PanelCommand };
  const option = OPTION.exec(words);
  // /permissions is Codex's: a Claude session runs without asking, and the words stay a message there.
  if (!option || option[1] === 'permissions' && agent !== 'codex') return null;
  return { kind: 'option', option: option[1] as ComposerOption, value: option[2]?.trim() ?? '' };
}

// What setting `option` to `value` sends; null for a value that option does not take (/fast takes on and off, /permissions its three choices). The model
// "default" is no model: the default one.
export function optionPatch(option: ComposerOption, value: string): NativeRunOptionsPatch | null {
  if (option === 'fast') return value === 'on' || value === 'off' ? { fast: value === 'on' } : null;
  if (option === 'permissions') return isCodexPermissions(value) ? { permissions: value } : null;
  return option === 'model' ? { model: value === 'default' ? null : value } : { effort: value };
}

const choice = (name: string, description: string, current: boolean): Choice => ({ name, description, source: 'builtin', current });
export const modelChoices = (models: readonly NativeModelOption[], model: string | null) =>
  models.map(found => choice(found.value, [found.displayName !== found.value && found.displayName, found.description].filter(Boolean).join(' · '), found.value === model));
// The efforts of the model the session runs; of every model together when it is not known which.
export function effortChoices(models: readonly NativeModelOption[], model: string | null, effort: string | null) {
  const known = models.find(found => found.value === model), efforts = known ? known.efforts : [...new Set(models.flatMap(found => found.efforts))];
  return efforts.map(name => choice(name, '', name === effort));
}
export const fastChoices = (on: boolean) => [choice('on', t('开'), on), choice('off', t('关'), !on)];
// The three permissions a Codex session can run with, each named and said what it lets the agent do.
const PERMISSIONS: Record<CodexPermissions, { name: () => string; detail: () => string }> = {
  full: { name: () => t('全部放开'), detail: () => t('不询问，不限制沙箱') },
  config: { name: () => t('按 Codex 配置'), detail: () => t('由 Codex 自己的配置决定') },
  ask: { name: () => t('先询问'), detail: () => t('工作区内可写，其余先询问') },
};
export const permissionName = (value: CodexPermissions) => PERMISSIONS[value].name();
export const permissionChoices = (now: NativeRunOptions['permissions']) =>
  CODEX_PERMISSIONS.map(value => choice(value, `${PERMISSIONS[value].name()} · ${PERMISSIONS[value].detail()}`, value === now));
// How the words of a refused option read: what the option takes.
export const optionUsage = (option: ComposerOption) => option === 'permissions' ? t('用法：/permissions full、config 或 ask') : t('用法：/fast on 或 /fast off');

// The line that says what the session runs with once an option was changed.
export function optionTold(option: ComposerOption, now: NativeRunOptions, value: string) {
  if (option === 'model' && value === 'default') return t('模型已恢复默认');
  if (option === 'fast') return now.fast ? t('快速模式已开启') : t('快速模式已关闭');
  if (option === 'permissions') return t('本会话权限已设为{value}，从下一轮起生效', { value: permissionName(now.permissions ?? value as CodexPermissions) });
  return option === 'model' ? t('模型已设为 {value}', { value: now.model ?? t('默认') }) : t('思考强度已设为 {value}', { value: now.effort ?? t('默认') });
}
