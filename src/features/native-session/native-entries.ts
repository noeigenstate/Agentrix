// A native session as the reading view reads a conversation: the model's items become ConversationEntry[] and the messages not yet in the
// conversation become pending prompts, and the reading view's own components draw both. Pure: the same model gives the same entries. A field no
// event carried stays empty (no time is 0, no output is made up); a thinking summary is not part of the reading view's conversation.
import type { AgentActionBrief, ConversationEntry } from '../../shared/types';
import { t } from '../../shared/i18n';
import type { PendingPrompt } from '../reading/feed-parts';
import type { NativeItem, NativeModel } from './native-model.ts';
import { commandOf, fileChanges, itemState, messageText, planText, shortPath, toolOf } from './native-words';

// The reading view's tool step, with what the step printed (a command's output, a diff, a tool's input and result) for the opened group to show.
type Step = AgentActionBrief & { failed: boolean; output?: string };
const DONE_STEP = /^(completed|done)$/i;
const idOf = (item: NativeItem) => (typeof item.content.clientMessageId === 'string' && item.content.clientMessageId ? item.content.clientMessageId : item.id);
const imagesOf = (item: NativeItem) => (Array.isArray(item.content.images) ? item.content.images.filter((image): image is string => typeof image === 'string' && image !== '') : undefined);

// The fields a Claude tool's input names (it gives the input as a JSON text); anything that is not an object gives none.
function fieldsOf(input: string): Record<string, unknown> {
  try { const value: unknown = JSON.parse(input); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; } catch { return {}; }
}
const field = (fields: Record<string, unknown>, ...names: string[]) => names.map(name => fields[name]).find((value): value is string => typeof value === 'string' && value !== '') ?? '';

// By its name, what kind of step a tool is (Claude's tools by their names; Codex's tools carry a server).
const KINDS: [RegExp, AgentActionBrief['kind']][] = [[/^Read$/, 'read'], [/^(Grep|Glob)$/, 'search'], [/^Web(Fetch|Search)$/, 'web'], [/^(Task|Agent)$/, 'agent'], [/^Skill$/, 'skill'], [/^mcp__/, 'mcp']];
// The field a kind of step is named by.
const TARGET_FIELDS: Partial<Record<AgentActionBrief['kind'], string[]>> = { read: ['file_path', 'path'], search: ['pattern', 'query'], web: ['url', 'query'], agent: ['description', 'subagent_type'], skill: ['skill'] };

function toolStep(item: NativeItem, state: ReturnType<typeof itemState>): Step {
  const { name, server, input, result } = toolOf(item);
  const kind = server ? 'mcp' : KINDS.find(([pattern]) => pattern.test(name))?.[1] ?? 'other';
  const target = server ? `${server} · ${name}` : field(fieldsOf(input), ...TARGET_FIELDS[kind] ?? []) || name;
  return { kind, tool: name, target, detail: '', done: state !== 'running', failed: state === 'failed', output: [input, result].filter(Boolean).join('\n\n') };
}

function commandStep(item: NativeItem, state: ReturnType<typeof itemState>): Step {
  const { command, cwd, exitCode, durationMs, output } = commandOf(item), failed = !!exitCode || state === 'failed';
  const facts = [cwd && shortPath(cwd), exitCode !== null && t('退出码 {code}', { code: exitCode }), durationMs !== null && t('用时 {seconds} 秒', { seconds: (durationMs / 1000).toFixed(1) })].filter(Boolean).join(' · ');
  return { kind: 'command', tool: 'command', target: command, detail: facts, done: state !== 'running', failed, output };
}

function fileStep(item: NativeItem, state: ReturnType<typeof itemState>): Step {
  const changes = fileChanges(item), { input, result } = toolOf(item);
  // A change Claude names only in the input of its Edit or Write.
  const paths = changes.map(change => change.path).filter(Boolean), named = paths.length ? paths : [field(fieldsOf(input), 'file_path', 'path')].filter(Boolean);
  const diffs = changes.filter(change => change.diff).map(change => (changes.length > 1 && change.path ? `${change.path}\n${change.diff}` : change.diff));
  return { kind: 'edit', tool: 'file-change', target: named.join('、'), detail: '', done: state !== 'running', failed: state === 'failed', written: named, output: (diffs.length ? diffs.join('\n\n') : input) || result };
}

function stepOf(item: NativeItem, over: boolean): Step | null {
  const state = over && itemState(item) === 'running' ? null : itemState(item);
  switch (item.kind) {
    case 'command': return commandStep(item, state);
    case 'file-change': return fileStep(item, state);
    case 'tool': return toolStep(item, state);
    case 'web': return { kind: 'web', tool: 'web', target: messageText(item), detail: '', done: state !== 'running', failed: state === 'failed' };
    case 'other': return { kind: 'other', tool: String(item.content.providerType ?? 'other'), target: String(item.content.providerType ?? ''), detail: '', done: state !== 'running', failed: state === 'failed' };
    default: return null;
  }
}

// The messages not in the conversation yet: one the runtime refused (an item marked unsent, or a rejected receipt) or holds in its queue.
// A refused one is lost, a queued one waits; both are drawn as pending messages and neither is a message of the conversation.
const refused = (model: NativeModel, item: NativeItem) => item.content.unsent === true || model.receipts[idOf(item)] === 'rejected';
const held = (model: NativeModel, item: NativeItem) => refused(model, item) || model.receipts[idOf(item)] === 'queued';

// images: the pictures that went with a message the owner sent, by its id (the runtime's echo carries none).
export function nativeEntries(model: NativeModel, images: Readonly<Record<string, string[]>> = {}): ConversationEntry[] {
  const over = model.session?.state === 'stopped' || model.session?.state === 'failed' || model.session?.state === 'disconnected';
  const entries: ConversationEntry[] = [];
  for (const id of model.order) {
    const item = model.items[id], at = item.at ?? 0;
    if (item.kind === 'user-message') {
      const text = messageText(item), pictures = imagesOf(item) ?? images[idOf(item)];
      if (!held(model, item) && (text || pictures?.length)) entries.push({ id: item.id, at, role: 'user', text, ...(pictures?.length ? { images: pictures } : {}) });
    } else if (item.kind === 'agent-message' || item.kind === 'plan') {
      const text = item.kind === 'plan' ? planText(item) : messageText(item);
      if (text) entries.push({ id: item.id, at, role: 'assistant', text });
    } else {
      const tool = stepOf(item, over);
      if (tool) entries.push({ id: item.id, at, role: 'tool', tool });
    }
  }
  const at = entries.at(-1)?.at ?? 0, { plan, diff } = model;
  if (plan?.steps.length) {
    const output = plan.steps.map(step => `${DONE_STEP.test(step.status ?? '') ? '[x]' : '[ ]'} ${step.text}`).join('\n');
    const done = plan.steps.filter(step => DONE_STEP.test(step.status ?? '')).length;
    entries.push({ id: 'native:plan', at, role: 'tool', tool: { kind: 'other', tool: 'plan', target: t('计划'), detail: t('{done} / {total} 步', { done, total: plan.steps.length }), done: true, failed: false, output: [plan.explanation, output].filter(Boolean).join('\n\n') } as Step });
  }
  if (diff) entries.push({ id: 'native:diff', at, role: 'tool', tool: { kind: 'edit', tool: 'diff', target: t('本轮改动'), detail: '', done: true, failed: false, output: diff } as Step });
  return entries;
}

export type SentMessage = { id: string; text: string; images?: string[]; at: number };
export type NativePending = { prompts: PendingPrompt[]; queued: ReadonlySet<string>; lost: ReadonlySet<string> };

// What the owner sent that the conversation does not show: sent here and not echoed yet (sending), held in the runtime's queue (queued), or
// refused (lost, never delivered, so the owner may send it again). A receipt of unknown delivery stays "sending": it is neither lost nor resent.
export function nativePending(model: NativeModel, sent: readonly SentMessage[], discarded: ReadonlySet<string> = new Set()): NativePending {
  const users = model.order.map(id => model.items[id]).filter(item => item.kind === 'user-message');
  const prompts = new Map<string, PendingPrompt>(), queued = new Set<string>(), lost = new Set<string>();
  const add = (id: string, prompt: Omit<PendingPrompt, 'id' | 'role'>) => { if (!discarded.has(id)) prompts.set(id, { id, role: 'user', ...prompt }); };
  for (const item of users) {
    const id = idOf(item);
    if (held(model, item)) {
      (refused(model, item) ? lost : queued).add(id);
      add(id, { text: messageText(item), at: item.at ?? 0, sending: false, images: imagesOf(item) });
    }
  }
  const known = new Set(users.map(idOf));
  for (const message of sent) {
    const status = model.receipts[message.id], present = prompts.get(message.id);
    if (present) { prompts.set(message.id, { ...present, images: present.images ?? message.images }); continue; }
    if (known.has(message.id)) continue;
    if (status === 'rejected') lost.add(message.id); else if (status === 'queued') queued.add(message.id);
    add(message.id, { text: message.text, at: message.at, sending: !status || status === 'unknown', images: message.images });
  }
  for (const id of discarded) { lost.delete(id); queued.delete(id); }
  return { prompts: [...prompts.values()].sort((a, b) => a.at - b.at), queued, lost };
}

// The step the agent is on now, for the line that says what it is doing; null when no step runs.
export const runningStep = (entries: readonly ConversationEntry[]) => entries.filter(entry => entry.tool && !entry.tool.done).at(-1)?.tool ?? null;
