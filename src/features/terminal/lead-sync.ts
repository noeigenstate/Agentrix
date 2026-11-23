import { useEffect, useRef } from 'react';
import type { ProjectTerminal, SeatsInfo } from '../../shared/types';
import { claudeInputMatches } from '../agents/agent-screen-input.ts';
import { applyLeadStep } from './lead-picker.ts';
import { leadSteps } from './lead-steps.ts';
import { canPasteScreen, readScreen, subscribeScreen, type Screen } from './terminal-screen';

const tried = new Map<string, Set<string>>();

// Mounted once per terminal split; it draws nothing.
export function LeadSync({ projectId, terminal }: { projectId: string; terminal: ProjectTerminal }) {
  useLeadSync(projectId, terminal);
  return null;
}

// Keeps one terminal's running Claude Code lead on its routing seat while the conversation runs in conductor mode.
export function useLeadSync(projectId: string, terminal: ProjectTerminal) {
  const current = useRef(terminal); current.current = terminal;
  const seats = useRef<SeatsInfo | null>(null);
  const running = useRef(false);
  const claude = terminal.agent === 'claude' && terminal.codexActive && !!terminal.sessionId;
  useEffect(() => {
    if (!claude) return;
    const api = window.agentrix;
    if (!api?.skillSeats) return;
    let active = true;
    const id = terminal.id, session = terminal.sessionId;
    const conversation = () => current.current.readingHistory?.threadId ?? current.current.agentStartedAt ?? null;
    const target = () => seats.current?.conductor ? seats.current.leads?.claude : null;
    const frame = (): Screen | null => {
      const screen = readScreen(id);
      return screen?.sessionId === session && !screen.pending ? screen : null;
    };
    const ready = () => {
      const screen = frame();
      return !!screen && canPasteScreen('claude', screen, true);
    };
    const syncLead = async () => {
      const seat = target(), thread = conversation();
      if (!seat || running.current || !api.answerTerminal) return;
      const key = JSON.stringify([session, thread]), choice = JSON.stringify([seat.model, seat.effort]);
      const live = () => active && current.current.sessionId === session && current.current.codexActive
        && current.current.agent === 'claude' && conversation() === thread && target()?.model === seat.model && target()?.effort === seat.effort;
      if (!live() || !ready()) return;
      running.current = true;
      try {
        const steps = leadSteps(seat, current.current.agentSettings);
        if (!steps.length) return;
        const choices = tried.get(key) ?? new Set<string>();
        if (choices.has(choice)) return;
        choices.add(choice);
        tried.set(key, choices);
        const rows = () => frame()?.rows ?? [];
        const terminal = { rows, ready, active: live, write: (value: string) => api.answerTerminal(id, value),
          inputMatches: (command: string) => claudeInputMatches(rows(), command) };
        for (const step of steps) {
          if (!await applyLeadStep(step, terminal)) return;
        }
      } finally { running.current = false; }
    };
    let reads = 0;
    const load = () => {
      const read = ++reads;
      seats.current = null;
      void api.skillSeats(projectId, id).then(info => { if (active && read === reads) { seats.current = info; void syncLead(); } }, () => {});
    };
    load();
    const off = api.onSkills?.(load);
    const unsubscribe = subscribeScreen(id, () => { if (seats.current?.conductor) void syncLead(); });
    return () => { active = false; off?.(); unsubscribe(); };
  }, [claude, projectId, terminal.id, terminal.sessionId]);
}
