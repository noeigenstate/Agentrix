import type { ConversationEntry, ProjectTerminal } from './types';

type Command = '/model' | '/effort';
type Submission = { command: Command; at: number; until: number };
export type LeadRoutingNotice = { model?: string; effort?: string; incomplete?: boolean };
type Route = { submissions: Submission[]; outcome: LeadRoutingNotice | null };

// Renderer memory only. A reopened transcript needs the same live PTY and conversation to use these receipts.
const routes = new Map<string, readonly Route[]>();
const listeners = new Set<() => void>();
const empty: readonly Route[] = [];

export function leadRoutingScope(terminal: ProjectTerminal) {
  return terminal.sessionId ? JSON.stringify([
    terminal.id, terminal.sessionId, terminal.readingHistory?.threadId ?? terminal.agentStartedAt ?? null,
  ]) : '';
}

export const leadRoutingSnapshot = (scope: string) => routes.get(scope) ?? empty;

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
    for (const listener of listeners) listener();
  };
  return {
    submit(command: Command, at = Date.now()) {
      const submission = { command, at, until: Infinity };
      update({ ...route, submissions: [...route.submissions, submission] });
      return (until = Date.now()) => update({ ...route, submissions: route.submissions.map(item => item === submission ? { ...item, until } : item) });
    },
    finish(outcome: LeadRoutingNotice) { if (route.submissions.length) update({ ...route, outcome }); },
  };
}

function isReceipt(entry: ConversationEntry, { command, at, until }: Submission) {
  if (entry.role !== 'user' || entry.queued || entry.cancelled || entry.answer || entry.images?.length || entry.sender?.kind === 'planner'
    || entry.at < at || entry.at > until || entry.text !== command) return false;
  const original = entry.original?.trim();
  if (!original || original === command) return original === command;
  // Claude can shorten the displayed command by dropping its arguments. Match the original, with zero arguments.
  const name = original.match(/<command-name>\s*(\/\w+)\s*<\/command-name>/)?.[1];
  const wrappers = /<command-name>[^<]*<\/command-name>|<command-message>[^<]*<\/command-message>|<command-args>\s*<\/command-args>/g;
  return name === command && !original.replace(wrappers, '').trim();
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
