// The two lines the conversation gets from events that belong to no item: the context was compacted, and a result was too large to keep. native-model.ts
// makes them items (kind context-compacted / item-dropped, id notice:<sequence>); each is drawn as a plain line of text, as a local command's output is, so it
// is seen without opening anything. They are no reply of the agent: the round's result is read without them (`isNotice`). A number no event carried is not written.
import type { ConversationEntry } from '../../shared/types';
import { currentLanguage, t } from '../../shared/i18n';
import type { NativeItem } from './native-model.ts';

const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
// From ten thousand on, in the unit the language counts by (one decimal, ".0" dropped): 18 万 and 2.1 万, or 180k and 21k; the plain number below it.
export function tokenWords(count: number) {
  if (count < 10000) return String(count);
  return currentLanguage() === 'en' ? `${Number((count / 1000).toFixed(1))}k` : `${Number((count / 10000).toFixed(1))} 万`;
}
// Megabytes (1024 × 1024 bytes) with one decimal.
export const sizeWords = (bytes: number) => (bytes / 1048576).toFixed(1);

function compactedLine({ content }: NativeItem) {
  const before = number(content.preTokens), after = number(content.postTokens);
  const what = content.trigger === 'manual' ? t('上下文已压缩（手动）') : t('上下文已压缩（自动）');
  return before !== null && after !== null ? `${what}· ${t('{from} → {to} token', { from: tokenWords(before), to: tokenWords(after) })}` : what;
}

function droppedLine({ content }: NativeItem) {
  const bytes = number(content.bytes);
  return bytes === null ? t('有一条结果太大，未显示，任务继续') : t('有一条结果太大（{size} MB），未显示，任务继续', { size: sizeWords(bytes) });
}

// The words an item of these kinds is drawn as; null for any other item.
export function noticeText(item: NativeItem) {
  return item.kind === 'context-compacted' ? compactedLine(item) : item.kind === 'item-dropped' ? droppedLine(item) : null;
}

export const isNotice = (entry: Pick<ConversationEntry, 'id'>) => entry.id.startsWith('notice:');
