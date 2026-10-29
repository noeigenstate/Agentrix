import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Project } from '../../shared/types';
import type { ScreenChoice } from '../agents/agent-screen-types';
import { choiceIdentity, parseAgentScreen } from '../agents/agent-screen';
import { signInScreen } from '../agents/sign-in-screen';
import { hasCliInput } from '../reading/cli-panel';
import { bindApproval, subscribeScreen, type Screen } from '../terminal/terminal-screen';
import { reviewHistory } from './review-history';

// Something one of the agents waits on you for, across every project: a permission to grant, a question to answer, a
// choice to make (a model, a folder to trust), a sign-in, or a notice its CLI raised that only its terminal can take.
// Permission screen instances and epochs track observations, never native request identity. Their cards only
// open the source terminal; no screen-derived permission answer can authorize a PTY write.
export type DecisionKind = 'approval' | 'question' | 'choice' | 'signin' | 'attention' | 'review';
export type Decision = {
  id: string; kind: DecisionKind; projectId: string; projectName: string; terminalId: string; sessionId: string | null; terminalTitle: string; multipleTerminals: boolean;
  agent: 'claude' | 'codex'; title: string; context: string[]; choice: ScreenChoice | null; identity: string | null; message: string; since: number; native?: import('../../shared/types').NativeApproval;
};

// When each decision was first seen, so it can say how long it has waited and keep its place in the queue.
const firstSeen = new Map<string, number>();
// What blocks work comes first; a finished round to review waits after it.
const ORDER: Record<DecisionKind, number> = { approval: 0, question: 1, choice: 2, signin: 3, attention: 4, review: 5 };

// Decisions put off until a moment: kept in this window's storage, by decision.
type Snoozes = Record<string, number>;
const SNOOZE_KEY = 'agentrix.decisions.snoozed';
let snoozes: Snoozes = (() => { try { return JSON.parse(localStorage.getItem(SNOOZE_KEY) || '{}') as Snoozes; } catch { return {}; } })();
const snoozeListeners = new Set<() => void>();
export function snooze(id: string, until: number) {
  snoozes = { ...Object.fromEntries(Object.entries(snoozes).filter(([, at]) => at > Date.now())), [id]: until };
  try { localStorage.setItem(SNOOZE_KEY, JSON.stringify(snoozes)); } catch { /* kept for this session only */ }
  snoozeListeners.forEach(listener => listener());
}
const useSnoozes = () => useSyncExternalStore(listener => { snoozeListeners.add(listener); return () => { snoozeListeners.delete(listener); }; }, () => snoozes);

// Every live agent terminal's screen, kept current.
function useScreens(ids: string[]) {
  const [screens, setScreens] = useState<Record<string, Screen>>({});
  const key = ids.join('|');
  useEffect(() => {
    const offs = ids.map(id => subscribeScreen(id, screen => setScreens(current => ({ ...current, [id]: screen }))));
    return () => offs.forEach(off => off());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return screens;
}

export function useDecisions(projects: readonly Project[]) {
  const live = projects.flatMap(project => project.terminals.filter(terminal => terminal.codexActive && terminal.sessionId).map(terminal => ({ project, terminal })));
  const screens = useScreens(live.map(({ terminal }) => terminal.id));
  const snoozed = useSnoozes();
  const [now, setNow] = useState(Date.now());
  // A snooze that ends brings its decision back without anything else changing.
  useEffect(() => {
    const next = Math.min(...Object.values(snoozed).filter(at => at > Date.now()));
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(next - Date.now() + 50, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [snoozed, now]);
  const all = useMemo(() => {
    const found: Decision[] = [];
    for (const { project, terminal } of live) {
      const agent = terminal.agent === 'claude' ? 'claude' : 'codex', observed = screens[terminal.id] ?? null, rows = observed?.rows ?? [];
      const base = { projectId: project.id, projectName: project.name, terminalId: terminal.id, sessionId: terminal.sessionId, terminalTitle: terminal.title, multipleTerminals: project.terminals.length > 1, agent } as const;
      const parsed = parseAgentScreen(agent, rows), screen = { ...parsed, choice: bindApproval(parsed.choice, agent, observed) };
      const add = (decision: Omit<Decision, 'since' | keyof typeof base>) => {
        const id = `${terminal.id}:${terminal.sessionId}:${decision.id}`;
        if (!firstSeen.has(id)) { firstSeen.set(id, Date.now()); if (firstSeen.size > 500) firstSeen.delete(firstSeen.keys().next().value!); }
        found.push({ ...base, ...decision, id, since: firstSeen.get(id)! });
      };
      if (terminal.nativeApprovals?.length) {
        for (const native of terminal.nativeApprovals) add({ id: native.token, kind: 'approval', title: `${native.provider} native approval`, context: [], choice: null, identity: null, message: '', native });
        continue;
      }
      if (screen.choice) {
        const choice = screen.choice, identity = choiceIdentity(choice);
        const kind: DecisionKind = choice.kind === 'permission' ? 'approval' : choice.kind === 'question' ? 'question' : 'choice';
        add({ id: `${choice.approval?.instance ?? ''}:${identity}`, kind, title: choice.title, context: choice.context, choice, identity, message: '' });
        continue;
      }
      const signIn = rows.length && !hasCliInput(agent, rows, screen) ? signInScreen(agent, rows) : null;
      if (signIn) { add({ id: 'signin', kind: 'signin', title: '', context: signIn.lines, choice: null, identity: null, message: '' }); continue; }
      // Claude said it needs you (its Notification hook) but nothing on its screen can be answered from here.
      if (terminal.needsInput !== null) add({ id: `attention:${terminal.needsInput}`, kind: 'attention', title: '', context: [], choice: null, identity: null, message: terminal.needsInput });
    }
    // A round that finished and has not been looked at: its work is handed in for review. The terminal that finished
    // last speaks for the project; looking at the project (or accepting here) is what clears it.
    for (const project of projects) {
      if (!project.unread) continue;
      const terminal = [...project.terminals].sort((a, b) => (b.lastCompletedAt ?? 0) - (a.lastCompletedAt ?? 0))[0];
      if (!terminal) continue;
      const id = `${terminal.id}:review:${project.lastCompletedAt ?? terminal.lastCompletedAt ?? 0}`;
      if (!firstSeen.has(id)) firstSeen.set(id, project.lastCompletedAt ?? Date.now());
      found.push({ id, kind: 'review', projectId: project.id, projectName: project.name, terminalId: terminal.id, sessionId: terminal.sessionId, terminalTitle: terminal.title, multipleTerminals: project.terminals.length > 1,
        agent: terminal.agent === 'codex' ? 'codex' : 'claude', title: reviewHistory(project.id).task || (terminal.task?.startsWith('<') ? '' : terminal.task), context: [], choice: null, identity: null, message: '', since: firstSeen.get(id)! });
    }
    return found.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.since - b.since);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, screens]);
  const open = all.filter(decision => !(snoozed[decision.id] > Date.now()));
  return { decisions: open, snoozed: all.length - open.length, all };
}
