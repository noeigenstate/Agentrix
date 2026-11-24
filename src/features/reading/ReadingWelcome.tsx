import { CircleNotch } from '@phosphor-icons/react';
import type { AgentScreen, ScreenAgent } from '../agents/agent-screen-types';
import type { AgentCommand } from '../../shared/types';
import { t } from '../../shared/i18n';
import { adapterOf } from '../../../electron/features/cli-adapters/registry.mjs';

export function ReadingWelcome({ agent, screen, commands, complete, disabled, starting = true }: {
  agent: ScreenAgent; screen: AgentScreen; commands: AgentCommand[]; complete: (command: AgentCommand) => void; disabled: boolean; starting?: boolean;
}) {
  const banner = screen.banner;
  const model = screen.status.model ?? banner?.model, effort = screen.status.effort ?? banner?.effort;
  const manifest = adapterOf(agent)?.manifest;
  const names = manifest?.words.welcome ?? [];
  const suggestions = names.flatMap(name => {
    const command = commands.find(item => item.name === name && item.source === 'builtin');
    return command ? [command] : [];
  });
  return <div className="reading-welcome">
    <h2>{banner?.product ?? manifest?.label ?? agent}{banner?.version && <small>v{banner.version}</small>}</h2>
    {!banner && starting && <p className="reading-welcome-starting"><CircleNotch size={13} className="loading-spinner" />{t('正在启动…')}</p>}
    {(model || effort || banner?.plan) && <p className="reading-welcome-model">{[model, effort, banner?.plan].filter(Boolean).join(' · ')}</p>}
    {banner?.directory && <code className="reading-welcome-directory" title={banner.directory}>{banner.directory}</code>}
    <h3>{t('试试这些命令')}</h3>
    <div className="reading-welcome-commands">{suggestions.map(command => <button type="button" key={command.name} disabled={disabled} onClick={() => complete(command)}>
      <code>{command.name}</code><span>{t(command.description)}</span>
    </button>)}</div>
  </div>;
}
