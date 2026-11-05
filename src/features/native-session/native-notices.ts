// The two lines the conversation gets from events that belong to no item: the context was compacted, and a result was too large to keep. native-model.ts
// makes them items (kind context-compacted / item-dropped, id notice:<sequence>); each is drawn as a plain line of text, as a local command's output is, so it
// is seen without opening anything. They are no reply of the agent: the round's result is read without them (`isNotice`). A number no event carried is not written.
import type { ConversationEntry } from '../../shared/types';
import { t } from '../../shared/i18n';
import type { NativeItem } from './native-model.ts';

const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
// 18 万, 2.1 万 from ten thousand on (one decimal, ".0" dropped); the plain number below it.
export const tokenWords = (count: number) => (count >= 10000 ? t('{count} 万', { count: String(Number((count / 10000).toFixed(1))) }) : String(count));
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
