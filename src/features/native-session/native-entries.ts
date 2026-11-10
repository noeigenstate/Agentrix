// A native session as the reading view reads a conversation: the model's items become ConversationEntry[] and the messages not yet in the
// conversation become pending prompts, and the reading view's own components draw both. Pure: the same model gives the same entries. A field no
// event carried stays empty (no time is 0, no output is made up); a thinking summary is not part of the reading view's conversation.
import type { AgentActionBrief, ConversationEntry } from '../../shared/types';
import { t } from '../../shared/i18n';
import { splitQuote, type MessageEntry, type PendingPrompt } from '../reading/feed-parts';
import { isOver, type NativeItem, type NativeModel } from './native-model.ts';
import { noticeText } from './native-notices.ts';
import { commandOf, fieldOf, fileChanges, generatedOf, itemState, messageText, picturesOf, planText, shortPath, toolOf, type StepMark } from './native-words';

// The reading view's tool step, with what the step printed (a command's output, a diff, a tool's result) for the opened group to show.
type Step = AgentActionBrief & { failed: boolean; output?: string; unconfirmed?: boolean };
const DONE_STEP = /^(completed|done)$/i;
const idOf = (item: NativeItem) => (typeof item.content.clientMessageId === 'string' && item.content.clientMessageId ? item.content.clientMessageId : item.id);

// By its name, what kind of step a tool is (Claude's tools by their names; Codex's tools carry a server).
const KINDS: [RegExp, AgentActionBrief['kind']][] = [[/^Read$/, 'read'], [/^(Grep|Glob)$/, 'search'], [/^Web(Fetch|Search)$/, 'web'], [/^(Task|Agent)$/, 'agent'], [/^Skill$/, 'skill'], [/^mcp__/, 'mcp']];
// The field a kind of step is named by.
const TARGET_FIELDS: Partial<Record<AgentActionBrief['kind'], string[]>> = { read: ['file_path', 'path'], search: ['pattern', 'query'], web: ['url', 'query'], agent: ['description', 'subagent_type'], skill: ['skill'] };

// A step that ended without a result is cut off, not done: it is drawn as stopped (the cross) and says so.
// A step whose end the provider could not confirm ("unknown") is not drawn as done: it is marked unconfirmed (the reading view draws a question and counts it as no pass).
const marks = (state: StepMark) => ({ done: state !== 'running', failed: state === 'failed' || state === 'interrupted', ...(state === 'unknown' ? { unconfirmed: true } : {}) });

function toolStep(item: NativeItem, state: StepMark): Step {
  const { name, server, fields, path, result } = toolOf(item);
  const kind = server ? 'mcp' : KINDS.find(([pattern]) => pattern.test(name))?.[1] ?? 'other';
  const target = server ? `${server} · ${name}` : (kind === 'read' && path) || fieldOf(fields, ...TARGET_FIELDS[kind] ?? []) || name;
  return { kind, tool: name, target, detail: '', ...marks(state), output: result };
}

function commandStep(item: NativeItem, state: StepMark): Step {
  // The command and its phrase (运行测试, 检查类型…) are main's, from the same rules the terminal transcript uses (electron/command-phrase.cjs), so the result
  // row's list of checks reads the same in both. A record that gives only the tool's input names the command there.
  const { command: given, phrase, cwd, exitCode, durationMs, output } = commandOf(item), mark = marks(state);
  // A "!" line's output the model did not get (main says so) is said on its card: the command ran, but the model never saw what it printed.
  const facts = [cwd && shortPath(cwd), exitCode !== null && t('退出码 {code}', { code: exitCode }), durationMs !== null && t('用时 {seconds} 秒', { seconds: (durationMs / 1000).toFixed(1) }),
    item.content.modelDelivery === 'rejected' && t('输出未发送给模型')].filter(Boolean).join(' · ');
  return { kind: 'command', tool: 'command', target: given || fieldOf(toolOf(item).fields, 'command'), detail: facts, ...mark, failed: mark.failed || !!exitCode, output, ...(phrase ? { phrase } : {}) };
}

function fileStep(item: NativeItem, state: StepMark): Step {
  const changes = fileChanges(item), { fields, result } = toolOf(item);
  // A change named by its path, else (an older record) by the input of the Edit or Write.
  const paths = changes.map(change => change.path).filter(Boolean), named = paths.length ? paths : [fieldOf(fields, 'file_path', 'path')].filter(Boolean);
  const diffs = changes.filter(change => change.diff).map(change => (changes.length > 1 && change.path ? `${change.path}\n${change.diff}` : change.diff));
  return { kind: 'edit', tool: 'file-change', target: named.join('、'), detail: '', ...marks(state), written: named, output: diffs.length ? diffs.join('\n\n') : result };
}

function stepOf(item: NativeItem, settled: boolean): Step | null {
  const state = itemState(item, settled);
  const step = ((): Step | null => {
    switch (item.kind) {
      case 'command': return commandStep(item, state);
      case 'file-change': return fileStep(item, state);
      // The question tool is asked as a card and answered there; a step for it would say the same thing twice.
      case 'tool': return toolOf(item).name === 'AskUserQuestion' ? null : toolStep(item, state);
      case 'web': return { kind: 'web', tool: 'web', target: messageText(item), detail: '', ...marks(state) };
      case 'other': return { kind: 'other', tool: String(item.content.providerType ?? 'other'), target: String(item.content.providerType ?? ''), detail: '', ...marks(state) };
      default: return null;
    }
  })();
  const said = state === 'interrupted' ? t('已中断') : state === 'unknown' ? t('结果未能确认') : '';
  return step && said ? { ...step, detail: [step.detail, said].filter(Boolean).join(' · ') } : step;
}

// The messages not in the conversation yet: one the runtime refused (an item marked unsent, or a rejected receipt) or holds in its queue.
// A refused one is lost, a queued one waits; both are drawn as pending messages and neither is a message of the conversation.
const refused = (model: NativeModel, item: NativeItem) => item.content.unsent === true || model.receipts[idOf(item)] === 'rejected';
const held = (model: NativeModel, item: NativeItem) => refused(model, item) || model.receipts[idOf(item)] === 'queued';

// images: the pictures that went with a message the owner sent, by its id (a record that carries none has them here).
export function nativeEntries(model: NativeModel, images: Readonly<Record<string, string[]>> = {}): ConversationEntry[] {
  // A step with no result once its turn is over (the session ended, or is idle with no turn running) is cut off, not running.
  const settled = isOver(model) || model.session?.state === 'idle' && !model.turn.running;
  const entries: MessageEntry[] = [];
  for (const id of model.order) {
    const item = model.items[id], at = item.at ?? 0, line = noticeText(item);
    if (item.content.discarded === true) continue;
    if (item.kind === 'user-message') {
      const text = messageText(item), pictures = picturesOf(item) ?? images[idOf(item)], omitted = item.content.imagesOmitted === true && !pictures;
      if (!held(model, item) && (text || pictures || omitted)) entries.push({ id: item.id, at, role: 'user', text, ...(pictures ? { images: pictures } : {}), ...(omitted ? { imagesOmitted: true } : {}) });
    } else if (item.kind === 'agent-message' || item.kind === 'plan') {
      const text = item.kind === 'plan' ? planText(item) : messageText(item), generated = generatedOf(item), pictures = picturesOf(item);
      // A drawn picture is drawn by the feed only with a picture to show; its words may be none.
      if (text || generated && pictures) entries.push({ id: item.id, at, role: 'assistant', text, ...(generated && pictures ? { generated, images: pictures } : {}) });
    } else if (line) {
      entries.push({ id: item.id, at, role: 'assistant', text: line });
    } else {
      const tool = stepOf(item, settled);
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
      add(id, { text: messageText(item), at: item.at ?? 0, sending: false, images: picturesOf(item) });
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

// Whether the latest round (after the owner's last message) holds a "!" line: it has no message of its own, so the message above it is not the round's to send again.
export const shellRound = (entries: readonly ConversationEntry[]) => entries.slice(entries.map(entry => entry.role).lastIndexOf('user') + 1).some(entry => entry.id.startsWith('shell:'));

// The step the agent is on now, for the line that says what it is doing; null when no step runs.
export const runningStep = (entries: readonly ConversationEntry[]) => entries.filter(entry => entry.tool && !entry.tool.done).at(-1)?.tool ?? null;

// What the owner has sent in this conversation, oldest first, for ↑ in the message box: the messages of the conversation (the history replayed after a
// run-mode switch included), the "!" lines among them, and those not echoed yet, each without the quote it carried, as the reading view keeps what was typed. The last 50.
export const SENT_KEPT = 50;
// What the owner typed for an entry: a message, or the command of a "!" line (its card is the item shell:<id> main publishes), written with its "!" as it was typed.
const said = (entry: ConversationEntry) => entry.role === 'user' ? entry.text ?? '' : entry.role === 'tool' && entry.id.startsWith('shell:') && entry.tool?.target ? `!${entry.tool.target}` : '';
export const sentTexts = (entries: readonly ConversationEntry[], pending: readonly PendingPrompt[]): string[] =>
  [...entries.map(said), ...pending.map(prompt => prompt.text)]
    .map(text => splitQuote(text).rest.trim()).filter(Boolean).slice(-SENT_KEPT);
