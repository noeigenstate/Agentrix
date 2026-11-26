import { hasImageLabel, isPasteSummary, withoutImageLabels, type ScreenAgent } from '../cli-screens/index.ts';
import type { PasteReceipt } from '../terminal/terminal-screen';
// Renderer echoes are replaced only by newly observed user records, one record per send.
export const PENDING_PROMPT_TIMEOUT = 20_000;
// The reading view keeps 400 entries; the user records seen are bounded well above that.
const SEEN_LIMIT = 1000;
type UserRecord = { id: string; role: string; text?: string; original?: string; at?: number; receivedAt?: number;
  queued?: boolean; cancelled?: boolean; undeliveredAt?: number; undeliveredReplaced?: boolean; images?: string[] };
export type PendingPrompt = { id: string; role: 'user'; text: string; at: number; sending: boolean; images?: string[]; imageCount?: number; undelivered?: boolean };
export type PendingPrompts = { sessionId: string | null; prompts: readonly PendingPrompt[]; seen: readonly string[] };
// A paste request in flight is ambiguous even if no echo has appeared. Only an unattempted/rejected paste can be
// retried from an empty input; a confirmed paste may instead be finished from its exact, still-unsent input.
export type WaitingAttempt = { epoch?: number; parse?: number; phase: 'ready' | 'pasting' | 'pasted' | 'entered' | 'rejected'; echo?: string; resuming?: boolean; paste?: PasteReceipt };
export type WaitingMessage = { id: number; text: string; at: number; uncertain?: boolean; seen?: readonly string[];
  earlier?: readonly PendingPrompt[]; attempt?: WaitingAttempt; recoveries?: number; retryOf?: string };
type ReceiptPrompt = Pick<PendingPrompt, 'text' | 'at'> & { seen?: readonly string[] };

export const normalizePrompt = (text: string) => text.trim().replace(/\s+/g, ' ');

const timely = (prompt: { at: number }, record: UserRecord) => {
  const at = record.receivedAt ?? record.at;
  return (record.undeliveredAt === undefined || prompt.at < record.undeliveredAt) && (at === undefined || at >= prompt.at - 500);
};
const withoutPasteTags = (text: string) => text.replace(/<\/?pasted_content\b[^>]*>\n?/g, '');
const boundedTranscript = (text: string) => text.length === 20003 && text.endsWith('\n\n…');
const transcriptMatches = (message: string, record: string, original?: string) => {
  const bounded = boundedTranscript(record);
  // The producer retains the full original beside its 20,000-character display. Shared prefixes cannot identify
  // distinct long sends. Keep the legacy prefix fallback only for records without that original.
  if (bounded && original !== undefined) record = withoutImageLabels(withoutPasteTags(original)).trim();
  const normalized = normalizePrompt(message);
  return normalized === normalizePrompt(record)
    || (bounded && original === undefined && normalized.startsWith(normalizePrompt(record.slice(0, 20000))));
};

export const matchesPrompt = (prompt: Pick<PendingPrompt, 'text' | 'at'>, record: UserRecord) =>
  timely(prompt, record) && transcriptMatches(prompt.text, record.text ?? '', record.original);

function takeReceipt<T extends ReceiptPrompt>(prompts: T[], record: UserRecord): T | undefined {
  const index = prompts.findIndex(prompt => !prompt.seen?.includes(record.id) && matchesPrompt(prompt, record));
  return index >= 0 ? prompts.splice(index, 1)[0] : undefined;
}

// The echo for an earlier identical send owns its receipt, even if that echo has since retired. Keep the contenders
// captured at admission across remounts, and consume each receipt once. Untimestamped history cannot confirm delivery.
export function reconcileOutbox(messages: WaitingMessage[], records: readonly UserRecord[]): WaitingMessage[] {
  const candidates = new Map<string, ReceiptPrompt & { id: string }>();
  for (const message of messages) {
    if (!message.uncertain) continue;
    for (const prompt of message.earlier ?? []) {
      if (!candidates.has(prompt.id)) candidates.set(prompt.id, { ...prompt, seen: message.seen });
    }
    const id = `outbox:${message.id}`;
    candidates.set(id, { ...message, id });
  }
  if (!candidates.size) return messages;
  const pending = [...candidates.values()], matched = new Set<string>(), seen = new Set<string>();
  for (const record of records) {
    if (record.role !== 'user' || record.cancelled || seen.has(record.id) || !Number.isFinite(record.receivedAt ?? record.at)) continue;
    const prompt = takeReceipt(pending, record);
    if (prompt) { matched.add(prompt.id); seen.add(record.id); }
  }
  if (!matched.size) return messages;
  return messages.flatMap(message => {
    if (!message.uncertain) return [message];
    if (matched.has(`outbox:${message.id}`)) return [];
    return [{ ...message, earlier: message.earlier?.filter(prompt => !matched.has(prompt.id)), seen: [...new Set([...(message.seen ?? []), ...seen])] }];
  });
}

// Pair queue records and renderer echoes one-to-one. Raw-terminal sends and reloads have no echo;
// the transcript still owns queued and undelivered cards and their position ahead of later sends.
export function pendingPromptCards(prompts: readonly PendingPrompt[], records: readonly UserRecord[]) {
  const remaining = [...prompts], queuedIds = new Set<string>();
  const cards: PendingPrompt[] = [];
  for (const record of records) {
    if (record.role !== 'user' || !record.queued || record.undeliveredReplaced) continue;
    if (record.undeliveredAt !== undefined) {
      const shown = record.text ?? '';
      const original = record.original ?? shown;
      const text = boundedTranscript(shown) ? withoutImageLabels(withoutPasteTags(original)).trim() : shown;
      cards.push({ id: record.id, role: 'user', text, at: record.at ?? 0,
        sending: false, undelivered: true, images: record.images, imageCount: record.images?.length || Number(hasImageLabel(original)) });
      continue;
    }
    if (record.cancelled) continue;
    const echo = takeReceipt(remaining, record);
    const card: PendingPrompt = { ...echo, id: echo?.id ?? record.id, role: 'user', text: echo?.text ?? record.text ?? '', at: record.at ?? echo?.at ?? 0, sending: false, images: record.images ?? echo?.images };
    cards.push(card); queuedIds.add(card.id);
  }
  return { prompts: [...cards, ...remaining], queuedIds };
}
// A slash command (/model, /prompts:fix) or shell mode (!ls); a message that starts with a path (/tmp/shot.png, what an
// SSH project's pasted picture becomes) is a message, not a command whose screen is shown in a popup.
export const isTypedCommand = (text: string) => (/^\/[^\s/]+(?:\s|$)/.test(text) || text.startsWith('!')) && !/[\r\n]/.test(text);

// Whether what the CLI's input holds is this message: its input wraps lines, puts "[Image #1]" before pasted pictures,
// may cut a long line short with "…", and shows a long paste only as "[Pasted text #1 +12 lines]" (Claude) or
// "[Pasted Content 1200 chars]" (Codex). It must be this message, not one that merely begins the same way: Enter on a
// leftover "delete" would send it instead of "delete nothing".
const squash = (text: string) => withoutImageLabels(text).replace(/\s+/g, '');
export function sameMessage(message: string, draft: string, agent?: ScreenAgent) {
  if (!draft.trim()) return false;
  // Only a long or multi-line message is shown as a paste summary; its words cannot be compared.
  if (isPasteSummary(draft, agent)) return /\n/.test(message.trim()) || message.length > 200;
  const sent = squash(message), held = squash(draft);
  if (!sent || !held) return false;
  return held.endsWith('…') ? held.length > 9 && sent.startsWith(held.slice(0, -1)) : sent === held;
}

export function createPendingPrompts(sessionId: string | null, entries: readonly UserRecord[] = []): PendingPrompts {
  return { sessionId, prompts: [], seen: entries.filter(entry => entry.role === 'user' && (!entry.queued || entry.cancelled)).map(entry => entry.id).slice(-SEEN_LIMIT) };
}

export function reconcilePendingPrompts(state: PendingPrompts, sessionId: string | null, entries: readonly UserRecord[], now: number): PendingPrompts {
  if (state.sessionId !== sessionId) return createPendingPrompts(sessionId, entries);
  const seen = new Set(state.seen), prompts = [...state.prompts];
  let changed = false;
  for (const entry of entries) {
    if (entry.role !== 'user' || entry.queued && !entry.cancelled || seen.has(entry.id)) continue;
    // The echo with the same text, or one this record ends with: a prompt Claude put back after an interrupt can
    // precede what was sent.
    const text = normalizePrompt(entry.text ?? '');
    const lost = entry.undeliveredAt !== undefined;
    let index = prompts.findIndex(prompt => matchesPrompt(prompt, entry));
    if (index < 0 && !lost) index = prompts.findIndex(prompt => timely(prompt, entry) && text.endsWith(normalizePrompt(prompt.text)));
    // A matching text receipt cannot acknowledge pictures. Leave it unseen so a later thumbnail update can confirm it.
    if (index >= 0 && !(lost && hasImageLabel(entry.original ?? '')) && (entry.images?.length ?? 0) < (prompts[index].imageCount ?? 0)) continue;
    seen.add(entry.id); changed = true;
    if (index >= 0) prompts.splice(index, 1);
  }
  for (let index = 0; index < prompts.length; index++) {
    const prompt = prompts[index];
    if (prompt.sending && now - prompt.at >= PENDING_PROMPT_TIMEOUT) {
      prompts[index] = { ...prompt, sending: false }; changed = true;
    }
  }
  return changed ? { ...state, prompts, seen: [...seen].slice(-SEEN_LIMIT) } : state;
}

export function addPendingPrompt(state: PendingPrompts, id: string, text: string, now: number, images: string[] = [], imageCount = images.length): PendingPrompts {
  if ((!normalizePrompt(text) && !imageCount) || isTypedCommand(text)) return state;
  const prompt: PendingPrompt = { id, role: 'user', text, at: now, sending: true,
    ...(images.length ? { images } : {}), ...(imageCount ? { imageCount } : {}) };
  return { ...state, prompts: [...state.prompts.filter(pending => pending.id !== id), prompt] };
}

export function removePendingPrompt(state: PendingPrompts, id: string): PendingPrompts {
  const prompts = state.prompts.filter(prompt => prompt.id !== id);
  return prompts.length === state.prompts.length ? state : { ...state, prompts };
}
