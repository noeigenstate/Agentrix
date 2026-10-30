import { Article, Terminal as TerminalIcon } from '@phosphor-icons/react';
import type { Project } from '../../shared/types';
import { t } from '../../shared/i18n';
import { useActiveTerminal } from '../terminal/active-terminal';
import { terminalInUse, visibleTerminals } from '../terminal/terminal-visibility.ts';
import { readingShown, setReading, useTerminalChoice } from './reading-mode';

// In the title bar, for the terminal in use of the project in focus while an agent runs in it: the terminal and the reading view side by side, the one shown selected.
// The terminal the switch acts on and whether it shows reading; null when the project has no agent session to switch (the title bar draws nothing, and the app menu has no reading items).
export function useReadingSwitch(project?: Project) {
  const terminal = terminalInUse(visibleTerminals(project?.terminals ?? [], true), useActiveTerminal(project?.id ?? ''));
  const raw = useTerminalChoice();
  return terminal?.sessionId && terminal.codexActive ? { terminalId: terminal.id, reading: readingShown(terminal, raw) } : null;
}

export function ModeSwitch({ project }: { project: Project }) {
  const current = useReadingSwitch(project);
  if (!current) return null;
  const { terminalId, reading } = current;
  const modes = [
    { reading: false, label: t('切换到终端'), text: t('终端'), icon: <TerminalIcon size={14} aria-hidden="true" /> },
    { reading: true, label: t('阅读视图：按文档排版显示对话'), text: t('阅读'), icon: <Article size={14} aria-hidden="true" /> },
  ];
  return <div className="mode-switch" role="group" aria-label={t('显示方式')}>
    {modes.map(mode => <button key={String(mode.reading)} type="button" aria-pressed={reading === mode.reading} aria-label={mode.label} title={mode.label} onClick={() => setReading(terminalId, mode.reading)}>
      {mode.icon}<span>{mode.text}</span>
    </button>)}
  </div>;
}
