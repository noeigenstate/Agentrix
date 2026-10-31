import { Article, Terminal as TerminalIcon } from '@phosphor-icons/react';
import type { Project } from '../../shared/types';
import { t } from '../../shared/i18n';
import { useActiveTerminal } from '../terminal/active-terminal';
import { terminalInUse, visibleTerminals } from '../terminal/terminal-visibility.ts';
import { readingShown, setReading, useTerminalChoice } from './reading-mode';

// In the title bar, for the terminal in use of the project in focus while an agent runs in it: the terminal and the reading view side by side, the one shown selected.
export function ModeSwitch({ project }: { project: Project }) {
  const terminal = terminalInUse(visibleTerminals(project.terminals, true), useActiveTerminal(project.id));
  const raw = useTerminalChoice();
  if (!terminal?.sessionId || !terminal.codexActive) return null;
  const reading = readingShown(terminal, raw);
  const modes = [
    { reading: false, label: t('切换到终端'), text: t('终端'), icon: <TerminalIcon size={14} aria-hidden="true" /> },
    { reading: true, label: t('阅读视图：按文档排版显示对话'), text: t('阅读'), icon: <Article size={14} aria-hidden="true" /> },
  ];
  return <div className="mode-switch" role="group" aria-label={t('显示方式')}>
    {modes.map(mode => <button key={String(mode.reading)} type="button" aria-pressed={reading === mode.reading} aria-label={mode.label} title={mode.label} onClick={() => setReading(terminal.id, mode.reading)}>
      {mode.icon}<span>{mode.text}</span>
    </button>)}
  </div>;
}
