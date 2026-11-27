import { CircleNotch, TerminalWindow } from '@phosphor-icons/react';
import { commandRows, commandRun } from './agent-command-run';
import { t } from '../../shared/i18n';
import type { AgentProvider } from '../../shared/agent-events';
import { PathText } from './PathText';
import { adapterOf } from '../../../electron/features/cli-adapters/registry.mjs';

// In place of the conversation while the agent's CLI runs something that is no conversation (codex update): what it
// does, and what it prints as the terminal shows it. When it ends the terminal comes back by itself.
export function AgentCommandRun({ agent, command, rows, onShowTerminal }: { agent: AgentProvider; command: string; rows: readonly string[]; onShowTerminal: () => void }) {
  const { label: name, command: cli } = adapterOf(agent)!.manifest;
  const run = commandRun(command), shown = commandRows(rows, cli, command);
  return <section className="reading-command-run" role="status" aria-live="polite">
    <header>{run.working ? <CircleNotch size={16} className="loading-spinner" /> : <TerminalWindow size={16} />}
      <strong>{t(run.title, { agent: name, command })}</strong><code>{`${cli} ${command}`}</code></header>
    {shown.length > 0 ? <pre><PathText text={shown.join('\n')} /></pre> : <p>{t('正在等待它的输出…')}</p>}
    <button type="button" className="text-button" onClick={onShowTerminal}><TerminalWindow size={14} />{t('在终端里查看')}</button>
  </section>;
}
