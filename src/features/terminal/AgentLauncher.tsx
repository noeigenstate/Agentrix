import { useEffect, useState } from 'react';
import { CircleNotch, Terminal as TerminalIcon } from '@phosphor-icons/react';
import type { AgentsState, Result } from '../../shared/types';
import { relativeTime } from '../../shared/time';
import { t } from '../../shared/i18n';
import './agent-launcher.css';

type Agent = 'claude' | 'codex';
type History = Record<Agent, { id: string; at: number } | null>;
const AGENTS: { agent: Agent; name: string; mark: string }[] = [{ agent: 'claude', name: 'Claude Code', mark: '✻' }, { agent: 'codex', name: 'Codex', mark: '>_' }];

// A project with no terminal yet: pick the agent to work with, fresh or continuing this folder's latest conversation
// with it. An agent not installed yet is installed by the same click (Node.js first, when even npm is missing), then
// started. A plain terminal (for other CLIs) stays one click away.
export function AgentLauncher({ terminalId, onAction }: {
  terminalId: string; onAction: <T,>(promise: Promise<Result<T>>) => Promise<T | undefined>;
}) {
  const [history, setHistory] = useState<History | null>(null);
  const [mode, setMode] = useState<'new' | 'continue' | 'native' | null>(null);
  const [starting, setStarting] = useState<Agent | 'terminal' | null>(null);
  const [agents, setAgents] = useState<AgentsState | null>(null);
  useEffect(() => {
    let active = true;
    void window.agentrix.getAgents().then(result => { if (active && result.ok) setAgents(result.value); });
    const off = window.agentrix.onAgents(state => { if (active) setAgents(state); });
    return () => { active = false; off(); };
  }, []);
  const missing = (agent: Agent) => !!agents && !agents[agent].installed;
  useEffect(() => {
    let active = true;
    void window.agentrix.agentHistory(terminalId).then(result => {
      if (!active) return;
      const found = result.ok ? result.value : { claude: null, codex: null };
      setHistory(found); setMode(current => current ?? (found.claude || found.codex ? 'continue' : 'new'));
    });
    return () => { active = false; };
  }, [terminalId]);
  const known = !!history && !!(history.claude || history.codex), chosen = mode ?? 'new';
  const start = async (what: Agent | 'terminal') => {
    if (starting) return;
    setStarting(what);
    // Once started, the terminal (or the reading view) takes this card's place; a failure leaves it to try again.
    if (what === 'terminal') await onAction(window.agentrix.startTerminal(terminalId));
    else if (missing(what) && !agents?.npm) await onAction(window.agentrix.openNode());
    else {
      const installed = missing(what) ? await onAction(window.agentrix.installAgent(what)) : agents;
      if (installed) setAgents(installed);
      if (installed?.[what].installed) await onAction(window.agentrix.agentLaunch(terminalId, what, chosen));
    }
    setStarting(null);
  };
  const note = (agent: Agent) => {
    if (chosen === 'native') return agent === 'claude' ? 'Managed SDK conversation · native tool approvals · no TUI or resume' : 'Real TUI · native approvals · experimental remote transport';
    if (agents?.installing === agent) return t('正在安装…');
    if (missing(agent)) return agents!.npm ? t('未安装 · 点击一键安装') : t('未安装 · 需要先安装 Node.js');
    if (chosen === 'new') return t('开始新的对话');
    if (!history) return t('正在查找开发记录…');
    const last = history[agent];
    return last ? t('接着上次的对话 · {time}', { time: relativeTime(last.at, Date.now()) }) : t('没有它的开发记录，将重新开始');
  };
  return <div className="agent-launcher">
    <p className="agent-launcher-title">{t('选择助手，开始开发')}</p>
    <div className="agent-launcher-mode" role="radiogroup" aria-label={t('开发方式')}>
      <button type="button" role="radio" aria-checked={chosen === 'native'} onClick={() => setMode('native')}>Native approvals</button>
      <button type="button" role="radio" aria-checked={chosen === 'new'} onClick={() => setMode('new')}>{t('开始新开发')}</button>
      <button type="button" role="radio" aria-checked={chosen === 'continue'} disabled={!known} title={history && !known ? t('这个文件夹还没有开发记录') : undefined} onClick={() => setMode('continue')}>{t('继承开发历史')}</button>
    </div>
    <div className="agent-launcher-agents">{AGENTS.map(({ agent, name, mark }) => <button type="button" key={agent} className={`agent-launcher-agent is-${agent}${missing(agent) ? ' is-missing' : ''}`} disabled={!!starting || !!agents?.installing} onClick={() => void start(agent)}>
      <span className="agent-launcher-mark" aria-hidden="true" data-audit-ignore>{starting === agent || agents?.installing === agent ? <CircleNotch size={16} className="loading-spinner" /> : mark}</span>
      <b>{chosen === 'native' && agent === 'claude' ? 'Claude SDK (managed)' : name}</b><small>{note(agent)}</small>
    </button>)}</div>
    {agents?.error && <p className="agent-launcher-error" role="alert">{agents.error}</p>}
    <div className="agent-launcher-more">
      <button type="button" className="text-button" disabled={!!starting} onClick={() => void start('terminal')}><TerminalIcon size={13} />{t('只打开终端')}</button>
    </div>
  </div>;
}
