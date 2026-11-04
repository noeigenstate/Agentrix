import { useEffect, useRef, useState } from 'react';
import type { ProjectTerminal } from '../../shared/types';
import { t } from '../../shared/i18n';
import { CallsCard } from './AgentCalls';
import './subagent-chip.css';

// The activity pane's way in when a narrow window hides the pane (CSS shows this only there): a chip in the project header that opens the very same list of called models
// (CallsCard, the same row buttons and the same toggleSplit) in a popover. It exists only for a terminal with a sub-agent whose record can be read.
// It is a control of the header, so opening it, like any click inside the popover, never expands a project.
export function SubagentChip({ terminal }: { terminal: ProjectTerminal }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null), chip = useRef<HTMLButtonElement>(null);
  const calls = terminal.agentUsage?.calls ?? [], items = calls.flatMap(call => call.items);
  const viewable = items.some(item => item.viewable);
  useEffect(() => {
    if (!open) return;
    const close = (refocus: boolean) => { setOpen(false); if (refocus) chip.current?.focus(); };
    const outside = (event: PointerEvent) => { if (!anchor.current?.contains(event.target as Node)) close(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(true); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); };
  }, [open]);
  useEffect(() => { if (!viewable) setOpen(false); }, [viewable]);
  if (!viewable) return null;
  const running = items.filter(item => item.state === 'running').length;
  return <div className="subagent-chip-anchor" ref={anchor}
    // Tabbing out of the popover closes it; choosing a row closes it too, so the view that opens is not left under it.
    onBlur={event => { if (open && !anchor.current?.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
    <button type="button" ref={chip} className="button small subagent-chip" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
      {t('子 agent {count}', { count: items.length })}
      {running > 0 && <span className="subagent-chip-run" title={t('{count} 个运行中', { count: running })}><i aria-hidden="true" />{running}</span>}
    </button>
    {open && <div className="subagent-menu" role="dialog" aria-label={t('子 agent')} onClick={event => {
      if ((event.target as Element).closest('.activity-call-open')) { setOpen(false); chip.current?.focus(); }
    }}>
      <CallsCard calls={calls} terminalId={terminal.id} />
    </div>}
  </div>;
}
