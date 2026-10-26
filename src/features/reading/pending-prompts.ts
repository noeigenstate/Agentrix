// Renderer echoes are replaced only by newly observed user records, one record per send.
export const PENDING_PROMPT_TIMEOUT = 20_000;
// The reading view keeps 400 entries; the user records seen are bounded well above that.
const SEEN_LIMIT = 1000;
type UserRecord = { id: string; role: string; text?: string; original?: string; at?: number; queued?: boolean; cancelled?: boolean; images?: string[] };
export type PendingPrompt = { id: string; role: 'user'; text: string; at: number; sending: boolean; images?: string[] };
export type PendingPrompts = { sessionId: string | null; prompts: readonly PendingPrompt[]; seen: readonly string[] };

export const normalizePrompt = (text: string) => text.trim().replace(/\s+/g, ' ');

const timely = (prompt: { at: number }, record: UserRecord) => record.at === undefined || record.at >= prompt.at - 500;
const transcriptMatches = (message: string, record: string, original?: string) => {
  const bounded = record.length === 20003 && record.endsWith('\n\n…');
  // The producer retains the full original beside its 20,000-character display. Shared prefixes cannot identify
  // distinct long sends. Keep the legacy prefix fallback only for records without that original.
  if (bounded && original !== undefined) record = original.replace(/<\/?pasted_content\b[^>]*>\n?/g, '').replace(/\[Image #\d+\]\s?/g, '').trim();
  return normalizePrompt(message) === normalizePrompt(record)
    || (bounded && original === undefined && normalizePrompt(message).startsWith(normalizePrompt(record.slice(0, 20000))));
};

// Pair queue records and renderer echoes one-to-one. Raw-terminal sends and reloads have no echo;
// the transcript still owns a queued card, its timestamp and its position ahead of later sends.
export function pendingPromptCards(prompts: readonly PendingPrompt[], records: readonly UserRecord[]) {
  const remaining = [...prompts], queuedIds = new Set<string>();
  const cards: PendingPrompt[] = [];
  for (const record of records) {
    if (!record.queued || record.cancelled || record.role !== 'user') continue;
    const index = remaining.findIndex(prompt => timely(prompt, record) && transcriptMatches(prompt.text, record.text ?? '', record.original));
    const echo = index >= 0 ? remaining.splice(index, 1)[0] : undefined;
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
const squash = (text: string) => text.replace(/\[Image #\d+\]/g, '').replace(/\s+/g, '');
const PASTE_SUMMARY = /^\s*(?:\[Image #\d+\]\s*)*\[(?:Pasted text #\d+[^\]]*|Pasted Content \d+ chars)\]\s*$/;
export function sameMessage(message: string, draft: string) {
  if (!draft.trim()) return false;
  // Only a long or multi-line message is shown as a paste summary; its words cannot be compared.
  if (PASTE_SUMMARY.test(draft)) return /\n/.test(message.trim()) || message.length > 200;
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
    seen.add(entry.id); changed = true;
    // The echo with the same text, or one this record ends with: a prompt Claude put back after an interrupt can
    // precede what was sent.
    const text = normalizePrompt(entry.text ?? '');
    let index = prompts.findIndex(prompt => timely(prompt, entry) && transcriptMatches(prompt.text, entry.text ?? '', entry.original));
    if (index < 0) index = prompts.findIndex(prompt => timely(prompt, entry) && text.endsWith(normalizePrompt(prompt.text)));
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

export function addPendingPrompt(state: PendingPrompts, id: string, text: string, now: number, images: string[] = []): PendingPrompts {
  if (!normalizePrompt(text) || isTypedCommand(text)) return state;
  return { ...state, prompts: [...state.prompts, { id, role: 'user', text, at: now, sending: true, ...(images.length ? { images } : {}) }] };
}

export function removePendingPrompt(state: PendingPrompts, id: string): PendingPrompts {
  const prompts = state.prompts.filter(prompt => prompt.id !== id);
  return prompts.length === state.prompts.length ? state : { ...state, prompts };
}
