import { useEffect, useRef } from 'react';
import type { AgentSettings, ProjectTerminal, SeatsInfo } from '../../shared/types';
import { leadRoutingScope, routingNotice, setLeadRoutingFailure, setLeadRoutingPending, trackLeadRouting, type LeadRoutingNotice } from '../../shared/lead-routing-notices.ts';
import { t } from '../../shared/i18n';
import { screenOf, unverifiedScreenStep } from '../cli-screens/index.ts';
import { applyLeadStep } from './lead-picker.ts';
import { comparableModel, leadSteps, pendingLeadChanges, type LeadSeat, type LeadStep } from './lead-steps.ts';
import { canPasteScreen, readScreen, subscribeScreen, type Screen } from './terminal-screen';

type Terminal = Parameters<typeof applyLeadStep>[1];
type FastSettings = Window['agentrix']['leadFastSettings'];
const fields = ['model', 'effort', 'fast', 'ultracode'] as const;

const targetKey = (seat: LeadSeat | null | undefined) => seat && JSON.stringify([seat.model, seat.effort, seat.fast === true, seat.ultracode === true]);

// A screen echo can reach the renderer before the same change arrives through the transcript poll.
function reconcileSettings(before: AgentSettings, observed: Partial<AgentSettings>, latest: AgentSettings | null | undefined) {
  const actual = { ...latest } as AgentSettings;
  for (const key of fields) {
    if (observed[key] !== undefined && before[key] === latest?.[key]) Object.assign(actual, { [key]: observed[key] });
    else delete observed[key];
  }
  return actual;
}

async function withFastSettings(step: Extract<LeadStep, { kind: 'fast' }>, options: {
  id: string; sessionId: string; access: FastSettings; apply: () => Promise<boolean>; confirmed: () => boolean; failure: (reason: string) => void;
}) {
  const { id, sessionId, access, apply, confirmed, failure } = options;
  try {
    const start = await access(id, { sessionId, target: step.target });
    if (!start.ok || !start.value) { failure(t('无法读取或恢复 Claude Code 的快速模式默认设置。')); return false; }
    let applied;
    try { applied = await apply(); }
    finally {
      const end = await access(id, { token: start.value, confirmed: confirmed() });
      if (!end.ok) { failure(t('无法读取或恢复 Claude Code 的快速模式默认设置。')); applied = false; }
    }
    return applied;
  } catch {
    failure(t('无法读取或恢复 Claude Code 的快速模式默认设置。'));
    return false;
  }
}

async function switchLead(steps: LeadStep[], terminal: Terminal, scope: string, access: { id: string; sessionId: string; access: FastSettings }) {
  const route = trackLeadRouting(scope);
  const observed: Partial<AgentSettings> = {};
  const notice: LeadRoutingNotice = {};
  let incomplete = true;
  try {
    for (const step of steps) {
      if (!terminal.active()) { incomplete = false; return { observed, notice, incomplete }; }
      let close: (() => void) | undefined;
      let typed = false;
      const failure = (reason: string) => {
        if (step.kind === 'fast') notice.fastError ??= { target: step.target, reason };
      };
      const apply = () => applyLeadStep(step, terminal, {
        typed: () => { typed = true; },
        submitted: command => { close = route.submit(command); },
        observed: (settings, changed) => {
          Object.assign(observed, settings);
          if (changed.model && step.kind === 'model') notice.model = changed.model;
          if (changed.effort) notice.effort = changed.effort;
          if (typeof changed.ultracode === 'boolean') notice.ultracode = changed.ultracode;
          if (typeof changed.fast === 'boolean') notice.fast = changed.fast;
        },
        failure,
      });
      try {
        const applied = step.kind === 'fast' && terminal.picker.restoreFastDefaults
          ? await withFastSettings(step, { ...access, apply, confirmed: () => observed.fast === step.target, failure })
          : await apply();
        if (!applied) {
          incomplete = typed || !!close || !!notice.fastError;
          if (incomplete && terminal.active()) failure(t('未收到 Claude Code 的快速模式确认。'));
          return { observed, notice, incomplete };
        }
      } finally { close?.(); }
    }
    incomplete = false;
    return { observed, notice, incomplete };
  } finally {
    const report = incomplete || Object.keys(notice).length;
    notice.incomplete = incomplete;
    route.finish(report ? notice : null);
  }
}

// Mounted once per terminal split; it draws nothing.
export function LeadSync({ projectId, terminal, onError }: {
  projectId: string; terminal: ProjectTerminal; onError?: (message: string) => void;
}) {
  useLeadSync(projectId, terminal, onError);
  return null;
}

function useLeadSync(projectId: string, terminal: ProjectTerminal, onError?: (message: string) => void) {
  const current = useRef(terminal); current.current = terminal;
  const error = useRef(onError); error.current = onError;
  const wake = useRef<(() => void) | null>(null);
  const agent = terminal.cliActive ? terminal.agent : null;
  useEffect(() => {
    const api = window.agentrix, session = terminal.sessionId, id = terminal.id;
    const facet = screenOf(agent), picker = facet?.picker, echo = facet?.echo, matches = facet?.inputMatches;
    if (!agent || !session || !picker || !echo || !matches || !api?.skillSeats || !api.answerTerminal) return;
    let active = true, running = false, loading = false, seats: SeatsInfo | null = null, reads = 0;
    let failed = '', scope = '', previous: AgentSettings | null = null, observed: Partial<AgentSettings> = {};
    const clearFailure = () => { if (failed) { failed = ''; setLeadRoutingFailure(scope, null); } };
    const clearPending = () => setLeadRoutingPending(scope, null);
    const target = () => seats?.conductor ? seats.leads?.[agent] : null;
    const conversation = () => leadRoutingScope(current.current);
    const frame = (): Screen | null => {
      const screen = readScreen(id);
      return screen?.sessionId === session && !screen.pending ? screen : null;
    };
    const busy = facet.facts?.busy ?? facet.working;
    const ready = () => {
      const screen = frame();
      return !!screen && !busy(screen.rows) && canPasteScreen(agent, screen, true);
    };
    const actual = () => previous ? reconcileSettings(previous, observed, current.current.agentSettings) : current.current.agentSettings;
    const state = (seat: LeadSeat, { model, effort, fast, ultracode }: AgentSettings) =>
      JSON.stringify([targetKey(seat), model ? comparableModel(model) : null, effort, fast, ultracode]);
    const syncLead = async () => {
      if (running || loading) return;
      const thread = conversation(), seat = target(), choice = targetKey(seat);
      const bound = () => active && current.current.cliActive && current.current.agent === agent && conversation() === thread;
      const live = () => bound() && targetKey(target()) === choice;
      if (scope !== thread) { clearFailure(); clearPending(); scope = thread; previous = null; observed = {}; }
      const settings = actual();
      if (!seat || !settings) { clearFailure(); clearPending(); return; }
      const key = state(seat, settings);
      const steps = leadSteps(seat, settings, !!picker.restoreFastDefaults && !api.leadFastSettings);
      const switchReason = () => {
        const currentFrame = readScreen(id);
        const version = currentFrame?.sessionId === session && currentFrame.agent === agent ? currentFrame.agentVersion : undefined;
        return steps.map(step => unverifiedScreenStep(agent, step, version)).find(Boolean);
      };
      const reason = switchReason(), failureKey = reason ? JSON.stringify([key, reason]) : key;
      if (failed !== failureKey) clearFailure();
      if (failed || !live() || !steps.length) { clearPending(); return; }
      if (reason) {
        clearPending();
        failed = failureKey;
        setLeadRoutingFailure(thread, { targetModel: seat.model, notice: { unavailable: reason } });
        return;
      }
      if (!ready()) {
        const screen = readScreen(id);
        setLeadRoutingPending(thread, screen?.sessionId === session && busy(screen.rows) ? pendingLeadChanges(steps, settings, seats?.catalog ?? []) : null);
        return;
      }
      running = true;
      const rows = () => frame()?.rows ?? [];
      const driver = { rows, ready, bound, active: () => live() && !switchReason(), picker, echo,
        write: (value: string) => api.answerTerminal(id, value), inputMatches: (command: string) => matches(rows(), command) };
      const before = current.current.agentSettings ?? settings;
      try {
        const result = await switchLead(steps, driver, thread, { id, sessionId: session, access: api.leadFastSettings });
        if (bound()) {
          for (const field of fields) if (result.observed[field] !== undefined) Object.assign(observed, { [field]: result.observed[field] });
          previous = before;
          if (result.incomplete && live() && !switchReason()) {
            failed = state(seat, actual() ?? settings);
            setLeadRoutingFailure(thread, { targetModel: seat.model, notice: result.notice });
          }
          if (result.notice.fastError) error.current?.(routingNotice(result.notice, t));
        }
      } finally {
        running = false;
        if (active) clearPending();
      }
      if (active) void syncLead();
    };
    const load = () => {
      loading = true;
      const read = ++reads;
      const currentRead = () => active && read === reads;
      const accept = (info: SeatsInfo | null) => {
        if (!currentRead()) return;
        loading = false;
        const previousTarget = targetKey(target());
        seats = info;
        if (running && previousTarget !== targetKey(target())) clearPending();
        void syncLead();
      };
      void api.skillSeats(projectId, id).then(accept, () => { if (currentRead()) loading = false; });
    };
    wake.current = () => { void syncLead(); };
    load();
    const off = api.onSkills?.(load);
    const unsubscribe = subscribeScreen(id, wake.current);
    return () => { active = false; clearFailure(); clearPending(); wake.current = null; off?.(); unsubscribe(); };
  }, [agent, projectId, terminal.id, terminal.sessionId]);
  useEffect(() => { wake.current?.(); }, [terminal.agentSettings, terminal.readingHistory?.threadId, terminal.agentStartedAt]);
}
