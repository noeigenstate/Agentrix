import { useEffect, useRef } from 'react';
import type { AgentSettings, ProjectTerminal, SeatsInfo } from '../../shared/types';
import { leadRoutingScope, routingNotice, trackLeadRouting, type LeadRoutingNotice } from '../../shared/lead-routing-notices.ts';
import { t } from '../../shared/i18n';
import { claudeInputMatches, claudeWorking } from '../agents/agent-screen-input.ts';
import { applyLeadStep } from './lead-picker.ts';
import { comparableModel, leadSteps, type LeadSeat, type LeadStep } from './lead-steps.ts';
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
        const applied = step.kind === 'fast'
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
  } finally { route.finish(incomplete || Object.keys(notice).length ? { ...notice, incomplete } : null); }
}

// Mounted once per terminal split; it draws nothing.
export function LeadSync({ projectId, terminal, remote = false, onError }: {
  projectId: string; terminal: ProjectTerminal; remote?: boolean; onError?: (message: string) => void;
}) {
  useLeadSync(projectId, terminal, remote, onError);
  return null;
}

function useLeadSync(projectId: string, terminal: ProjectTerminal, remote: boolean, onError?: (message: string) => void) {
  const current = useRef(terminal); current.current = terminal;
  const error = useRef(onError); error.current = onError;
  const wake = useRef<(() => void) | null>(null);
  const claude = terminal.agent === 'claude' && terminal.codexActive && !!terminal.sessionId;
  useEffect(() => {
    const api = window.agentrix, session = terminal.sessionId, id = terminal.id;
    if (!claude || !session || !api?.skillSeats || !api.answerTerminal) return;
    let active = true, running = false, loading = false, seats: SeatsInfo | null = null, reads = 0;
    let failed = '', scope = '', previous: AgentSettings | null = null, observed: Partial<AgentSettings> = {};
    const target = () => seats?.conductor ? seats.leads?.claude : null;
    const conversation = () => leadRoutingScope(current.current);
    const frame = (): Screen | null => {
      const screen = readScreen(id);
      return screen?.sessionId === session && !screen.pending ? screen : null;
    };
    const ready = () => {
      const screen = frame();
      return !!screen && !claudeWorking(screen.rows) && canPasteScreen('claude', screen, true);
    };
    const actual = () => previous ? reconcileSettings(previous, observed, current.current.agentSettings) : current.current.agentSettings;
    const state = (seat: LeadSeat, { model, effort, fast, ultracode }: AgentSettings) =>
      JSON.stringify([targetKey(seat), model ? comparableModel(model) : null, effort, fast, ultracode]);
    const syncLead = async () => {
      if (running || loading) return;
      const thread = conversation(), seat = target(), choice = targetKey(seat);
      const bound = () => active && current.current.codexActive && current.current.agent === 'claude' && conversation() === thread;
      const live = () => bound() && targetKey(target()) === choice;
      if (scope !== thread) { scope = thread; failed = ''; previous = null; observed = {}; }
      const settings = actual();
      if (!seat || !settings) { failed = ''; return; }
      const key = state(seat, settings);
      if (failed !== key) failed = '';
      if (failed || !live() || !ready()) return;
      const steps = leadSteps(seat, settings, remote || !api.leadFastSettings);
      if (!steps.length) return;
      running = true;
      const rows = () => frame()?.rows ?? [];
      const picker = { rows, ready, bound, active: live, write: (value: string) => api.answerTerminal(id, value),
        inputMatches: (command: string) => claudeInputMatches(rows(), command) };
      const before = current.current.agentSettings ?? settings;
      try {
        const result = await switchLead(steps, picker, thread, { id, sessionId: session, access: api.leadFastSettings });
        if (bound()) {
          for (const field of fields) if (result.observed[field] !== undefined) Object.assign(observed, { [field]: result.observed[field] });
          previous = before;
          if (result.incomplete && live()) failed = state(seat, actual() ?? settings);
          if (result.notice.fastError) error.current?.(routingNotice(result.notice, t));
        }
      } finally { running = false; }
      if (active) void syncLead();
    };
    const load = () => {
      loading = true;
      const read = ++reads;
      const currentRead = () => active && read === reads;
      const accept = (info: SeatsInfo | null) => {
        if (!currentRead()) return;
        loading = false;
        seats = info;
        void syncLead();
      };
      void api.skillSeats(projectId, id).then(accept, () => { if (currentRead()) loading = false; });
    };
    wake.current = () => { void syncLead(); };
    load();
    const off = api.onSkills?.(load);
    const unsubscribe = subscribeScreen(id, wake.current);
    return () => { active = false; wake.current = null; off?.(); unsubscribe(); };
  }, [claude, projectId, terminal.id, terminal.sessionId, remote]);
  useEffect(() => { wake.current?.(); }, [terminal.agentSettings, terminal.readingHistory?.threadId, terminal.agentStartedAt]);
}
