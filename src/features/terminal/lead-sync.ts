import { useEffect, useRef } from 'react';
import type { ProjectTerminal, SeatsInfo } from '../../shared/types';
import { leadSteps } from './lead-steps.ts';
import { canPasteScreen, readScreen, subscribeScreen, type Screen } from './terminal-screen';

// In conductor mode model routing owns the lead. A running Claude Code does not reread its settings, so a changed lead
// seat reaches it the way the owner would give it: /model and /effort typed into an empty input box. Claude Code takes them
// mid-turn too, so the switch does not wait for the turn to end. It asks before switching the model of a conversation with
// history; that question is answered yes.
// Each target is tried once per conversation, so a model or effort the CLI refuses is not typed again and again.

const SWITCH_QUESTION = /Switch model\?/i;
const tried = new Map<string, string>();
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Types one command into an empty input box and presses Enter once the screen shows it was taken.
async function typeCommand(text: string, write: (value: string) => void, active: () => boolean, shown: () => boolean) {
  write(text);
  if (!(await until(shown, active, 3000))) return false;
  write('\r');
  return true;
}

async function until(check: () => boolean, active: () => boolean, ms: number) {
  for (const end = Date.now() + ms; active() && Date.now() < end; await pause(150)) if (check()) return true;
  return false;
}

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
    const live = () => active && current.current.sessionId === session && current.current.codexActive;
    const frame = (): Screen | null => { const screen = readScreen(id); return screen && screen.sessionId === session ? screen : null; };
    const ready = () => {
      const screen = frame();
      return !!screen && canPasteScreen('claude', screen, true);
    };
    const run = async () => {
      if (running.current || !live()) return;
      const info = seats.current, seat = info?.conductor ? info.leads?.claude : null;
      const steps = leadSteps(seat, current.current.agentSettings);
      const key = `${session}`, target = JSON.stringify(seat);
      if (!steps.length || tried.get(key) === target) return;
      running.current = true;
      try {
        if (!(await until(ready, live, 10 * 60_000))) return;
        tried.set(key, target);
        for (const step of steps) {
          if (!(await until(ready, live, 60_000))) return;
          const sent = await typeCommand(step.command, value => api.writeTerminal(id, value), live, () => frame()?.rows.some(row => row.includes(step.command)) ?? false);
          if (!sent) return;
          // The switch question comes only when the conversation has history; otherwise the prompt returns at once.
          if (step.confirm && await until(() => SWITCH_QUESTION.test(frame()?.rows.join('\n') ?? '') || ready(), live, 5000)
            && SWITCH_QUESTION.test(frame()?.rows.join('\n') ?? '')) api.writeTerminal(id, '\r');
        }
      } finally { running.current = false; }
    };
    const load = () => void api.skillSeats(projectId, id).then(info => { if (active) { seats.current = info; void run(); } }, () => {});
    load();
    const off = api.onSkills?.(load);
    const unsubscribe = subscribeScreen(id, () => { if (seats.current?.conductor) void run(); });
    return () => { active = false; off?.(); unsubscribe(); };
  }, [claude, projectId, terminal.id, terminal.sessionId]);
}
