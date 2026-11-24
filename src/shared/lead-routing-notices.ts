import type { ConversationEntry, ProjectTerminal } from './types';

export type LeadRoutingCommand = '/model' | '/effort' | '/fast on' | '/fast off';
type Submission = { command: LeadRoutingCommand; at: number; until: number };
export type LeadRoutingNotice = { model?: string; effort?: string; fast?: boolean; ultracode?: boolean; incomplete?: boolean; unavailable?: string; fastError?: { target: boolean; reason: string } };
type LeadRoutingFailure = { targetModel: string; notice: LeadRoutingNotice };
type Route = { submissions: Submission[]; outcome: LeadRoutingNotice | null };

// Renderer memory only. A reopened transcript needs the same live PTY and conversation to use these receipts.
const routes = new Map<string, readonly Route[]>();
const failures = new Map<string, LeadRoutingFailure>();
const listeners = new Set<() => void>();
const empty: readonly Route[] = [];
const notify = () => { for (const listener of listeners) listener(); };

export function leadRoutingScope(terminal: ProjectTerminal) {
  return terminal.sessionId ? JSON.stringify([
    terminal.id, terminal.sessionId, terminal.readingHistory?.threadId ?? terminal.agentStartedAt ?? null,
  ]) : '';
}

export const leadRoutingSnapshot = (scope: string) => routes.get(scope) ?? empty;
export const leadRoutingFailure = (scope: string) => failures.get(scope) ?? null;
export const unverifiedSwitchWords = (cli: string, t: (text: string, values: { cli: string }) => string) =>
  t('未验证的 {cli} 版本，不支持运行中切换', { cli });

export function setLeadRoutingFailure(scope: string, failure: LeadRoutingFailure | null) {
  if (failure) failures.set(scope, failure);
  else if (!failures.delete(scope)) return;
  notify();
}

export function subscribeLeadRouting(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function trackLeadRouting(scope: string) {
  let route: Route = { submissions: [], outcome: null };
  const update = (next: Route) => {
    const previous = leadRoutingSnapshot(scope).filter(item => item !== route);
    route = next;
    routes.delete(scope);
    routes.set(scope, [...previous.slice(-31), route]);
    if (routes.size > 128) routes.delete(routes.keys().next().value!);
    notify();
  };
  return {
    submit(command: LeadRoutingCommand, at = Date.now()) {
      const submission = { command, at, until: Infinity };
      update({ ...route, submissions: [...route.submissions, submission] });
      return (until = Date.now()) => update({ ...route, submissions: route.submissions.map(item => item === submission ? { ...item, until } : item) });
    },
    finish(outcome: LeadRoutingNotice | null) { if (route.submissions.length) update({ ...route, outcome }); },
  };
}

function isReceipt(entry: ConversationEntry, { command, at, until }: Submission) {
  if (entry.role !== 'user' || entry.queued || entry.cancelled || entry.answer || entry.images?.length || entry.sender?.kind === 'planner'
    || entry.at < at || entry.at > until) return false;
  const original = entry.original?.trim();
  if (original === command) return entry.text === command || entry.text === command.split(' ', 1)[0];
  if (!original) return false;
  // Claude can shorten the displayed command by dropping its arguments. Match them against the original record.
  const name = original.match(/<command-name>\s*(\/\w+)\s*<\/command-name>/)?.[1];
  const args = original.match(/<command-args>([^<]*)<\/command-args>/)?.[1].trim();
  const wrappers = /<command-name>[^<]*<\/command-name>|<command-message>[^<]*<\/command-message>|<command-args>[^<]*<\/command-args>/g;
  return !!name && (entry.text === name || entry.text === command) && (args ? `${name} ${args}` : name) === command && !original.replace(wrappers, '').trim();
}

export function routingNotice({ model, effort, incomplete, fast, ultracode, fastError, unavailable }: LeadRoutingNotice,
  t: (text: string, values?: Record<string, string>) => string) {
  if (unavailable) return unverifiedSwitchWords(unavailable, t);
  if (fastError) {
    const { reason, target } = fastError;
    return target ? t('快速模式未开启：{reason}', { reason }) : t('快速模式未关闭：{reason}', { reason });
  }
  if (incomplete) return t('按模型路由切换未完成');
  const fastLabel = fast === undefined ? '' : fast ? t('快速') : t('快速已关闭');
  const ultraLabel = ultracode === undefined ? '' : ultracode ? 'Ultracode' : t('Ultracode 已关闭');
  const labels = [model, effort, ultraLabel, fastLabel].filter(Boolean);
  if (model || labels.length > 1) return t('已按模型路由切换到 {model}', { model: labels.join(' · ') });
  if (effort) return t('已按模型路由将思考深度调为 {effort}', { effort });
  if (ultracode !== undefined) return ultracode ? t('已按模型路由开启 Ultracode') : t('已按模型路由关闭 Ultracode');
  if (fast !== undefined) return fast ? t('已按模型路由开启快速模式') : t('已按模型路由关闭快速模式');
  return '';
}

// A combined switch occupies its first matched position. The other matched records (and pending switches) are hidden.
export function leadRoutingNotices(entries: readonly ConversationEntry[], snapshot: readonly Route[]) {
  const notices = new Map<string, LeadRoutingNotice | null>();
  for (const { submissions, outcome } of snapshot) {
    const ids = submissions.flatMap(submission => {
      const matches = entries.filter(entry => isReceipt(entry, submission));
      return matches.length === 1 ? [matches[0].id] : [];
    });
    ids.forEach((id, index) => notices.set(id, index === 0 ? outcome : null));
  }
  return notices;
}
