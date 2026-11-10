import { useEffect, useRef, useState } from 'react';
import { t } from '../../shared/i18n';
import type { Result } from '../../shared/types';
import { nativeBridge } from './native-bridge.ts';
import { effortChoices, fastChoices, modelChoices, optionPatch, optionTold, type Choice, type ComposerAction, type ComposerOption } from './native-composer.ts';
import { nativeItem, refreshNativeSession } from './native-store.ts';
import { readPanel } from './panel-read.ts';
import type { PanelAgent, PanelCommand, PanelState } from './native-panel.ts';

// An unavailable or failed main-process call reads as a refusal with its reason.
function ask<T>(call: Promise<Result<T>> | undefined): Promise<Result<T>> {
  return (call ?? Promise.resolve({ ok: false as const, error: t('当前版本还不支持这个命令') })).catch(error => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
}

// The native controls of both providers: the main-process calls, shared choice menus,
// and the line that says what was set. `clear` empties the box when the words are taken, `restore` puts them back if main refuses them (unless something new
// was typed meanwhile), `onError` shows a refusal. A new conversation shuts the box until the card shows the new session: the view of this one goes with it.
export function useComposerActions({ terminalId, sessionId, agent, clear, restore, onError }: {
  terminalId: string; sessionId: string; agent: PanelAgent; clear: () => void; restore: (words: string) => void; onError: (message: string | null) => void;
}) {
  const [menu, setMenu] = useState<{ option: ComposerOption; items: Choice[] } | null>(null), [told, setTold] = useState<string | null>(null), [renewing, setRenewing] = useState(false);
  const [panel, setPanel] = useState<PanelState | null>(null), asked = useRef(0);
  // What was set is told for two seconds.
  useEffect(() => {
    if (!told) return;
    const timer = setTimeout(() => setTold(null), 2000);
    return () => clearTimeout(timer);
  }, [told]);
  const fail = (words: string, message: string) => { restore(words); onError(message); };

  const apply = async (option: ComposerOption, value: string, words: string) => {
    const result = await ask(nativeBridge()?.runOptions?.(terminalId, sessionId, optionPatch(option, value)!));
    if (result.ok) setTold(optionTold(option, result.value, value)); else fail(words, result.error);
  };
  // The menu of an option: the current values and, for a model or an effort, the models the session can run.
  const choices = async (option: ComposerOption, words: string) => {
    const bridge = nativeBridge();
    const [now, models] = await Promise.all([ask(bridge?.runOptions?.(terminalId, sessionId, {})), option === 'fast' ? null : ask(bridge?.models?.(terminalId, sessionId))]);
    if (!now.ok) return fail(words, now.error);
    if (models && !models.ok) return fail(words, models.error);
    const known = models?.ok ? models.value : [];
    const items = option === 'fast' ? fastChoices(now.value.fast) : option === 'model' ? modelChoices(known, now.value.model) : effortChoices(known, now.value.model, now.value.effort);
    if (items.length) setMenu({ option, items }); else fail(words, t('没有可选的项'));
  };
  const renew = async (words: string) => {
    setRenewing(true); clear();
    const result = await ask(nativeBridge()?.newConversation?.(terminalId, sessionId));
    if (result.ok) { refreshNativeSession(terminalId); return; }
    setRenewing(false); fail(words, result.error);
  };

  // /status, /usage, /context and /cost: the window opens at once on its loading state and fills with what main read. The query is no message of the
  // conversation — it leaves no bubble and takes no turn — so the box is emptied for good, and the window shows a failure itself. Closing the window drops
  // an answer still on its way; the refresh button asks the same again.
  const query = async (command: PanelCommand, fromBox = true) => {
    const mine = ++asked.current;
    if (fromBox) clear();
    setMenu(null); setPanel({ agent, command, state: 'loading' });
    const result = await ask(nativeBridge()?.send(terminalId, sessionId, crypto.randomUUID(), `/${command}`));
    if (mine !== asked.current) return;
    const answer = result.ok ? readPanel(agent, result.value) : null;
    setPanel(answer ? { agent, command, state: 'ready', panel: answer } : { agent, command, state: 'failed', error: result.ok ? t('这个会话没有返回状态') : result.error });
  };
  const closePanel = () => { asked.current++; setPanel(null); };
  const refresh = () => { if (panel) void query(panel.command, false); };

  // `action` is what `composerAction` found in `words`.
  const run = async (action: ComposerAction, words: string) => {
    setTold(null); onError(null);
    if (action.kind === 'new') return renew(words);
    if (action.kind === 'panel') return query(action.command);
    if (action.kind === 'shell') {
      if (!action.command) return;
      clear();
      const id = crypto.randomUUID(), result = await ask(nativeBridge()?.shell?.(terminalId, sessionId, id, action.command));
      // A refusal before the command ran gives the words back; one after it ran (its card has an exit code or output) must not, or Enter would run it again.
      if (result.ok) return;
      const card = nativeItem(terminalId, `shell:${id}`)?.content;
      if (card && (card.exitCode != null || card.output || card.modelDelivery === 'unknown')) onError(result.error); else fail(words, result.error);
      return;
    }
    const { option, value } = action;
    if (value && !optionPatch(option, value)) return onError(t('用法：/fast on 或 /fast off'));
    clear();
    return value ? apply(option, value, words) : choices(option, words);
  };
  // A line of the menu was picked: the option is set to it.
  const choose = (value: string) => {
    const option = menu?.option;
    setMenu(null);
    if (option) void apply(option, value, '');
  };
  const forget = () => { setMenu(null); setTold(null); };

  return { menu: menu?.items ?? null, told, renewing, panel, closePanel, refresh, run, choose, close: () => setMenu(null), forget };
}
