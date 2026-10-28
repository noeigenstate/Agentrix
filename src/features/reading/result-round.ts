import type { ConversationEntry, GitChange } from '../../shared/types';

// The steps that check work, by the phrase the activity text gives a command: what was run, and whether it passed.
// Anything else the agent says about its checks is its own word, shown as such.
export const CHECKS = new Set(['运行测试', '检查类型', '构建项目', '检查代码格式']);

type Round = { goal: string; reply: string; written: string[] };
function lastWhere<T>(items: readonly T[], test: (item: T) => unknown): T | undefined {
  for (let index = items.length - 1; index >= 0; index--) if (test(items[index])) return items[index];
}
// The last thing you asked: an answer you gave the agent's question and a message still queued do not start a round.
function startOf(entries: readonly ConversationEntry[]) {
  for (let index = entries.length - 1; index >= 0; index--) if (entries[index].role === 'user' && !entries[index].answer && !entries[index].queued) return index;
  return -1;
}
export const writtenBy = (round: readonly ConversationEntry[]) => [...new Set(round.flatMap(entry => entry.tool?.done && !entry.tool.failed ? entry.tool.written ?? [] : []))];
const replyOf = (round: readonly ConversationEntry[]) => lastWhere(round, entry => entry.role === 'assistant' && entry.text);

// What the round did, from the agent's own conversation: the last thing you asked, the answer it ended on, and the
// files its steps wrote.
export function lastRound(entries: readonly ConversationEntry[]): Round {
  const start = startOf(entries), round = entries.slice(start + 1);
  return { goal: start >= 0 ? entries[start].text ?? '' : '', reply: replyOf(round)?.text ?? '', written: writtenBy(round) };
}

const STATE: Record<string, string> = { M: '修改', A: '新增', D: '删除', R: '重命名', C: '复制', U: '冲突', '?': '新文件' };
// A changed file's state in Git, the way the review card names it.
export const changeLabel = (change: Pick<GitChange, 'untracked' | 'index' | 'worktree'>) =>
  change.untracked ? STATE['?'] : STATE[(change.worktree.trim() || change.index.trim())[0]] ?? change.worktree;

export type ResultKind = 'picture' | 'code' | 'text' | 'failed';
export type RoundCheck = { id: string; phrase: string; target: string; done: boolean; failed: boolean };
export type LatestResult = {
  kind: ResultKind;
  // The entry the status row stands over and the actions under: the picture, the last reply, or the step the round ended on.
  anchor: string;
  request: string; startedAt: number; endedAt: number;
  reply: string; written: string[]; checks: RoundCheck[];
  picture: { path: string; prompt: string } | null;
  // What stopped a failed round: the step's target.
  failure: string;
};

// The latest round, once it has ended: its kind and what it left. Null while the agent works or waits (nothing to hand
// in yet), and for a round that left neither a reply, a picture nor files. Only this round carries the result card.
export function latestResult(entries: readonly ConversationEntry[], { idle, interrupted }: { idle: boolean; interrupted: boolean }): LatestResult | null {
  const start = startOf(entries);
  if (!idle || start < 0) return null;
  const round = entries.slice(start + 1), last = round.at(-1);
  if (!last) return null;
  const tools = round.filter(entry => entry.tool);
  const reply = replyOf(round);
  const base = {
    request: entries[start].text ?? '', startedAt: entries[start].at, endedAt: last.at, reply: reply?.text ?? '', written: writtenBy(round),
    checks: tools.filter(entry => entry.tool!.kind === 'command' && entry.tool!.phrase && CHECKS.has(entry.tool!.phrase))
      .map(({ id, tool }) => ({ id, phrase: tool!.phrase!, target: tool!.target, done: tool!.done, failed: tool!.failed })),
  };
  const failure = last.tool?.failed ? last.tool.target : '';
  if (interrupted || failure) return { ...base, kind: 'failed', anchor: last.id, picture: null, failure };
  const drawn = lastWhere(round, entry => entry.generated && entry.images?.[0]);
  if (drawn) return { ...base, kind: 'picture', anchor: drawn.id, picture: drawn.generated!, failure: '' };
  if (base.written.length) return { ...base, kind: 'code', anchor: last.id, picture: null, failure: '' };
  return reply ? { ...base, kind: 'text', anchor: reply.id, picture: null, failure: '' } : null;
}

// The status row's title when the task has none of its own: what the round did, never a copy of your message above it.
export const FALLBACK_TITLES: Record<ResultKind, string> = { picture: '生成图片', code: '修改代码', text: '回答问题', failed: '执行任务' };

export type ResultAction = 'enlarge' | 'save' | 'open' | 'continue' | 'ask' | 'copy' | 'retry';
// The buttons under a result, in order, and which of them can act now. A picture an SSH agent drew stays on that
// computer (no save); a retry sends the request again, so only while the agent sits at its input.
export function resultActions(result: LatestResult, { remote, canSend }: { remote: boolean; canSend: boolean }): { id: ResultAction; disabled: boolean }[] {
  const action = (id: ResultAction, disabled = false) => ({ id, disabled });
  switch (result.kind) {
    case 'picture': return [action('enlarge'), action('save', remote), action('continue')];
    case 'code': return [action('open', !result.written.length), action('continue')];
    case 'text': return [action('ask'), action('copy')];
    case 'failed': return [action('retry', !canSend || !result.request), action('continue')];
  }
}

// How long the round took, as the parts the label is written from.
export function elapsed(startedAt: number, endedAt: number) {
  const seconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  return { hours: Math.floor(seconds / 3600), minutes: Math.floor(seconds % 3600 / 60), seconds: seconds % 60 };
}
