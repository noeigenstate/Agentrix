// What a Claude session's message box does with words that are not a message, as the terminal's does: /clear, /new and /reset begin a new conversation,
// /model, /effort and /fast change or pick what the session runs with, and a line that starts with "!" is a shell command. Pure: the words in, the action out.
import { t } from '../../shared/i18n';
import type { AgentCommand, NativeModelOption, NativeRunOptions, NativeRunOptionsPatch } from '../../shared/types';

export type ComposerOption = 'model' | 'effort' | 'fast';
export type ComposerAction = { kind: 'new' } | { kind: 'shell'; command: string } | { kind: 'option'; option: ComposerOption; value: string };
// One line the "/" list draws (the list's own `AgentCommand` without a view); `current` marks the value that is set now in a choice menu.
export type ListLine = Pick<AgentCommand, 'name' | 'description' | 'source'> & { current?: boolean };
export type Choice = ListLine & { source: 'builtin'; current: boolean };

const NEW = /^\/(?:clear|new|reset)$/, OPTION = /^\/(model|effort|fast)(?:\s+([\s\S]*))?$/;

// The action the (trimmed) words ask for; null when they are an ordinary message. `value` is '' when the option is named without one (a menu); a "!" with
// no command gives an empty command, which does nothing.
export function composerAction(words: string): ComposerAction | null {
  if (NEW.test(words)) return { kind: 'new' };
  if (words.startsWith('!')) return { kind: 'shell', command: words.slice(1).trim() };
  const option = OPTION.exec(words);
  return option ? { kind: 'option', option: option[1] as ComposerOption, value: option[2]?.trim() ?? '' } : null;
}

// What setting `option` to `value` sends; null for a value that option does not take (/fast takes on and off). The model "default" is no model: the default one.
export function optionPatch(option: ComposerOption, value: string): NativeRunOptionsPatch | null {
  if (option === 'fast') return value === 'on' || value === 'off' ? { fast: value === 'on' } : null;
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
export const fastChoices = (on: boolean) => [choice('on', t('开启'), on), choice('off', t('关闭'), !on)];

// The line that says what the session runs with once an option was changed.
export function optionTold(option: ComposerOption, now: NativeRunOptions, value: string) {
  if (option === 'model' && value === 'default') return t('模型已恢复默认');
  if (option === 'fast') return now.fast ? t('快速模式已开启') : t('快速模式已关闭');
  return option === 'model' ? t('模型已设为 {value}', { value: now.model ?? t('默认') }) : t('思考强度已设为 {value}', { value: now.effort ?? t('默认') });
}
